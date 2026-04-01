begin;

create extension if not exists pgcrypto;
create extension if not exists vector;

-- Move from enum-based roles to text + check constraints.
alter table public.user_roles
  alter column role type text using role::text;

alter table public.user_roles
  add constraint user_roles_role_check
  check (role in ('owner', 'editor', 'viewer'));

drop function if exists public.current_app_role();

create function public.current_app_role()
returns text
language sql
stable
as $$
  select role
  from public.user_roles
  where user_id = auth.uid();
$$;

drop type if exists public.app_role;

-- Harden existing core tables with lifecycle and versioning fields.
alter table public.books
  add column if not exists status text not null default 'active',
  add column if not exists archived_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists version integer not null default 1;

alter table public.books
  add constraint books_status_check
  check (status in ('draft', 'active', 'archived', 'deleted'));

alter table public.campaigns
  add column if not exists status text not null default 'draft',
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists version integer not null default 1;

alter table public.campaigns
  add constraint campaigns_status_check
  check (status in ('draft', 'planned', 'active', 'paused', 'completed', 'archived', 'deleted'));

alter table public.posts
  add column if not exists workflow_status text not null default 'draft',
  add column if not exists scheduled_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists version integer not null default 1;

alter table public.posts
  add constraint posts_workflow_status_check
  check (workflow_status in ('draft', 'queued', 'ready', 'scheduled', 'publishing', 'published', 'failed', 'archived', 'deleted'));

update public.posts
set workflow_status = case
  when status = 'published' then 'published'
  when status = 'archived' then 'archived'
  else 'draft'
end
where workflow_status is null;

create table if not exists public.book_documents (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  source_type text not null default 'upload' check (source_type in ('upload', 'url', 'import')),
  source_uri text,
  file_name text,
  mime_type text,
  parse_status text not null default 'pending' check (parse_status in ('pending', 'processing', 'parsed', 'failed', 'archived', 'deleted')),
  parse_error text,
  document_metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.book_document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.book_documents (id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  token_count integer,
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'archived', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  unique (document_id, chunk_index)
);

create table if not exists public.book_insights (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.books (id) on delete cascade,
  document_id uuid references public.book_documents (id) on delete set null,
  insight_type text not null check (insight_type in ('summary', 'theme', 'quote', 'fact', 'persona', 'cta', 'other')),
  title text,
  content text not null,
  confidence numeric(5,4),
  status text not null default 'active' check (status in ('active', 'archived', 'deleted')),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.brand_kits (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  voice_guidelines text,
  colors jsonb not null default '[]'::jsonb,
  typography jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('draft', 'active', 'archived', 'deleted')),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.prompt_templates (
  id uuid primary key default gen_random_uuid(),
  brand_kit_id uuid references public.brand_kits (id) on delete set null,
  name text not null,
  template_type text not null check (template_type in ('post', 'variant', 'insight', 'image', 'other')),
  body text not null,
  variables jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('draft', 'active', 'archived', 'deleted')),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

alter table public.campaigns
  add column if not exists brand_kit_id uuid references public.brand_kits (id) on delete set null;

create table if not exists public.post_variants (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  prompt_template_id uuid references public.prompt_templates (id) on delete set null,
  variant_type text not null default 'copy' check (variant_type in ('copy', 'hook', 'cta', 'image_prompt', 'hashtag_set', 'other')),
  content text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'archived', 'deleted')),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references public.posts (id) on delete set null,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  asset_type text not null check (asset_type in ('image', 'video', 'audio', 'document', 'other')),
  provider text,
  storage_path text not null,
  mime_type text,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'ready' check (status in ('processing', 'ready', 'failed', 'archived', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.platform_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  platform text not null check (platform in ('linkedin', 'instagram', 'facebook', 'x', 'tiktok', 'youtube', 'threads', 'pinterest', 'other')),
  external_account_id text,
  account_name text,
  auth_status text not null default 'connected' check (auth_status in ('connected', 'expired', 'revoked', 'error')),
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  unique (platform, external_account_id)
);

create table if not exists public.buffer_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  platform_account_id uuid references public.platform_accounts (id) on delete set null,
  buffer_user_id text,
  access_status text not null default 'connected' check (access_status in ('connected', 'expired', 'revoked', 'error')),
  access_token_ref text,
  refresh_token_ref text,
  token_expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.buffer_profiles (
  id uuid primary key default gen_random_uuid(),
  buffer_account_id uuid not null references public.buffer_accounts (id) on delete cascade,
  platform_account_id uuid references public.platform_accounts (id) on delete set null,
  service text not null check (service in ('linkedin', 'instagram', 'facebook', 'x', 'tiktok', 'youtube', 'threads', 'pinterest', 'other')),
  external_profile_id text,
  profile_name text,
  is_active boolean not null default true,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  unique (buffer_account_id, external_profile_id)
);

create table if not exists public.utm_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  name text not null,
  source text not null,
  medium text not null,
  campaign text,
  term text,
  content text,
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

alter table public.posts
  add column if not exists platform_account_id uuid references public.platform_accounts (id) on delete set null,
  add column if not exists buffer_profile_id uuid references public.buffer_profiles (id) on delete set null,
  add column if not exists utm_profile_id uuid references public.utm_profiles (id) on delete set null;

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references public.posts (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  prompt_template_id uuid references public.prompt_templates (id) on delete set null,
  initiated_by uuid not null references auth.users (id) on delete restrict,
  provider text,
  model text,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  request_payload jsonb not null default '{}'::jsonb,
  result_payload jsonb not null default '{}'::jsonb,
  error_message text,
  attempts integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.publish_jobs (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  post_variant_id uuid references public.post_variants (id) on delete set null,
  buffer_profile_id uuid references public.buffer_profiles (id) on delete set null,
  initiated_by uuid not null references auth.users (id) on delete restrict,
  status text not null default 'queued' check (status in ('queued', 'running', 'published', 'failed', 'cancelled')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  last_error text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.post_metrics (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  post_variant_id uuid references public.post_variants (id) on delete set null,
  platform_account_id uuid references public.platform_accounts (id) on delete set null,
  metric_date date not null,
  impressions integer not null default 0,
  reach integer not null default 0,
  clicks integer not null default 0,
  likes integer not null default 0,
  comments integer not null default 0,
  shares integer not null default 0,
  saves integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (post_id, post_variant_id, platform_account_id, metric_date)
);

-- Requested core indexes.
create index if not exists idx_posts_workflow_status_scheduled_at
  on public.posts (workflow_status, scheduled_at);

create index if not exists idx_publish_jobs_status_next_attempt_at
  on public.publish_jobs (status, next_attempt_at);

create index if not exists idx_generation_jobs_status_created_at
  on public.generation_jobs (status, created_at desc);

create index if not exists idx_book_documents_book_id_parse_status
  on public.book_documents (book_id, parse_status);

create index if not exists idx_buffer_profiles_service_is_active
  on public.buffer_profiles (service, is_active);

-- Additional practical FK/search indexes.
create index if not exists idx_book_document_chunks_document_id on public.book_document_chunks (document_id);
create index if not exists idx_book_insights_book_id on public.book_insights (book_id);
create index if not exists idx_campaigns_brand_kit_id on public.campaigns (brand_kit_id);
create index if not exists idx_posts_campaign_id on public.posts (campaign_id);
create index if not exists idx_posts_buffer_profile_id on public.posts (buffer_profile_id);
create index if not exists idx_post_variants_post_id on public.post_variants (post_id);
create index if not exists idx_media_assets_post_id on public.media_assets (post_id);
create index if not exists idx_buffer_profiles_buffer_account_id on public.buffer_profiles (buffer_account_id);
create index if not exists idx_publish_jobs_post_id on public.publish_jobs (post_id);
create index if not exists idx_post_metrics_post_id_metric_date on public.post_metrics (post_id, metric_date desc);

-- RLS-ready defaults for all new tables.
alter table public.book_documents enable row level security;
alter table public.book_document_chunks enable row level security;
alter table public.book_insights enable row level security;
alter table public.brand_kits enable row level security;
alter table public.prompt_templates enable row level security;
alter table public.post_variants enable row level security;
alter table public.media_assets enable row level security;
alter table public.platform_accounts enable row level security;
alter table public.buffer_accounts enable row level security;
alter table public.buffer_profiles enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.publish_jobs enable row level security;
alter table public.utm_profiles enable row level security;
alter table public.post_metrics enable row level security;

-- Keep policy model consistent with existing role helpers.
drop policy if exists "book_documents_read" on public.book_documents;
create policy "book_documents_read" on public.book_documents for select using (public.has_any_role());
drop policy if exists "book_documents_write_editor_owner" on public.book_documents;
create policy "book_documents_write_editor_owner" on public.book_documents for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "book_document_chunks_read" on public.book_document_chunks;
create policy "book_document_chunks_read" on public.book_document_chunks for select using (public.has_any_role());
drop policy if exists "book_document_chunks_write_editor_owner" on public.book_document_chunks;
create policy "book_document_chunks_write_editor_owner" on public.book_document_chunks for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "book_insights_read" on public.book_insights;
create policy "book_insights_read" on public.book_insights for select using (public.has_any_role());
drop policy if exists "book_insights_write_editor_owner" on public.book_insights;
create policy "book_insights_write_editor_owner" on public.book_insights for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "brand_kits_read" on public.brand_kits;
create policy "brand_kits_read" on public.brand_kits for select using (public.has_any_role());
drop policy if exists "brand_kits_write_editor_owner" on public.brand_kits;
create policy "brand_kits_write_editor_owner" on public.brand_kits for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "prompt_templates_read" on public.prompt_templates;
create policy "prompt_templates_read" on public.prompt_templates for select using (public.has_any_role());
drop policy if exists "prompt_templates_write_editor_owner" on public.prompt_templates;
create policy "prompt_templates_write_editor_owner" on public.prompt_templates for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "post_variants_read" on public.post_variants;
create policy "post_variants_read" on public.post_variants for select using (public.has_any_role());
drop policy if exists "post_variants_write_editor_owner" on public.post_variants;
create policy "post_variants_write_editor_owner" on public.post_variants for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "media_assets_read" on public.media_assets;
create policy "media_assets_read" on public.media_assets for select using (public.has_any_role());
drop policy if exists "media_assets_write_editor_owner" on public.media_assets;
create policy "media_assets_write_editor_owner" on public.media_assets for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "platform_accounts_read" on public.platform_accounts;
create policy "platform_accounts_read" on public.platform_accounts for select using (public.has_any_role());
drop policy if exists "platform_accounts_write_editor_owner" on public.platform_accounts;
create policy "platform_accounts_write_editor_owner" on public.platform_accounts for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "buffer_accounts_read" on public.buffer_accounts;
create policy "buffer_accounts_read" on public.buffer_accounts for select using (public.has_any_role());
drop policy if exists "buffer_accounts_write_editor_owner" on public.buffer_accounts;
create policy "buffer_accounts_write_editor_owner" on public.buffer_accounts for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "buffer_profiles_read" on public.buffer_profiles;
create policy "buffer_profiles_read" on public.buffer_profiles for select using (public.has_any_role());
drop policy if exists "buffer_profiles_write_editor_owner" on public.buffer_profiles;
create policy "buffer_profiles_write_editor_owner" on public.buffer_profiles for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "generation_jobs_read" on public.generation_jobs;
create policy "generation_jobs_read" on public.generation_jobs for select using (public.has_any_role());
drop policy if exists "generation_jobs_write_editor_owner" on public.generation_jobs;
create policy "generation_jobs_write_editor_owner" on public.generation_jobs for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "publish_jobs_read" on public.publish_jobs;
create policy "publish_jobs_read" on public.publish_jobs for select using (public.has_any_role());
drop policy if exists "publish_jobs_write_editor_owner" on public.publish_jobs;
create policy "publish_jobs_write_editor_owner" on public.publish_jobs for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "utm_profiles_read" on public.utm_profiles;
create policy "utm_profiles_read" on public.utm_profiles for select using (public.has_any_role());
drop policy if exists "utm_profiles_write_editor_owner" on public.utm_profiles;
create policy "utm_profiles_write_editor_owner" on public.utm_profiles for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "post_metrics_read" on public.post_metrics;
create policy "post_metrics_read" on public.post_metrics for select using (public.has_any_role());
drop policy if exists "post_metrics_write_editor_owner" on public.post_metrics;
create policy "post_metrics_write_editor_owner" on public.post_metrics for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

-- Reuse existing touch trigger for all update-tracked tables.
drop trigger if exists trg_touch_book_documents on public.book_documents;
create trigger trg_touch_book_documents before update on public.book_documents
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_book_document_chunks on public.book_document_chunks;
create trigger trg_touch_book_document_chunks before update on public.book_document_chunks
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_book_insights on public.book_insights;
create trigger trg_touch_book_insights before update on public.book_insights
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_brand_kits on public.brand_kits;
create trigger trg_touch_brand_kits before update on public.brand_kits
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_prompt_templates on public.prompt_templates;
create trigger trg_touch_prompt_templates before update on public.prompt_templates
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_post_variants on public.post_variants;
create trigger trg_touch_post_variants before update on public.post_variants
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_media_assets on public.media_assets;
create trigger trg_touch_media_assets before update on public.media_assets
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_platform_accounts on public.platform_accounts;
create trigger trg_touch_platform_accounts before update on public.platform_accounts
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_buffer_accounts on public.buffer_accounts;
create trigger trg_touch_buffer_accounts before update on public.buffer_accounts
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_buffer_profiles on public.buffer_profiles;
create trigger trg_touch_buffer_profiles before update on public.buffer_profiles
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_generation_jobs on public.generation_jobs;
create trigger trg_touch_generation_jobs before update on public.generation_jobs
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_publish_jobs on public.publish_jobs;
create trigger trg_touch_publish_jobs before update on public.publish_jobs
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_utm_profiles on public.utm_profiles;
create trigger trg_touch_utm_profiles before update on public.utm_profiles
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_post_metrics on public.post_metrics;
create trigger trg_touch_post_metrics before update on public.post_metrics
for each row execute function public.touch_updated_at();

commit;
