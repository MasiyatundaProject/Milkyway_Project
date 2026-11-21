begin;

alter table public.mw_post_notifications
  add column if not exists read_at timestamptz;

drop policy if exists mw_post_notifications_recipient_update on public.mw_post_notifications;
create policy mw_post_notifications_recipient_update on public.mw_post_notifications
  for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());
grant update (read_at) on public.mw_post_notifications to authenticated;

alter table public.mw_dm_group_members
  add column if not exists last_read_at timestamptz;

create or replace function public.mw_dm_group_mark_read(p_group uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.mw_dm_group_members
  set last_read_at = now()
  where group_id = p_group and user_id = auth.uid();
  if not found then
    raise exception 'Group membership not found.';
  end if;
end;
$$;
revoke all on function public.mw_dm_group_mark_read(uuid) from public, anon;
grant execute on function public.mw_dm_group_mark_read(uuid) to authenticated;

create or replace function public.mw_dm_call_notification_read(p_call uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.mw_dm_calls c
  set answer = coalesce(case when jsonb_typeof(c.answer) = 'object' then c.answer else '{}'::jsonb end, '{}'::jsonb)
    || jsonb_build_object(
      'notification_read_by',
      (case when jsonb_typeof(c.answer->'notification_read_by') = 'array'
        then c.answer->'notification_read_by' else '[]'::jsonb end)
        || jsonb_build_array(auth.uid()::text)
    )
  where c.id = p_call and c.callee_id = auth.uid();
  if not found then
    raise exception 'Call notification not found.';
  end if;
end;
$$;
revoke all on function public.mw_dm_call_notification_read(uuid) from public, anon;
grant execute on function public.mw_dm_call_notification_read(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
