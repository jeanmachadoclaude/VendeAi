// wpp-connect - fluxo "1 clique" de conexão do WhatsApp.
// Cria a instância da org no servidor Evolution (central ou próprio),
// configura o webhook automaticamente e devolve o QR Code / estado.
// Frontend: sb.functions.invoke('wpp-connect')  → { connected, qr?, state, managed }

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getEvolution, evoState, evoEnsureInstance, evoQr } from '../_shared/evolution.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { orgId } = await requireUser(req)
    const cfg = await getEvolution(orgId)
    const db = admin()

    // Token secreto por org: a wpp-webhook rejeita (401) qualquer chamada sem
    // ele. Reaproveita o token já existente; gera um novo só na primeira vez.
    const { data: prevInteg } = await db.from('integrations')
      .select('config').eq('org_id', orgId).eq('type', 'whatsapp_evolution').maybeSingle()
    const prevConfig = (prevInteg?.config ?? {}) as Record<string, unknown>
    const webhookToken = (prevConfig.webhook_token as string) || crypto.randomUUID().replace(/-/g, '')

    const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/wpp-webhook?org=${orgId}&token=${webhookToken}`

    // Preserva o config existente (api_url/api_key do modo avançado etc.) e
    // grava/atualiza nome da instância, modo e o token do webhook.
    const mergedConfig = {
      ...prevConfig,
      instance_name: cfg.instanceName,
      managed: cfg.managed,
      webhook_token: webhookToken,
    }

    // Garante que a linha de integração existe (guarda o nome da instância)
    if (cfg.integrationId) {
      await db.from('integrations').update({
        config: mergedConfig,
      }).eq('id', cfg.integrationId).eq('org_id', orgId)
    } else {
      const { data } = await db.from('integrations').insert({
        org_id: orgId, type: 'whatsapp_evolution',
        config: mergedConfig,
        is_active: false,
      }).select('id').single()
      cfg.integrationId = data?.id ?? null
    }

    // 1. Já conectado?
    let state = await evoState(cfg)
    if (state === 'open') {
      await db.from('integrations').update({ is_active: true, last_sync: new Date().toISOString() })
        .eq('id', cfg.integrationId)
      return json({ connected: true, state, managed: cfg.managed })
    }

    // 2. Garante instância + webhook (idempotente) - pode já devolver o QR
    let qr = await evoEnsureInstance(cfg, webhookUrl)

    // 3. Se não veio QR na criação, busca no endpoint de conexão
    if (!qr) qr = await evoQr(cfg)

    // 4. Reconfere o estado (pode ter conectado entre as chamadas)
    state = await evoState(cfg)
    if (state === 'open') {
      await db.from('integrations').update({ is_active: true, last_sync: new Date().toISOString() })
        .eq('id', cfg.integrationId)
      return json({ connected: true, state, managed: cfg.managed })
    }

    await db.from('integrations').update({ is_active: false }).eq('id', cfg.integrationId)

    if (!qr) {
      return json({
        connected: false, state, managed: cfg.managed,
        error: 'Servidor de WhatsApp acessível, mas o QR Code não veio. Tente novamente em alguns segundos.',
      })
    }
    return json({ connected: false, state, qr, managed: cfg.managed })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'wpp-connect')
    return json({ error: String(e?.message || e) }, 500)
  }
})
