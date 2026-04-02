begin;

create or replace view public.dashboard_post_kpis
with (security_invoker = true) as
select
  p.id as post_id,
  p.title,
  p.book_id,
  p.campaign_id,
  p.platform,
  pv.id as post_variant_id,
  sum(pm.impressions)::bigint as impressions,
  sum(pm.clicks)::bigint as clicks,
  sum(pm.interactions)::bigint as interactions,
  case
    when sum(pm.impressions) > 0 then round(sum(pm.clicks)::numeric * 100 / sum(pm.impressions)::numeric, 4)
    else 0
  end as ctr,
  case
    when sum(pm.impressions) > 0 then round(sum(pm.interactions)::numeric * 100 / sum(pm.impressions)::numeric, 4)
    else 0
  end as engagement_rate
from public.post_metrics pm
join public.posts p on p.id = pm.post_id
left join public.post_variants pv
  on pv.id = pm.post_variant_id
 and pv.post_id = p.id
group by p.id, p.title, p.book_id, p.campaign_id, p.platform, pv.id;

grant select on public.dashboard_post_kpis to authenticated;
grant select on public.dashboard_post_kpis to anon;
grant select on public.dashboard_post_kpis to service_role;

commit;
