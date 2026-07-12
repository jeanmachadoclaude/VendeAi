-- ============================================================================
-- RLS POR PAPEL (role) — Prompt 6
-- ============================================================================
-- Até aqui quase todas as tabelas tinham UMA policy "org_isolation" FOR ALL,
-- só isolando por org_id. Resultado: um SDR podia, via REST (PostgREST),
-- deletar TODOS os negócios/contatos/pipelines da org. Aqui trocamos essas
-- policies FOR ALL por policies separadas por comando, mantendo SEMPRE o
-- filtro org_id = get_user_org_id() e acrescentando a matriz de papéis.
--
-- Papéis (profiles.role): 'admin' | 'manager' | 'sdr' | 'viewer'.
--   - viewer  = somente-leitura nas tabelas de negócio (contacts, deals,
--               activities, calendar_events). Nas demais tabelas comporta-se
--               como sdr (que já não pode escrever nas tabelas admin-only).
--   - sdr     = cria/edita negócio; só apaga o próprio; não mexe em
--               pipelines/produtos/campos/tags/automações/integrações.
--   - manager = como admin nas tabelas de negócio + estrutura (pipelines,
--               produtos, campos, tags, automações), mas NÃO em integrações.
--   - admin   = tudo.
--
-- NÃO mexe em: analises, automation_runs, automation_logs, ai_usage,
--   service_health, audit_logs, wpp_messages (têm desenho próprio).
-- profiles/organizations já foram tratadas no prompt anterior — não refeito.
-- ============================================================================

-- Helper estável: papel do usuário logado. security definer para não esbarrar
-- na RLS de profiles nem recursar dentro das próprias policies.
create or replace function get_user_role()
returns text language sql security definer stable set search_path = public as $$
  select role from profiles where id = auth.uid() limit 1;
$$;

-- ── TABELAS DE NEGÓCIO (coluna de dono = owner_id) ──────────────────────────
-- contacts, deals, activities, calendar_events:
--   SELECT: todos os membros.
--   INSERT/UPDATE: todos os membros exceto viewer.
--   DELETE: admin/manager OU dono (owner_id = auth.uid()).

-- contacts
drop policy if exists org_isolation_contacts on contacts;
create policy contacts_select on contacts for select
  using (org_id = get_user_org_id());
create policy contacts_insert on contacts for insert
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy contacts_update on contacts for update
  using (org_id = get_user_org_id() and get_user_role() <> 'viewer')
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy contacts_delete on contacts for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or owner_id = auth.uid()));

-- deals
drop policy if exists org_isolation_deals on deals;
create policy deals_select on deals for select
  using (org_id = get_user_org_id());
create policy deals_insert on deals for insert
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy deals_update on deals for update
  using (org_id = get_user_org_id() and get_user_role() <> 'viewer')
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy deals_delete on deals for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or owner_id = auth.uid()));

-- activities
drop policy if exists org_isolation_activities on activities;
create policy activities_select on activities for select
  using (org_id = get_user_org_id());
create policy activities_insert on activities for insert
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy activities_update on activities for update
  using (org_id = get_user_org_id() and get_user_role() <> 'viewer')
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy activities_delete on activities for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or owner_id = auth.uid()));

-- calendar_events
drop policy if exists org_isolation_calendar on calendar_events;
create policy calendar_select on calendar_events for select
  using (org_id = get_user_org_id());
create policy calendar_insert on calendar_events for insert
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy calendar_update on calendar_events for update
  using (org_id = get_user_org_id() and get_user_role() <> 'viewer')
  with check (org_id = get_user_org_id() and get_user_role() <> 'viewer');
create policy calendar_delete on calendar_events for delete
  using (org_id = get_user_org_id()
         and (get_user_role() in ('admin','manager') or owner_id = auth.uid()));

-- ── INTERACOES (coluna de dono = created_by) ────────────────────────────────
-- SELECT/INSERT/UPDATE para todos os membros; DELETE admin/manager OU autor.
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

-- ── ESTRUTURA (SELECT todos; INSERT/UPDATE/DELETE só admin/manager) ─────────
-- pipelines, pipeline_stages, products, custom_field_defs, tags, automations.
-- O 1º login NÃO cria pipeline via INSERT direto: agora usa a RPC
-- ensure_default_pipeline (security definer, mais abaixo), então o INSERT
-- direto pode ficar restrito a admin/manager sem quebrar o onboarding.

-- pipelines
drop policy if exists org_isolation_pipelines on pipelines;
create policy pipelines_select on pipelines for select
  using (org_id = get_user_org_id());
create policy pipelines_insert on pipelines for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy pipelines_update on pipelines for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy pipelines_delete on pipelines for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));

-- pipeline_stages (sem org_id: isola pela org do pipeline-pai)
drop policy if exists org_isolation_stages on pipeline_stages;
create policy stages_select on pipeline_stages for select
  using (exists (select 1 from pipelines p
                 where p.id = pipeline_stages.pipeline_id
                   and p.org_id = get_user_org_id()));
create policy stages_insert on pipeline_stages for insert
  with check (get_user_role() in ('admin','manager')
              and exists (select 1 from pipelines p
                          where p.id = pipeline_stages.pipeline_id
                            and p.org_id = get_user_org_id()));
create policy stages_update on pipeline_stages for update
  using (get_user_role() in ('admin','manager')
         and exists (select 1 from pipelines p
                     where p.id = pipeline_stages.pipeline_id
                       and p.org_id = get_user_org_id()))
  with check (get_user_role() in ('admin','manager')
              and exists (select 1 from pipelines p
                          where p.id = pipeline_stages.pipeline_id
                            and p.org_id = get_user_org_id()));
create policy stages_delete on pipeline_stages for delete
  using (get_user_role() in ('admin','manager')
         and exists (select 1 from pipelines p
                     where p.id = pipeline_stages.pipeline_id
                       and p.org_id = get_user_org_id()));

-- products
drop policy if exists org_isolation_products on products;
create policy products_select on products for select
  using (org_id = get_user_org_id());
create policy products_insert on products for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy products_update on products for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy products_delete on products for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));

-- custom_field_defs
drop policy if exists org_isolation_cfd on custom_field_defs;
create policy cfd_select on custom_field_defs for select
  using (org_id = get_user_org_id());
create policy cfd_insert on custom_field_defs for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy cfd_update on custom_field_defs for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy cfd_delete on custom_field_defs for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));

-- tags
drop policy if exists org_isolation_tags on tags;
create policy tags_select on tags for select
  using (org_id = get_user_org_id());
create policy tags_insert on tags for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy tags_update on tags for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy tags_delete on tags for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));

-- automations
drop policy if exists org_isolation_automations on automations;
create policy automations_select on automations for select
  using (org_id = get_user_org_id());
create policy automations_insert on automations for insert
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy automations_update on automations for update
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'))
  with check (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));
create policy automations_delete on automations for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));

-- ── INTEGRATIONS (SELECT todos; INSERT/UPDATE/DELETE só admin) ──────────────
drop policy if exists org_isolation_integrations on integrations;
create policy integrations_select on integrations for select
  using (org_id = get_user_org_id());
create policy integrations_insert on integrations for insert
  with check (org_id = get_user_org_id() and get_user_role() = 'admin');
create policy integrations_update on integrations for update
  using (org_id = get_user_org_id() and get_user_role() = 'admin')
  with check (org_id = get_user_org_id() and get_user_role() = 'admin');
create policy integrations_delete on integrations for delete
  using (org_id = get_user_org_id() and get_user_role() = 'admin');

-- ── WPP_CONVERSATIONS (operacional: todos leem/escrevem; DELETE admin/manager)
drop policy if exists org_isolation_wpp_conv on wpp_conversations;
create policy wpp_conv_select on wpp_conversations for select
  using (org_id = get_user_org_id());
create policy wpp_conv_insert on wpp_conversations for insert
  with check (org_id = get_user_org_id());
create policy wpp_conv_update on wpp_conversations for update
  using (org_id = get_user_org_id())
  with check (org_id = get_user_org_id());
create policy wpp_conv_delete on wpp_conversations for delete
  using (org_id = get_user_org_id() and get_user_role() in ('admin','manager'));

-- ── RPC: pipeline padrão no 1º login (substitui o INSERT direto) ────────────
-- security definer: cria o pipeline Outbound + 6 etapas SEM depender de o
-- usuário ter permissão de INSERT em pipelines/pipeline_stages. Só age na
-- própria org do chamador e apenas se ainda não houver nenhum pipeline (mesma
-- semântica do antigo ensureDefaultPipeline). Idempotente.
create or replace function ensure_default_pipeline(p_org uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_pipe  uuid;
  v_owner uuid := auth.uid();
begin
  -- Só a própria org do usuário logado; ignora chamadas para outras orgs.
  if p_org is null or p_org <> get_user_org_id() then
    return null;
  end if;

  -- Já existe pipeline? Não faz nada.
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
