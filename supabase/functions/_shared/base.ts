// Módulo compartilhado das Edge Functions do VendeAI
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
    .from('profiles').select('org_id, full_name, role').eq('id', user.id).single()
  if (!profile?.org_id) throw json({ error: 'Perfil sem organização' }, 400)

  return { user, orgId: profile.org_id as string, userName: profile.full_name as string, role: profile.role as string }
}

// Metodologia Outpace Growth salva em organizations.settings.vendeai_methodology
export async function getMethodology(orgId: string): Promise<string> {
  const { data } = await admin()
    .from('organizations').select('settings').eq('id', orgId).single()
  return (data?.settings?.vendeai_methodology as string) ||
    'Metodologia padrão: qualifique com SPIN Selling, seja consultivo, foque em dor e ROI, ' +
    'conduza sempre para o próximo passo concreto (reunião, proposta ou fechamento).'
}

// ── Quota de IA por organização ──────────────────────────────
// Limite mensal por CONTAGEM de chamadas (não por tokens): simples e
// previsível. Lido de organizations.settings.ai_quota_monthly (default
// 200). Chame ANTES da IA em cada function que consome Claude, logo
// após requireUser — lança um 429 amigável se a org estourou o mês.
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
