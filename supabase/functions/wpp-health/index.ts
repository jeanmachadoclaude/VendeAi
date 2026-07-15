// wpp-health - monitor da Evolution API (WhatsApp), ponto único de falha global.
//
// A Evolution roda numa única instância no Railway servindo TODOS os clientes.
// Este worker roda a cada 5 min via pg_cron (job vendeai-wpp-health, header
// x-worker-key = secret AUTOMATIONS_WORKER_KEY), pinga o servidor, mede a
// latência e grava uma linha em service_health. Em transição ok↔down o detalhe
// registra a mudança de forma clara.
//
// Observação sobre auditoria: audit_logs é por-org (org_id NOT NULL) e a saúde
// da Evolution é global, então não há "audit_logs global". A transição fica
// registrada em service_health.detail (ver runbook). Não misturamos um evento
// global na trilha de auditoria de uma org específica.
//
// Deploy: supabase functions deploy wpp-health --no-verify-jwt --use-api
// Segurança: a apikey da Evolution NUNCA aparece em logs nem na resposta.

import { admin, cors, json, timingSafeEqual } from '../_shared/base.ts'

const SERVICE = 'evolution'
const TIMEOUT_MS = 10_000

const db = admin()

type Probe = { status: number; ms: number; ok: boolean; err?: string }

// Faz um GET com timeout, medindo latência. Nunca lança: erros viram err.
async function probe(url: string, key: string, path: string): Promise<Probe> {
  const started = Date.now()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${url}${path}`, { headers: { apikey: key }, signal: ctrl.signal })
    await res.text().catch(() => {}) // drena o corpo p/ liberar a conexão
    return { status: res.status, ms: Date.now() - started, ok: res.ok }
  } catch (e) {
    const name = (e as Error)?.name
    return { status: 0, ms: Date.now() - started, ok: false, err: name === 'AbortError' ? 'timeout' : String((e as Error)?.message || e) }
  } finally {
    clearTimeout(t)
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Autenticação: apenas o worker (cron) pode acionar. Publicada com
  // --no-verify-jwt, então o header x-worker-key é a única barreira.
  const workerKey = Deno.env.get('AUTOMATIONS_WORKER_KEY')
  const gotKey = req.headers.get('x-worker-key') || ''
  if (!workerKey || !timingSafeEqual(gotKey, workerKey)) {
    return json({ error: 'Não autorizado' }, 401)
  }

  const url = Deno.env.get('EVOLUTION_URL')?.replace(/\/+$/, '')
  const key = Deno.env.get('EVOLUTION_API_KEY')

  let status: 'ok' | 'down'
  let latency: number | null
  let detail: string

  if (!url || !key) {
    status = 'down'
    latency = null
    detail = 'Servidor de mensagens não configurado (secrets EVOLUTION_URL/EVOLUTION_API_KEY ausentes).'
  } else {
    // Dois checks: raiz (liveness) e fetchInstances (autenticado/funcional).
    const root = await probe(url, key, '/')
    const inst = await probe(url, key, '/instance/fetchInstances')

    // "ok" exige raiz respondendo E o endpoint autenticado sem erro (2xx).
    // Assim 401 (apikey errada) ou 5xx contam como "down".
    const up = root.status > 0 && inst.ok
    status = up ? 'ok' : 'down'
    latency = up ? inst.ms : (root.status > 0 ? root.ms : null)

    if (up) {
      detail = `Evolution OK: raiz ${root.status} (${root.ms}ms), instances ${inst.status} (${inst.ms}ms).`
    } else if (root.status === 0 && inst.status === 0) {
      detail = `Evolution inacessível: ${root.err || inst.err || 'sem resposta'}.`
    } else {
      detail = `Evolution com erro: raiz ${root.status}, instances ${inst.status}${inst.err ? ' (' + inst.err + ')' : ''}.`
    }
  }

  // Última leitura registrada, para detectar transição ok↔down.
  const { data: prev } = await db.from('service_health')
    .select('status')
    .eq('service', SERVICE)
    .order('checked_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const prevStatus = prev?.status as string | undefined
  const transitioned = !!prevStatus && prevStatus !== status
  if (transitioned) {
    detail = `⚠️ Transição ${prevStatus} → ${status}. ${detail}`
    console.log(`wpp-health: TRANSIÇÃO ${prevStatus} → ${status}`)
  }

  const { error } = await db.from('service_health').insert({
    service: SERVICE, status, latency_ms: latency, detail,
  })
  if (error) {
    console.error('wpp-health insert:', error.message)
    return json({ error: error.message }, 500)
  }

  console.log(`wpp-health: ${status} latency=${latency ?? 'n/a'}ms transition=${transitioned}`)
  return json({ ok: true, status, latency_ms: latency, transitioned })
})
