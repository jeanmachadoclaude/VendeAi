-- ═══════════════════════════════════════════════════════════════
-- EQUIPE REAL COM CONVITES (12/jul/2026)
--
-- Até aqui todo usuário novo ganhava uma ORG PRÓPRIA (bootstrap_org_profile):
-- não havia como duas pessoas trabalharem na mesma organização. A seção
-- "Equipe" do settings era 100% mockada. Aqui construímos o sistema real:
--
--  1. profiles.is_active — desativação de membro (sem apagar histórico).
--  2. org_invites — convites por e-mail com token único e expiração.
--  3. RPCs (todas security definer):
--       create_invite(email, role)         → admin gera convite + token forte
--       get_invite_info(token)             → dado público mínimo (org, e-mail
--                                            mascarado, papel) p/ a tela de login
--       accept_invite(token)               → convidado entra na org do convite
--       find_pending_invite_for_me()       → acha convite pendente pelo e-mail
--       set_member_active(user, active)    → admin ativa/desativa membro
--
-- SEGURANÇA:
--   - org_id do convite vem SEMPRE da org do admin logado (nunca do cliente).
--   - token gerado no servidor (gen_random_bytes 32) — nunca gravado em audit.
--   - convidado NÃO lê org_invites; o aceite é via RPC definer com checagem de
--     e-mail (auth.users.email = e-mail do convite, case-insensitive).
--   - is_active NÃO entra em get_user_org_id() (evita quebrar toda a RLS);
--     a barreira fica em initAuth (frontend) e requireUser (Edge Functions),
--     reforçada pelo signOut global via Edge Function member-admin. Limitação
--     conhecida: o JWT segue válido para REST direto até expirar.
-- ═══════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ── 1. DESATIVAÇÃO DE MEMBRO ─────────────────────────────────────
alter table profiles add column if not exists is_active boolean not null default true;

-- ── 2. TABELA DE CONVITES ────────────────────────────────────────
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

-- RLS: apenas o admin da org enxerga/gere seus convites. O CONVIDADO nunca
-- lê a tabela (o aceite acontece pela RPC accept_invite, security definer).
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

-- ── HELPER: token url-safe de 32 bytes ───────────────────────────
create or replace function gen_invite_token()
returns text language sql volatile set search_path = public, extensions as $$
  -- base64 → url-safe: '+'→'-', '/'→'_', remove '='
  select translate(encode(gen_random_bytes(32), 'base64'), '+/=', '-_');
$$;

-- ── 3. RPC create_invite: admin gera o convite ───────────────────
-- Gera o token no servidor (fora do alcance/logs do cliente), impede duplicar
-- convite pendente para o mesmo e-mail e recusa e-mail que já é membro.
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

  -- revoga convites pendentes anteriores p/ o mesmo e-mail (evita 2 links vivos)
  update org_invites set revoked_at = now()
   where org_id = v_caller.org_id and lower(email) = lower(p_email)
     and accepted_at is null and revoked_at is null and expires_at > now();

  v_token := gen_invite_token();
  insert into org_invites (org_id, email, role, token, invited_by)
    values (v_caller.org_id, lower(p_email), p_role, v_token, v_caller.id)
    returning id into v_id;

  select name into v_org from organizations where id = v_caller.org_id;

  -- auditoria SEM o token
  insert into audit_logs (org_id, user_id, user_email, action, entity, entity_id, details)
    values (v_caller.org_id, v_caller.id, v_caller.email, 'convite_criado',
            'org_invites', v_id, jsonb_build_object('email', lower(p_email), 'role', p_role));

  return jsonb_build_object('ok', true, 'invite_id', v_id, 'token', v_token,
                            'org_name', v_org, 'role', p_role, 'email', lower(p_email));
end $$;
revoke all on function create_invite(text, text) from anon, public;
grant execute on function create_invite(text, text) to authenticated;

-- ── 3. RPC get_invite_info: dado público mínimo p/ a tela de login ─
-- Retorna só org_name, e-mail mascarado, papel e validade — nada sensível,
-- nenhum token. Chamável por anon (usuário ainda nem tem conta).
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

-- ── 3. RPC accept_invite: convidado entra na org do convite ───────
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

  -- o e-mail logado precisa ser o mesmo do convite
  select email into v_email from auth.users where id = v_uid;
  if v_email is null or lower(v_email) is distinct from lower(v_inv.email) then
    return jsonb_build_object('ok', false,
      'reason', 'Este convite foi enviado para outro e-mail. Entre com o e-mail do convite.');
  end if;

  -- cria/atualiza o profile do usuário na org do convite (bypassa RLS: definer)
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

-- ── 3. RPC find_pending_invite_for_me: cobre quem cadastra sem o link
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

-- ── 5. RPC set_member_active: admin ativa/desativa membro ─────────
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

  -- protege o último admin ativo da org
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
