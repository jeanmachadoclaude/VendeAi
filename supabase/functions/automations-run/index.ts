// automations-run — worker de execução das automações (13ª function)
// Roda a cada 5 min via pg_cron (header x-worker-key) e também sob demanda
// pelo frontend ("Executar agora", JWT do usuário → processa só a org dele).
//
// Duas fases:
//   1. ENFILEIRAR: varre eventos recentes (leads criados, etapas movidas,
//      ganhos/perdas, inatividade, data prevista) e cria automation_runs
//      (dedupe por automation_id+dedupe_key; delay vira resume_at futuro).
//   2. PROCESSAR: executa runs pendentes com resume_at vencido, caminhando
//      pelo grafo (fluxos visuais) ou pelo grafo implícito (modo simples).
//      Nós de espera reagendam resume_at; condições seguem o ramo sim/não.

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getEvolution, evoHeaders } from '../_shared/evolution.ts'
import { getGmailConfig, gmailAccessToken, encodeMime } from '../_shared/gmail.ts'

const LOOKBACK_H = 72        // janela de varredura de eventos (cobre downtime do cron)
const MAX_RUNS = 50          // runs processadas por invocação
const MAX_STEPS = 30         // proteção contra loop no grafo

type Node = { id: string; type: string; subtype?: string; config?: Record<string, unknown> }
type Edge = { from: string; fromPort?: string; to: string }
type Graph = { nodes: Node[]; edges: Edge[] }
type Automation = {
  id: string; org_id: string; name: string; kind: string; is_active: boolean
  trigger_type: string; trigger_config: Record<string, unknown>
  delay_hours: number; action_type: string; action_config: Record<string, unknown>
  graph: Graph | null; created_by: string | null
}

const db = admin()
const iso = (d: Date) => d.toISOString()
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000)

// ── Grafo ────────────────────────────────────────────────────
// Modo simples vira um grafo implícito: trigger → (delay) → action
function graphOf(a: Automation): Graph {
  if (a.kind === 'flow' && a.graph?.nodes?.length) return a.graph
  const nodes: Node[] = [{ id: 'trigger', type: 'trigger', subtype: a.trigger_type, config: a.trigger_config }]
  const edges: Edge[] = []
  let prev = 'trigger'
  if (a.delay_hours > 0) {
    nodes.push({ id: 'delay', type: 'delay', config: { hours: a.delay_hours } })
    edges.push({ from: prev, to: 'delay' })
    prev = 'delay'
  }
  nodes.push({ id: 'action', type: 'action', subtype: a.action_type, config: a.action_config })
  edges.push({ from: prev, to: 'action' })
  return { nodes, edges }
}
const nodeById = (g: Graph, id: string) => g.nodes.find(n => n.id === id)
const nextNode = (g: Graph, from: string, port = 'out') =>
  g.edges.find(e => e.from === from && (e.fromPort || 'out') === port)?.to ?? null
const firstNodeAfterTrigger = (g: Graph) => {
  const trig = g.nodes.find(n => n.type === 'trigger')
  return trig ? nextNode(g, trig.id) : null
}

// ── Fase 1: enfileirar eventos ───────────────────────────────
async function enqueue(autos: Automation[]): Promise<number> {
  let enqueued = 0
  for (const a of autos) {
    const g = graphOf(a)
    const start = firstNodeAfterTrigger(g)
    if (!start) continue
    const cfg = a.trigger_config || {}
    const since = iso(hoursAgo(LOOKBACK_H))
    const rows: Record<string, unknown>[] = []
    const mk = (dedupe: string, eventAt: string, contact_id: string | null, deal_id: string | null) => ({
      automation_id: a.id, org_id: a.org_id, contact_id, deal_id,
      dedupe_key: dedupe, current_node: start,
      resume_at: iso(new Date(new Date(eventAt).getTime())), // delay fica nos nós de espera
      status: 'pending',
    })

    try {
      if (a.trigger_type === 'lead_created' || a.trigger_type === 'form_submit') {
        let q = db.from('contacts').select('id, created_at, source')
          .eq('org_id', a.org_id).gte('created_at', since)
        if (a.trigger_type === 'form_submit') q = q.eq('source', 'formulario')
        else if (cfg.source) q = q.eq('source', cfg.source as string)
        const { data } = await q
        for (const c of data || []) rows.push(mk(`lead:${c.id}`, c.created_at, c.id, null))
      } else if (a.trigger_type === 'stage_changed') {
        const { data } = await db.from('activities')
          .select('id, created_at, deal_id, contact_id, meta')
          .eq('org_id', a.org_id).eq('type', 'stage_change').gte('created_at', since)
        for (const act of data || []) {
          const meta = (act.meta || {}) as Record<string, string>
          if (cfg.stage_id && meta.stage_id !== cfg.stage_id) continue
          if (cfg.pipeline_id && meta.pipeline_id && meta.pipeline_id !== cfg.pipeline_id) continue
          rows.push(mk(`act:${act.id}`, act.created_at, act.contact_id, act.deal_id))
        }
      } else if (a.trigger_type === 'deal_won' || a.trigger_type === 'deal_lost') {
        let q = db.from('deals').select('id, contact_id, closed_at, pipeline_id')
          .eq('org_id', a.org_id)
          .eq('status', a.trigger_type === 'deal_won' ? 'won' : 'lost')
          .gte('closed_at', since)
        if (cfg.pipeline_id) q = q.eq('pipeline_id', cfg.pipeline_id as string)
        const { data } = await q
        for (const d of data || []) rows.push(mk(`deal:${d.id}:${d.closed_at}`, d.closed_at, d.contact_id, d.id))
      } else if (a.trigger_type === 'no_activity') {
        const days = Number(cfg.days) || 7
        const { data } = await db.rpc('automation_idle_deals', { p_org: a.org_id, p_days: days })
        for (const d of data || []) rows.push(mk(`noact:${d.deal_id}:${d.last_at}`, iso(new Date()), d.contact_id, d.deal_id))
      } else if (a.trigger_type === 'date_condition') {
        const daysBefore = Number(cfg.days_before) || 0
        const today = new Date(); today.setHours(0, 0, 0, 0)
        const min = new Date(today); min.setDate(min.getDate() + daysBefore - 3) // lookback 3d
        const max = new Date(today); max.setDate(max.getDate() + daysBefore)
        const { data } = await db.from('deals')
          .select('id, contact_id, expected_close').eq('org_id', a.org_id).eq('status', 'open')
          .gte('expected_close', min.toISOString().slice(0, 10))
          .lte('expected_close', max.toISOString().slice(0, 10))
        for (const d of data || []) rows.push(mk(`date:${d.id}:${d.expected_close}`, iso(new Date()), d.contact_id, d.id))
      }
    } catch (e) { console.error(`enqueue ${a.name}:`, e); continue }

    if (rows.length) {
      const { data, error } = await db.from('automation_runs')
        .upsert(rows, { onConflict: 'automation_id,dedupe_key', ignoreDuplicates: true })
        .select('id')
      if (error) console.error(`enqueue insert ${a.name}:`, error.message)
      else enqueued += data?.length || 0
    }
  }
  return enqueued
}

// ── Contexto e templates ─────────────────────────────────────
async function loadCtx(run: Record<string, unknown>) {
  const ctx: Record<string, unknown> = { contact: null, deal: null, stage: null, owner: null }
  if (run.deal_id) {
    const { data } = await db.from('deals').select('*').eq('id', run.deal_id).maybeSingle()
    ctx.deal = data
    if (data?.contact_id && !run.contact_id) run.contact_id = data.contact_id
  }
  if (run.contact_id) {
    const { data } = await db.from('contacts').select('*').eq('id', run.contact_id).maybeSingle()
    ctx.contact = data
  }
  const deal = ctx.deal as Record<string, unknown> | null
  const contact = ctx.contact as Record<string, unknown> | null
  const stageId = deal?.stage_id || contact?.stage_id
  if (stageId) {
    const { data } = await db.from('pipeline_stages').select('id, name, pipeline_id').eq('id', stageId).maybeSingle()
    ctx.stage = data
  }
  const ownerId = deal?.owner_id || contact?.owner_id
  if (ownerId) {
    const { data } = await db.from('profiles').select('id, full_name').eq('id', ownerId).maybeSingle()
    ctx.owner = data
  }
  return ctx
}

function render(tpl: string, ctx: Record<string, unknown>): string {
  const c = (ctx.contact || {}) as Record<string, unknown>
  const d = (ctx.deal || {}) as Record<string, unknown>
  const vars: Record<string, string> = {
    nome: String(c.first_name || ''), sobrenome: String(c.last_name || ''),
    nome_completo: [c.first_name, c.last_name].filter(Boolean).join(' '),
    empresa: String(c.company || ''), email: String(c.email || ''),
    telefone: String(c.phone || c.whatsapp || ''), cargo: String(c.job_title || ''),
    responsavel: String((ctx.owner as Record<string, unknown>)?.full_name || ''),
    negocio: String(d.title || ''),
    valor: d.value != null ? Number(d.value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '',
    etapa: String((ctx.stage as Record<string, unknown>)?.name || ''),
    data_prevista: d.expected_close ? new Date(String(d.expected_close) + 'T12:00:00').toLocaleDateString('pt-BR') : '',
  }
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '')
}

// ── Condições ────────────────────────────────────────────────
function fieldValue(path: string, ctx: Record<string, unknown>): unknown {
  const [entity, ...rest] = String(path || '').split('.')
  const obj = (ctx[entity] || {}) as Record<string, unknown>
  if (rest[0] === 'cf') return ((obj.custom_fields || {}) as Record<string, unknown>)[rest[1]]
  return obj[rest[0]]
}
function evalCondition(cfg: Record<string, unknown>, ctx: Record<string, unknown>): boolean {
  const raw = fieldValue(String(cfg.field || ''), ctx)
  const val = cfg.value
  const op = String(cfg.op || 'eq')
  const isEmpty = raw === null || raw === undefined || raw === ''
  if (op === 'is_set') return !isEmpty
  if (op === 'not_set') return isEmpty
  const a = String(raw ?? '').toLowerCase(), b = String(val ?? '').toLowerCase()
  const na = Number(raw), nb = Number(val)
  const numeric = !isEmpty && !isNaN(na) && !isNaN(nb) && String(val).trim() !== ''
  switch (op) {
    case 'eq': return numeric ? na === nb : a === b
    case 'neq': return numeric ? na !== nb : a !== b
    case 'contains': return a.includes(b)
    case 'gt': return numeric && na > nb
    case 'lt': return numeric && na < nb
    default: return false
  }
}

// ── Ações ────────────────────────────────────────────────────
async function ownerFor(run: Record<string, unknown>, ctx: Record<string, unknown>, a: Automation): Promise<string | null> {
  const deal = ctx.deal as Record<string, unknown> | null
  const contact = ctx.contact as Record<string, unknown> | null
  return (deal?.owner_id || contact?.owner_id || a.created_by) as string | null
}

async function execAction(node: Node, run: Record<string, unknown>, ctx: Record<string, unknown>, a: Automation): Promise<Record<string, unknown>> {
  const cfg = (node.config || {}) as Record<string, unknown>
  const contact = ctx.contact as Record<string, unknown> | null
  const deal = ctx.deal as Record<string, unknown> | null
  const orgId = a.org_id

  switch (node.subtype) {
    case 'send_whatsapp': {
      const phone = String(contact?.whatsapp || contact?.phone || '').replace(/\D/g, '')
      if (!phone) throw new Error('Contato sem telefone/WhatsApp')
      const evo = await getEvolution(orgId) // lança se servidor não configurado
      const text = render(String(cfg.template || ''), ctx)
      if (!text) throw new Error('Template da mensagem vazio')
      // conversa: acha ou cria
      let { data: conv } = await db.from('wpp_conversations').select('id')
        .eq('org_id', orgId).eq('phone', phone).maybeSingle()
      if (!conv) {
        const ins = await db.from('wpp_conversations').insert({
          org_id: orgId, contact_id: contact?.id || null, phone,
        }).select('id').single()
        conv = ins.data
      }
      const res = await fetch(`${evo.apiUrl}/message/sendText/${evo.instanceName}`, {
        method: 'POST', headers: evoHeaders(evo),
        body: JSON.stringify({ number: phone, text }),
      })
      if (!res.ok) throw new Error(`Evolution ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const sent = await res.json() as Record<string, unknown>
      const key = sent.key as Record<string, unknown> | undefined
      const externalId = key?.id ? String(key.id) : null
      // Corrida com o eco do webhook (fromMe entra pelo webhook agora):
      // se ele gravou primeiro, marca como automática em vez de duplicar.
      let jaGravada = false
      if (externalId) {
        const { data: eco } = await db.from('wpp_messages')
          .select('id').eq('external_id', externalId).maybeSingle()
        if (eco) {
          jaGravada = true
          await db.from('wpp_messages').update({ is_auto: true }).eq('id', eco.id)
        }
      }
      if (!jaGravada) await db.from('wpp_messages').insert({
        conversation_id: conv!.id, direction: 'outbound', body: text,
        status: 'sent', is_auto: true, external_id: externalId,
      })
      await db.from('wpp_conversations').update({ last_message: text, last_message_at: iso(new Date()) }).eq('id', conv!.id)
      await db.from('activities').insert({
        org_id: orgId, contact_id: contact?.id || null, deal_id: deal?.id || null,
        type: 'whatsapp', title: `⚡ WhatsApp automático (${a.name})`, body: text.slice(0, 300),
        meta: { automation_id: a.id },
      })
      return { phone }
    }

    case 'send_email': {
      const to = String(contact?.email || '')
      if (!to) throw new Error('Contato sem e-mail')
      const { config } = await getGmailConfig(orgId) // lança se Gmail não conectado
      const token = await gmailAccessToken(config)
      const subject = render(String(cfg.subject || 'Mensagem de {{responsavel}}'), ctx) || 'VendeAI'
      const body = render(String(cfg.template || ''), ctx)
      if (!body) throw new Error('Template do e-mail vazio')
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: encodeMime(config.from_email, to, subject, body) }),
      })
      if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const sent = await res.json() as { id: string; threadId: string }
      await db.from('emails').insert({
        org_id: orgId, contact_id: contact?.id || null, deal_id: deal?.id || null,
        owner_id: await ownerFor(run, ctx, a), direction: 'outbound',
        from_email: config.from_email, to_email: to, subject, body,
        snippet: body.slice(0, 180), message_id: sent.id, thread_id: sent.threadId, status: 'sent',
      })
      await db.from('activities').insert({
        org_id: orgId, contact_id: contact?.id || null, deal_id: deal?.id || null,
        type: 'email', title: `⚡ E-mail automático: ${subject}`, body: body.slice(0, 300),
        meta: { automation_id: a.id },
      })
      return { to, subject }
    }

    case 'create_task': {
      const dueH = Number(cfg.due_hours) || 24
      const title = render(String(cfg.title || `Follow-up: {{nome}} {{negocio}}`), ctx).trim() || 'Follow-up'
      await db.from('activities').insert({
        org_id: orgId, contact_id: contact?.id || null, deal_id: deal?.id || null,
        owner_id: await ownerFor(run, ctx, a), type: 'task', title: `⚡ ${title}`,
        scheduled_at: iso(new Date(Date.now() + dueH * 3600_000)), is_done: false,
        meta: { automation_id: a.id },
      })
      return { title }
    }

    case 'create_event': {
      const startH = Number(cfg.start_hours) || 24
      const durMin = Number(cfg.duration_min) || 60
      const start = new Date(Date.now() + startH * 3600_000)
      const title = render(String(cfg.title || 'Reunião: {{nome_completo}}'), ctx).trim() || 'Reunião'
      await db.from('calendar_events').insert({
        org_id: orgId, contact_id: contact?.id || null, deal_id: deal?.id || null,
        owner_id: await ownerFor(run, ctx, a), title: `⚡ ${title}`,
        description: render(String(cfg.description || ''), ctx) || `Criado pela automação "${a.name}"`,
        type: 'meeting', start_at: iso(start), end_at: iso(new Date(start.getTime() + durMin * 60_000)),
      })
      return { title, start_at: iso(start) }
    }

    case 'assign_owner': {
      let newOwner: string | null = null
      if (cfg.mode === 'balanced' || !cfg.owner_id) {
        // distribuição balanceada: quem tem menos negócios abertos + leads
        const { data: profiles } = await db.from('profiles').select('id').eq('org_id', orgId)
        if (!profiles?.length) throw new Error('Org sem perfis')
        const counts: Record<string, number> = Object.fromEntries(profiles.map(p => [p.id, 0]))
        const { data: openDeals } = await db.from('deals').select('owner_id').eq('org_id', orgId).eq('status', 'open')
        for (const d of openDeals || []) if (d.owner_id && d.owner_id in counts) counts[d.owner_id]++
        newOwner = Object.entries(counts).sort((x, y) => x[1] - y[1])[0][0]
      } else {
        newOwner = String(cfg.owner_id)
      }
      if (contact?.id) await db.from('contacts').update({ owner_id: newOwner }).eq('id', contact.id)
      if (deal?.id) await db.from('deals').update({ owner_id: newOwner }).eq('id', deal.id)
      return { owner_id: newOwner }
    }

    case 'notify_team': {
      const msg = render(String(cfg.message || `Automação "${a.name}" disparada para {{nome_completo}} {{negocio}}`), ctx)
      await db.from('activities').insert({
        org_id: orgId, contact_id: contact?.id || null, deal_id: deal?.id || null,
        type: 'auto', title: `🔔 ${msg.slice(0, 120)}`, body: msg,
        meta: { automation_id: a.id, notify: true },
      })
      return { message: msg }
    }

    case 'move_stage': {
      if (!deal?.id) throw new Error('Gatilho sem negócio associado — mover etapa requer um negócio')
      const stageId = String(cfg.stage_id || '')
      if (!stageId) throw new Error('Etapa destino não configurada')
      const { data: stage } = await db.from('pipeline_stages')
        .select('id, name, pipeline_id, is_won, is_lost').eq('id', stageId).maybeSingle()
      if (!stage) throw new Error('Etapa destino não existe mais')
      const status = stage.is_won ? 'won' : stage.is_lost ? 'lost' : 'open'
      await db.from('deals').update({
        stage_id: stage.id, status,
        closed_at: status === 'open' ? null : iso(new Date()),
      }).eq('id', deal.id)
      await db.from('activities').insert({
        org_id: orgId, deal_id: deal.id, contact_id: contact?.id || null,
        type: status === 'won' ? 'deal_won' : status === 'lost' ? 'deal_lost' : 'stage_change',
        title: `⚡ ${deal.title} movido para ${stage.name} (${a.name})`,
        meta: { automation_id: a.id, stage_id: stage.id, pipeline_id: stage.pipeline_id },
      })
      return { stage_id: stage.id }
    }

    default:
      throw new Error(`Ação desconhecida: ${node.subtype}`)
  }
}

// ── Fase 2: processar runs pendentes ─────────────────────────
async function processRuns(orgFilter: string | null): Promise<{ processed: number; failed: number }> {
  let q = db.from('automation_runs').select('*')
    .eq('status', 'pending').lte('resume_at', iso(new Date()))
    .order('resume_at').limit(MAX_RUNS)
  if (orgFilter) q = q.eq('org_id', orgFilter)
  const { data: runs, error } = await q
  if (error) { console.error('processRuns:', error.message); return { processed: 0, failed: 0 } }

  let processed = 0, failed = 0
  for (const run of runs || []) {
    const { data: a } = await db.from('automations').select('*').eq('id', run.automation_id).maybeSingle()
    if (!a || !a.is_active) {
      await db.from('automation_runs').update({ status: 'cancelled', updated_at: iso(new Date()) }).eq('id', run.id)
      continue
    }
    const auto = a as Automation
    const g = graphOf(auto)
    const ctx = await loadCtx(run)

    let cursor: string | null = run.current_node || firstNodeAfterTrigger(g)
    let steps = 0
    let runFailed: string | null = null
    let paused = false

    while (cursor && steps++ < MAX_STEPS) {
      const node = nodeById(g, cursor)
      if (!node) break
      if (node.type === 'delay') {
        const h = Number((node.config as Record<string, unknown>)?.hours) || 0
        const next = nextNode(g, node.id)
        await db.from('automation_runs').update({
          current_node: next, resume_at: iso(new Date(Date.now() + h * 3600_000)),
          updated_at: iso(new Date()),
        }).eq('id', run.id)
        paused = !!next
        cursor = null
      } else if (node.type === 'condition') {
        const ok = evalCondition((node.config || {}) as Record<string, unknown>, ctx)
        cursor = nextNode(g, node.id, ok ? 'true' : 'false')
      } else if (node.type === 'action') {
        try {
          const meta = await execAction(node, run, ctx, auto)
          await db.from('automation_logs').insert({
            automation_id: auto.id, contact_id: run.contact_id, deal_id: run.deal_id,
            status: 'success', action_type: node.subtype, meta,
          })
        } catch (e) {
          const msg = e instanceof Response ? (await e.text()).slice(0, 300) : String((e as Error)?.message || e)
          await db.from('automation_logs').insert({
            automation_id: auto.id, contact_id: run.contact_id, deal_id: run.deal_id,
            status: 'failed', action_type: node.subtype, error_message: msg,
          })
          runFailed = msg
          break
        }
        cursor = nextNode(g, node.id)
      } else {
        cursor = nextNode(g, node.id) // trigger ou nó desconhecido: segue adiante
      }
    }

    if (paused && !runFailed) continue // espera reagendada

    await db.from('automation_runs').update({
      status: runFailed ? 'failed' : 'done', error: runFailed,
      current_node: null, updated_at: iso(new Date()),
    }).eq('id', run.id)

    if (runFailed) failed++
    else {
      processed++
      await db.from('automations').update({
        run_count: (auto as unknown as { run_count: number }).run_count + 1 || 1,
        last_run_at: iso(new Date()),
      }).eq('id', auto.id)
    }
  }
  return { processed, failed }
}

// ── HTTP handler ─────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // Autenticação: worker key (cron) OU JWT de usuário (execução manual da org)
  let orgFilter: string | null = null
  const workerKey = Deno.env.get('AUTOMATIONS_WORKER_KEY')
  const gotKey = req.headers.get('x-worker-key')
  if (!workerKey || gotKey !== workerKey) {
    try {
      const { orgId } = await requireUser(req)
      orgFilter = orgId
    } catch (e) {
      return e instanceof Response ? e : json({ error: 'Não autorizado' }, 401)
    }
  }

  try {
    let q = db.from('automations').select('*').eq('is_active', true)
    if (orgFilter) q = q.eq('org_id', orgFilter)
    const { data: autos, error } = await q
    if (error) throw new Error(error.message)

    const enqueued = await enqueue((autos || []) as Automation[])
    const { processed, failed } = await processRuns(orgFilter)
    console.log(`automations-run: ${enqueued} enfileiradas, ${processed} ok, ${failed} falhas`)
    return json({ ok: true, enqueued, processed, failed })
  } catch (e) {
    console.error(e)
    await reportError(e, 'automations-run')
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
