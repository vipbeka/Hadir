-- حاضر: دالة حذف الإعلان (انسخ الملف كله والصقه في Supabase → SQL Editor ثم Run)
-- آمنة: تنشئ الدالة فقط، لا تحذف أي بيانات عند التشغيل.
create or replace function public.svc_delete_announcement(p_actor uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; b public.announcements;
begin
  if not private.is_active_owner(p_actor) then perform private.err('forbidden'); end if;
  begin v_id := (p ->> 'id')::uuid; exception when others then perform private.err('not_found'); end;
  if v_id is null then perform private.err('not_found'); end if;
  delete from public.announcements where id = v_id returning * into b;
  if b.id is null then return jsonb_build_object('id', v_id, 'deleted', false); end if;
  update public.notification_outbox set status = 'skipped', last_error = 'announcement deleted'
   where event_type = 'announcement' and status in ('pending', 'failed') and dedupe_key like 'announcement:' || v_id::text || ':%';
  perform private.audit(p_actor, 'announcement.delete', 'announcements', v_id::text, to_jsonb(b), null, p ->> 'via');
  return jsonb_build_object('id', v_id, 'deleted', true);
end $$;
revoke all on function public.svc_delete_announcement(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.svc_delete_announcement(uuid, jsonb) to service_role;
