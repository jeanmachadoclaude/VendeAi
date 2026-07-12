-- ═══════════════════════════════════════════════════════════════
-- CORREÇÃO DE ESCALAÇÃO DE PRIVILÉGIO (12/jul/2026)
--
-- Duas brechas exploráveis via REST direto (PostgREST), ignorando a UI:
--  (a) profiles_update_own permitia o usuário editar o PRÓPRIO role e
--      org_id → qualquer SDR dava PATCH e virava admin.
--  (b) org_update_own permitia QUALQUER membro dar UPDATE em
--      organizations → trocar a senha de autorização de export
--      (settings.export_pass_hash) e a metodologia da IA.
--
-- Correções:
--  1. UPDATE em profiles passa a ser por COLUNA: só full_name, phone,
--     avatar_url e settings. role/org_id/email/id ficam fora do alcance
--     do REST direto. A policy profiles_update_own (id = auth.uid())
--     continua limitando à própria linha.
--  2. RPC set_member_role: única via para mudar role — só admin da MESMA
--     org do alvo, valida o papel, impede o último admin de se rebaixar,
--     e grava em audit_logs.
--  3. organizations UPDATE passa a exigir ser admin da org (SELECT
--     continua liberado a todos os membros).
--  4. INSERT direto em profiles revogado — o único fluxo que cria perfil
--     é bootstrap_org_profile (security definer); nenhuma página faz
--     insert direto em profiles.
--
-- Triggers security definer (fn_audit_row, update_updated_at) e Edge
-- Functions (service role) NÃO são afetados por grants de authenticated.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. PROFILES: UPDATE só nas colunas inofensivas ───────────────
-- Remove o UPDATE amplo (que incluía role e org_id) e concede apenas
-- as colunas que o usuário pode legitimamente editar em si mesmo.
-- Colunas reais confirmadas: id, org_id, full_name, email, phone, role,
-- avatar_url, settings, created_at, updated_at.
revoke update on profiles from authenticated;
revoke update on profiles from anon;
grant  update (full_name, phone, avatar_url, settings) on profiles to authenticated;

-- ── 4. PROFILES: sem INSERT direto pelo cliente ──────────────────
-- Bootstrap de perfil é sempre via RPC bootstrap_org_profile (definer).
revoke insert on profiles from authenticated;
revoke insert on profiles from anon;
drop policy if exists profiles_insert_own on profiles;

-- ── 3. ORGANIZATIONS: UPDATE só para admin da org ────────────────
-- SELECT (org_select_own) continua para todos os membros.
drop policy if exists org_update_own on organizations;
create policy org_update_admin on organizations for update
  using (exists (select 1 from profiles p
                 where p.id = auth.uid()
                   and p.org_id = organizations.id
                   and p.role = 'admin'))
  with check (exists (select 1 from profiles p
                      where p.id = auth.uid()
                        and p.org_id = organizations.id
                        and p.role = 'admin'));

-- ── 2. RPC: admin muda o role de um colega da mesma org ──────────
-- Security definer: roda como owner, contorna os grants por coluna e a
-- RLS para poder gravar em profiles.role. Todas as validações abaixo.
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
