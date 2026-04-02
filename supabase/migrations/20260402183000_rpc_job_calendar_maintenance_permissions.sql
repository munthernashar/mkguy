begin;

drop function if exists public.schedule_calendar_event(
  uuid,
  uuid,
  text,
  timestamptz,
  timestamptz,
  text,
  boolean
);

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

create or replace function public.retry_dead_letter_job(
  p_job_type text,
  p_job_id uuid
)
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

create or replace function public.schedule_calendar_event(
  p_event_id uuid default null,
  p_post_id uuid default null,
  p_campaign_id uuid default null,
  p_platform text default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_timezone text default 'UTC',
  p_approval_required boolean default true,
  p_reason text default null
)
returns public.calendar_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflicts jsonb;
  v_row public.calendar_events;
  v_source public.calendar_events;
  v_post_id uuid;
  v_campaign_id uuid;
  v_platform text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_timezone text;
  v_approval_required boolean;
begin
  if p_event_id is not null then
    select *
      into v_source
    from public.calendar_events ce
    where ce.id = p_event_id;

    if not found then
      raise exception 'calendar_event_not_found';
    end if;
  end if;

  v_post_id := coalesce(p_post_id, v_source.post_id);
  v_campaign_id := coalesce(p_campaign_id, v_source.campaign_id);
  v_platform := coalesce(nullif(p_platform, ''), v_source.platform);
  v_starts_at := coalesce(p_starts_at, v_source.starts_at);
  v_ends_at := coalesce(p_ends_at, v_source.ends_at);
  v_timezone := coalesce(nullif(p_timezone, ''), v_source.timezone, 'UTC');
  v_approval_required := coalesce(p_approval_required, v_source.approval_required, true);

  if v_post_id is null then
    raise exception 'p_post_id_required';
  end if;

  if v_platform is null then
    raise exception 'p_platform_required';
  end if;

  if v_starts_at is null then
    raise exception 'p_starts_at_required';
  end if;

  v_conflicts := public.detect_calendar_conflicts(v_post_id, v_campaign_id, v_platform, v_starts_at, v_approval_required);

  insert into public.calendar_events (
    post_id,
    campaign_id,
    platform,
    starts_at,
    ends_at,
    timezone,
    approval_required,
    scheduled_by,
    conflict_flags,
    notes,
    status
  )
  values (
    v_post_id,
    v_campaign_id,
    v_platform,
    v_starts_at,
    v_ends_at,
    v_timezone,
    v_approval_required,
    auth.uid(),
    v_conflicts,
    case when p_reason is null then null else left(p_reason, 1000) end,
    'scheduled'
  )
  on conflict (post_id)
  do update set
    campaign_id = excluded.campaign_id,
    platform = excluded.platform,
    starts_at = excluded.starts_at,
    ends_at = excluded.ends_at,
    timezone = excluded.timezone,
    approval_required = excluded.approval_required,
    scheduled_by = excluded.scheduled_by,
    conflict_flags = excluded.conflict_flags,
    notes = coalesce(excluded.notes, public.calendar_events.notes),
    status = 'rescheduled',
    updated_at = now(),
    version = public.calendar_events.version + 1
  returning * into v_row;

  update public.posts
  set scheduled_at = v_starts_at,
      workflow_status = 'scheduled',
      updated_at = now(),
      version = version + 1
  where id = v_post_id;

  return v_row;
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
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if not public.is_owner() then
    raise exception 'insufficient_privilege_owner_required';
  end if;

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

revoke all on function public.recover_stuck_jobs(integer) from public;
revoke all on function public.recover_stuck_jobs(integer) from anon;
grant execute on function public.recover_stuck_jobs(integer) to authenticated;
grant execute on function public.recover_stuck_jobs(integer) to service_role;

revoke all on function public.retry_dead_letter_job(text, uuid) from public;
revoke all on function public.retry_dead_letter_job(text, uuid) from anon;
grant execute on function public.retry_dead_letter_job(text, uuid) to authenticated;
grant execute on function public.retry_dead_letter_job(text, uuid) to service_role;

revoke all on function public.schedule_calendar_event(uuid, uuid, uuid, text, timestamptz, timestamptz, text, boolean, text) from public;
revoke all on function public.schedule_calendar_event(uuid, uuid, uuid, text, timestamptz, timestamptz, text, boolean, text) from anon;
grant execute on function public.schedule_calendar_event(uuid, uuid, uuid, text, timestamptz, timestamptz, text, boolean, text) to authenticated;
grant execute on function public.schedule_calendar_event(uuid, uuid, uuid, text, timestamptz, timestamptz, text, boolean, text) to service_role;

revoke all on function public.set_maintenance_mode(boolean, text) from public;
revoke all on function public.set_maintenance_mode(boolean, text) from anon;
grant execute on function public.set_maintenance_mode(boolean, text) to authenticated;
grant execute on function public.set_maintenance_mode(boolean, text) to service_role;

commit;
