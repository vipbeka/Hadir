-- @remote-only (Supabase Storage)
-- Private bucket for check-in selfies (feature 10). Each employee can upload
-- only into their own folder (<user id>/…); the owner can view all; nobody
-- can overwrite or delete through the API. JPEG/WEBP/PNG up to 2 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('checkin-selfies', 'checkin-selfies', false, 2097152, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists checkin_selfies_insert_own on storage.objects;
create policy checkin_selfies_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'checkin-selfies' and (storage.foldername(name))[1] = (select private.current_uid())::text);
drop policy if exists checkin_selfies_read on storage.objects;
create policy checkin_selfies_read on storage.objects for select to authenticated
  using (bucket_id = 'checkin-selfies' and ((storage.foldername(name))[1] = (select private.current_uid())::text or (select private.is_owner())));
