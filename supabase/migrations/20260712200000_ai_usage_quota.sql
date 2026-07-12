-- ═══════════════════════════════════════════════════════════════
-- QUOTA DE IA POR ORGANIZAÇÃO — medição + limite mensal (12/jul/2026)
--
-- A chave central ANTHROPIC_API_KEY é compartilhada por TODAS as orgs.
-- Sem limite, um único cliente pode drenar o crédito da chave. Esta
-- migration cria a trilha de consumo (ai_usage) e habilita o limite
-- mensal lido de organizations.settings.ai_quota_monthly (default 200).
--
-- A contagem do limite é POR CHAMADA de IA (linhas no mês), não por
-- tokens — simples e previsível. Os tokens ficam gravados só para
-- análise futura de custo. A checagem vive no helper checkAiQuota()
-- em supabase/functions/_shared/base.ts e a gravação no askClaude().
-- ═══════════════════════════════════════════════════════════════

-- ── TABELA ───────────────────────────────────────────────────
-- Uma linha por chamada de IA (org, função, modelo, tokens).
create table if not exists ai_usage (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  function_name text not null,                 -- 'vendeai-analyze' | 'analisar-interacao' | 'wpp-suggest'
  model         text,                          -- modelo efetivamente usado na chamada
  input_tokens  integer default 0,
  output_tokens integer default 0,
  created_at    timestamptz not null default now()
);
-- Índice para a contagem mensal por org (date_trunc('month', now())).
create index if not exists idx_ai_usage_org_month on ai_usage(org_id, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────
-- SELECT para membros da org (visibilidade do consumo em Configurações).
-- Escrita SÓ via service role: as Edge Functions usam admin(), então NÃO
-- há policy de insert/update/delete — o frontend nunca escreve aqui.
alter table ai_usage enable row level security;
drop policy if exists org_isolation_ai_usage_read on ai_usage;
create policy org_isolation_ai_usage_read on ai_usage
  for select using (org_id = get_user_org_id());
