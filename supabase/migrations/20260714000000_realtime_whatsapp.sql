-- Realtime no chat do WhatsApp (14/jul/2026)
-- O whatsapp.html só atualizava no load da página / volta pra aba — mensagem
-- recebida ficava invisível até recarregar. Com as tabelas na publication,
-- o frontend assina postgres_changes e a mensagem aparece em ~1s.
-- A RLS continua valendo: o Realtime só entrega a linha se a policy do
-- usuário assinante permitir SELECT (org_isolation via conversa-mãe).
alter publication supabase_realtime add table public.wpp_messages;
alter publication supabase_realtime add table public.wpp_conversations;
