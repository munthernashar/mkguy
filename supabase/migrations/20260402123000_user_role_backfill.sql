begin;

create or replace function public.backfill_missing_user_roles(
  p_default_role public.app_role default 'viewer'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_inserted_count integer := 0;
begin
  if v_actor_user_id is null then
    raise exception 'not_authenticated';
  end if;

  if not public.is_owner() then
    raise exception 'insufficient_role';
  end if;

  insert into public.user_roles (user_id, role)
  select au.id, p_default_role
  from auth.users au
  left join public.user_roles ur on ur.user_id = au.id
  where ur.user_id is null
  on conflict (user_id) do nothing;

  get diagnostics v_inserted_count = row_count;

  perform public.write_audit_log(
    'user_roles_backfill',
    'user_roles',
    null,
    jsonb_build_object(
      'default_role', p_default_role,
      'inserted_count', v_inserted_count
    )
  );

  return jsonb_build_object(
    'default_role', p_default_role,
    'inserted_count', v_inserted_count
  );
end;
$$;

comment on function public.backfill_missing_user_roles(public.app_role)
  is 'Owner-only Backfill: legt fehlende user_roles für bestehende auth.users mit Standardrolle an (idempotent via on conflict do nothing) und audit-loggt den Lauf.';

commit;
