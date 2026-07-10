-- ═══════════════════════════════════════════════════════════════
-- AUDITORIA + AUTORIZAÇÃO DE EXPORTAÇÃO/IMPORTAÇÃO (08/jul/2026)
--
-- 1. audit_logs: trilha imutável de tudo que todos os usuários
--    fazem (criar/editar/excluir via triggers no banco — impossível
--    de burlar pelo frontend) + exportações/importações.
--    Só admins da org conseguem LER; ninguém edita/apaga.
-- 2. authorize_export(): admin exporta direto; demais perfis
--    precisam da senha de autorização definida pelo admin
--    (hash bcrypt em organizations.settings.export_pass_hash).
--    Toda tentativa — autorizada ou negada — vira registro.
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
