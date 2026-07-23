-- Realtime na caixa de e-mail (23/jul/2026)
-- A página email.html só atualizava no load; e-mail novo (sync/cron) ou movido
-- ficava invisível até recarregar. Com a tabela `emails` na publication, o
-- frontend assina postgres_changes e reflete em ~1s. A RLS continua valendo:
-- o Realtime só entrega a linha se a policy de SELECT do usuário permitir.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'emails'
  ) then
    alter publication supabase_realtime add table public.emails;
  end if;
end $$;
