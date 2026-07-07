-- ═══════════════════════════════════════════════════════════════
-- VendeAI CRM — FASE 2: Vende.IA, E-mails e Telefonia
-- Execute no Supabase Dashboard → SQL Editor (projeto VendeAi)
-- Seguro para rodar mais de uma vez.
-- ═══════════════════════════════════════════════════════════════

-- Novos tipos de integração (voip para o discador)
alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check check (type in (
  'google_calendar','whatsapp_evolution','whatsapp_zapi',
  'gmail','slack','rd_station','webhook','voip'
));

-- ── E-MAILS ──────────────────────────────────────────────────
create table if not exists emails (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid references organizations(id) on delete cascade,
  contact_id      uuid references contacts(id) on delete set null,
  deal_id         uuid references deals(id) on delete set null,
  owner_id        uuid references profiles(id),
  direction       text not null check (direction in ('inbound','outbound')),
  from_email      text not null,
  to_email        text not null,
  subject         text,
  body            text,
  snippet         text,
  message_id      text,   -- Message-ID do Gmail (dedupe)
  thread_id       text,   -- thread do Gmail (agrupa conversas)
  status          text default 'sent' check (status in ('sent','delivered','failed','received')),
  sent_at         timestamptz default now(),
  created_at      timestamptz default now()
);
create unique index if not exists idx_emails_message_id on emails(org_id, message_id) where message_id is not null;
create index if not exists idx_emails_contact on emails(contact_id);
create index if not exists idx_emails_deal on emails(deal_id);
create index if not exists idx_emails_org on emails(org_id);

-- ── LIGAÇÕES (VoIP + transcrição) ────────────────────────────
create table if not exists calls (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid references organizations(id) on delete cascade,
  contact_id        uuid references contacts(id) on delete set null,
  deal_id           uuid references deals(id) on delete set null,
  owner_id          uuid references profiles(id),
  phone             text not null,
  direction         text default 'outbound' check (direction in ('inbound','outbound')),
  status            text default 'dialing' check (status in ('dialing','in_progress','completed','failed','no_answer','transcribing','transcribed')),
  duration_secs     int,
  provider          text,          -- 'twilio', 'zenvia', etc.
  provider_call_id  text,          -- CallSid / id externo (dedupe do webhook)
  recording_url     text,
  transcript        text,          -- texto gerado pelo speech-to-text
  sentiment_label   text,          -- Positivo / Neutro / Negativo (Vende.IA)
  sentiment_score   int,           -- 0-100
  started_at        timestamptz default now(),
  created_at        timestamptz default now()
);
create index if not exists idx_calls_deal on calls(deal_id);
create index if not exists idx_calls_contact on calls(contact_id);
create index if not exists idx_calls_org on calls(org_id);
create unique index if not exists idx_calls_provider_id on calls(org_id, provider_call_id) where provider_call_id is not null;

-- ── ANÁLISES DO VENDE.IA ─────────────────────────────────────
create table if not exists ai_analyses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references organizations(id) on delete cascade,
  deal_id     uuid references deals(id) on delete cascade,
  contact_id  uuid references contacts(id) on delete set null,
  kind        text default 'deal_analysis' check (kind in ('deal_analysis','wpp_suggestion','email_suggestion')),
  content     jsonb not null,   -- { summary, sentiment, next_steps[], objections[] } ou { suggestions[] }
  model       text,
  created_by  uuid references profiles(id),
  created_at  timestamptz default now()
);
create index if not exists idx_ai_deal on ai_analyses(deal_id, created_at desc);
create index if not exists idx_ai_org on ai_analyses(org_id);

-- ── RLS ──────────────────────────────────────────────────────
alter table emails      enable row level security;
alter table calls       enable row level security;
alter table ai_analyses enable row level security;

drop policy if exists "org_isolation_emails" on emails;
create policy "org_isolation_emails" on emails
  using (org_id = get_user_org_id());

drop policy if exists "org_isolation_calls" on calls;
create policy "org_isolation_calls" on calls
  using (org_id = get_user_org_id());

drop policy if exists "org_isolation_ai" on ai_analyses;
create policy "org_isolation_ai" on ai_analyses
  using (org_id = get_user_org_id());

-- updated_at não é necessário nessas tabelas (são append-only na prática)
