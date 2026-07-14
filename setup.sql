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
  is_active       boolean not null default true,
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

-- ── CUSTOM FIELD DEFS ────────────────────────────────────────
-- Definições de campos personalizados por org. Os VALORES ficam em
-- contacts.custom_fields / deals.custom_fields (jsonb).
create table if not exists custom_field_defs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  entity      text not null default 'contact' check (entity in ('contact','deal')),
  field_key   text not null,   -- chave no jsonb (slug estável)
  label       text not null,
  field_type  text not null default 'text' check (field_type in ('text','number','select','date','boolean')),
  options     jsonb default '[]',  -- para select: ["Opção A","Opção B"]
  position    int default 0,
  is_active   boolean default true,
  created_at  timestamptz default now(),
  unique(org_id, entity, field_key)
);

-- ── PRODUCTS ─────────────────────────────────────────────────
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  price       numeric(15,2) default 0,
  description text,
  is_active   boolean default true,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Negócio pode apontar para um produto/serviço do catálogo
alter table deals add column if not exists product_id uuid references products(id);

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

-- Papel do usuário logado (RLS por papel). security definer para não esbarrar
-- na RLS de profiles nem recursar dentro das próprias policies.
-- Papéis: 'admin' | 'manager' | 'sdr' | 'viewer'. Ver migration
-- 20260712210000_rls_por_papel.sql para a matriz completa.
create or replace function get_user_role()
returns text language sql security definer stable set search_path = public as $$
  select role from profiles where id = auth.uid() limit 1;
$$;

-- ── TABELAS DE NEGÓCIO (owner_id): contacts, deals, activities, calendar_events
-- SELECT: todos os membros. INSERT/UPDATE: todos exceto viewer (somente-leitura
-- nas tabelas de negócio). DELETE: admin/manager OU dono (owner_id = auth.uid()).
create policy "contacts_select" on contacts for select
  using (org_id = get_user_org_id());
create policy "contacts_insert" on contacts for insert
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy "contacts_update" on contacts for update
  using (org_id = get_user_org_id() and get_user_role() <> 'viewer')
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy "contacts_delete" on contacts for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or owner_id = auth.uid()));

create policy "deals_select" on deals for select
  using (org_id = get_user_org_id());
create policy "deals_insert" on deals for insert
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy "deals_update" on deals for update
  using (org_id = get_user_org_id() and get_user_role() <> 'viewer')
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy "deals_delete" on deals for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or owner_id = auth.uid()));

create policy "activities_select" on activities for select
  using (org_id = get_user_org_id());
create policy "activities_insert" on activities for insert
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy "activities_update" on activities for update
  using (org_id = get_user_org_id() and get_user_role() <> 'viewer')
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy "activities_delete" on activities for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or owner_id = auth.uid()));

create policy "calendar_select" on calendar_events for select
  using (org_id = get_user_org_id());
create policy "calendar_insert" on calendar_events for insert
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy "calendar_update" on calendar_events for update
  using (org_id = get_user_org_id() and get_user_role() <> 'viewer')
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy "calendar_delete" on calendar_events for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or owner_id = auth.uid()));

-- automations: estrutura — SELECT todos; escrita só admin/manager.
create policy "automations_select" on automations for select
  using (org_id = get_user_org_id());
create policy "automations_insert" on automations for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "automations_update" on automations for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "automations_delete" on automations for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));

-- wpp_conversations: operacional — todos leem/escrevem; DELETE só admin
-- (botão 🗑️ do whatsapp.html; mensagens caem junto via FK cascade).
create policy "wpp_conv_select" on wpp_conversations for select
  using (org_id = get_user_org_id());
create policy "wpp_conv_insert" on wpp_conversations for insert
  with check (org_id = get_user_org_id());
create policy "wpp_conv_update" on wpp_conversations for update
  using (org_id = get_user_org_id())
  with check (org_id = get_user_org_id());
create policy "wpp_conv_delete" on wpp_conversations for delete
  using (org_id = get_user_org_id() and get_user_role() = 'admin');

-- wpp_messages não tem org_id: isola pela org da conversa-mãe.
create policy "org_isolation_wpp_msg" on wpp_messages
  using (exists (select 1 from wpp_conversations c
                 where c.id = wpp_messages.conversation_id
                   and c.org_id = get_user_org_id()))
  with check (exists (select 1 from wpp_conversations c
                      where c.id = wpp_messages.conversation_id
                        and c.org_id = get_user_org_id()));

-- integrations: SELECT todos (páginas leem status); escrita só admin.
create policy "integrations_select" on integrations for select
  using (org_id = get_user_org_id());
create policy "integrations_insert" on integrations for insert
  with check (org_id = get_user_org_id() and get_user_role() = 'admin');
create policy "integrations_update" on integrations for update
  using (org_id = get_user_org_id() and get_user_role() = 'admin')
  with check (org_id = get_user_org_id() and get_user_role() = 'admin');
create policy "integrations_delete" on integrations for delete
  using (org_id = get_user_org_id() and get_user_role() = 'admin');

-- PROFILES: ver a si mesmo e colegas da org; editar só a própria linha.
-- INSERT NÃO é liberado ao cliente: criar perfil é sempre via
-- bootstrap_org_profile (security definer). O UPDATE é limitado por
-- COLUNA (grants abaixo) para o usuário não conseguir forjar o próprio
-- role/org_id via REST direto — role só muda pela RPC set_member_role.
create policy "profiles_select" on profiles for select
  using (id = auth.uid() or org_id = get_user_org_id());
create policy "profiles_update_own" on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- UPDATE só nas colunas inofensivas; sem INSERT direto pelo cliente.
revoke insert, update on profiles from authenticated;
revoke insert, update on profiles from anon;
grant  update (full_name, phone, avatar_url, settings) on profiles to authenticated;

-- ORGANIZATIONS: todos os membros LEEM; só admin da org faz UPDATE
-- (senão qualquer membro trocaria a senha de export e a metodologia da IA).
create policy "org_select_own" on organizations for select
  using (id = get_user_org_id());
create policy "org_update_admin" on organizations for update
  using (exists (select 1 from profiles p
                 where p.id = auth.uid()
                   and p.org_id = organizations.id
                   and p.role = 'admin'))
  with check (exists (select 1 from profiles p
                      where p.id = auth.uid()
                        and p.org_id = organizations.id
                        and p.role = 'admin'));

-- PIPELINES: estrutura — SELECT todos; INSERT/UPDATE/DELETE só admin/manager.
-- O 1º login NÃO cria pipeline via INSERT direto: usa a RPC
-- ensure_default_pipeline (security definer, definida mais abaixo).
create policy "pipelines_select" on pipelines for select
  using (org_id = get_user_org_id());
create policy "pipelines_insert" on pipelines for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "pipelines_update" on pipelines for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "pipelines_delete" on pipelines for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));

-- PIPELINE STAGES: sem org_id — isola pela org do pipeline-pai. Escrita só
-- admin/manager (via RPC no 1º login).
create policy "stages_select" on pipeline_stages for select
  using (exists (select 1 from pipelines p
                 where p.id = pipeline_stages.pipeline_id
                   and p.org_id = get_user_org_id()));
create policy "stages_insert" on pipeline_stages for insert
  with check (get_user_role() in ('admin','manager')
              and exists (select 1 from pipelines p
                          where p.id = pipeline_stages.pipeline_id
                            and p.org_id = get_user_org_id()));
create policy "stages_update" on pipeline_stages for update
  using (get_user_role() in ('admin','manager')
         and exists (select 1 from pipelines p
                     where p.id = pipeline_stages.pipeline_id
                       and p.org_id = get_user_org_id()))
  with check (get_user_role() in ('admin','manager')
              and exists (select 1 from pipelines p
                          where p.id = pipeline_stages.pipeline_id
                            and p.org_id = get_user_org_id()));
create policy "stages_delete" on pipeline_stages for delete
  using (get_user_role() in ('admin','manager')
         and exists (select 1 from pipelines p
                     where p.id = pipeline_stages.pipeline_id
                       and p.org_id = get_user_org_id()));

-- TAGS: estrutura — SELECT todos; escrita só admin/manager.
create policy "tags_select" on tags for select
  using (org_id = get_user_org_id());
create policy "tags_insert" on tags for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "tags_update" on tags for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "tags_delete" on tags for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));

-- CUSTOM FIELD DEFS + PRODUCTS: estrutura — SELECT todos; escrita admin/manager.
alter table custom_field_defs enable row level security;
alter table products          enable row level security;
create policy "cfd_select" on custom_field_defs for select
  using (org_id = get_user_org_id());
create policy "cfd_insert" on custom_field_defs for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "cfd_update" on custom_field_defs for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "cfd_delete" on custom_field_defs for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "products_select" on products for select
  using (org_id = get_user_org_id());
create policy "products_insert" on products for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "products_update" on products for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy "products_delete" on products for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create trigger trg_products_updated before update on products
  for each row execute function update_updated_at();

-- RPC: pipeline padrão no 1º login (substitui o INSERT direto do frontend).
-- security definer: cria Outbound + 6 etapas sem exigir INSERT em
-- pipelines/pipeline_stages. Só age na própria org e se não houver pipeline.
create or replace function ensure_default_pipeline(p_org uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_pipe  uuid;
  v_owner uuid := auth.uid();
begin
  if p_org is null or p_org <> get_user_org_id() then
    return null;
  end if;
  select id into v_pipe from pipelines where org_id = p_org limit 1;
  if found then
    return v_pipe;
  end if;
  insert into pipelines (org_id, name, emoji, position, created_by)
    values (p_org, 'Outbound', '🎯', 0, v_owner)
    returning id into v_pipe;
  insert into pipeline_stages (pipeline_id, name, color, position, default_prob, is_won, is_lost) values
    (v_pipe, 'Prospecção',  '#5e718a', 0, 10,  false, false),
    (v_pipe, 'Qualificado', '#4a7fd4', 1, 30,  false, false),
    (v_pipe, 'Proposta',    '#7ab3f0', 2, 55,  false, false),
    (v_pipe, 'Negociação',  '#f39c12', 3, 75,  false, false),
    (v_pipe, 'Ganho',       '#2ecc71', 4, 100, true,  false),
    (v_pipe, 'Perdido',     '#e74c3c', 5, 0,   false, true);
  return v_pipe;
end;
$$;
grant execute on function ensure_default_pipeline(uuid) to authenticated;

-- AUTOMATION LOGS: isola pela automação-pai
create policy "org_isolation_auto_logs" on automation_logs
  using (exists (select 1 from automations a
                 where a.id = automation_logs.automation_id
                   and a.org_id = get_user_org_id()));

-- BOOTSTRAP ATÔMICO: cria org + perfil admin no primeiro login.
-- security definer para não esbarrar na RLS durante o INSERT..RETURNING.
create or replace function bootstrap_org_profile(
  p_org_name text, p_slug text, p_full_name text, p_email text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_existing uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select org_id into v_existing from profiles where id = auth.uid();
  if v_existing is not null then
    return v_existing;
  end if;
  insert into organizations (name, slug) values (p_org_name, p_slug)
    returning id into v_org;
  insert into profiles (id, org_id, email, full_name, role)
    values (auth.uid(), v_org, p_email, p_full_name, 'admin')
  on conflict (id) do update
    set org_id = excluded.org_id, role = 'admin',
        email = excluded.email,
        full_name = coalesce(profiles.full_name, excluded.full_name);
  return v_org;
end $$;
revoke execute on function bootstrap_org_profile(text,text,text,text) from anon, public;
grant execute on function bootstrap_org_profile(text,text,text,text) to authenticated;

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

-- ═══════════════════════════════════════════════════════════════
-- AUTOMAÇÕES V2 — fluxos visuais + fila de execução (jul/2026)
-- (idempotente; espelha a migration 20260708150000_automacoes_v2)
-- ═══════════════════════════════════════════════════════════════
alter table automations add column if not exists kind text not null default 'simple';
alter table automations drop constraint if exists automations_kind_check;
alter table automations add constraint automations_kind_check check (kind in ('simple','flow'));
alter table automations add column if not exists graph jsonb;
alter table automation_logs add column if not exists action_type text;
alter table automation_logs add column if not exists meta jsonb default '{}';

create table if not exists automation_runs (
  id            uuid primary key default uuid_generate_v4(),
  automation_id uuid not null references automations(id) on delete cascade,
  org_id        uuid not null references organizations(id) on delete cascade,
  contact_id    uuid references contacts(id) on delete cascade,
  deal_id       uuid references deals(id) on delete cascade,
  dedupe_key    text not null,
  current_node  text,
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
create policy org_isolation_auto_runs on automation_runs using (org_id = get_user_org_id());

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

-- Worker: agendar via pg_cron + pg_net chamando a Edge Function
-- automations-run a cada 5 min com o header x-worker-key igual ao
-- secret AUTOMATIONS_WORKER_KEY (ver migration 20260708150000).

-- ═══════════════════════════════════════════════════════════════
-- AUDITORIA + AUTORIZAÇÃO DE EXPORTAÇÃO (08/jul/2026)
-- Conteúdo completo em supabase/migrations/20260708160000_auditoria_export_auth.sql
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ── TABELA ───────────────────────────────────────────────────
create table if not exists audit_logs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid,                -- null = ação do sistema (webhook/sync)
  user_email  text,
  action      text not null,       -- insert|update|delete|export|import|export_negado|import_negado|senha_export_definida|senha_export_removida
  entity      text not null,       -- tabela ou recurso (contacts, deals, contatos_excel, whatsapp_historico…)
  entity_id   uuid,
  details     jsonb default '{}',  -- diff campo a campo (update) ou snapshot (insert/delete)
  created_at  timestamptz default now()
);
create index if not exists idx_audit_org_time on audit_logs(org_id, created_at desc);
create index if not exists idx_audit_user on audit_logs(user_id);

alter table audit_logs enable row level security;

-- Só administradores da org leem a trilha. SEM policies de
-- insert/update/delete: escrita apenas via funções security definer,
-- e ninguém (nem admin) altera ou apaga registros pelo frontend.
drop policy if exists audit_admin_select on audit_logs;
create policy audit_admin_select on audit_logs for select
  using (
    org_id = get_user_org_id()
    and exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- ── TRIGGER GENÉRICO DE AUDITORIA ────────────────────────────
-- AFTER trigger, security definer (grava mesmo sem policy de insert).
-- Nunca derruba a operação principal: erro vira warning.
create or replace function fn_audit_row() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  rec       jsonb;
  oldrec    jsonb;
  v_org     uuid;
  v_details jsonb;
  v_email   text;
begin
  begin
    rec    := case when TG_OP = 'DELETE' then to_jsonb(OLD) else to_jsonb(NEW) end;
    oldrec := case when TG_OP = 'UPDATE' then to_jsonb(OLD) else null end;

    -- resolve a org do registro
    v_org := nullif(rec->>'org_id','')::uuid;
    if v_org is null and TG_TABLE_NAME = 'organizations' then
      v_org := nullif(rec->>'id','')::uuid;
    end if;
    if v_org is null and TG_TABLE_NAME = 'pipeline_stages' then
      select p.org_id into v_org from pipelines p
       where p.id = nullif(rec->>'pipeline_id','')::uuid;
    end if;
    if v_org is null then v_org := get_user_org_id(); end if;
    if v_org is null then return null; end if;

    -- sync do Google Agenda (service role) geraria dezenas de linhas por clique — pula
    if auth.uid() is null and TG_TABLE_NAME = 'calendar_events' then return null; end if;

    if TG_OP = 'UPDATE' then
      -- só os campos que mudaram, no formato {campo: {de, para}};
      -- settings/config podem conter segredos (hash da senha, tokens) → redigidos
      select jsonb_object_agg(t.k, jsonb_build_object(
               'de',   case when t.k in ('settings','config') then to_jsonb('«oculto»'::text)   else oldrec->t.k end,
               'para', case when t.k in ('settings','config') then to_jsonb('«alterado»'::text) else rec->t.k    end))
        into v_details
        from jsonb_object_keys(rec) as t(k)
       where rec->t.k is distinct from oldrec->t.k
         and t.k <> 'updated_at';
      if v_details is null then return null; end if;   -- nada relevante mudou
    else
      v_details := jsonb_strip_nulls(rec) - 'settings' - 'config';
    end if;

    if auth.uid() is not null then
      select email into v_email from profiles where id = auth.uid();
    end if;

    insert into audit_logs (org_id, user_id, user_email, action, entity, entity_id, details)
    values (v_org, auth.uid(), coalesce(v_email, 'sistema'),
            lower(TG_OP), TG_TABLE_NAME, nullif(rec->>'id','')::uuid, v_details);
  exception when others then
    raise warning 'fn_audit_row falhou em %: %', TG_TABLE_NAME, sqlerrm;
  end;
  return null;
end $$;

-- Aplica nas tabelas de negócio (wpp_* e emails/calls ficam de fora — volume alto,
-- já são rastreadas por conversa; activities é o próprio log de negócio)
do $$
declare t text;
begin
  foreach t in array array[
    'contacts','deals','pipelines','pipeline_stages','products',
    'custom_field_defs','automations','calendar_events',
    'organizations','profiles','integrations','tags'
  ] loop
    execute format('drop trigger if exists trg_audit on %I', t);
    execute format('create trigger trg_audit after insert or update or delete on %I
                    for each row execute function fn_audit_row()', t);
  end loop;
end $$;

-- Exceção pontual: apagar conversa do WhatsApp é raro e destrutivo,
-- então o DELETE entra na auditoria (INSERT/UPDATE de wpp_* seguem
-- fora por volume). Espelha 20260713010000_wpp_apagar_conversa_admin.sql.
drop trigger if exists trg_audit_delete on wpp_conversations;
create trigger trg_audit_delete after delete on wpp_conversations
  for each row execute function fn_audit_row();

-- ── SENHA DE AUTORIZAÇÃO (definida pelo admin) ───────────────
create or replace function set_export_password(p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_prof profiles%rowtype;
begin
  select * into v_prof from profiles where id = auth.uid();
  if v_prof.role is distinct from 'admin' then
    raise exception 'Apenas administradores podem definir a senha de autorização';
  end if;

  update organizations set settings = case
      when p_password is null or length(trim(p_password)) = 0
        then coalesce(settings, '{}'::jsonb) - 'export_pass_hash'
      else jsonb_set(coalesce(settings, '{}'::jsonb), '{export_pass_hash}',
                     to_jsonb(crypt(p_password, gen_salt('bf'))))
    end
  where id = v_prof.org_id;

  insert into audit_logs (org_id, user_id, user_email, action, entity)
  values (v_prof.org_id, v_prof.id, v_prof.email,
          case when p_password is null or length(trim(p_password)) = 0
               then 'senha_export_removida' else 'senha_export_definida' end,
          'organizations');
end $$;

-- ── AUTORIZAÇÃO DE EXPORTAÇÃO/IMPORTAÇÃO ─────────────────────
-- Chamada pelo frontend antes de qualquer extração de dados.
-- Admin → autorizado direto. Demais perfis → senha obrigatória
-- (sem senha definida, só admin exporta). Sempre registra.
create or replace function authorize_export(p_action text, p_resource text, p_password text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_prof   profiles%rowtype;
  v_hash   text;
  v_ok     boolean := false;
  v_reason text;
begin
  select * into v_prof from profiles where id = auth.uid();
  if v_prof.id is null or v_prof.org_id is null then
    return jsonb_build_object('ok', false, 'reason', 'Sessão inválida.');
  end if;
  if p_action not in ('export','import') then
    return jsonb_build_object('ok', false, 'reason', 'Ação inválida.');
  end if;

  if v_prof.role = 'admin' then
    v_ok := true;
  else
    select settings->>'export_pass_hash' into v_hash
      from organizations where id = v_prof.org_id;
    if v_hash is null then
      v_reason := 'Somente administradores podem exportar/importar dados. O admin pode liberar definindo uma senha de autorização em Configurações → Auditoria.';
    elsif p_password is not null and crypt(p_password, v_hash) = v_hash then
      v_ok := true;
    else
      v_reason := 'Senha de autorização incorreta.';
      perform pg_sleep(0.5);   -- freia tentativa de força bruta
    end if;
  end if;

  insert into audit_logs (org_id, user_id, user_email, action, entity, details)
  values (v_prof.org_id, v_prof.id, v_prof.email,
          case when v_ok then p_action else p_action || '_negado' end,
          p_resource,
          jsonb_build_object('autorizado', v_ok)
            || coalesce(jsonb_build_object('motivo', v_reason), '{}'::jsonb));

  return jsonb_build_object('ok', v_ok, 'reason', v_reason);
end $$;

-- ── VERIFICAÇÃO PELO SERVIDOR (Edge Functions) ───────────────
-- Usada pela wpp-import via service role. Bloqueada para o frontend
-- (senão daria para testar senhas sem deixar rastro na trilha).
create or replace function verify_export_password(p_org uuid, p_password text)
returns boolean language sql security definer set search_path = public, extensions as $$
  select coalesce(
    crypt(p_password, o.settings->>'export_pass_hash') = o.settings->>'export_pass_hash',
    false)
  from organizations o where o.id = p_org
$$;
revoke all on function verify_export_password(uuid, text) from public;
revoke all on function verify_export_password(uuid, text) from anon;
revoke all on function verify_export_password(uuid, text) from authenticated;
grant execute on function verify_export_password(uuid, text) to service_role;

revoke all on function set_export_password(text) from anon;
revoke all on function authorize_export(text, text, text) from anon;

-- ── PAPÉIS: admin muda o role de um colega da mesma org ──────────
-- Única via para alterar profiles.role (o UPDATE por coluna do cliente
-- não alcança a coluna role). Security definer: roda como owner e
-- contorna os grants por coluna / RLS. Valida admin, org, papel e
-- impede o último admin da org de se rebaixar. Grava em audit_logs.
create or replace function set_member_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller profiles%rowtype;
  v_target profiles%rowtype;
  v_admins int;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role is distinct from 'admin' then
    raise exception 'Apenas administradores podem alterar papéis.';
  end if;

  if p_role not in ('admin','manager','sdr','viewer') then
    raise exception 'Papel inválido: %', p_role;
  end if;

  select * into v_target from profiles where id = p_user;
  if v_target.id is null or v_target.org_id is distinct from v_caller.org_id then
    raise exception 'Usuário não encontrado na sua organização.';
  end if;

  -- impede o último admin da org de se rebaixar (deixaria a org sem admin)
  if v_target.id = v_caller.id and p_role is distinct from 'admin' then
    select count(*) into v_admins from profiles
     where org_id = v_caller.org_id and role = 'admin';
    if v_admins <= 1 then
      raise exception 'Você é o único admin da organização — promova outro antes de rebaixar a si mesmo.';
    end if;
  end if;

  update profiles set role = p_role where id = p_user;

  insert into audit_logs (org_id, user_id, user_email, action, entity, entity_id, details)
  values (v_caller.org_id, v_caller.id, v_caller.email,
          'papel_alterado', 'profiles', p_user,
          jsonb_build_object('de', v_target.role, 'para', p_role,
                             'alvo_email', v_target.email));
end $$;
revoke all on function set_member_role(uuid, text) from public;
revoke all on function set_member_role(uuid, text) from anon;
grant execute on function set_member_role(uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════
-- INTELIGÊNCIA ATIVA (jul/2026) — espelha a migration
-- 20260712150000_inteligencia_ativa.sql: interações coladas/upload
-- por deal + análises A.C.O.R.D.O. com tarefas sugeridas pela IA.
-- Tarefas aceitas viram activities (meta.origem='ia').
-- ═══════════════════════════════════════════════════════════════
-- ── INTERAÇÕES (colagem/upload manual de transcrições e textos) ──
create table if not exists interacoes (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  deal_id        uuid not null references deals(id) on delete cascade,
  contact_id     uuid references contacts(id) on delete set null,
  tipo           text not null check (tipo in ('call','email','mensagem')),
  conteudo       text not null,
  data_interacao timestamptz not null default now(),
  analisada      boolean default false,
  analise_id     uuid,   -- FK adicionada após criar analises (referência circular)
  created_by     uuid references profiles(id),
  criado_em      timestamptz default now()
);

-- ── ANÁLISES (output estruturado do framework A.C.O.R.D.O.) ──
create table if not exists analises (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id) on delete cascade,
  interacao_id            uuid references interacoes(id) on delete cascade,
  deal_id                 uuid not null references deals(id) on delete cascade,
  scores                  jsonb not null default '{}',  -- {acesso,clareza_dor,orcamento,roi,decisao,proximo_passo} 0-10
  letra_travada           text,
  resumo                  text,
  compromissos            jsonb default '[]',  -- [{quem,o_que,quando}]
  oportunidades_perdidas  jsonb default '[]',
  sinais_risco            jsonb default '[]',
  -- [{tipo,titulo,justificativa,prazo_dias,prazo_data,prioridade,status}]
  -- status: sugerida | aceita | editada | descartada (descartes ficam
  -- registrados para melhoria futura dos prompts)
  tarefas_sugeridas       jsonb default '[]',
  modelo                  text,
  criado_em               timestamptz default now()
);

alter table interacoes drop constraint if exists fk_interacoes_analise;
alter table interacoes add constraint fk_interacoes_analise
  foreign key (analise_id) references analises(id) on delete set null;

create index if not exists idx_interacoes_deal on interacoes(deal_id, data_interacao desc);
create index if not exists idx_analises_deal on analises(deal_id, criado_em desc);

alter table interacoes enable row level security;
alter table analises   enable row level security;
-- interacoes: SELECT/INSERT/UPDATE todos; DELETE admin/manager OU autor.
drop policy if exists org_isolation_interacoes on interacoes;
create policy interacoes_select on interacoes for select
  using (org_id = get_user_org_id());
create policy interacoes_insert on interacoes for insert
  with check (org_id = get_user_org_id());
create policy interacoes_update on interacoes for update
  using (org_id = get_user_org_id())
  with check (org_id = get_user_org_id());
create policy interacoes_delete on interacoes for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or created_by = auth.uid()));
drop policy if exists org_isolation_analises on analises;
create policy org_isolation_analises on analises using (org_id = get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- WHATSAPP NOMES + EDITAR/APAGAR (jul/2026) — espelha a migration
-- 20260712180000_wpp_nomes_editar_apagar.sql
-- ═══════════════════════════════════════════════════════════════
-- Nome exibido da conversa (pushName do WhatsApp) — usado quando a
-- conversa não está vinculada a um contato do CRM.
alter table wpp_conversations add column if not exists display_name text;

-- Marcações de edição/remoção de mensagens (a linha é preservada)
alter table wpp_messages add column if not exists edited_at  timestamptz;
alter table wpp_messages add column if not exists deleted_at timestamptz;

-- ── RPC: encontra contato pelo telefone, ignorando formatação ──
-- O WhatsApp usa "5511999998888"; contatos do CRM costumam ter
-- "(11) 99999-8888". Compara os últimos 8 dígitos (linha) e valida
-- que os DDDs não conflitam quando ambos existem.
create or replace function wpp_match_contact(p_org uuid, p_phone text)
returns uuid
language sql security definer stable as $$
  select c.id
  from contacts c
  where c.org_id = p_org
    and (
      right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 8)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 8)
      or right(regexp_replace(coalesce(c.whatsapp, ''), '\D', '', 'g'), 8)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 8)
    )
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 8
  order by (c.phone is not null) desc, c.created_at
  limit 1
$$;

-- ═══════════════════════════════════════════════════════════════
-- SERVICE HEALTH — vigilância da Evolution API (jul/2026) — espelha
-- a migration 20260712190000_service_health.sql
-- ═══════════════════════════════════════════════════════════════
-- Trilha global (não por-org) da saúde do WhatsApp. Só STATUS, nada
-- sensível. Checada a cada 5 min pela Edge Function wpp-health.
create table if not exists service_health (
  id          uuid primary key default gen_random_uuid(),
  service     text not null,
  status      text not null check (status in ('ok','down')),
  detail      text,
  latency_ms  integer,
  checked_at  timestamptz not null default now()
);
create index if not exists idx_service_health_latest
  on service_health(service, checked_at desc);

-- SELECT liberado a authenticated (status não é sensível). Escrita só
-- via service role (wpp-health) — sem policies de insert/update/delete.
alter table service_health enable row level security;
drop policy if exists service_health_read on service_health;
create policy service_health_read on service_health
  for select to authenticated using (true);

-- Job pg_cron a cada 5 min chamando wpp-health (padrão do
-- vendeai-automations-worker: header x-worker-key = AUTOMATIONS_WORKER_KEY).
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

-- ═══════════════════════════════════════════════════════════════
-- QUOTA DE IA POR ORGANIZAÇÃO (jul/2026) — espelha a migration
-- 20260712200000_ai_usage_quota.sql
-- ═══════════════════════════════════════════════════════════════
-- Trilha de consumo de IA (uma linha por chamada). Limite mensal por
-- contagem de linhas, lido de organizations.settings.ai_quota_monthly
-- (default 200). Checagem no helper checkAiQuota() e gravação no
-- askClaude() em supabase/functions/_shared/base.ts.
create table if not exists ai_usage (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  function_name text not null,
  model         text,
  input_tokens  integer default 0,
  output_tokens integer default 0,
  created_at    timestamptz not null default now()
);
create index if not exists idx_ai_usage_org_month on ai_usage(org_id, created_at desc);

-- SELECT para membros da org; escrita só via service role (sem policy de
-- insert/update/delete — as Edge Functions escrevem via admin()).
alter table ai_usage enable row level security;
drop policy if exists org_isolation_ai_usage_read on ai_usage;
create policy org_isolation_ai_usage_read on ai_usage
  for select using (org_id = get_user_org_id());

-- ═══════════════════════════════════════════════════════════════
-- EQUIPE REAL COM CONVITES (12/jul/2026) — espelha a migration
-- 20260712220000_equipe_convites.sql: org_invites + is_active +
-- RPCs create_invite / get_invite_info / accept_invite /
-- find_pending_invite_for_me / set_member_active.
-- ═══════════════════════════════════════════════════════════════
alter table profiles add column if not exists is_active boolean not null default true;

create table if not exists org_invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  email       text not null,
  role        text not null default 'sdr' check (role in ('admin','manager','sdr','viewer')),
  token       text not null unique,
  invited_by  uuid references profiles(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  revoked_at  timestamptz
);
create index if not exists idx_org_invites_org   on org_invites(org_id);
create index if not exists idx_org_invites_email on org_invites(lower(email));

alter table org_invites enable row level security;
-- Só o admin da org lê/gere convites; o convidado NUNCA lê a tabela (aceite
-- via RPC accept_invite, security definer).
drop policy if exists invites_admin_select on org_invites;
create policy invites_admin_select on org_invites for select
  using (org_id = get_user_org_id()
         and exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));
drop policy if exists invites_admin_insert on org_invites;
create policy invites_admin_insert on org_invites for insert
  with check (org_id = get_user_org_id()
              and exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));
drop policy if exists invites_admin_update on org_invites;
create policy invites_admin_update on org_invites for update
  using (org_id = get_user_org_id()
         and exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (org_id = get_user_org_id()
              and exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));

create or replace function gen_invite_token()
returns text language sql volatile set search_path = public, extensions as $$
  select translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
$$;

create or replace function create_invite(p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_caller profiles%rowtype;
  v_token  text;
  v_id     uuid;
  v_org    text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role is distinct from 'admin' then
    raise exception 'Apenas administradores podem convidar membros.';
  end if;
  if p_role not in ('admin','manager','sdr','viewer') then
    raise exception 'Papel inválido: %', p_role;
  end if;
  if p_email is null or position('@' in p_email) = 0 then
    raise exception 'E-mail inválido.';
  end if;
  if exists (select 1 from profiles
             where org_id = v_caller.org_id and lower(email) = lower(p_email)) then
    raise exception 'Esse e-mail já pertence a um membro da equipe.';
  end if;
  update org_invites set revoked_at = now()
   where org_id = v_caller.org_id and lower(email) = lower(p_email)
     and accepted_at is null and revoked_at is null and expires_at > now();
  v_token := gen_invite_token();
  insert into org_invites (org_id, email, role, token, invited_by)
    values (v_caller.org_id, lower(p_email), p_role, v_token, v_caller.id)
    returning id into v_id;
  select name into v_org from organizations where id = v_caller.org_id;
  insert into audit_logs (org_id, user_id, user_email, action, entity, entity_id, details)
    values (v_caller.org_id, v_caller.id, v_caller.email, 'convite_criado',
            'org_invites', v_id, jsonb_build_object('email', lower(p_email), 'role', p_role));
  return jsonb_build_object('ok', true, 'invite_id', v_id, 'token', v_token,
                            'org_name', v_org, 'role', p_role, 'email', lower(p_email));
end $$;
revoke all on function create_invite(text, text) from anon, public;
grant execute on function create_invite(text, text) to authenticated;

create or replace function get_invite_info(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_inv    org_invites%rowtype;
  v_org    text;
  v_masked text;
begin
  select * into v_inv from org_invites where token = p_token;
  if v_inv.id is null then
    return jsonb_build_object('ok', false, 'reason', 'Convite não encontrado.');
  end if;
  select name into v_org from organizations where id = v_inv.org_id;
  v_masked := regexp_replace(v_inv.email, '^(.).*(@.*)$', '\1***\2');
  if v_inv.accepted_at is not null then
    return jsonb_build_object('ok', false, 'org_name', v_org, 'reason', 'Convite já utilizado.');
  elsif v_inv.revoked_at is not null then
    return jsonb_build_object('ok', false, 'org_name', v_org, 'reason', 'Convite revogado.');
  elsif v_inv.expires_at <= now() then
    return jsonb_build_object('ok', false, 'org_name', v_org, 'reason', 'Convite expirado.');
  end if;
  return jsonb_build_object('ok', true, 'org_name', v_org,
                            'email_mask', v_masked, 'role', v_inv.role);
end $$;
grant execute on function get_invite_info(text) to anon, authenticated;

create or replace function accept_invite(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_inv   org_invites%rowtype;
  v_uid   uuid := auth.uid();
  v_email text;
  v_org   text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'Não autenticado.'); end if;
  select * into v_inv from org_invites where token = p_token;
  if v_inv.id is null      then return jsonb_build_object('ok', false, 'reason', 'Convite não encontrado.'); end if;
  if v_inv.accepted_at is not null then return jsonb_build_object('ok', false, 'reason', 'Convite já utilizado.'); end if;
  if v_inv.revoked_at  is not null then return jsonb_build_object('ok', false, 'reason', 'Convite revogado.'); end if;
  if v_inv.expires_at  <= now()    then return jsonb_build_object('ok', false, 'reason', 'Convite expirado.'); end if;
  select email into v_email from auth.users where id = v_uid;
  if v_email is null or lower(v_email) is distinct from lower(v_inv.email) then
    return jsonb_build_object('ok', false,
      'reason', 'Este convite foi enviado para outro e-mail. Entre com o e-mail do convite.');
  end if;
  insert into profiles (id, org_id, email, full_name, role, is_active)
    values (v_uid, v_inv.org_id, lower(v_email), split_part(v_email, '@', 1), v_inv.role, true)
  on conflict (id) do update
    set org_id = v_inv.org_id, role = v_inv.role, is_active = true,
        email = coalesce(profiles.email, excluded.email),
        full_name = coalesce(profiles.full_name, excluded.full_name);
  update org_invites set accepted_at = now() where id = v_inv.id;
  select name into v_org from organizations where id = v_inv.org_id;
  insert into audit_logs (org_id, user_id, user_email, action, entity, entity_id, details)
    values (v_inv.org_id, v_uid, lower(v_email), 'convite_aceito',
            'org_invites', v_inv.id, jsonb_build_object('role', v_inv.role));
  return jsonb_build_object('ok', true, 'org_name', v_org, 'org_id', v_inv.org_id, 'role', v_inv.role);
end $$;
grant execute on function accept_invite(text) to authenticated;

create or replace function find_pending_invite_for_me()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_email text; v_token text;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false); end if;
  select email into v_email from auth.users where id = auth.uid();
  if v_email is null then return jsonb_build_object('ok', false); end if;
  select token into v_token from org_invites
   where lower(email) = lower(v_email)
     and accepted_at is null and revoked_at is null and expires_at > now()
   order by created_at desc limit 1;
  if v_token is null then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'token', v_token);
end $$;
grant execute on function find_pending_invite_for_me() to authenticated;

create or replace function set_member_active(p_user uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_caller profiles%rowtype;
  v_target profiles%rowtype;
  v_admins int;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_caller from profiles where id = auth.uid();
  if v_caller.id is null or v_caller.role is distinct from 'admin' then
    raise exception 'Apenas administradores podem ativar/desativar membros.';
  end if;
  select * into v_target from profiles where id = p_user;
  if v_target.id is null or v_target.org_id is distinct from v_caller.org_id then
    raise exception 'Usuário não encontrado na sua organização.';
  end if;
  if p_active = false and v_target.role = 'admin' then
    select count(*) into v_admins from profiles
     where org_id = v_caller.org_id and role = 'admin' and is_active = true and id <> p_user;
    if v_admins < 1 then
      raise exception 'Não é possível desativar o último administrador ativo da organização.';
    end if;
  end if;
  update profiles set is_active = p_active where id = p_user;
  insert into audit_logs (org_id, user_id, user_email, action, entity, entity_id, details)
    values (v_caller.org_id, v_caller.id, v_caller.email,
            case when p_active then 'membro_reativado' else 'membro_desativado' end,
            'profiles', p_user, jsonb_build_object('alvo_email', v_target.email));
end $$;
revoke all on function set_member_active(uuid, boolean) from anon, public;
grant execute on function set_member_active(uuid, boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════
-- DEAL FILES — anexos por negócio (jul/2026) — espelha a migration
-- 20260713000000_deal_files.sql
-- ═══════════════════════════════════════════════════════════════
-- Aba "Arquivos" do painel de deal: upload real no bucket privado
-- 'deal-files' (caminho org_id/deal_id/arquivo) + metadados aqui.

create table if not exists deal_files (
  id            uuid primary key default uuid_generate_v4(),
  org_id        uuid references organizations(id) on delete cascade,
  deal_id       uuid references deals(id) on delete cascade,
  uploaded_by   uuid references profiles(id),
  name          text not null,
  storage_path  text not null,
  size_bytes    bigint,
  mime_type     text,
  created_at    timestamptz default now()
);

create index if not exists idx_deal_files_deal on deal_files(deal_id);

alter table deal_files enable row level security;

drop policy if exists "deal_files_select" on deal_files;
create policy "deal_files_select" on deal_files for select
  using (org_id = get_user_org_id());
drop policy if exists "deal_files_insert" on deal_files;
create policy "deal_files_insert" on deal_files for insert
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
drop policy if exists "deal_files_delete" on deal_files;
create policy "deal_files_delete" on deal_files for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or uploaded_by = auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit)
values ('deal-files', 'deal-files', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "deal_files_storage_select" on storage.objects;
create policy "deal_files_storage_select" on storage.objects for select
  to authenticated
  using (bucket_id = 'deal-files'
         and (storage.foldername(name))[1] = get_user_org_id()::text);
drop policy if exists "deal_files_storage_insert" on storage.objects;
create policy "deal_files_storage_insert" on storage.objects for insert
  to authenticated
  with check (bucket_id = 'deal-files'
              and (storage.foldername(name))[1] = get_user_org_id()::text
              and get_user_role() <> 'viewer');
drop policy if exists "deal_files_storage_delete" on storage.objects;
create policy "deal_files_storage_delete" on storage.objects for delete
  to authenticated
  using (bucket_id = 'deal-files'
         and (storage.foldername(name))[1] = get_user_org_id()::text
         and (get_user_role() in ('admin','manager') or owner = auth.uid()));

-- ══ Realtime no chat do WhatsApp (14/jul/2026) ══
-- Sem isso o whatsapp.html só atualiza no reload — mensagem recebida fica
-- invisível. A RLS continua valendo no Realtime (só entrega linha que a
-- policy de SELECT do assinante permitir).
do $$ begin
  alter publication supabase_realtime add table public.wpp_messages;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.wpp_conversations;
exception when duplicate_object then null; end $$;
