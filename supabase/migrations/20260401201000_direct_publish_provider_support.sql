alter table public.platform_accounts
  add column if not exists access_token_ref text,
  add column if not exists refresh_token_ref text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists secure_metadata jsonb not null default '{}'::jsonb;

alter table public.publish_jobs
  add column if not exists direct_post_id text,
  add column if not exists diagnostic_path text;
