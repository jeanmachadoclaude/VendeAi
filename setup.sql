-- ============================================================
--  VendeAI CRM · Supabase Schema
--  Outpace Growth · 2026
-- ============================================================

-- ── EXTENSIONS ──────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ── ORGANIZATIONS ────────────────────────────────────────────
create table if not exists organizations (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  slug        text unique not null,
  plan        text default 'pro' check (plan in ('free','pro','enterprise')),
  settings    jsonb default '{}',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── PROFILES (extends Supabase auth.users) ───────────────────
create table if not exists profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  org_id          uuid references organizations(id),
  full_name       text,
  email           text,
  phone           text,
  role            text default 'sdr' check (role in ('admin','manager','sdr','viewer')),
  avatar_url      text,
  settings        jsonb default '{}',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── PIPELINES ────────────────────────────────────────────────
create table if not exists pipelines (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid references organizations(id) on delete cascade,
  name        text not null,
  emoji       text default '🔄',
  position    int default 0,
  is_active   boolean default true,
  created_by  uuid references profiles(id),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── PIPELINE STAGES ──────────────────────────────────────────
create table if not exists pipeline_stages (
  id               uuid primary key default uuid_generate_v4(),
  pipeline_id      uuid references pipelines(id) on delete cascade,
  name             text not null,
  color            text default '#4a7fd4',
  position         int default 0,
  default_prob     int default 30 check (default_prob between 0 and 100),
  is_won           boolean default false,
  is_lost          boolean default false,
  created_at       timestamptz default now()
);

-- ── CONTACTS ─────────────────────────────────────────────────
create table if not exists contacts (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid references organizations(id) on delete cascade,
  first_name      text not null,
  last_name       text,
  email           text,
  phone           text,    -- usado para WhatsApp (formato: 5511999999999)
  whatsapp        text,
  company         text,
  job_title       text,
  linkedin_url    text,
  tags            text[] default '{}',
  tag_color       text default 'warm' check (tag_color in ('hot','warm','cold')),
  owner_id        uuid references profiles(id),
  stage_id        uuid references pipeline_stages(id),
  source          text,    -- 'formulario','manual','importacao','inbound'
  notes           text,
  custom_fields   jsonb default '{}',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── DEALS ────────────────────────────────────────────────────
create table if not exists deals (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid references organizations(id) on delete cascade,
  title           text not null,
  contact_id      uuid references contacts(id),
  pipeline_id     uuid references pipelines(id),
  stage_id        uuid references pipeline_stages(id),
  owner_id        uuid references profiles(id),
  value           numeric(15,2) default 0,
  probability     int default 30 check (probability between 0 and 100),
  expected_close  date,
  closed_at       timestamptz,
  status          text default 'open' check (status in ('open','won','lost')),
  lost_reason     text,
  notes           text,
  tags            text[] default '{}',
  custom_fields   jsonb default '{}',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── ACTIVITIES ───────────────────────────────────────────────
create table if not exists activities (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid references organizations(id) on delete cascade,
  deal_id     uuid references deals(id) on delete cascade,
  contact_id  uuid references contacts(id),
  owner_id    uuid references profiles(id),
  type        text not null check (type in (
                'note','call','email','whatsapp','meeting',
                'task','stage_change','deal_won','deal_lost','auto')),
  title       text,
  body        text,
  scheduled_at  timestamptz,
  completed_at  timestamptz,
  is_done     boolean default false,
  meta        jsonb default '{}',
  created_at  timestamptz default now()
);

-- ── WHATSAPP CONVERSATIONS ───────────────────────────────────
create table if not exists wpp_conversations (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid references organizations(id) on delete cascade,
  contact_id      uuid references contacts(id),
  phone           text not null,
  last_message    text,
  last_message_at timestamptz,
  unread_count    int default 0,
  status          text default 'open' check (status in ('open','resolved','archived')),
  assigned_to     uuid references profiles(id),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists wpp_messages (
  id              uuid primary key default uuid_generate_v4(),
  conversation_id uuid references wpp_conversations(id) on delete cascade,
  direction       text not null check (direction in ('inbound','outbound')),
  body            text,
  media_url       text,
  media_type      text,
  status          text default 'sent' check (status in ('pending','sent','delivered','read','failed')),
  is_auto         boolean default false,
  sent_by         uuid references profiles(id),
  external_id     text,  -- ID da mensagem na Evolution API / Z-API
  created_at      timestamptz default now()
);

-- ── CALENDAR EVENTS ──────────────────────────────────────────
create table if not exists calendar_events (
  id              uuid primary key default uuid_generate_v4(),
  org_id          uuid references organizations(id) on delete cascade,
  deal_id         uuid references deals(id),
  contact_id      uuid references contacts(id),
  owner_id        uuid references profiles(id),
  title           text not null,
  description     text,
  type            text default 'meeting' check (type in ('meeting','call','task','other')),
  start_at        timestamptz not null,
  end_at          timestamptz,
  location        text,
  meet_link       text,
  google_event_id text,   -- ID do evento no Google Calendar (para sync)
  all_day         boolean default false,
  attendees       text[] default '{}',
  status          text default 'scheduled' check (status in ('scheduled','completed','cancelled')),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── AUTOMATIONS ──────────────────────────────────────────────
create table if not exists automations (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid references organizations(id) on delete cascade,
  name        text not null,
  description text,
  is_active   boolean default true,
  trigger_type text not null check (trigger_type in (
                 'lead_created','stage_changed','deal_won','deal_lost',
                 'no_activity','date_condition','form_submit')),
  trigger_config  jsonb default '{}',
  delay_hours     int default 0,
  action_type     text not null check (action_type in (
                    'send_whatsapp','send_email','create_task',
                    'create_event','assign_owner','notify_team','move_stage')),
  action_config   jsonb default '{}',
  run_count       int default 0,
  last_run_at     timestamptz,
  created_by      uuid references profiles(id),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists automation_logs (
  id              uuid primary key default uuid_generate_v4(),
  automation_id   uuid references automations(id) on delete cascade,
  contact_id      uuid references contacts(id),
  deal_id         uuid references deals(id),
  status          text check (status in ('success','failed','skipped')),
  error_message   text,
  executed_at     timestamptz default now()
);

-- ── INTEGRATIONS ─────────────────────────────────────────────
create table if not exists integrations (
  id          uuid primary key default uuid_generate_v4(),
  org_id      uuid references organizations(id) on delete cascade,
  type        text not null check (type in (
                'google_calendar','whatsapp_evolution','whatsapp_zapi',
                'gmail','slack','rd_station','webhook')),
  config      jsonb default '{}',  -- tokens, keys (criptografados)
  is_active   boolean default false,
  last_sync   timestamptz,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ── TAGS ─────────────────────────────────────────────────────
create table if not exists tags (
  id      uuid primary key default uuid_generate_v4(),
  org_id  uuid references organizations(id) on delete cascade,
  name    text not null,
  color   text default '#4a7fd4',
  unique(org_id, name)
);

-- ── INDEXES ──────────────────────────────────────────────────
create index if not exists idx_contacts_org    on contacts(org_id);
create index if not exists idx_contacts_owner  on contacts(owner_id);
create index if not exists idx_contacts_stage  on contacts(stage_id);
create index if not exists idx_deals_org       on deals(org_id);
create index if not exists idx_deals_pipeline  on deals(pipeline_id);
create index if not exists idx_deals_stage     on deals(stage_id);
create index if not exists idx_deals_owner     on deals(owner_id);
create index if not exists idx_deals_status    on deals(status);
create index if not exists idx_activities_deal on activities(deal_id);
create index if not exists idx_activities_contact on activities(contact_id);
create index if not exists idx_wpp_conv_contact on wpp_conversations(contact_id);
create index if not exists idx_wpp_msg_conv    on wpp_messages(conversation_id);
create index if not exists idx_cal_events_org  on calendar_events(org_id);
create index if not exists idx_auto_logs_auto  on automation_logs(automation_id);

-- ── ROW-LEVEL SECURITY ───────────────────────────────────────
alter table organizations        enable row level security;
alter table profiles             enable row level security;
alter table pipelines            enable row level security;
alter table pipeline_stages      enable row level security;
alter table contacts             enable row level security;
alter table deals                enable row level security;
alter table activities           enable row level security;
alter table wpp_conversations    enable row level security;
alter table wpp_messages         enable row level security;
alter table calendar_events      enable row level security;
alter table automations          enable row level security;
alter table automation_logs      enable row level security;
alter table integrations         enable row level security;
alter table tags                 enable row level security;

-- Política: usuários só veem dados da própria org
create or replace function get_user_org_id()
returns uuid language sql security definer as $$
  select org_id from profiles where id = auth.uid() limit 1;
$$;

-- Exemplo de política (repita para todas as tabelas com org_id)
create policy "org_isolation_contacts" on contacts
  using (org_id = get_user_org_id());

create policy "org_isolation_deals" on deals
  using (org_id = get_user_org_id());

create policy "org_isolation_activities" on activities
  using (org_id = get_user_org_id());

create policy "org_isolation_automations" on automations
  using (org_id = get_user_org_id());

create policy "org_isolation_calendar" on calendar_events
  using (org_id = get_user_org_id());

create policy "org_isolation_wpp_conv" on wpp_conversations
  using (org_id = get_user_org_id());

create policy "org_isolation_integrations" on integrations
  using (org_id = get_user_org_id());

-- ── TRIGGERS: updated_at ─────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger trg_organizations_updated  before update on organizations  for each row execute function update_updated_at();
create trigger trg_profiles_updated       before update on profiles        for each row execute function update_updated_at();
create trigger trg_pipelines_updated      before update on pipelines       for each row execute function update_updated_at();
create trigger trg_contacts_updated       before update on contacts        for each row execute function update_updated_at();
create trigger trg_deals_updated          before update on deals           for each row execute function update_updated_at();
create trigger trg_wpp_conv_updated       before update on wpp_conversations for each row execute function update_updated_at();
create trigger trg_calendar_updated       before update on calendar_events for each row execute function update_updated_at();
create trigger trg_automations_updated    before update on automations     for each row execute function update_updated_at();

-- ── SEED: Pipeline padrão ───────────────────────────────────
-- Execute após criar sua org. Substitua 'SEU_ORG_ID' pelo UUID da org.
/*
insert into pipelines (org_id, name, emoji, position) values
  ('SEU_ORG_ID', 'Outbound', '🎯', 0),
  ('SEU_ORG_ID', 'Inbound',  '📥', 1),
  ('SEU_ORG_ID', 'Parceiros','🤝', 2);

insert into pipeline_stages (pipeline_id, name, color, position, default_prob) values
  ((select id from pipelines where name='Outbound' limit 1), 'Prospecção',  '#5e718a', 0, 10),
  ((select id from pipelines where name='Outbound' limit 1), 'Qualificado', '#4a7fd4', 1, 30),
  ((select id from pipelines where name='Outbound' limit 1), 'Proposta',    '#7ab3f0', 2, 55),
  ((select id from pipelines where name='Outbound' limit 1), 'Negociação',  '#f39c12', 3, 75),
  ((select id from pipelines where name='Outbound' limit 1), 'Ganho',       '#2ecc71', 4, 100),
  ((select id from pipelines where name='Outbound' limit 1), 'Perdido',     '#e74c3c', 5, 0);
*/
