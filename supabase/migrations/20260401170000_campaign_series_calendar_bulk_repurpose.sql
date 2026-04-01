begin;

alter table public.campaigns
  add column if not exists campaign_type text not null default 'one_off'
    check (campaign_type in ('one_off', 'series')),
  add column if not exists objective text,
  add column if not exists period_starts_at timestamptz,
  add column if not exists period_ends_at timestamptz,
  add column if not exists platform_mix jsonb not null default '[]'::jsonb,
  add column if not exists cadence jsonb not null default '{}'::jsonb,
  add column if not exists cta_goal text;

create table if not exists public.campaign_series_rules (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null unique references public.campaigns (id) on delete cascade,
  allowed_weekdays int[] not null default array[1,2,3,4,5],
  allowed_times time[] not null default array['09:00'::time],
  topic_rotation jsonb not null default '[]'::jsonb,
  platform_frequencies jsonb not null default '{}'::jsonb,
  timezone text not null default 'UTC',
  status text not null default 'active' check (status in ('active', 'paused', 'archived', 'deleted')),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  check (array_length(allowed_weekdays, 1) > 0),
  check (
    not exists (
      select 1 from unnest(allowed_weekdays) as d
      where d < 0 or d > 6
    )
  )
);

create table if not exists public.evergreen_repost_rules (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  platform text not null check (platform in ('linkedin', 'instagram', 'facebook', 'x', 'tiktok', 'youtube', 'threads', 'pinterest', 'other')),
  min_spacing_days integer not null default 14 check (min_spacing_days >= 1),
  variant_rotation text not null default 'round_robin' check (variant_rotation in ('round_robin', 'least_recent', 'random')),
  min_kpi_metric text,
  min_kpi_threshold numeric(12,4),
  status text not null default 'active' check (status in ('active', 'paused', 'archived', 'deleted')),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  unique (campaign_id, platform)
);

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null unique references public.posts (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  platform text not null check (platform in ('linkedin', 'instagram', 'facebook', 'x', 'tiktok', 'youtube', 'threads', 'pinterest', 'other')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  timezone text not null default 'UTC',
  approval_required boolean not null default true,
  approved_at timestamptz,
  scheduled_by uuid references auth.users (id) on delete set null,
  conflict_flags jsonb not null default '[]'::jsonb,
  status text not null default 'scheduled' check (status in ('scheduled', 'rescheduled', 'cancelled', 'published', 'archived', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  check (ends_at is null or ends_at > starts_at)
);

create index if not exists idx_calendar_events_starts_at on public.calendar_events (starts_at);
create index if not exists idx_calendar_events_campaign_platform on public.calendar_events (campaign_id, platform);

create table if not exists public.bulk_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns (id) on delete set null,
  requested_count integer not null check (requested_count > 0 and requested_count <= 500),
  generation_brief text,
  options jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'archived', 'deleted')),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1
);

create table if not exists public.bulk_scheduler_jobs (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns (id) on delete set null,
  platform text check (platform in ('linkedin', 'instagram', 'facebook', 'x', 'tiktok', 'youtube', 'threads', 'pinterest', 'other')),
  window_start timestamptz not null,
  window_end timestamptz not null,
  timezone text not null default 'UTC',
  max_per_day integer not null default 3 check (max_per_day >= 1),
  options jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'archived', 'deleted')),
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  check (window_end > window_start)
);

alter table public.posts
  add column if not exists approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved', 'rejected')),
  add column if not exists approved_at timestamptz,
  add column if not exists master_post_id uuid references public.posts (id) on delete set null,
  add column if not exists repurpose_notes text,
  add column if not exists repurpose_strategy text
    check (repurpose_strategy in ('tone_shift', 'structure_shift', 'angle_shift', 'format_shift', 'other'));

create table if not exists public.repurpose_rules (
  id uuid primary key default gen_random_uuid(),
  source_platform text not null check (source_platform in ('linkedin', 'instagram', 'facebook', 'x', 'tiktok', 'youtube', 'threads', 'pinterest', 'other')),
  target_platform text not null check (target_platform in ('linkedin', 'instagram', 'facebook', 'x', 'tiktok', 'youtube', 'threads', 'pinterest', 'other')),
  transform_template text not null,
  required_changes jsonb not null default '[]'::jsonb,
  max_similarity numeric(4,3) not null default 0.850 check (max_similarity > 0 and max_similarity < 1),
  is_active boolean not null default true,
  created_by uuid not null references auth.users (id) on delete restrict,
  updated_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_platform, target_platform)
);

create or replace function public.detect_calendar_conflicts(
  p_post_id uuid,
  p_campaign_id uuid,
  p_platform text,
  p_starts_at timestamptz,
  p_approval_required boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflicts jsonb := '[]'::jsonb;
  v_existing_count integer := 0;
  v_missing_approval boolean := false;
  v_platform_daily_limit integer := 6;
  v_platform_day_count integer := 0;
begin
  select count(*) into v_existing_count
  from public.calendar_events ce
  where ce.starts_at between p_starts_at - interval '30 minutes' and p_starts_at + interval '30 minutes'
    and ce.status in ('scheduled', 'rescheduled')
    and ce.post_id <> p_post_id;

  if v_existing_count >= 3 then
    v_conflicts := v_conflicts || jsonb_build_array('overplanning');
  end if;

  if p_approval_required then
    select coalesce(p.approval_status <> 'approved', true)
      into v_missing_approval
    from public.posts p
    where p.id = p_post_id;

    if v_missing_approval then
      v_conflicts := v_conflicts || jsonb_build_array('missing_approval');
    end if;
  end if;

  select count(*) into v_platform_day_count
  from public.calendar_events ce
  where ce.platform = p_platform
    and ce.starts_at::date = p_starts_at::date
    and ce.status in ('scheduled', 'rescheduled');

  if v_platform_day_count >= v_platform_daily_limit then
    v_conflicts := v_conflicts || jsonb_build_array('platform_limit');
  end if;

  return v_conflicts;
end;
$$;

create or replace function public.schedule_calendar_event(
  p_post_id uuid,
  p_campaign_id uuid,
  p_platform text,
  p_starts_at timestamptz,
  p_ends_at timestamptz default null,
  p_timezone text default 'UTC',
  p_approval_required boolean default true
)
returns public.calendar_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflicts jsonb;
  v_row public.calendar_events;
begin
  v_conflicts := public.detect_calendar_conflicts(p_post_id, p_campaign_id, p_platform, p_starts_at, p_approval_required);

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
    status
  )
  values (
    p_post_id,
    p_campaign_id,
    p_platform,
    p_starts_at,
    p_ends_at,
    p_timezone,
    p_approval_required,
    auth.uid(),
    v_conflicts,
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
    status = 'rescheduled',
    updated_at = now(),
    version = public.calendar_events.version + 1
  returning * into v_row;

  update public.posts
  set scheduled_at = p_starts_at,
      workflow_status = 'scheduled',
      updated_at = now(),
      version = version + 1
  where id = p_post_id;

  return v_row;
end;
$$;

create or replace function public.bulk_schedule_approved_posts(
  p_campaign_id uuid,
  p_platform text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_slot_interval_minutes integer default 120,
  p_max_per_day integer default 3
)
returns table (post_id uuid, scheduled_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cursor timestamptz := p_window_start;
  v_post record;
  v_today_count integer;
begin
  if p_window_end <= p_window_start then
    raise exception 'window_end must be after window_start';
  end if;

  for v_post in
    select p.id
    from public.posts p
    where p.campaign_id = p_campaign_id
      and p.platform = p_platform
      and p.approval_status = 'approved'
      and p.workflow_status in ('ready', 'draft', 'queued', 'failed')
    order by p.created_at
  loop
    loop
      exit when v_cursor > p_window_end;

      select count(*) into v_today_count
      from public.calendar_events ce
      where ce.platform = p_platform
        and ce.starts_at::date = v_cursor::date
        and ce.status in ('scheduled', 'rescheduled');

      if v_today_count < p_max_per_day then
        perform public.schedule_calendar_event(
          v_post.id,
          p_campaign_id,
          p_platform,
          v_cursor,
          null,
          'UTC',
          true
        );

        post_id := v_post.id;
        scheduled_at := v_cursor;
        return next;

        v_cursor := v_cursor + make_interval(mins => p_slot_interval_minutes);
        exit;
      end if;

      v_cursor := date_trunc('day', v_cursor) + interval '1 day' + interval '09 hours';
    end loop;
  end loop;

  return;
end;
$$;

create or replace function public.create_repurposed_post(
  p_master_post_id uuid,
  p_target_platform text,
  p_title text,
  p_body text,
  p_created_by uuid
)
returns public.posts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_master public.posts;
  v_new_post public.posts;
begin
  select *
  into v_master
  from public.posts
  where id = p_master_post_id
    and deleted_at is null;

  if not found then
    raise exception 'Master post % not found', p_master_post_id;
  end if;

  if lower(trim(coalesce(v_master.body, ''))) = lower(trim(coalesce(p_body, ''))) then
    raise exception 'Repurposed copy must not be a 1:1 copy of master post';
  end if;

  insert into public.posts (
    campaign_id,
    title,
    body,
    status,
    workflow_status,
    platform,
    language,
    created_by,
    updated_by,
    master_post_id,
    repurpose_strategy,
    repurpose_notes
  )
  values (
    v_master.campaign_id,
    coalesce(p_title, v_master.title || ' (' || p_target_platform || ')'),
    p_body,
    'draft',
    'draft',
    p_target_platform,
    v_master.language,
    p_created_by,
    p_created_by,
    p_master_post_id,
    'format_shift',
    'Repurposed from master post with platform-specific adaptation.'
  )
  returning * into v_new_post;

  return v_new_post;
end;
$$;

create or replace view public.calendar_events_month_view as
select *
from public.calendar_events
where starts_at >= date_trunc('month', now())
  and starts_at < date_trunc('month', now()) + interval '1 month';

create or replace view public.calendar_events_week_view as
select *
from public.calendar_events
where starts_at >= date_trunc('week', now())
  and starts_at < date_trunc('week', now()) + interval '1 week';

create or replace view public.calendar_events_day_view as
select *
from public.calendar_events
where starts_at >= date_trunc('day', now())
  and starts_at < date_trunc('day', now()) + interval '1 day';

alter table public.campaign_series_rules enable row level security;
alter table public.evergreen_repost_rules enable row level security;
alter table public.calendar_events enable row level security;
alter table public.bulk_generation_jobs enable row level security;
alter table public.bulk_scheduler_jobs enable row level security;
alter table public.repurpose_rules enable row level security;

drop policy if exists "campaign_series_rules_read" on public.campaign_series_rules;
create policy "campaign_series_rules_read" on public.campaign_series_rules
for select using (public.has_any_role());
drop policy if exists "campaign_series_rules_write" on public.campaign_series_rules;
create policy "campaign_series_rules_write" on public.campaign_series_rules
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "evergreen_repost_rules_read" on public.evergreen_repost_rules;
create policy "evergreen_repost_rules_read" on public.evergreen_repost_rules
for select using (public.has_any_role());
drop policy if exists "evergreen_repost_rules_write" on public.evergreen_repost_rules;
create policy "evergreen_repost_rules_write" on public.evergreen_repost_rules
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "calendar_events_read" on public.calendar_events;
create policy "calendar_events_read" on public.calendar_events
for select using (public.has_any_role());
drop policy if exists "calendar_events_write" on public.calendar_events;
create policy "calendar_events_write" on public.calendar_events
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "bulk_generation_jobs_read" on public.bulk_generation_jobs;
create policy "bulk_generation_jobs_read" on public.bulk_generation_jobs
for select using (public.is_editor_or_owner());
drop policy if exists "bulk_generation_jobs_write" on public.bulk_generation_jobs;
create policy "bulk_generation_jobs_write" on public.bulk_generation_jobs
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "bulk_scheduler_jobs_read" on public.bulk_scheduler_jobs;
create policy "bulk_scheduler_jobs_read" on public.bulk_scheduler_jobs
for select using (public.is_editor_or_owner());
drop policy if exists "bulk_scheduler_jobs_write" on public.bulk_scheduler_jobs;
create policy "bulk_scheduler_jobs_write" on public.bulk_scheduler_jobs
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "repurpose_rules_read" on public.repurpose_rules;
create policy "repurpose_rules_read" on public.repurpose_rules
for select using (public.has_any_role());
drop policy if exists "repurpose_rules_write" on public.repurpose_rules;
create policy "repurpose_rules_write" on public.repurpose_rules
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop trigger if exists trg_touch_campaign_series_rules on public.campaign_series_rules;
create trigger trg_touch_campaign_series_rules before update on public.campaign_series_rules
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_evergreen_repost_rules on public.evergreen_repost_rules;
create trigger trg_touch_evergreen_repost_rules before update on public.evergreen_repost_rules
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_calendar_events on public.calendar_events;
create trigger trg_touch_calendar_events before update on public.calendar_events
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_bulk_generation_jobs on public.bulk_generation_jobs;
create trigger trg_touch_bulk_generation_jobs before update on public.bulk_generation_jobs
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_bulk_scheduler_jobs on public.bulk_scheduler_jobs;
create trigger trg_touch_bulk_scheduler_jobs before update on public.bulk_scheduler_jobs
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_repurpose_rules on public.repurpose_rules;
create trigger trg_touch_repurpose_rules before update on public.repurpose_rules
for each row execute function public.touch_updated_at();

commit;
