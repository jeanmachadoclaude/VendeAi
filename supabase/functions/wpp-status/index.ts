// wpp-status - verifica estado da conexão e retorna QR code se necessário.
// Chamado pelo settings.html (status/QR) e automations.html (pill de status).
// Usa getEvolution: funciona no modo gerenciado (secrets EVOLUTION_URL/KEY)
// e no modo avançado (api_url/api_key no config da integração).
// Frontend: sb.functions.invoke('wpp-status') → { configured, connected, state, qr? }

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getEvolution, evoState, evoQr } from '../_shared/evolution.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { orgId } = await requireUser(req)

    let cfg
    try {
      cfg = await getEvolution(orgId)
    } catch (e) {
      // 424 no_server: nem secrets nem credenciais próprias → não configurado
      if (e instanceof Response) return json({ configured: false })
      throw e
    }

    const db = admin()
    const state = await evoState(cfg)

    if (state === 'open') {
      await db.from('integrations').update({
        is_active: true,
        last_sync: new Date().toISOString(),
      }).eq('org_id', orgId).eq('type', 'whatsapp_evolution')

      return json({ configured: true, connected: true, state, managed: cfg.managed })
    }

    // Não conectado - tenta obter o QR Code para pareamento
    const qr = await evoQr(cfg)

    await db.from('integrations').update({ is_active: false })
      .eq('org_id', orgId).eq('type', 'whatsapp_evolution')

    return json({ configured: true, connected: false, state, qr, managed: cfg.managed })
  } catch (e) {
    if (e instanceof Response) return e
    console.error('wpp-status:', e)
    await reportError(e, 'wpp-status')
    return json({ configured: true, connected: false, error: 'Não foi possível conectar à API' })
  }
})
