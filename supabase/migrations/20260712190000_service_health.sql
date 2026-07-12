-- ═══════════════════════════════════════════════════════════════
-- SERVICE HEALTH — vigilância da Evolution API (WhatsApp) (12/jul/2026)
--
-- A Evolution é ponto único de falha (uma instância no Railway serve
-- TODOS os clientes). Esta migration cria a trilha de saúde do serviço
-- e agenda a checagem a cada 5 min via pg_cron chamando a Edge Function
-- wpp-health (mesmo padrão do worker vendeai-automations-worker).
--
-- Sem monitoramento externo o serviço pode cair sem ninguém perceber.
-- Ver também docs/runbook-whatsapp.md (ações manuais do Jean).
-- ═══════════════════════════════════════════════════════════════

-- ── TABELA ───────────────────────────────────────────────────
-- Trilha global (não é por-org): apenas STATUS do serviço, nada
-- sensível. Uma linha por checagem; a mais recente por 'service'
-- é a verdade atual.
create table if not exists service_health (
  id          uuid primary key default gen_random_uuid(),
  service     text not null,                 -- 'evolution' (WhatsApp)
  status      text not null check (status in ('ok','down')),
  detail      text,                          -- legível: latências, código, transição
  latency_ms  integer,                       -- latência medida (null se inacessível)
  checked_at  timestamptz not null default now()
);
create index if not exists idx_service_health_latest
  on service_health(service, checked_at desc);

-- ── RLS ──────────────────────────────────────────────────────
-- Serviço global: SELECT liberado a qualquer usuário autenticado
-- (dado não sensível: só o status). Escrita SÓ via service role
-- (a Edge Function wpp-health) — nenhuma policy de insert/update/delete,
-- então o frontend nunca escreve aqui.
alter table service_health enable row level security;
drop policy if exists service_health_read on service_health;
create policy service_health_read on service_health
  for select to authenticated using (true);

-- ── AGENDAMENTO: checagem a cada 5 min via pg_cron + pg_net ──
-- Mesmo padrão do job vendeai-automations-worker (migration
-- 20260708150000_automacoes_v2.sql): net.http_post com o header
-- x-worker-key = secret AUTOMATIONS_WORKER_KEY. A function wpp-health
-- é publicada com --no-verify-jwt e valida esse header.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('vendeai-wpp-health')
where exists (select 1 from cron.job where jobname = 'vendeai-wpp-health');

select cron.schedule(
  'vendeai-wpp-health',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://hniieydykjvjwggshvkf.supabase.co/functions/v1/wpp-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-key', '32e848f2ad41a0c2728795e38caf834427a697ca2ab4022c'
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $$
);
