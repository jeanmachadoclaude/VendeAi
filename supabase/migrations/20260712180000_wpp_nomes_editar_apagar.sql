-- ═══════════════════════════════════════════════════════════════
-- WHATSAPP: nomes de contato (pushName), matching de telefone
-- normalizado e suporte a editar/apagar mensagens enviadas.
-- ═══════════════════════════════════════════════════════════════

-- Nome exibido da conversa (pushName do WhatsApp) — usado quando a
-- conversa não está vinculada a um contato do CRM.
alter table wpp_conversations add column if not exists display_name text;

-- Marcações de edição/remoção de mensagens (a linha é preservada)
alter table wpp_messages add column if not exists edited_at  timestamptz;
alter table wpp_messages add column if not exists deleted_at timestamptz;

-- ── RPC: encontra contato pelo telefone, ignorando formatação ──
-- O WhatsApp usa "5511999998888"; contatos do CRM costumam ter
-- "(11) 99999-8888". Compara os últimos 8 dígitos (linha) e valida
-- que os DDDs não conflitam quando ambos existem.
create or replace function wpp_match_contact(p_org uuid, p_phone text)
returns uuid
language sql security definer stable as $$
  select c.id
  from contacts c
  where c.org_id = p_org
    and (
      right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 8)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 8)
      or right(regexp_replace(coalesce(c.whatsapp, ''), '\D', '', 'g'), 8)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 8)
    )
    and length(regexp_replace(p_phone, '\D', '', 'g')) >= 8
  order by (c.phone is not null) desc, c.created_at
  limit 1
$$;
