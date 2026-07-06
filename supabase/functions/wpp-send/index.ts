// wpp-send — proxy seguro para envio via Evolution API
// Chamado pelo frontend com o JWT do usuário. A API key nunca sai do servidor.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SVC  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const admin = createClient(SUPABASE_URL, SUPABASE_SVC)

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405 })

  // Autentica o usuário via JWT
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response('Unauthorized', { status: 401, headers: cors })

  const client = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user } } = await client.auth.getUser()
  if (!user) return new Response('Unauthorized', { status: 401, headers: cors })

  const { data: profile } = await admin
    .from('profiles')
    .select('org_id')
    .eq('id', user.id)
    .single()
  if (!profile?.org_id) return new Response('No org', { status: 400, headers: cors })

  let body: { conversation_id: string; message: string }
  try   { body = await req.json() }
  catch { return new Response('Invalid JSON', { status: 400, headers: cors }) }

  const { conversation_id, message } = body
  if (!conversation_id || !message) {
    return new Response('Missing fields', { status: 400, headers: cors })
  }

  // Busca a conversa (valida que pertence à org do usuário)
  const { data: conv } = await admin
    .from('wpp_conversations')
    .select('phone')
    .eq('id', conversation_id)
    .eq('org_id', profile.org_id)
    .single()
  if (!conv) return new Response('Conversation not found', { status: 404, headers: cors })

  // Busca credenciais da Evolution API
  const { data: integration } = await admin
    .from('integrations')
    .select('config, is_active')
    .eq('org_id', profile.org_id)
    .eq('type', 'whatsapp_evolution')
    .maybeSingle()

  let externalId: string | null = null
  let msgStatus = 'pending'

  if (integration?.is_active && integration.config) {
    const cfg = integration.config as Record<string, string>
    const { api_url, api_key, instance_name } = cfg

    try {
      const evoRes = await fetch(`${api_url}/message/sendText/${instance_name}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', apikey: api_key },
        body:    JSON.stringify({ number: conv.phone, text: message }),
      })

      if (evoRes.ok) {
        const evoData = await evoRes.json() as Record<string, unknown>
        const evoKey  = evoData.key as Record<string, unknown> | undefined
        externalId    = evoKey?.id ? String(evoKey.id) : null
        msgStatus     = 'sent'
      } else {
        console.error('Evolution API error:', evoRes.status, await evoRes.text())
        // Continua — salva no banco mesmo sem envio real (modo preview)
      }
    } catch (e) {
      console.error('Fetch error ao chamar Evolution API:', e)
    }
  }

  // Salva mensagem no banco
  const { data: msg, error: msgErr } = await admin
    .from('wpp_messages')
    .insert({
      conversation_id,
      direction:   'outbound',
      body:        message,
      status:      msgStatus,
      sent_by:     user.id,
      is_auto:     false,
      external_id: externalId,
    })
    .select()
    .single()

  if (msgErr) {
    console.error('DB error:', msgErr)
    return new Response('DB error', { status: 500, headers: cors })
  }

  // Atualiza prévia da conversa
  await admin.from('wpp_conversations').update({
    last_message:    message,
    last_message_at: new Date().toISOString(),
  }).eq('id', conversation_id)

  return new Response(JSON.stringify(msg), {
    status:  200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
})
