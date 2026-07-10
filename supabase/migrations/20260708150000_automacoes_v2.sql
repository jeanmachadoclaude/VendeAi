-- ═══════════════════════════════════════════════════════════════
-- AUTOMAÇÕES V2 — modo flow (construtor visual) + fila de execução
-- ═══════════════════════════════════════════════════════════════

-- ── automations: suporte a fluxos visuais ────────────────────
alter table automations add column if not exists kind text not null default 'simple';
alter table automations drop constraint if exists automations_kind_check;
alter table automations add constraint automations_kind_check check (kind in ('simple','flow'));
alter table automations add column if not exists graph jsonb;

-- ── automation_logs: logs mais ricos ─────────────────────────
alter table automation_logs add column if not exists action_type text;
alter table automation_logs add column if not exists meta jsonb default '{}';

-- ── automation_runs: fila de execução (permite delay/retomada) ──
-- Cada evento que dispara uma automação vira uma "run". O worker
-- (Edge Function automations-run) processa runs pendentes cuja
-- resume_at já passou; nós de espera reagendam resume_at.
create table if not exists automation_runs (
  id            uuid primary key default uuid_generate_v4(),
  automation_id uuid not null references automations(id) on delete cascade,
  org_id        uuid not null references organizations(id) on delete cascade,
  contact_id    uuid references contacts(id) on delete cascade,
  deal_id       uuid references deals(id) on delete cascade,
  dedupe_key    text not null,          -- evita disparo duplicado p/ mesmo evento
  current_node  text,                    -- id do próximo nó a executar (fluxos)
  resume_at     timestamptz not null default now(),
  status        text not null default 'pending'
                  check (status in ('pending','done','failed','cancelled')),
  error         text,
  context       jsonb default '{}',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create unique index if not exists idx_auto_runs_dedupe on automation_runs(automation_id, dedupe_key);
create index if not exists idx_auto_runs_pending on automation_runs(status, resume_at);

alter table automation_runs enable row level security;
drop policy if exists org_isolation_auto_runs on automation_runs;
create policy org_isolation_auto_runs on automation_runs
  using (org_id = get_user_org_id());

-- ── RPC: negócios abertos sem atividade há N dias ────────────
create or replace function automation_idle_deals(p_org uuid, p_days int)
returns table(deal_id uuid, contact_id uuid, last_at timestamptz)
language sql security definer as $$
  select d.id, d.contact_id,
         greatest(coalesce(max(a.created_at), d.created_at), d.created_at) as last_at
  from deals d
  left join activities a on a.deal_id = d.id
  where d.org_id = p_org and d.status = 'open'
  group by d.id
  having greatest(coalesce(max(a.created_at), d.created_at), d.created_at)
         < now() - make_interval(days => p_days)
$$;

-- ── Agendamento: worker a cada 5 minutos via pg_cron + pg_net ──
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('vendeai-automations-worker')
where exists (select 1 from cron.job where jobname = 'vendeai-automations-worker');

select cron.schedule(
  'vendeai-automations-worker',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://hniieydykjvjwggshvkf.supabase.co/functions/v1/automations-run',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-worker-key', '32e848f2ad41a0c2728795e38caf834427a697ca2ab4022c'
    ),
    body := '{"source":"cron"}'::jsonb
  );
  $$
);
