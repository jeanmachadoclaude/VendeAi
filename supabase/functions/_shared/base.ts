// Módulo compartilhado das Edge Functions do VendeAI
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ── Sentry: monitoramento de erros (PROMPT 12) ───────────────
// Envia eventos ao Sentry por HTTP (store endpoint), sem SDK pesado.
// PRIVACIDADE: NUNCA enviar corpo de mensagens de WhatsApp, e-mails ou
// dados de contatos. Apenas nome da função, ids e a mensagem de erro.
const SENTRY_DSN_FUNCTIONS =
  'https://67082a5c217e7869e1fe25f0e1afbde4@o4511724774686720.ingest.us.sentry.io/4511724807847936'

function parseSentryDsn(dsn: string) {
  try {
    const u = new URL(dsn)
    return {
      protocol: u.protocol.replace(':', ''),
      host:      u.host,
      publicKey: u.username,
      projectId: u.pathname.replace(/^\//, ''),
    }
  } catch {
    return null
  }
}

// Reporta um erro ao Sentry. Envolvido em try/catch: uma falha de report
// NUNCA derruba a function. Só primitivos (ids, flags) passam no "extra" -
// objetos que possam carregar dados sensíveis são descartados.
export async function reportError(
  err: unknown,
  context: string | { functionName: string; [k: string]: unknown },
): Promise<void> {
  try {
    const dsn = parseSentryDsn(SENTRY_DSN_FUNCTIONS)
    if (!dsn) return

    const ctx = typeof context === 'string' ? { functionName: context } : context
    const fnName = String(ctx.functionName || 'unknown')

    const message = err instanceof Error ? err.message : String(err)
    const type    = err instanceof Error ? (err.name || 'Error') : 'Error'
    const stack   = err instanceof Error ? err.stack : undefined

    // Apenas ids/valores primitivos (nunca objetos com possível PII).
    const extra: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(ctx)) {
      if (k === 'functionName' || v == null) continue
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') extra[k] = v
    }
    // O stack contém apenas caminhos de código (sem dados de usuário).
    if (stack) extra.stack = stack.slice(0, 4000)

    const payload = {
      event_id:    crypto.randomUUID().replace(/-/g, ''),
      timestamp:   new Date().toISOString(),
      platform:    'javascript',
      level:       'error',
      environment: 'production',
      release:     'vendeai-functions@2026-07-12',
      logger:      fnName,
      server_name: fnName,
      transaction: fnName,
      message,
      exception: { values: [{ type, value: message }] },
      tags:  { function: fnName },
      extra,
    }

    await fetch(`${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/store/`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=vendeai-functions/1.0, sentry_key=${dsn.publicKey}`,
      },
      body: JSON.stringify(payload),
    })
  } catch (_reportErr) {
    // Falha de report é silenciosa por design - não derruba a function.
  }
}

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

export function admin(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}

// Comparação de strings em tempo constante (evita timing attacks ao validar
// tokens de webhook). Deno não expõe crypto.timingSafeEqual do Node, então
// acumulamos as diferenças com XOR percorrendo todos os bytes.
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ba = enc.encode(a)
  const bb = enc.encode(b)
  if (ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i]
  return diff === 0
}

// Autentica o usuário pelo JWT do frontend e resolve a org.
// Retorna { user, orgId } ou lança uma Response de erro.
export async function requireUser(req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) throw json({ error: 'Não autenticado' }, 401)

  const client = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )
  const { data: { user } } = await client.auth.getUser()
  if (!user) throw json({ error: 'Sessão inválida' }, 401)

  const { data: profile } = await admin()
    .from('profiles').select('org_id, full_name, role, is_active').eq('id', user.id).single()
  if (!profile?.org_id) throw json({ error: 'Perfil sem organização' }, 400)
  // Membro desativado: recusa em qualquer Edge Function (barreira do servidor).
  if (profile.is_active === false) throw json({ error: 'Conta desativada. Fale com o administrador.' }, 403)

  return { user, orgId: profile.org_id as string, userName: profile.full_name as string, role: profile.role as string }
}

// ── Base de Conhecimento da IA por organização ───────────────
// organizations.settings.knowledge (jsonb): { empresa, linguagem,
// produtos_detalhes, objecoes, metodologia, playbook: {<12 bancos>} }.
// O catálogo real da tabela products entra automaticamente.
// Retrocompat: settings.vendeai_methodology segue valendo como metodologia
// quando knowledge.metodologia está vazio.

const KB_PLAYBOOK: Array<[string, string]> = [
  ['onboarding',   'Banco 1 · Onboarding e modelo comercial'],
  ['icp_dor',      'Banco 2 · Dor latente e ICP (perfil de cliente ideal)'],
  ['puv',          'Banco 3 · Impact Test e Proposta Única de Valor'],
  ['pitch',        'Banco 4 · One Minute Pitch'],
  ['canais',       'Banco 5 · Canais de aquisição'],
  ['inteligencia', 'Banco 6 · Inteligência comercial (base, priorização, enriquecimento)'],
  ['prevendas',    'Banco 7 · Pré-vendas (cadência, abordagem, scripts de SDR)'],
  ['vendas',       'Banco 8 · Vendas (roteiro de call, matriz de objeções, modelo de proposta)'],
  ['pipeline',     'Banco 9 · Tech stack e pipeline'],
  ['metricas',     'Banco 10 · Métricas e KPIs'],
  ['rituais',      'Banco 11 · Rituais de gestão'],
  ['scaleup',      'Banco 12 · Scale up'],
]

const KB_MAX_CHARS = 8000
const KB_FALLBACK =
  'Metodologia padrão: qualifique com SPIN Selling, seja consultivo, foque em dor e ROI, ' +
  'conduza sempre para o próximo passo concreto (reunião, proposta ou fechamento).'

export async function getKnowledge(orgId: string): Promise<string> {
  const db = admin()
  const [orgRes, prodRes] = await Promise.all([
    db.from('organizations').select('settings').eq('id', orgId).single(),
    db.from('products').select('name, price, description')
      .eq('org_id', orgId).eq('is_active', true).order('name').limit(30),
  ])
  const settings = (orgRes.data?.settings ?? {}) as Record<string, unknown>
  const kb = (settings.knowledge ?? {}) as Record<string, unknown>
  const playbook = (kb.playbook ?? {}) as Record<string, unknown>

  const sections: string[] = []
  const push = (titulo: string, valor: unknown) => {
    const txt = String(valor ?? '').trim()
    if (txt) sections.push(`### ${titulo}\n${txt}`)
  }

  push('Empresa (missão, visão, valores e cultura)', kb.empresa)
  push('Linguagem e tom de voz', kb.linguagem)

  const prods = prodRes.data || []
  if (prods.length) {
    sections.push('### Produtos e serviços (catálogo do CRM)\n' + prods.map(p =>
      `- ${p.name}${p.price != null ? ` · R$ ${p.price}` : ''}${p.description ? `: ${p.description}` : ''}`,
    ).join('\n'))
  }
  push('Detalhes adicionais de produtos e serviços', kb.produtos_detalhes)
  push('Objeções comuns e como responder', kb.objecoes)
  push('Metodologia de vendas', kb.metodologia || settings.vendeai_methodology)
  for (const [key, label] of KB_PLAYBOOK) push(label, playbook[key])

  if (!sections.length) return KB_FALLBACK

  let out =
    '## Base de Conhecimento da empresa\n' +
    'Use SEMPRE a linguagem, os produtos e a metodologia abaixo, mesclando com os ' +
    'frameworks de qualificação (BANT, SPIN, ROI):\n\n' + sections.join('\n\n')
  if (out.length > KB_MAX_CHARS) out = out.slice(0, KB_MAX_CHARS) + '\n[Base de conhecimento truncada por tamanho]'
  return out
}

// Wrapper legado - hoje devolve a Base de Conhecimento completa.
export async function getMethodology(orgId: string): Promise<string> {
  return getKnowledge(orgId)
}

// ── Quota de IA por organização ──────────────────────────────
// Limite mensal por CONTAGEM de chamadas (não por tokens): simples e
// previsível. Lido de organizations.settings.ai_quota_monthly (default
// 200). Chame ANTES da IA em cada function que consome Claude, logo
// após requireUser - lança um 429 amigável se a org estourou o mês.
const AI_QUOTA_DEFAULT = 200

export async function checkAiQuota(orgId: string): Promise<void> {
  const db = admin()
  const { data: org } = await db
    .from('organizations').select('settings').eq('id', orgId).single()
  const raw = (org?.settings as Record<string, unknown> | null)?.ai_quota_monthly
  const quota = raw === undefined || raw === null ? AI_QUOTA_DEFAULT : Number(raw)

  // Início do mês corrente em UTC (equivale a date_trunc('month', now())
  // no Postgres, que roda em UTC no Supabase).
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  const { count } = await db
    .from('ai_usage').select('id', { count: 'exact', head: true })
    .eq('org_id', orgId).gte('created_at', monthStart.toISOString())

  if ((count ?? 0) >= quota) {
    throw json({ error: 'Limite mensal de análises de IA atingido. Fale com o suporte para ampliar.' }, 429)
  }
}

// Grava 1 linha de consumo em ai_usage. Falha aqui NUNCA derruba a
// análise (mesmo padrão do logActivity): try/catch com console.warn.
async function recordAiUsage(
  orgId: string, functionName: string, model: string,
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
): Promise<void> {
  try {
    await admin().from('ai_usage').insert({
      org_id: orgId,
      function_name: functionName,
      model,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    })
  } catch (e) {
    console.warn('ai_usage: falha ao gravar consumo (ignorado):', e)
  }
}

// ── Cliente Claude (Anthropic API) ───────────────────────────
// Requer o secret ANTHROPIC_API_KEY:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
const CLAUDE_MODEL = Deno.env.get('VENDEAI_MODEL') || 'claude-opus-4-8'

export async function askClaude(opts: {
  system: string
  prompt: string
  schema: Record<string, unknown>
  maxTokens?: number
  model?: string   // override pontual; default = VENDEAI_MODEL/claude-opus-4-8
  // Quando presente, grava 1 linha em ai_usage (org, função, modelo,
  // tokens) após a resposta. Não passar = não mede (ex.: chamadas internas).
  track?: { orgId: string; functionName: string }
}): Promise<Record<string, unknown>> {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    throw json({ error: 'ANTHROPIC_API_KEY não configurada no Supabase (secrets).' }, 500)
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model || CLAUDE_MODEL,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      output_config: { format: { type: 'json_schema', schema: opts.schema } },
      messages: [{ role: 'user', content: opts.prompt }],
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('Claude API error:', res.status, errText)
    throw json({ error: `Falha na IA (${res.status}). Verifique a chave e o crédito da API.` }, 502)
  }

  const data = await res.json() as Record<string, unknown>
  if (data.stop_reason === 'refusal') {
    throw json({ error: 'A IA recusou esta análise.' }, 502)
  }
  const content = data.content as Array<Record<string, unknown>>
  const text = content?.find(b => b.type === 'text')?.text as string
  if (!text) throw json({ error: 'Resposta vazia da IA.' }, 502)
  const parsed = JSON.parse(text)

  // Mede o consumo (não bloqueia a resposta se a gravação falhar).
  if (opts.track) {
    await recordAiUsage(
      opts.track.orgId, opts.track.functionName, opts.model || CLAUDE_MODEL,
      data.usage as { input_tokens?: number; output_tokens?: number } | undefined,
    )
  }

  return parsed
}
