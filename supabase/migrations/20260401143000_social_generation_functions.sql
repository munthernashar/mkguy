begin;

create table if not exists public.content_seeds (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  insight_id uuid references public.book_insights (id) on delete set null,
  campaign_id uuid references public.campaigns (id) on delete set null,
  seed_text text not null,
  source_link text,
  seed_metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'archived', 'deleted')),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

alter table public.brand_kits
  add column if not exists do_words jsonb not null default '[]'::jsonb,
  add column if not exists dont_words jsonb not null default '[]'::jsonb;

alter table public.posts
  add column if not exists book_id uuid references public.books (id) on delete set null,
  add column if not exists seed_id uuid references public.content_seeds (id) on delete set null,
  add column if not exists platform text default 'linkedin' check (platform in ('linkedin', 'x', 'threads', 'instagram', 'other')),
  add column if not exists language text default 'de' check (language in ('de', 'en')),
  add column if not exists cta_required boolean not null default true,
  add column if not exists link_required boolean not null default true;

alter table public.post_variants
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.generation_request_cache (
  id uuid primary key default gen_random_uuid(),
  request_hash text not null unique,
  request_kind text not null,
  response_payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_content_seeds_book_id on public.content_seeds (book_id);
create index if not exists idx_generation_request_cache_expires_at on public.generation_request_cache (expires_at);

alter table public.content_seeds enable row level security;
alter table public.generation_request_cache enable row level security;

drop policy if exists "content_seeds_read" on public.content_seeds;
create policy "content_seeds_read" on public.content_seeds for select using (public.has_any_role());
drop policy if exists "content_seeds_write_editor_owner" on public.content_seeds;
create policy "content_seeds_write_editor_owner" on public.content_seeds for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "generation_request_cache_read" on public.generation_request_cache;
create policy "generation_request_cache_read" on public.generation_request_cache for select using (public.is_editor_or_owner());
drop policy if exists "generation_request_cache_write" on public.generation_request_cache;
create policy "generation_request_cache_write" on public.generation_request_cache for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop trigger if exists trg_touch_content_seeds on public.content_seeds;
create trigger trg_touch_content_seeds before update on public.content_seeds
for each row execute function public.touch_updated_at();

commit;
