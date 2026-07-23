-- ═══════════════════════════════════════════════════════════════════════
-- E-mail: caixa completa (FASE 4)
--
-- Amplia a tabela `emails` de "só e-mails de leads na inbox" para uma caixa
-- de e-mail completa espelhando o Gmail: pastas (Entrada/Enviados/Spam/Lixo/
-- Arquivo), estado de leitura e os labels crus do Gmail. O email-sync passa a
-- importar TODAS as pastas (includeSpamTrash) e derivar a pasta pelos labels.
-- ═══════════════════════════════════════════════════════════════════════

-- Pasta derivada dos labels do Gmail: inbox | sent | spam | trash | archive
alter table emails add column if not exists folder text;
alter table emails add column if not exists is_read boolean not null default true;
alter table emails add column if not exists gmail_labels text[];

-- Backfill das linhas já existentes (antes só havia inbound=inbox, outbound=sent)
update emails set folder = case
  when folder is not null then folder
  when direction = 'outbound' then 'sent'
  else 'inbox'
end
where folder is null;

-- Índice para a listagem por pasta (mais recente primeiro), por org
create index if not exists idx_emails_org_folder on emails(org_id, folder, sent_at desc);
