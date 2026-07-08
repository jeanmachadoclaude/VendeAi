-- ============================================================
-- VendeAI · Policies RLS faltantes + bootstrap atômico
-- (pipelines/pipeline_stages/profiles/organizations/tags/automation_logs
--  estavam com RLS habilitada e ZERO policies — frontend bloqueado)
-- ============================================================

-- PROFILES: ver a si mesmo e colegas da org; editar/criar o próprio
drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select
  using (id = auth.uid() or org_id = get_user_org_id());
drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles for insert
  with check (id = auth.uid());
drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- ORGANIZATIONS: ver/editar a própria org
drop policy if exists "org_select_own" on organizations;
create policy "org_select_own" on organizations for select
  using (id = get_user_org_id());
drop policy if exists "org_update_own" on organizations;
create policy "org_update_own" on organizations for update
  using (id = get_user_org_id()) with check (id = get_user_org_id());

-- PIPELINES: isolamento por org (leitura e escrita)
drop policy if exists "org_isolation_pipelines" on pipelines;
create policy "org_isolation_pipelines" on pipelines
  using (org_id = get_user_org_id()) with check (org_id = get_user_org_id());

-- PIPELINE STAGES: sem org_id — isola pela org do pipeline-pai
drop policy if exists "org_isolation_stages" on pipeline_stages;
create policy "org_isolation_stages" on pipeline_stages
  using (exists (select 1 from pipelines p
                 where p.id = pipeline_stages.pipeline_id
                   and p.org_id = get_user_org_id()))
  with check (exists (select 1 from pipelines p
                      where p.id = pipeline_stages.pipeline_id
                        and p.org_id = get_user_org_id()));

-- TAGS: isolamento por org
drop policy if exists "org_isolation_tags" on tags;
create policy "org_isolation_tags" on tags
  using (org_id = get_user_org_id()) with check (org_id = get_user_org_id());

-- AUTOMATION LOGS: isola pela automação-pai
drop policy if exists "org_isolation_auto_logs" on automation_logs;
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
