-- ═══════════════════════════════════════════════════════════════
-- DEAL FILES — anexos por negócio (jul/2026)
-- Aba "Arquivos" do painel de deal no pipeline.html deixa de ser
-- mock: upload real no Storage (bucket privado 'deal-files') com
-- metadados nesta tabela. Caminho no bucket: org_id/deal_id/arquivo.
-- ═══════════════════════════════════════════════════════════════

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

-- Mesma matriz das tabelas de negócio: SELECT todos os membros;
-- INSERT todos exceto viewer; DELETE admin/manager OU quem subiu.
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

-- ── Bucket privado (50 MB por arquivo, igual ao aviso da UI) ──
insert into storage.buckets (id, name, public, file_size_limit)
values ('deal-files', 'deal-files', false, 52428800)
on conflict (id) do nothing;

-- ── Policies do Storage: acesso restrito à pasta da própria org ──
-- O primeiro segmento do caminho é sempre o org_id do usuário.
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
