alter table public.buffer_accounts
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists connected_at timestamptz,
  add column if not exists last_synced_at timestamptz,
  add column if not exists last_sync_error text;

alter table public.buffer_profiles
  add column if not exists raw_payload jsonb not null default '{}'::jsonb,
  add column if not exists last_synced_at timestamptz;

alter table public.publish_jobs
  add column if not exists provider text default 'buffer',
  add column if not exists buffer_update_id text,
  add column if not exists last_error_code text,
  add column if not exists debug_payload jsonb not null default '{}'::jsonb;
