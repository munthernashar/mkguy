begin;

alter table public.posts
  add column if not exists destination_url text,
  add column if not exists utm_url text,
  add column if not exists utm_manual_override boolean not null default false,
  add column if not exists selected_variant_id uuid references public.post_variants (id) on delete set null;

create table if not exists public.utm_builder_rules (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users (id) on delete set null,
  name text not null,
  source_template text not null default '{{platform}}',
  medium_template text not null default 'social',
  campaign_template text not null default '{{campaign_name}}',
  term_template text,
  content_template text,
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, name)
);

alter table public.post_variants
  add column if not exists hook_text text,
  add column if not exists cta_text text,
  add column if not exists hashtag_set text[] not null default '{}',
  add column if not exists image_asset_id uuid references public.media_assets (id) on delete set null,
  add column if not exists performance_label text;

alter table public.post_metrics
  add column if not exists provider text,
  add column if not exists external_post_id text,
  add column if not exists interactions integer not null default 0,
  add column if not exists ctr numeric(8,4) not null default 0,
  add column if not exists engagement_rate numeric(8,4) not null default 0,
  add column if not exists raw_metric_id uuid,
  add column if not exists ingested_at timestamptz not null default now();

create table if not exists public.raw_metrics (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  post_id uuid references public.posts (id) on delete set null,
  post_variant_id uuid references public.post_variants (id) on delete set null,
  platform_account_id uuid references public.platform_accounts (id) on delete set null,
  external_post_id text,
  metric_date date not null,
  payload jsonb not null,
  ingested_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.post_metrics
  drop constraint if exists post_metrics_raw_metric_id_fkey;
alter table public.post_metrics
  add constraint post_metrics_raw_metric_id_fkey
  foreign key (raw_metric_id) references public.raw_metrics (id) on delete set null;

create table if not exists public.metric_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  requested_by uuid references auth.users (id) on delete set null,
  requested_window interval not null default interval '7 days',
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaign_optimization_settings (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null unique references public.campaigns (id) on delete cascade,
  auto_optimize_enabled boolean not null default false,
  min_impressions integer not null default 100,
  winner_metric text not null default 'ctr' check (winner_metric in ('ctr', 'engagement_rate')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.apply_utm_template(p_template text, p_post_id uuid)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_template text := coalesce(p_template, '');
  v_post public.posts;
  v_campaign public.campaigns;
begin
  select * into v_post from public.posts where id = p_post_id;
  if v_post.campaign_id is not null then
    select * into v_campaign from public.campaigns where id = v_post.campaign_id;
  end if;

  return replace(
    replace(
      replace(
        replace(v_template, '{{platform}}', coalesce(v_post.platform, 'social')),
        '{{campaign_name}}', coalesce(v_campaign.name, 'always_on')
      ),
      '{{post_id}}', coalesce(v_post.id::text, '')
    ),
    '{{post_title}}', regexp_replace(coalesce(v_post.title, ''), '\\s+', '-', 'g')
  );
end;
$$;

create or replace function public.build_post_utm_url(p_post_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post public.posts;
  v_profile public.utm_profiles;
  v_rule public.utm_builder_rules;
  v_source text;
  v_medium text;
  v_campaign text;
  v_term text;
  v_content text;
  v_parts text[] := '{}';
  v_base text;
begin
  select * into v_post from public.posts where id = p_post_id;
  if not found or coalesce(v_post.destination_url, '') = '' then
    return null;
  end if;

  if v_post.utm_profile_id is not null then
    select * into v_profile from public.utm_profiles where id = v_post.utm_profile_id;
  else
    select * into v_profile
    from public.utm_profiles
    where owner_user_id = v_post.created_by
      and is_default = true
      and status = 'active'
    order by updated_at desc
    limit 1;
  end if;

  select * into v_rule
  from public.utm_builder_rules
  where (owner_user_id = v_post.created_by or owner_user_id is null)
    and is_default = true
    and status = 'active'
  order by owner_user_id nulls last, updated_at desc
  limit 1;

  v_source := coalesce(v_profile.source, public.apply_utm_template(v_rule.source_template, p_post_id), lower(coalesce(v_post.platform, 'social')));
  v_medium := coalesce(v_profile.medium, public.apply_utm_template(v_rule.medium_template, p_post_id), 'social');
  v_campaign := coalesce(v_profile.campaign, public.apply_utm_template(v_rule.campaign_template, p_post_id));
  v_term := coalesce(v_profile.term, public.apply_utm_template(v_rule.term_template, p_post_id));
  v_content := coalesce(v_profile.content, public.apply_utm_template(v_rule.content_template, p_post_id));

  if v_source is not null and v_source <> '' then v_parts := array_append(v_parts, 'utm_source=' || replace(v_source, ' ', '-')); end if;
  if v_medium is not null and v_medium <> '' then v_parts := array_append(v_parts, 'utm_medium=' || replace(v_medium, ' ', '-')); end if;
  if v_campaign is not null and v_campaign <> '' then v_parts := array_append(v_parts, 'utm_campaign=' || replace(v_campaign, ' ', '-')); end if;
  if v_term is not null and v_term <> '' then v_parts := array_append(v_parts, 'utm_term=' || replace(v_term, ' ', '-')); end if;
  if v_content is not null and v_content <> '' then v_parts := array_append(v_parts, 'utm_content=' || replace(v_content, ' ', '-')); end if;

  v_base := v_post.destination_url;

  if array_length(v_parts, 1) is null then
    return v_base;
  end if;

  return v_base || case when position('?' in v_base) > 0 then '&' else '?' end || array_to_string(v_parts, '&');
end;
$$;

create or replace function public.sync_post_utm_url()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.utm_manual_override then
    return new;
  end if;

  if tg_op = 'INSERT'
     or new.destination_url is distinct from old.destination_url
     or new.utm_profile_id is distinct from old.utm_profile_id
     or new.approval_status is distinct from old.approval_status
     or new.workflow_status is distinct from old.workflow_status
     or new.scheduled_at is distinct from old.scheduled_at then

    if new.approval_status = 'approved'
       or new.workflow_status in ('scheduled', 'publishing', 'published')
       or new.scheduled_at is not null then
      new.utm_url := public.build_post_utm_url(new.id);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_post_utm_url on public.posts;
create trigger trg_sync_post_utm_url
before insert or update on public.posts
for each row execute function public.sync_post_utm_url();

create or replace function public.normalize_post_metric_row(p_raw_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_raw public.raw_metrics;
  v_impressions integer;
  v_reach integer;
  v_clicks integer;
  v_likes integer;
  v_comments integer;
  v_shares integer;
  v_saves integer;
  v_interactions integer;
  v_ctr numeric(8,4);
  v_engagement numeric(8,4);
begin
  select * into v_raw from public.raw_metrics where id = p_raw_id;
  if not found then
    raise exception 'raw_metrics row not found: %', p_raw_id;
  end if;

  v_impressions := greatest(coalesce((v_raw.payload->>'impressions')::integer, 0), 0);
  v_reach := greatest(coalesce((v_raw.payload->>'reach')::integer, v_impressions), 0);
  v_clicks := greatest(coalesce((v_raw.payload->>'clicks')::integer, 0), 0);
  v_likes := greatest(coalesce((v_raw.payload->>'likes')::integer, 0), 0);
  v_comments := greatest(coalesce((v_raw.payload->>'comments')::integer, 0), 0);
  v_shares := greatest(coalesce((v_raw.payload->>'shares')::integer, 0), 0);
  v_saves := greatest(coalesce((v_raw.payload->>'saves')::integer, 0), 0);

  v_interactions := v_likes + v_comments + v_shares + v_saves;
  v_ctr := case when v_impressions > 0 then round((v_clicks::numeric / v_impressions::numeric) * 100, 4) else 0 end;
  v_engagement := case when v_impressions > 0 then round((v_interactions::numeric / v_impressions::numeric) * 100, 4) else 0 end;

  insert into public.post_metrics (
    post_id,
    post_variant_id,
    platform_account_id,
    metric_date,
    impressions,
    reach,
    clicks,
    likes,
    comments,
    shares,
    saves,
    interactions,
    ctr,
    engagement_rate,
    provider,
    external_post_id,
    metadata,
    raw_metric_id,
    ingested_at
  )
  values (
    v_raw.post_id,
    v_raw.post_variant_id,
    v_raw.platform_account_id,
    v_raw.metric_date,
    v_impressions,
    v_reach,
    v_clicks,
    v_likes,
    v_comments,
    v_shares,
    v_saves,
    v_interactions,
    v_ctr,
    v_engagement,
    v_raw.provider,
    v_raw.external_post_id,
    jsonb_build_object('normalized_from', 'raw_metrics', 'provider', v_raw.provider),
    v_raw.id,
    now()
  )
  on conflict (post_id, post_variant_id, platform_account_id, metric_date)
  do update set
    impressions = excluded.impressions,
    reach = excluded.reach,
    clicks = excluded.clicks,
    likes = excluded.likes,
    comments = excluded.comments,
    shares = excluded.shares,
    saves = excluded.saves,
    interactions = excluded.interactions,
    ctr = excluded.ctr,
    engagement_rate = excluded.engagement_rate,
    provider = excluded.provider,
    external_post_id = excluded.external_post_id,
    metadata = excluded.metadata,
    raw_metric_id = excluded.raw_metric_id,
    ingested_at = now(),
    updated_at = now();
end;
$$;

create or replace function public.ingest_available_provider_metrics(
  p_provider text,
  p_since timestamptz default now() - interval '7 days',
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_row record;
  v_count integer := 0;
  v_payload jsonb;
  v_raw_id uuid;
begin
  insert into public.metric_ingestion_jobs (provider, status, requested_by, requested_window, started_at)
  values (p_provider, 'running', auth.uid(), now() - p_since, now())
  returning id into v_job_id;

  for v_row in
    select pj.id,
           pj.post_id,
           pj.post_variant_id,
           p.platform_account_id,
           coalesce(pj.buffer_update_id, pj.direct_post_id) as external_post_id,
           coalesce(pj.debug_payload, '{}'::jsonb) as payload,
           coalesce(pj.published_at, pj.updated_at, now())::date as metric_date
    from public.publish_jobs pj
    join public.posts p on p.id = pj.post_id
    where coalesce(pj.provider, 'buffer') = p_provider
      and coalesce(pj.published_at, pj.updated_at, now()) >= p_since
      and coalesce(pj.buffer_update_id, pj.direct_post_id) is not null
    order by coalesce(pj.published_at, pj.updated_at, now()) desc
    limit greatest(p_limit, 1)
  loop
    v_payload := jsonb_build_object(
      'impressions', coalesce((v_row.payload->>'impressions')::integer, 0),
      'reach', coalesce((v_row.payload->>'reach')::integer, 0),
      'clicks', coalesce((v_row.payload->>'clicks')::integer, 0),
      'likes', coalesce((v_row.payload->>'likes')::integer, 0),
      'comments', coalesce((v_row.payload->>'comments')::integer, 0),
      'shares', coalesce((v_row.payload->>'shares')::integer, 0),
      'saves', coalesce((v_row.payload->>'saves')::integer, 0),
      'source_publish_job_id', v_row.id
    );

    insert into public.raw_metrics (
      provider,
      post_id,
      post_variant_id,
      platform_account_id,
      external_post_id,
      metric_date,
      payload,
      ingested_at
    )
    values (
      p_provider,
      v_row.post_id,
      v_row.post_variant_id,
      v_row.platform_account_id,
      v_row.external_post_id,
      v_row.metric_date,
      v_payload,
      now()
    )
    returning id into v_raw_id;

    perform public.normalize_post_metric_row(v_raw_id);
    v_count := v_count + 1;
  end loop;

  update public.metric_ingestion_jobs
  set status = 'completed',
      completed_at = now(),
      updated_at = now(),
      metadata = jsonb_build_object('ingested_rows', v_count)
  where id = v_job_id;

  return v_count;
exception when others then
  update public.metric_ingestion_jobs
  set status = 'failed',
      completed_at = now(),
      updated_at = now(),
      error_message = sqlerrm
  where id = v_job_id;
  raise;
end;
$$;

create or replace view public.dashboard_post_kpis as
select
  p.id as post_id,
  p.title,
  p.book_id,
  p.campaign_id,
  p.platform,
  pm.post_variant_id,
  sum(pm.impressions)::bigint as impressions,
  sum(pm.clicks)::bigint as clicks,
  sum(pm.interactions)::bigint as interactions,
  case when sum(pm.impressions) > 0 then round(sum(pm.clicks)::numeric * 100 / sum(pm.impressions)::numeric, 4) else 0 end as ctr,
  case when sum(pm.impressions) > 0 then round(sum(pm.interactions)::numeric * 100 / sum(pm.impressions)::numeric, 4) else 0 end as engagement_rate
from public.post_metrics pm
join public.posts p on p.id = pm.post_id
group by p.id, p.title, p.book_id, p.campaign_id, p.platform, pm.post_variant_id;

create or replace function public.dashboard_widgets(
  p_from date default current_date - 30,
  p_to date default current_date,
  p_book_id uuid default null,
  p_campaign_id uuid default null,
  p_platform text default null
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_data jsonb;
begin
  with filtered as (
    select *
    from public.dashboard_post_kpis d
    join public.posts p on p.id = d.post_id
    where exists (
      select 1 from public.post_metrics pm
      where pm.post_id = d.post_id
        and pm.metric_date between p_from and p_to
    )
      and (p_book_id is null or p.book_id = p_book_id)
      and (p_campaign_id is null or p.campaign_id = p_campaign_id)
      and (p_platform is null or p.platform = p_platform)
  ),
  top_ctr as (
    select jsonb_agg(to_jsonb(t) order by t.ctr desc) as data
    from (select post_id, title, platform, ctr, engagement_rate, impressions from filtered order by ctr desc limit 10) t
  ),
  hook_rank as (
    select jsonb_agg(to_jsonb(t) order by t.avg_ctr desc) as data
    from (
      select pv.hook_text, round(avg(f.ctr), 4) as avg_ctr, count(*) as samples
      from filtered f
      join public.post_variants pv on pv.id = f.post_variant_id
      where coalesce(pv.hook_text, '') <> ''
      group by pv.hook_text
      order by avg_ctr desc
      limit 10
    ) t
  ),
  cta_rank as (
    select jsonb_agg(to_jsonb(t) order by t.avg_ctr desc) as data
    from (
      select pv.cta_text, round(avg(f.ctr), 4) as avg_ctr, count(*) as samples
      from filtered f
      join public.post_variants pv on pv.id = f.post_variant_id
      where coalesce(pv.cta_text, '') <> ''
      group by pv.cta_text
      order by avg_ctr desc
      limit 10
    ) t
  ),
  platform_cmp as (
    select jsonb_agg(to_jsonb(t) order by t.ctr desc) as data
    from (
      select platform, round(avg(ctr), 4) as ctr, round(avg(engagement_rate), 4) as engagement_rate, count(*) as posts
      from filtered
      group by platform
      order by avg(ctr) desc
    ) t
  ),
  underperformers as (
    select jsonb_agg(to_jsonb(t) order by t.ctr asc) as data
    from (
      select post_id, title, platform, ctr, engagement_rate, impressions
      from filtered
      where impressions >= 100
      order by ctr asc, engagement_rate asc
      limit 10
    ) t
  )
  select jsonb_build_object(
    'top_ctr_posts', coalesce((select data from top_ctr), '[]'::jsonb),
    'hook_rankings', coalesce((select data from hook_rank), '[]'::jsonb),
    'cta_rankings', coalesce((select data from cta_rank), '[]'::jsonb),
    'platform_comparison', coalesce((select data from platform_cmp), '[]'::jsonb),
    'underperformers', coalesce((select data from underperformers), '[]'::jsonb)
  ) into v_data;

  return v_data;
end;
$$;

create or replace function public.pick_winning_variant(p_post_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_winner uuid;
begin
  select k.post_variant_id
  into v_winner
  from public.dashboard_post_kpis k
  where k.post_id = p_post_id
    and k.post_variant_id is not null
  order by k.ctr desc, k.engagement_rate desc, k.impressions desc
  limit 1;

  if v_winner is not null then
    update public.posts
    set selected_variant_id = v_winner,
        updated_at = now(),
        version = version + 1
    where id = p_post_id;
  end if;

  return v_winner;
end;
$$;

create or replace function public.apply_campaign_auto_optimization(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.campaign_optimization_settings;
  v_post record;
  v_count integer := 0;
begin
  select * into v_settings
  from public.campaign_optimization_settings
  where campaign_id = p_campaign_id;

  if not found or not v_settings.auto_optimize_enabled then
    return 0;
  end if;

  for v_post in
    select k.post_id
    from public.dashboard_post_kpis k
    join public.posts p on p.id = k.post_id
    where p.campaign_id = p_campaign_id
    group by k.post_id
    having sum(k.impressions) >= v_settings.min_impressions
  loop
    if public.pick_winning_variant(v_post.post_id) is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

create index if not exists idx_posts_campaign_platform on public.posts (campaign_id, platform);
create index if not exists idx_post_metrics_variant_date on public.post_metrics (post_variant_id, metric_date desc);
create index if not exists idx_raw_metrics_provider_date on public.raw_metrics (provider, metric_date desc);
create index if not exists idx_metric_ingestion_jobs_provider_status on public.metric_ingestion_jobs (provider, status, created_at desc);

alter table public.utm_builder_rules enable row level security;
alter table public.raw_metrics enable row level security;
alter table public.metric_ingestion_jobs enable row level security;
alter table public.campaign_optimization_settings enable row level security;

drop policy if exists "utm_builder_rules_read" on public.utm_builder_rules;
create policy "utm_builder_rules_read" on public.utm_builder_rules
for select using (public.has_any_role());
drop policy if exists "utm_builder_rules_write" on public.utm_builder_rules;
create policy "utm_builder_rules_write" on public.utm_builder_rules
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "raw_metrics_read" on public.raw_metrics;
create policy "raw_metrics_read" on public.raw_metrics
for select using (public.has_any_role());
drop policy if exists "raw_metrics_write" on public.raw_metrics;
create policy "raw_metrics_write" on public.raw_metrics
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "metric_ingestion_jobs_read" on public.metric_ingestion_jobs;
create policy "metric_ingestion_jobs_read" on public.metric_ingestion_jobs
for select using (public.has_any_role());
drop policy if exists "metric_ingestion_jobs_write" on public.metric_ingestion_jobs;
create policy "metric_ingestion_jobs_write" on public.metric_ingestion_jobs
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop policy if exists "campaign_optimization_settings_read" on public.campaign_optimization_settings;
create policy "campaign_optimization_settings_read" on public.campaign_optimization_settings
for select using (public.has_any_role());
drop policy if exists "campaign_optimization_settings_write" on public.campaign_optimization_settings;
create policy "campaign_optimization_settings_write" on public.campaign_optimization_settings
for all using (public.is_editor_or_owner()) with check (public.is_editor_or_owner());

drop trigger if exists trg_touch_utm_builder_rules on public.utm_builder_rules;
create trigger trg_touch_utm_builder_rules before update on public.utm_builder_rules
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_metric_ingestion_jobs on public.metric_ingestion_jobs;
create trigger trg_touch_metric_ingestion_jobs before update on public.metric_ingestion_jobs
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_campaign_optimization_settings on public.campaign_optimization_settings;
create trigger trg_touch_campaign_optimization_settings before update on public.campaign_optimization_settings
for each row execute function public.touch_updated_at();

commit;
