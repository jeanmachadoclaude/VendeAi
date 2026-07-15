// wpp-send - proxy seguro para envio via Evolution API
// Chamado pelo frontend com o JWT do usuário. A API key nunca sai do servidor.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getEvolution, evoHeaders } from '../_shared/evolution.ts'
import { reportError } from '../_shared/base.ts'

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SVC  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const admin = createClient(SUPABASE_URL, SUPABASE_SVC)

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
}

async function handleSend(req: Request): Promise<Response> {
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

  // Resolve o servidor Evolution (central do VendeAI ou próprio da org)
  let externalId: string | null = null
  let msgStatus = 'pending'
  // Motivo da não-entrega, quando houver - vira uma mensagem CLARA (não técnica)
  // para o usuário. A mensagem é salva de qualquer forma (fallback), então o
  // usuário nunca perde o texto; só precisa saber que ainda não saiu.
  let reason: 'no_server' | 'not_connected' | 'unavailable' | null = null
  let notice: string | null = null

  let evo = null
  try {
    evo = await getEvolution(profile.org_id)
  } catch (_) {
    // Servidor de mensagens ainda não ativado (secrets ausentes ou org sem config)
    reason = 'no_server'
    notice = 'WhatsApp ainda não ativado. Ative em Configurações → Integrações.'
  }

  if (evo) {
    try {
      const evoRes = await fetch(`${evo.apiUrl}/message/sendText/${evo.instanceName}`, {
        method:  'POST',
        headers: evoHeaders(evo),
        body:    JSON.stringify({ number: conv.phone, text: message }),
      })

      if (evoRes.ok) {
        const evoData = await evoRes.json() as Record<string, unknown>
        const evoKey  = evoData.key as Record<string, unknown> | undefined
        externalId    = evoKey?.id ? String(evoKey.id) : null
        msgStatus     = 'sent'
      } else {
        // Não logamos o corpo cru para o usuário; só o status no servidor.
        console.error('Evolution API error:', evoRes.status, await evoRes.text().catch(() => ''))
        // 401/403/404 costumam ser instância desconectada; 5xx/erros = fora do ar.
        if (evoRes.status === 401 || evoRes.status === 403 || evoRes.status === 404) {
          reason = 'not_connected'
          notice = 'WhatsApp desconectado. Reconecte pelo QR em Configurações → Integrações.'
        } else {
          reason = 'unavailable'
          notice = 'WhatsApp temporariamente indisponível. A mensagem foi salva e você pode reenviar em instantes.'
        }
      }
    } catch (e) {
      console.error('Fetch error ao chamar Evolution API:', e)
      reason = 'unavailable'
      notice = 'WhatsApp temporariamente indisponível. A mensagem foi salva e você pode reenviar em instantes.'
    }
  }

  // Corrida com o eco do webhook: agora fromMe também entra pelo webhook,
  // e ele pode gravar ANTES desta function. Se a mensagem já existe com este
  // external_id, só atribui o remetente em vez de duplicar.
  if (externalId) {
    const { data: eco } = await admin.from('wpp_messages')
      .select('*').eq('external_id', externalId).maybeSingle()
    if (eco) {
      await admin.from('wpp_messages')
        .update({ sent_by: user.id }).eq('id', eco.id)
      return new Response(JSON.stringify({ ...eco, sent_by: user.id, delivered: true, reason, notice }), {
        status:  200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
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

  return new Response(JSON.stringify({ ...msg, delivered: msgStatus === 'sent', reason, notice }), {
    status:  200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// try/catch de último nível: erro não tratado vai ao Sentry (sem o texto da
// mensagem) e responde 500 limpo - nunca derruba o envio.
Deno.serve((req: Request) =>
  handleSend(req).catch(async (e) => {
    console.error('wpp-send erro não tratado:', e)
    await reportError(e, 'wpp-send')
    return new Response('Internal error', { status: 500, headers: cors })
  })
)
