begin;

create extension if not exists pgcrypto;

create type public.app_role as enum ('owner', 'editor', 'viewer');

create table if not exists public.user_roles (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_roles_user_id_unique unique (user_id)
);

create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  summary text,
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns (id) on delete set null,
  title text not null,
  body text,
  status text not null default 'draft',
  published_at timestamptz,
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users (id) on delete set null,
  action text not null,
  entity text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.current_app_role()
returns public.app_role
language sql
stable
as $$
  select role
  from public.user_roles
  where user_id = auth.uid();
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
as $$
  select coalesce(public.current_app_role() = 'owner', false);
$$;

create or replace function public.is_editor_or_owner()
returns boolean
language sql
stable
as $$
  select coalesce(public.current_app_role() in ('owner', 'editor'), false);
$$;

create or replace function public.has_any_role()
returns boolean
language sql
stable
as $$
  select coalesce(public.current_app_role() in ('owner', 'editor', 'viewer'), false);
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.seed_first_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  role_count bigint;
begin
  select count(*) into role_count from public.user_roles;

  if role_count = 0 then
    insert into public.user_roles (user_id, role)
    values (new.id, 'owner')
    on conflict (user_id) do nothing;
  end if;

  return new;
end;
$$;

create or replace function public.write_audit_log(
  p_action text,
  p_entity text default null,
  p_entity_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (actor_user_id, action, entity, entity_id, details)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_details, '{}'::jsonb));
end;
$$;

create or replace function public.audit_roles_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.write_audit_log('role_assigned', 'user_roles', new.user_id::text, jsonb_build_object('role', new.role));
    return new;
  elsif tg_op = 'UPDATE' and old.role is distinct from new.role then
    perform public.write_audit_log('role_changed', 'user_roles', new.user_id::text, jsonb_build_object('from', old.role, 'to', new.role));
    return new;
  elsif tg_op = 'DELETE' then
    perform public.write_audit_log('role_revoked', 'user_roles', old.user_id::text, jsonb_build_object('role', old.role));
    return old;
  end if;

  return null;
end;
$$;

create or replace function public.audit_content_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_id text;
  v_details jsonb;
begin
  if tg_op = 'INSERT' then
    v_entity_id := new.id::text;
    v_details := jsonb_build_object('operation', 'create');
    perform public.write_audit_log(lower(tg_table_name) || '_created', tg_table_name, v_entity_id, v_details);
    return new;
  elsif tg_op = 'UPDATE' then
    v_entity_id := new.id::text;
    v_details := jsonb_build_object('operation', 'update');
    perform public.write_audit_log(lower(tg_table_name) || '_updated', tg_table_name, v_entity_id, v_details);

    if tg_table_name = 'posts' and old.status is distinct from new.status and new.status = 'published' then
      perform public.write_audit_log('post_published', tg_table_name, v_entity_id, jsonb_build_object('from', old.status, 'to', new.status));
    end if;

    return new;
  elsif tg_op = 'DELETE' then
    v_entity_id := old.id::text;
    v_details := jsonb_build_object('operation', 'delete');
    perform public.write_audit_log(lower(tg_table_name) || '_deleted', tg_table_name, v_entity_id, v_details);
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_touch_user_roles on public.user_roles;
create trigger trg_touch_user_roles before update on public.user_roles
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_books on public.books;
create trigger trg_touch_books before update on public.books
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_campaigns on public.campaigns;
create trigger trg_touch_campaigns before update on public.campaigns
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_posts on public.posts;
create trigger trg_touch_posts before update on public.posts
for each row execute function public.touch_updated_at();

drop trigger if exists trg_seed_first_owner on auth.users;
create trigger trg_seed_first_owner after insert on auth.users
for each row execute function public.seed_first_owner();

drop trigger if exists trg_audit_user_roles on public.user_roles;
create trigger trg_audit_user_roles after insert or update or delete on public.user_roles
for each row execute function public.audit_roles_changes();

drop trigger if exists trg_audit_books on public.books;
create trigger trg_audit_books after insert or update or delete on public.books
for each row execute function public.audit_content_changes();

drop trigger if exists trg_audit_campaigns on public.campaigns;
create trigger trg_audit_campaigns after insert or update or delete on public.campaigns
for each row execute function public.audit_content_changes();

drop trigger if exists trg_audit_posts on public.posts;
create trigger trg_audit_posts after insert or update or delete on public.posts
for each row execute function public.audit_content_changes();

alter table public.user_roles enable row level security;
alter table public.books enable row level security;
alter table public.campaigns enable row level security;
alter table public.posts enable row level security;
alter table public.audit_logs enable row level security;

create policy "user_roles_select_own_or_owner" on public.user_roles
for select
using (auth.uid() = user_id or public.is_owner());

create policy "user_roles_owner_insert" on public.user_roles
for insert
with check (public.is_owner());

create policy "user_roles_owner_update" on public.user_roles
for update
using (public.is_owner())
with check (public.is_owner());

create policy "user_roles_owner_delete" on public.user_roles
for delete
using (public.is_owner());

create policy "books_read" on public.books
for select
using (public.has_any_role());

create policy "books_write_editor_owner" on public.books
for all
using (public.is_editor_or_owner())
with check (public.is_editor_or_owner());

create policy "campaigns_read" on public.campaigns
for select
using (public.has_any_role());

create policy "campaigns_write_editor_owner" on public.campaigns
for all
using (public.is_editor_or_owner())
with check (public.is_editor_or_owner());

create policy "posts_read" on public.posts
for select
using (public.has_any_role());

create policy "posts_write_editor_owner" on public.posts
for all
using (public.is_editor_or_owner())
with check (public.is_editor_or_owner());

create policy "audit_logs_select_owner" on public.audit_logs
for select
using (public.is_owner());

create policy "audit_logs_insert_authenticated" on public.audit_logs
for insert
with check (auth.uid() is not null and actor_user_id = auth.uid());

commit;
