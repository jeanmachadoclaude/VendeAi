// wpp-status — verifica estado da conexão e retorna QR code se necessário
// Chamado pelo settings.html para mostrar status real e QR code de pareamento.

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

  // Autentica o usuário
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

  // Busca credenciais salvas
  const { data: integration } = await admin
    .from('integrations')
    .select('config, is_active')
    .eq('org_id', profile.org_id)
    .eq('type', 'whatsapp_evolution')
    .maybeSingle()

  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  if (!integration?.config) {
    return json({ configured: false })
  }

  const cfg = integration.config as Record<string, string>
  const { api_url, api_key, instance_name } = cfg

  if (!api_url || !api_key || !instance_name) {
    return json({ configured: false })
  }

  try {
    // 1. Verifica estado da conexão
    const stateRes  = await fetch(`${api_url}/instance/connectionState/${instance_name}`, {
      headers: { apikey: api_key },
    })

    if (!stateRes.ok) {
      return json({ configured: true, connected: false, error: `Evolution API retornou ${stateRes.status}` })
    }

    const stateData = await stateRes.json() as Record<string, unknown>
    const instance  = stateData.instance as Record<string, unknown> | undefined
    const state     = String(instance?.state ?? 'close')

    if (state === 'open') {
      // Marca integração como ativa e atualiza last_sync
      await admin.from('integrations').update({
        is_active: true,
        last_sync: new Date().toISOString(),
      }).eq('org_id', profile.org_id).eq('type', 'whatsapp_evolution')

      return json({ configured: true, connected: true, state })
    }

    // 2. Não conectado — busca QR code
    // Evolution v2: GET /instance/connect/{instance} retorna { base64 }.
    // Evolution v1: GET /instance/qrcode/{instance}?image=true.
    let qr: string | null = null
    const qrV2 = await fetch(`${api_url}/instance/connect/${instance_name}`, {
      headers: { apikey: api_key },
    })
    if (qrV2.ok) {
      const qrData = await qrV2.json() as Record<string, unknown>
      qr = (qrData.base64 as string) ?? null
    }
    if (!qr) {
      const qrV1 = await fetch(`${api_url}/instance/qrcode/${instance_name}?image=true`, {
        headers: { apikey: api_key },
      })
      if (qrV1.ok) {
        const qrData = await qrV1.json() as Record<string, unknown>
        qr = (qrData.base64 as string) ?? null
      }
    }

    // Marca integração como inativa
    await admin.from('integrations').update({ is_active: false })
      .eq('org_id', profile.org_id).eq('type', 'whatsapp_evolution')

    return json({ configured: true, connected: false, state, qr })

  } catch (e) {
    console.error('Erro ao conectar Evolution API:', e)
    return json({ configured: true, connected: false, error: 'Não foi possível conectar à API' })
  }
})
