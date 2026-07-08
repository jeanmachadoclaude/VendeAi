-- ============================================================
-- VendeAI · Campos personalizados (leads/negócios) + Produtos
-- ============================================================

-- Definições de campos personalizados por organização.
-- Os VALORES continuam em contacts.custom_fields / deals.custom_fields (jsonb);
-- esta tabela define quais campos existem, o tipo e as opções.
create table if not exists custom_field_defs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  entity      text not null default 'contact' check (entity in ('contact','deal')),
  field_key   text not null,   -- chave no jsonb (slug estável, nunca muda após criar)
  label       text not null,   -- rótulo exibido
  field_type  text not null default 'text' check (field_type in ('text','number','select','date','boolean')),
  options     jsonb default '[]',  -- para select: ["Opção A","Opção B"]
  position    int default 0,
  is_active   boolean default true,
  created_at  timestamptz default now(),
  unique(org_id, entity, field_key)
);

-- Produtos / serviços da organização
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

create index if not exists idx_cfd_org      on custom_field_defs(org_id);
create index if not exists idx_products_org on products(org_id);
create index if not exists idx_deals_product on deals(product_id);

alter table custom_field_defs enable row level security;
alter table products          enable row level security;

drop policy if exists "org_isolation_cfd" on custom_field_defs;
create policy "org_isolation_cfd" on custom_field_defs
  using (org_id = get_user_org_id()) with check (org_id = get_user_org_id());

drop policy if exists "org_isolation_products" on products;
create policy "org_isolation_products" on products
  using (org_id = get_user_org_id()) with check (org_id = get_user_org_id());

drop trigger if exists trg_products_updated on products;
create trigger trg_products_updated before update on products
  for each row execute function update_updated_at();
