-- ═══════════════════════════════════════════════════════════════════════
-- E-mail: sincronização automática (FASE 4)
--
-- Agenda o email-sync a cada 15 min via pg_cron. A function roda em modo
-- "worker" (header x-worker-key) e varre TODAS as orgs com Gmail conectado.
--
-- IMPORTANTE: o segredo EMAIL_WORKER_KEY precisa existir nas Edge Functions
-- com EXATAMENTE o mesmo valor do header abaixo:
--   supabase secrets set EMAIL_WORKER_KEY=477002b1c88e55db0ab91585076d30a287e79525cd1b550c
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('vendeai-email-sync')
where exists (select 1 from cron.job where jobname = 'vendeai-email-sync');

select cron.schedule(
  'vendeai-email-sync',
  '*/15 * * * *',   -- a cada 15 minutos
  $$
  select net.http_post(
    url := 'https://hniieydykjvjwggshvkf.supabase.co/functions/v1/email-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-key', '477002b1c88e55db0ab91585076d30a287e79525cd1b550c'
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $$
);
