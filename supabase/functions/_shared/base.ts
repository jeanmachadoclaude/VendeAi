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
  return JSON.parse(text)
}
