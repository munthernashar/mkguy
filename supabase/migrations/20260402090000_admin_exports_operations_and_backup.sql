begin;

create table if not exists public.admin_settings (
  id integer primary key default 1,
  global_limits jsonb not null default '{"max_posts_per_day": 50, "max_publish_jobs_batch": 100, "max_generation_jobs_batch": 100}'::jsonb,
  default_utm_rules jsonb not null default '{"source": "social", "medium": "organic", "campaign_template": "{campaign_name}", "content_template": "{post_id}"}'::jsonb,
  feature_toggles jsonb not null default '{"enable_csv_exports": true, "enable_dead_letter_ops": true, "enable_direct_publish": true, "enable_seed_overview_export": true}'::jsonb,
  maintenance_mode boolean not null default false,
  maintenance_message text,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_settings_singleton check (id = 1)
);

insert into public.admin_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.job_operation_audit (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users (id) on delete set null,
  operation text not null check (operation in ('retry_selected', 'cancel_running', 'maintenance_mode_changed')),
  job_type text check (job_type in ('publish', 'generation')),
  job_id uuid,
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_settings enable row level security;
alter table public.job_operation_audit enable row level security;

drop policy if exists "admin_settings_read" on public.admin_settings;
create policy "admin_settings_read" on public.admin_settings
  for select using (public.has_any_role());

drop policy if exists "admin_settings_write_owner" on public.admin_settings;
create policy "admin_settings_write_owner" on public.admin_settings
  for all using (public.is_owner()) with check (public.is_owner());

drop policy if exists "job_operation_audit_read_owner" on public.job_operation_audit;
create policy "job_operation_audit_read_owner" on public.job_operation_audit
  for select using (public.is_owner());

drop policy if exists "job_operation_audit_write_editor_owner" on public.job_operation_audit;
create policy "job_operation_audit_write_editor_owner" on public.job_operation_audit
  for insert with check (public.is_editor_or_owner());

create or replace function public.export_posts_csv(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_book_id uuid default null,
  p_campaign_id uuid default null,
  p_platform text default null
)
returns text
language sql
security definer
set search_path = public
as $$
  with rows as (
    select
      p.id,
      p.title,
      p.workflow_status,
      p.scheduled_at,
      p.published_at,
      p.created_at,
      b.id as book_id,
      b.title as book_title,
      c.id as campaign_id,
      c.name as campaign_name,
      coalesce(pa.platform, bp.service) as platform
    from public.posts p
    left join public.books b on b.id = p.book_id
    left join public.campaigns c on c.id = p.campaign_id
    left join public.platform_accounts pa on pa.id = p.platform_account_id
    left join public.buffer_profiles bp on bp.id = p.buffer_profile_id
    where p.deleted_at is null
      and (p_from is null or p.created_at >= p_from)
      and (p_to is null or p.created_at <= p_to)
      and (p_book_id is null or p.book_id = p_book_id)
      and (p_campaign_id is null or p.campaign_id = p_campaign_id)
      and (p_platform is null or lower(coalesce(pa.platform, bp.service, '')) = lower(p_platform))
  )
  select 'post_id,title,workflow_status,scheduled_at,published_at,created_at,book_id,book_title,campaign_id,campaign_name,platform' || E'\n'
    || coalesce(string_agg(
      array_to_string(array[
        quote_nullable(id::text),
        quote_nullable(title),
        quote_nullable(workflow_status),
        quote_nullable(scheduled_at::text),
        quote_nullable(published_at::text),
        quote_nullable(created_at::text),
        quote_nullable(book_id::text),
        quote_nullable(book_title),
        quote_nullable(campaign_id::text),
        quote_nullable(campaign_name),
        quote_nullable(platform)
      ], ','),
      E'\n' order by created_at desc
    ), '')
  from rows;
$$;

create or replace function public.export_publish_jobs_csv(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_book_id uuid default null,
  p_campaign_id uuid default null,
  p_platform text default null
)
returns text
language sql
security definer
set search_path = public
as $$
  with rows as (
    select
      j.id,
      j.post_id,
      j.status,
      j.attempts,
      j.max_attempts,
      j.claimed_by,
      j.last_error_code,
      j.published_at,
      j.created_at,
      p.book_id,
      p.campaign_id,
      coalesce(pa.platform, bp.service) as platform
    from public.publish_jobs j
    join public.posts p on p.id = j.post_id
    left join public.platform_accounts pa on pa.id = p.platform_account_id
    left join public.buffer_profiles bp on bp.id = coalesce(j.buffer_profile_id, p.buffer_profile_id)
    where j.deleted_at is null
      and (p_from is null or j.created_at >= p_from)
      and (p_to is null or j.created_at <= p_to)
      and (p_book_id is null or p.book_id = p_book_id)
      and (p_campaign_id is null or p.campaign_id = p_campaign_id)
      and (p_platform is null or lower(coalesce(pa.platform, bp.service, '')) = lower(p_platform))
  )
  select 'publish_job_id,post_id,status,attempts,max_attempts,claimed_by,last_error_code,published_at,created_at,book_id,campaign_id,platform' || E'\n'
    || coalesce(string_agg(
      array_to_string(array[
        quote_nullable(id::text),
        quote_nullable(post_id::text),
        quote_nullable(status),
        quote_nullable(attempts::text),
        quote_nullable(max_attempts::text),
        quote_nullable(claimed_by),
        quote_nullable(last_error_code),
        quote_nullable(published_at::text),
        quote_nullable(created_at::text),
        quote_nullable(book_id::text),
        quote_nullable(campaign_id::text),
        quote_nullable(platform)
      ], ','),
      E'\n' order by created_at desc
    ), '')
  from rows;
$$;

create or replace function public.export_kpi_metrics_csv(
  p_from date default null,
  p_to date default null,
  p_book_id uuid default null,
  p_campaign_id uuid default null,
  p_platform text default null
)
returns text
language sql
security definer
set search_path = public
as $$
  with rows as (
    select
      m.metric_date,
      m.post_id,
      p.book_id,
      p.campaign_id,
      coalesce(pa.platform, bp.service) as platform,
      m.impressions,
      m.reach,
      m.clicks,
      m.likes,
      m.comments,
      m.shares,
      m.saves
    from public.post_metrics m
    join public.posts p on p.id = m.post_id
    left join public.platform_accounts pa on pa.id = coalesce(m.platform_account_id, p.platform_account_id)
    left join public.buffer_profiles bp on bp.id = p.buffer_profile_id
    where (p_from is null or m.metric_date >= p_from)
      and (p_to is null or m.metric_date <= p_to)
      and (p_book_id is null or p.book_id = p_book_id)
      and (p_campaign_id is null or p.campaign_id = p_campaign_id)
      and (p_platform is null or lower(coalesce(pa.platform, bp.service, '')) = lower(p_platform))
  )
  select 'metric_date,post_id,book_id,campaign_id,platform,impressions,reach,clicks,likes,comments,shares,saves,engagement_total' || E'\n'
    || coalesce(string_agg(
      array_to_string(array[
        quote_nullable(metric_date::text),
        quote_nullable(post_id::text),
        quote_nullable(book_id::text),
        quote_nullable(campaign_id::text),
        quote_nullable(platform),
        quote_nullable(impressions::text),
        quote_nullable(reach::text),
        quote_nullable(clicks::text),
        quote_nullable(likes::text),
        quote_nullable(comments::text),
        quote_nullable(shares::text),
        quote_nullable(saves::text),
        quote_nullable((likes + comments + shares + saves)::text)
      ], ','),
      E'\n' order by metric_date desc
    ), '')
  from rows;
$$;

create or replace function public.export_campaigns_csv(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_book_id uuid default null,
  p_campaign_id uuid default null,
  p_platform text default null
)
returns text
language sql
security definer
set search_path = public
as $$
  with rows as (
    select
      c.id,
      c.name,
      c.status,
      c.starts_at,
      c.ends_at,
      c.created_at,
      min(p.book_id::text) as book_id,
      count(distinct p.id) as post_count,
      count(distinct case when p.workflow_status = 'published' then p.id end) as published_post_count,
      string_agg(distinct coalesce(pa.platform, bp.service), '|' order by coalesce(pa.platform, bp.service)) as platforms
    from public.campaigns c
    left join public.posts p on p.campaign_id = c.id and p.deleted_at is null
    left join public.platform_accounts pa on pa.id = p.platform_account_id
    left join public.buffer_profiles bp on bp.id = p.buffer_profile_id
    where c.deleted_at is null
      and (p_from is null or c.created_at >= p_from)
      and (p_to is null or c.created_at <= p_to)
      and (
        p_book_id is null
        or exists (
          select 1
          from public.posts pb
          where pb.campaign_id = c.id
            and pb.book_id = p_book_id
            and pb.deleted_at is null
        )
      )
      and (p_campaign_id is null or c.id = p_campaign_id)
      and (p_platform is null or exists (
        select 1
        from public.posts px
        left join public.platform_accounts pax on pax.id = px.platform_account_id
        left join public.buffer_profiles bpx on bpx.id = px.buffer_profile_id
        where px.campaign_id = c.id
          and lower(coalesce(pax.platform, bpx.service, '')) = lower(p_platform)
      ))
    group by c.id
  )
  select 'campaign_id,name,status,starts_at,ends_at,created_at,book_id,post_count,published_post_count,platforms' || E'\n'
    || coalesce(string_agg(
      array_to_string(array[
        quote_nullable(id::text),
        quote_nullable(name),
        quote_nullable(status),
        quote_nullable(starts_at::text),
        quote_nullable(ends_at::text),
        quote_nullable(created_at::text),
        quote_nullable(book_id::text),
        quote_nullable(post_count::text),
        quote_nullable(published_post_count::text),
        quote_nullable(platforms)
      ], ','),
      E'\n' order by created_at desc
    ), '')
  from rows;
$$;

create or replace function public.export_book_seed_overview_csv(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_book_id uuid default null,
  p_campaign_id uuid default null,
  p_platform text default null
)
returns text
language sql
security definer
set search_path = public
as $$
  with rows as (
    select
      b.id,
      b.title,
      b.status,
      b.created_at,
      count(distinct d.id) as document_count,
      count(distinct i.id) as insight_count,
      count(distinct c.id) filter (where p_campaign_id is null or c.id = p_campaign_id) as campaign_count,
      count(distinct p.id) filter (
        where p_platform is null
          or exists (
            select 1 from public.platform_accounts pa
            where pa.id = p.platform_account_id and lower(pa.platform) = lower(p_platform)
          )
          or exists (
            select 1 from public.buffer_profiles bp
            where bp.id = p.buffer_profile_id and lower(bp.service) = lower(p_platform)
          )
      ) as post_count
    from public.books b
    left join public.book_documents d on d.book_id = b.id and d.deleted_at is null
    left join public.book_insights i on i.book_id = b.id and i.deleted_at is null
    left join public.campaigns c
      on c.deleted_at is null
      and exists (
        select 1
        from public.posts cp
        where cp.campaign_id = c.id
          and cp.book_id = b.id
          and cp.deleted_at is null
      )
    left join public.posts p on p.book_id = b.id and p.deleted_at is null
    where b.deleted_at is null
      and (p_from is null or b.created_at >= p_from)
      and (p_to is null or b.created_at <= p_to)
      and (p_book_id is null or b.id = p_book_id)
    group by b.id
  )
  select 'book_id,title,status,created_at,document_count,insight_count,campaign_count,post_count' || E'\n'
    || coalesce(string_agg(
      array_to_string(array[
        quote_nullable(id::text),
        quote_nullable(title),
        quote_nullable(status),
        quote_nullable(created_at::text),
        quote_nullable(document_count::text),
        quote_nullable(insight_count::text),
        quote_nullable(campaign_count::text),
        quote_nullable(post_count::text)
      ], ','),
      E'\n' order by created_at desc
    ), '')
  from rows;
$$;

create or replace function public.list_dead_letter_jobs(
  p_job_type text default null,
  p_limit integer default 200
)
returns table (
  job_type text,
  job_id uuid,
  status text,
  attempts integer,
  max_attempts integer,
  last_error_code text,
  error_message text,
  dead_lettered_at timestamptz,
  post_id uuid,
  campaign_id uuid
)
language sql
security definer
set search_path = public
as $$
  select * from (
    select
      'publish'::text as job_type,
      j.id as job_id,
      j.status,
      j.attempts,
      j.max_attempts,
      j.last_error_code,
      j.last_error as error_message,
      j.dead_lettered_at,
      j.post_id,
      p.campaign_id
    from public.publish_jobs j
    left join public.posts p on p.id = j.post_id
    where j.status = 'dead_letter'

    union all

    select
      'generation'::text as job_type,
      g.id as job_id,
      g.status,
      g.attempts,
      g.max_attempts,
      g.last_error_code,
      g.error_message,
      g.dead_lettered_at,
      g.post_id,
      g.campaign_id
    from public.generation_jobs g
    where g.status = 'dead_letter'
  ) q
  where (p_job_type is null or q.job_type = p_job_type)
  order by q.dead_lettered_at desc nulls last
  limit greatest(p_limit, 1);
$$;

create or replace function public.retry_selected_jobs(
  p_job_type text,
  p_job_ids uuid[],
  p_reason text default 'manual_retry_selected'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if p_job_ids is null or array_length(p_job_ids, 1) is null then
    return 0;
  end if;

  if p_job_type = 'publish' then
    update public.publish_jobs
    set status = 'queued',
        next_attempt_at = now(),
        lease_expires_at = null,
        claimed_at = null,
        claimed_by = null,
        dead_lettered_at = null,
        updated_at = now()
    where id = any(p_job_ids)
      and status in ('dead_letter', 'failed', 'cancelled');

    get diagnostics v_count = row_count;

    insert into public.job_operation_audit (actor_user_id, operation, job_type, job_id, reason, details)
    select auth.uid(), 'retry_selected', 'publish', unnest(p_job_ids), p_reason, jsonb_build_object('updated_rows', v_count);
  elsif p_job_type = 'generation' then
    update public.generation_jobs
    set status = 'queued',
        next_attempt_at = now(),
        lease_expires_at = null,
        claimed_at = null,
        claimed_by = null,
        dead_lettered_at = null,
        updated_at = now()
    where id = any(p_job_ids)
      and status in ('dead_letter', 'failed', 'cancelled');

    get diagnostics v_count = row_count;

    insert into public.job_operation_audit (actor_user_id, operation, job_type, job_id, reason, details)
    select auth.uid(), 'retry_selected', 'generation', unnest(p_job_ids), p_reason, jsonb_build_object('updated_rows', v_count);
  else
    raise exception 'unsupported job type: %', p_job_type;
  end if;

  perform public.write_audit_log(
    'jobs_retry_selected',
    'job_queue',
    null,
    jsonb_build_object('job_type', p_job_type, 'job_ids', p_job_ids, 'updated_rows', v_count, 'reason', p_reason)
  );

  return v_count;
end;
$$;

create or replace function public.cancel_running_job(
  p_job_type text,
  p_job_id uuid,
  p_reason text default 'manual_cancel_running'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
begin
  if p_job_type = 'publish' then
    update public.publish_jobs
    set status = 'cancelled',
        lease_expires_at = null,
        claimed_at = null,
        claimed_by = null,
        last_error_code = coalesce(last_error_code, 'manual_cancelled'),
        last_error = coalesce(last_error, p_reason),
        updated_at = now()
    where id = p_job_id
      and status = 'running';
    get diagnostics v_updated = row_count;
  elsif p_job_type = 'generation' then
    update public.generation_jobs
    set status = 'cancelled',
        lease_expires_at = null,
        claimed_at = null,
        claimed_by = null,
        last_error_code = coalesce(last_error_code, 'manual_cancelled'),
        error_message = coalesce(error_message, p_reason),
        updated_at = now()
    where id = p_job_id
      and status = 'running';
    get diagnostics v_updated = row_count;
  else
    raise exception 'unsupported job type: %', p_job_type;
  end if;

  if v_updated > 0 then
    insert into public.job_operation_audit (actor_user_id, operation, job_type, job_id, reason)
    values (auth.uid(), 'cancel_running', p_job_type, p_job_id, p_reason);

    perform public.write_audit_log(
      'job_cancelled_running',
      'job_queue',
      p_job_id::text,
      jsonb_build_object('job_type', p_job_type, 'reason', p_reason)
    );

    return true;
  end if;

  return false;
end;
$$;

create or replace function public.set_maintenance_mode(
  p_enabled boolean,
  p_message text default null
)
returns public.admin_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.admin_settings;
begin
  update public.admin_settings
  set maintenance_mode = coalesce(p_enabled, false),
      maintenance_message = left(p_message, 2000),
      updated_by = auth.uid(),
      updated_at = now()
  where id = 1
  returning * into v_settings;

  insert into public.job_operation_audit (actor_user_id, operation, reason, details)
  values (
    auth.uid(),
    'maintenance_mode_changed',
    case when p_enabled then 'enabled' else 'disabled' end,
    jsonb_build_object('maintenance_mode', p_enabled, 'maintenance_message', left(coalesce(p_message, ''), 2000))
  );

  perform public.write_audit_log(
    'maintenance_mode_changed',
    'admin_settings',
    '1',
    jsonb_build_object('maintenance_mode', p_enabled, 'maintenance_message', left(coalesce(p_message, ''), 2000))
  );

  return v_settings;
end;
$$;

commit;
