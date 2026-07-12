-- ═══════════════════════════════════════════════════════════════
-- INTELIGÊNCIA ATIVA — captura de interações + análise A.C.O.R.D.O.
-- A IA analisa calls/e-mails/mensagens e sugere tarefas com
-- justificativa. Tarefas aceitas viram registros em activities
-- (meta.origem='ia') — sem tabela paralela de tarefas.
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
drop policy if exists org_isolation_interacoes on interacoes;
create policy org_isolation_interacoes on interacoes using (org_id = get_user_org_id());
drop policy if exists org_isolation_analises on analises;
create policy org_isolation_analises on analises using (org_id = get_user_org_id());
