-- Mídia no WhatsApp (14/jul/2026)
-- Áudio, figurinha, GIF, imagem, vídeo e documento recebidos agora são
-- baixados da Evolution pelo wpp-webhook e guardados no bucket PRIVADO
-- wpp-media (caminho org_id/conversa_id/external_id.ext). O frontend gera
-- URL assinada para exibir. media_url/media_type já existiam na tabela
-- (nunca usadas); media_url passa a guardar o CAMINHO no bucket.
alter table wpp_messages
  add column if not exists media_mime text,
  add column if not exists media_name text;

insert into storage.buckets (id, name, public, file_size_limit)
values ('wpp-media', 'wpp-media', false, 26214400) -- 25MB
on conflict (id) do nothing;

-- Só leitura para membros da org (a escrita é exclusiva do service role)
drop policy if exists "wpp_media_select" on storage.objects;
create policy "wpp_media_select" on storage.objects for select
  to authenticated
  using (bucket_id = 'wpp-media'
         and (storage.foldername(name))[1] = get_user_org_id()::text);
