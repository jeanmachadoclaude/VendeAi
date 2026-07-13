-- ═══════════════════════════════════════════════════════════════════════
-- Backup e Disaster Recovery — PROMPT 11
--
-- Cria o bucket PRIVADO 'backups' e agenda o backup lógico semanal
-- (Edge Function backup-export) via pg_cron. Complementa os backups físicos
-- diários do Supabase (WAL-G, retenção ~7 dias, SEM PITR). Ver
-- docs/runbook-restore.md para o passo a passo de restauração.
-- ═══════════════════════════════════════════════════════════════════════

-- ── Bucket privado 'backups' ──────────────────────────────────────────
-- public = false e NENHUMA policy em storage.objects para este bucket:
-- só o service role (que ignora RLS) lê/escreve. Um vazamento aqui
-- exporia o banco inteiro, então o acesso é o mais restrito possível.
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do update set public = false;

-- ── Agendamento: backup lógico semanal (domingo 03:00 UTC) ────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('vendeai-backup-export')
where exists (select 1 from cron.job where jobname = 'vendeai-backup-export');

select cron.schedule(
  'vendeai-backup-export',
  '0 3 * * 0',   -- domingo às 03:00 UTC
  $$
  select net.http_post(
    url := 'https://hniieydykjvjwggshvkf.supabase.co/functions/v1/backup-export',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-key', '32e848f2ad41a0c2728795e38caf834427a697ca2ab4022c'
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $$
);
