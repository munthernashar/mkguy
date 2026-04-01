alter table public.publish_jobs
  add column if not exists provider_status text,
  add column if not exists provider_status_checked_at timestamptz;

create index if not exists idx_publish_jobs_buffer_status_poll
  on public.publish_jobs (provider, status, provider_status_checked_at)
  where provider = 'buffer' and buffer_update_id is not null;

alter table public.buffer_accounts
  add column if not exists token_scheme text not null default 'enc_v1',
  add column if not exists token_rotated_at timestamptz,
  add column if not exists auth_retry_at timestamptz;

alter table public.platform_accounts
  add column if not exists token_scheme text not null default 'enc_v1',
  add column if not exists token_rotated_at timestamptz,
  add column if not exists auth_retry_at timestamptz;
