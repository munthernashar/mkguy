-- Worker runtime metadata
alter table public.generation_jobs
  add column if not exists max_attempts integer not null default 5,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists claimed_by text,
  add column if not exists last_error_code text,
  add column if not exists dead_lettered_at timestamptz;

alter table public.publish_jobs
  add column if not exists lease_expires_at timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists claimed_by text,
  add column if not exists dead_lettered_at timestamptz;

alter table public.generation_jobs
  drop constraint if exists generation_jobs_status_check;
alter table public.generation_jobs
  add constraint generation_jobs_status_check
  check (status in ('queued', 'running', 'completed', 'failed', 'cancelled', 'dead_letter'));

alter table public.publish_jobs
  drop constraint if exists publish_jobs_status_check;
alter table public.publish_jobs
  add constraint publish_jobs_status_check
  check (status in ('queued', 'running', 'published', 'failed', 'cancelled', 'dead_letter'));

create index if not exists idx_publish_jobs_claiming
  on public.publish_jobs (status, next_attempt_at, lease_expires_at, created_at);
create index if not exists idx_generation_jobs_claiming
  on public.generation_jobs (status, next_attempt_at, lease_expires_at, created_at);
create index if not exists idx_publish_jobs_dead_letter
  on public.publish_jobs (status, dead_lettered_at desc);
create index if not exists idx_generation_jobs_dead_letter
  on public.generation_jobs (status, dead_lettered_at desc);

create table if not exists public.job_rate_limit_buckets (
  scope text not null,
  bucket_start timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (scope, bucket_start)
);

alter table public.job_rate_limit_buckets enable row level security;

drop policy if exists "job_rate_limit_buckets_read" on public.job_rate_limit_buckets;
create policy "job_rate_limit_buckets_read" on public.job_rate_limit_buckets
  for select using (public.has_any_role());

drop policy if exists "job_rate_limit_buckets_write_editor_owner" on public.job_rate_limit_buckets;
create policy "job_rate_limit_buckets_write_editor_owner" on public.job_rate_limit_buckets
  for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

create or replace function public.consume_job_rate_limit(
  p_scope text,
  p_limit integer,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket timestamptz := to_timestamp(floor(extract(epoch from now()) / greatest(p_window_seconds, 1)) * greatest(p_window_seconds, 1));
  v_count integer;
begin
  insert into public.job_rate_limit_buckets (scope, bucket_start, request_count)
  values (p_scope, v_bucket, 1)
  on conflict (scope, bucket_start)
  do update set
    request_count = public.job_rate_limit_buckets.request_count + 1,
    updated_at = now()
  returning request_count into v_count;

  return v_count <= greatest(p_limit, 1);
end;
$$;

create or replace function public.classify_job_error(
  p_http_status integer default null,
  p_error_code text default null,
  p_is_timeout boolean default false
)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_is_timeout, false) then 'transient'
    when p_http_status = 429 then 'transient'
    when p_http_status >= 500 then 'transient'
    when p_error_code ilike any (array['%timeout%', '%rate_limit%', '%temporar%', '%network%']) then 'transient'
    when p_http_status in (400, 401) then 'hard'
    else 'hard'
  end;
$$;

create or replace function public.calculate_retry_at(
  p_attempts integer,
  p_base_seconds integer default 30,
  p_max_seconds integer default 3600
)
returns timestamptz
language sql
stable
as $$
  select now()
    + make_interval(secs => least(greatest(p_base_seconds, 1) * (2 ^ greatest(least(p_attempts, 16) - 1, 0))::integer, greatest(p_max_seconds, 1)))
    + make_interval(secs => floor(random() * 10)::integer);
$$;

create or replace function public.apply_publish_job_failure(
  p_job_id uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_is_timeout boolean default false
)
returns public.publish_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.publish_jobs;
  v_new_attempts integer;
  v_error_class text;
  v_next_attempt timestamptz;
  v_target_status text;
begin
  select * into v_job from public.publish_jobs where id = p_job_id for update;
  if not found then
    raise exception 'publish job not found: %', p_job_id;
  end if;

  v_new_attempts := coalesce(v_job.attempts, 0) + 1;
  v_error_class := public.classify_job_error(p_http_status, p_error_code, p_is_timeout);

  if v_error_class = 'transient' and v_new_attempts < coalesce(v_job.max_attempts, 5) then
    v_next_attempt := public.calculate_retry_at(v_new_attempts);
    v_target_status := 'queued';
  else
    v_next_attempt := null;
    v_target_status := 'dead_letter';
  end if;

  update public.publish_jobs
  set
    attempts = v_new_attempts,
    status = v_target_status,
    next_attempt_at = v_next_attempt,
    last_error_code = p_error_code,
    last_error = left(coalesce(p_error_message, p_error_code, 'unknown_error'), 5000),
    lease_expires_at = null,
    claimed_at = null,
    claimed_by = null,
    dead_lettered_at = case when v_target_status = 'dead_letter' then now() else null end,
    updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

create or replace function public.apply_generation_job_failure(
  p_job_id uuid,
  p_error_code text,
  p_error_message text,
  p_http_status integer default null,
  p_is_timeout boolean default false
)
returns public.generation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.generation_jobs;
  v_new_attempts integer;
  v_error_class text;
  v_next_attempt timestamptz;
  v_target_status text;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found then
    raise exception 'generation job not found: %', p_job_id;
  end if;

  v_new_attempts := coalesce(v_job.attempts, 0) + 1;
  v_error_class := public.classify_job_error(p_http_status, p_error_code, p_is_timeout);

  if v_error_class = 'transient' and v_new_attempts < coalesce(v_job.max_attempts, 5) then
    v_next_attempt := public.calculate_retry_at(v_new_attempts);
    v_target_status := 'queued';
  else
    v_next_attempt := null;
    v_target_status := 'dead_letter';
  end if;

  update public.generation_jobs
  set
    attempts = v_new_attempts,
    status = v_target_status,
    next_attempt_at = v_next_attempt,
    last_error_code = p_error_code,
    error_message = left(coalesce(p_error_message, p_error_code, 'unknown_error'), 5000),
    lease_expires_at = null,
    claimed_at = null,
    claimed_by = null,
    dead_lettered_at = case when v_target_status = 'dead_letter' then now() else null end,
    updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

create or replace function public.run_publish_jobs(
  p_worker_id text default 'worker',
  p_batch_size integer default 20,
  p_lease_seconds integer default 120,
  p_provider_limit integer default 30,
  p_profile_limit integer default 20,
  p_user_campaign_limit integer default 40,
  p_window_seconds integer default 60,
  p_defer_seconds integer default 60
)
returns table (claimed_job_id uuid, action text, reason text, next_attempt_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_ok_provider boolean;
  v_ok_profile boolean;
  v_ok_user_campaign boolean;
  v_campaign_id uuid;
  v_next timestamptz;
  v_processed integer := 0;
begin
  for v_row in
    select j.id, j.provider, j.buffer_profile_id, j.initiated_by, p.campaign_id
    from public.publish_jobs j
    left join public.posts p on p.id = j.post_id
    where j.status = 'queued'
      and coalesce(j.next_attempt_at, j.created_at) <= now()
      and (j.lease_expires_at is null or j.lease_expires_at <= now())
      and j.deleted_at is null
    order by coalesce(j.next_attempt_at, j.created_at), j.created_at
    for update of j skip locked
    limit greatest(p_batch_size, 1) * 3
  loop
    v_campaign_id := v_row.campaign_id;
    v_ok_provider := public.consume_job_rate_limit('provider:' || coalesce(v_row.provider, 'unknown'), p_provider_limit, p_window_seconds);
    v_ok_profile := public.consume_job_rate_limit('profile:' || coalesce(v_row.buffer_profile_id::text, 'none'), p_profile_limit, p_window_seconds);
    v_ok_user_campaign := public.consume_job_rate_limit(
      'user_campaign:' || coalesce(v_row.initiated_by::text, 'none') || ':' || coalesce(v_campaign_id::text, 'none'),
      p_user_campaign_limit,
      p_window_seconds
    );

    if v_ok_provider and v_ok_profile and v_ok_user_campaign then
      update public.publish_jobs
      set status = 'running',
          lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
          claimed_at = now(),
          claimed_by = p_worker_id,
          updated_at = now()
      where id = v_row.id
      returning id, 'claimed', null::text, null::timestamptz
      into claimed_job_id, action, reason, next_attempt_at;

      v_processed := v_processed + 1;
      return next;
    else
      v_next := now() + make_interval(secs => greatest(p_defer_seconds, 15));
      update public.publish_jobs
      set status = 'queued',
          next_attempt_at = v_next,
          last_error_code = 'rate_limited_deferred',
          last_error = 'Rate limit reached for provider/profile/user-campaign scope. Job deferred.',
          updated_at = now()
      where id = v_row.id;

      claimed_job_id := v_row.id;
      action := 'deferred';
      reason := 'rate_limit';
      next_attempt_at := v_next;
      v_processed := v_processed + 1;
      return next;
    end if;

    exit when v_processed >= greatest(p_batch_size, 1);
  end loop;
end;
$$;

create or replace function public.run_generation_jobs(
  p_worker_id text default 'worker',
  p_batch_size integer default 20,
  p_lease_seconds integer default 120
)
returns table (claimed_job_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select g.id
    from public.generation_jobs g
    where g.status = 'queued'
      and coalesce(g.next_attempt_at, g.created_at) <= now()
      and (g.lease_expires_at is null or g.lease_expires_at <= now())
      and g.deleted_at is null
    order by coalesce(g.next_attempt_at, g.created_at), g.created_at
    for update skip locked
    limit greatest(p_batch_size, 1)
  ), updated as (
    update public.generation_jobs g
    set status = 'running',
        started_at = coalesce(g.started_at, now()),
        lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 10)),
        claimed_at = now(),
        claimed_by = p_worker_id,
        updated_at = now()
    from picked
    where g.id = picked.id
    returning g.id
  )
  select id from updated;
end;
$$;

create or replace function public.recover_stuck_jobs(
  p_requeue_delay_seconds integer default 30
)
returns table (job_type text, job_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with recovered_publish as (
    update public.publish_jobs
    set status = 'queued',
        next_attempt_at = now() + make_interval(secs => greatest(p_requeue_delay_seconds, 5)),
        lease_expires_at = null,
        claimed_at = null,
        claimed_by = null,
        last_error_code = 'lease_timeout_recovered',
        last_error = 'Worker lease expired. Job re-queued automatically.',
        updated_at = now()
    where status = 'running'
      and lease_expires_at is not null
      and lease_expires_at < now()
    returning id
  ), recovered_generation as (
    update public.generation_jobs
    set status = 'queued',
        next_attempt_at = now() + make_interval(secs => greatest(p_requeue_delay_seconds, 5)),
        lease_expires_at = null,
        claimed_at = null,
        claimed_by = null,
        last_error_code = 'lease_timeout_recovered',
        error_message = 'Worker lease expired. Job re-queued automatically.',
        updated_at = now()
    where status = 'running'
      and lease_expires_at is not null
      and lease_expires_at < now()
    returning id
  )
  select 'publish'::text, id from recovered_publish
  union all
  select 'generation'::text, id from recovered_generation;
end;
$$;

create or replace function public.job_monitoring_dashboard(p_window_hours integer default 24)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := now() - make_interval(hours => greatest(p_window_hours, 1));
begin
  return jsonb_build_object(
    'publish_status_distribution', (
      select coalesce(jsonb_object_agg(status, cnt), '{}'::jsonb)
      from (
        select status, count(*)::integer as cnt
        from public.publish_jobs
        where created_at >= v_from
        group by status
      ) s
    ),
    'generation_status_distribution', (
      select coalesce(jsonb_object_agg(status, cnt), '{}'::jsonb)
      from (
        select status, count(*)::integer as cnt
        from public.generation_jobs
        where created_at >= v_from
        group by status
      ) s
    ),
    'top_error_codes', (
      select coalesce(jsonb_agg(t), '[]'::jsonb)
      from (
        select coalesce(last_error_code, 'unknown') as code, count(*)::integer as count
        from public.publish_jobs
        where updated_at >= v_from and last_error_code is not null
        group by coalesce(last_error_code, 'unknown')
        order by count desc
        limit 10
      ) t
    ),
    'error_list', (
      select coalesce(jsonb_agg(e), '[]'::jsonb)
      from (
        select id, status, provider, last_error_code, left(coalesce(last_error, ''), 300) as last_error, updated_at
        from public.publish_jobs
        where updated_at >= v_from and last_error_code is not null
        order by updated_at desc
        limit 50
      ) e
    ),
    'success_rate', (
      select case when count(*) = 0 then 0 else round((count(*) filter (where status = 'published'))::numeric / count(*)::numeric, 4) end
      from public.publish_jobs
      where updated_at >= v_from
    ),
    'publish_latency_seconds', (
      select coalesce(round(avg(extract(epoch from (published_at - created_at)))), 0)
      from public.publish_jobs
      where published_at is not null and created_at >= v_from
    ),
    'dead_letter', (
      jsonb_build_object(
        'publish', (select count(*)::integer from public.publish_jobs where status = 'dead_letter'),
        'generation', (select count(*)::integer from public.generation_jobs where status = 'dead_letter')
      )
    )
  );
end;
$$;

create or replace function public.job_detail_redacted(p_job_type text, p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if p_job_type = 'publish' then
    select jsonb_build_object(
      'id', id,
      'status', status,
      'provider', provider,
      'attempts', attempts,
      'max_attempts', max_attempts,
      'next_attempt_at', next_attempt_at,
      'last_error_code', last_error_code,
      'last_error', last_error,
      'payload', (coalesce(debug_payload, '{}'::jsonb) - 'access_token' - 'refresh_token' - 'token' - 'authorization'),
      'claimed_by', claimed_by,
      'claimed_at', claimed_at,
      'lease_expires_at', lease_expires_at
    ) into v_result
    from public.publish_jobs where id = p_job_id;
  elsif p_job_type = 'generation' then
    select jsonb_build_object(
      'id', id,
      'status', status,
      'provider', provider,
      'model', model,
      'attempts', attempts,
      'max_attempts', max_attempts,
      'next_attempt_at', next_attempt_at,
      'last_error_code', last_error_code,
      'last_error', error_message,
      'request_payload', (coalesce(request_payload, '{}'::jsonb) - 'access_token' - 'refresh_token' - 'token' - 'authorization'),
      'result_payload', (coalesce(result_payload, '{}'::jsonb) - 'access_token' - 'refresh_token' - 'token' - 'authorization'),
      'claimed_by', claimed_by,
      'claimed_at', claimed_at,
      'lease_expires_at', lease_expires_at
    ) into v_result
    from public.generation_jobs where id = p_job_id;
  else
    raise exception 'unsupported_job_type';
  end if;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

create or replace function public.retry_dead_letter_job(p_job_type text, p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_job_type = 'publish' then
    update public.publish_jobs
    set status = 'queued',
        next_attempt_at = now(),
        lease_expires_at = null,
        claimed_at = null,
        claimed_by = null,
        dead_lettered_at = null,
        updated_at = now()
    where id = p_job_id and status = 'dead_letter';
    return found;
  elsif p_job_type = 'generation' then
    update public.generation_jobs
    set status = 'queued',
        next_attempt_at = now(),
        lease_expires_at = null,
        claimed_at = null,
        claimed_by = null,
        dead_lettered_at = null,
        updated_at = now()
    where id = p_job_id and status = 'dead_letter';
    return found;
  end if;
  return false;
end;
$$;

create or replace function public.discard_dead_letter_job(p_job_type text, p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_job_type = 'publish' then
    update public.publish_jobs
    set status = 'cancelled',
        archived_at = coalesce(archived_at, now()),
        updated_at = now()
    where id = p_job_id and status = 'dead_letter';
    return found;
  elsif p_job_type = 'generation' then
    update public.generation_jobs
    set status = 'cancelled',
        archived_at = coalesce(archived_at, now()),
        updated_at = now()
    where id = p_job_id and status = 'dead_letter';
    return found;
  end if;
  return false;
end;
$$;
