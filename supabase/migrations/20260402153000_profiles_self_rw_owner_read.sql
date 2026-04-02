begin;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'User profile data gekoppelt an auth.users.';

alter table public.profiles enable row level security;

-- Self-Service: users can only access their own profile rows.
drop policy if exists "profiles_select_own_or_owner" on public.profiles;
drop policy if exists "profiles_insert_own_or_owner" on public.profiles;
drop policy if exists "profiles_update_own_or_owner" on public.profiles;
drop policy if exists "profiles_select_self_or_owner" on public.profiles;
drop policy if exists "profiles_insert_self" on public.profiles;
drop policy if exists "profiles_update_self" on public.profiles;
drop policy if exists "profiles_admin_read_all" on public.profiles;

create policy "profiles_select_self_or_owner" on public.profiles
  for select
  using (auth.uid() = user_id or public.is_owner());

create policy "profiles_insert_self" on public.profiles
  for insert
  with check (auth.uid() = user_id);

create policy "profiles_update_self" on public.profiles
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Optional signup bootstrap: create empty profile row when a new auth user is inserted.
create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_handle_new_user_profile on auth.users;
create trigger trg_handle_new_user_profile
after insert on auth.users
for each row execute function public.handle_new_user_profile();

-- Keep updated_at in sync.
drop trigger if exists trg_touch_profiles on public.profiles;
create trigger trg_touch_profiles before update on public.profiles
for each row execute function public.touch_updated_at();

commit;
