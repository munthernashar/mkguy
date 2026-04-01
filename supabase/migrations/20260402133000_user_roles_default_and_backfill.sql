begin;

create or replace function public.seed_user_role_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  role_count bigint;
  target_role public.app_role;
begin
  select count(*) into role_count from public.user_roles;

  if role_count = 0 then
    target_role := 'owner';
  else
    target_role := 'viewer';
  end if;

  insert into public.user_roles (user_id, role)
  values (new.id, target_role)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

comment on function public.seed_user_role_on_signup()
  is 'Weist neuen Auth-Usern automatisch eine Rolle zu: erster User owner, danach viewer.';

drop trigger if exists trg_seed_first_owner on auth.users;
create trigger trg_seed_first_owner
after insert on auth.users
for each row execute function public.seed_user_role_on_signup();

insert into public.user_roles (user_id, role)
select au.id, 'viewer'::public.app_role
from auth.users au
left join public.user_roles ur on ur.user_id = au.id
where ur.user_id is null
on conflict (user_id) do nothing;

commit;
