-- ═══════════════════════════════════════════════════════════════
-- APAGAR CONVERSA DO WHATSAPP — somente admin (jul/2026)
-- Botão 🗑️ no whatsapp.html. Antes o DELETE de wpp_conversations
-- valia para admin/manager; agora somente admin. As mensagens caem
-- junto (FK conversation_id on delete cascade).
-- ═══════════════════════════════════════════════════════════════

drop policy if exists "wpp_conv_delete" on wpp_conversations;
create policy "wpp_conv_delete" on wpp_conversations for delete
  using (org_id = get_user_org_id() and get_user_role() = 'admin');

-- Deleção de conversa é rara e destrutiva: entra na auditoria.
-- (INSERT/UPDATE de wpp_* continuam fora do trg_audit por volume.)
drop trigger if exists trg_audit_delete on wpp_conversations;
create trigger trg_audit_delete after delete on wpp_conversations
  for each row execute function fn_audit_row();
