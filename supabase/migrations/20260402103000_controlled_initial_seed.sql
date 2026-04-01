begin;

create or replace function public.ensure_initial_seed(
  p_env text default 'prod'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_env text := case when lower(coalesce(p_env, 'prod')) in ('dev', 'development') then 'dev' else 'prod' end;
  v_books_count bigint;
  v_campaigns_count bigint;
  v_posts_count bigint;
  v_book_id uuid;
  v_campaign_id uuid;
  v_utm_id uuid;
  v_seeded boolean := false;
  v_inserted_books integer := 0;
  v_inserted_campaigns integer := 0;
  v_inserted_posts integer := 0;
  v_inserted_utm_profiles integer := 0;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  if not public.is_editor_or_owner() then
    raise exception 'insufficient_role_for_seed';
  end if;

  perform pg_advisory_xact_lock(hashtext('public.ensure_initial_seed.v1'));

  select count(*) into v_books_count from public.books where deleted_at is null;
  select count(*) into v_campaigns_count from public.campaigns where deleted_at is null;
  select count(*) into v_posts_count from public.posts where deleted_at is null;

  if v_books_count = 0 and v_campaigns_count = 0 and v_posts_count = 0 then
    if v_env = 'dev' then
      insert into public.books (title, description, status, created_by, updated_by)
      values ('[DEV] Demo Book', 'Minimaler Onboarding-Datensatz für lokale Entwicklung.', 'active', v_user_id, v_user_id)
      returning id into v_book_id;

      insert into public.campaigns (name, summary, status, starts_at, created_by, updated_by)
      values ('[DEV] Demo Campaign', 'Basiskampagne für Smoke-Tests in Development.', 'active', now(), v_user_id, v_user_id)
      returning id into v_campaign_id;

      insert into public.utm_profiles (
        owner_user_id,
        name,
        source,
        medium,
        campaign,
        content,
        is_default,
        status
      )
      values (
        v_user_id,
        'DEV Default UTM',
        'dev-social',
        'organic',
        'dev-onboarding',
        'seed',
        true,
        'active'
      )
      returning id into v_utm_id;

      insert into public.posts (
        campaign_id,
        book_id,
        title,
        body,
        status,
        workflow_status,
        platform,
        language,
        utm_profile_id,
        destination_url,
        created_by,
        updated_by
      )
      values (
        v_campaign_id,
        v_book_id,
        '[DEV] Willkommen im Studio',
        'Dies ist ein automatisch erzeugter Entwicklungs-Post.',
        'draft',
        'draft',
        'linkedin',
        'de',
        v_utm_id,
        'https://example.dev/welcome',
        v_user_id,
        v_user_id
      );
    else
      insert into public.books (title, description, status, created_by, updated_by)
      values ('Getting Started: Social Playbook', 'Basisset für den Produktiv-Onboarding-Flow.', 'active', v_user_id, v_user_id)
      returning id into v_book_id;

      insert into public.campaigns (name, summary, status, starts_at, created_by, updated_by)
      values ('Onboarding Kampagne', 'Erste Kampagne mit einem startklaren Beispielpost.', 'active', now(), v_user_id, v_user_id)
      returning id into v_campaign_id;

      insert into public.utm_profiles (
        owner_user_id,
        name,
        source,
        medium,
        campaign,
        content,
        is_default,
        status
      )
      values (
        v_user_id,
        'Default Social UTM',
        'social',
        'organic',
        'onboarding',
        'starter',
        true,
        'active'
      )
      returning id into v_utm_id;

      insert into public.posts (
        campaign_id,
        book_id,
        title,
        body,
        status,
        workflow_status,
        platform,
        language,
        utm_profile_id,
        destination_url,
        created_by,
        updated_by
      )
      values (
        v_campaign_id,
        v_book_id,
        'Willkommen bei deinem ersten Beitrag',
        'Passe diesen Beispielpost an und veröffentliche ihn direkt aus dem Studio.',
        'draft',
        'draft',
        'linkedin',
        'de',
        v_utm_id,
        'https://example.com/start',
        v_user_id,
        v_user_id
      );
    end if;

    v_seeded := true;
    v_inserted_books := 1;
    v_inserted_campaigns := 1;
    v_inserted_posts := 1;
    v_inserted_utm_profiles := 1;
  end if;

  return jsonb_build_object(
    'seeded', v_seeded,
    'env', v_env,
    'inserted', jsonb_build_object(
      'books', v_inserted_books,
      'campaigns', v_inserted_campaigns,
      'posts', v_inserted_posts,
      'utm_profiles', v_inserted_utm_profiles
    ),
    'existing_before', jsonb_build_object(
      'books', v_books_count,
      'campaigns', v_campaigns_count,
      'posts', v_posts_count
    )
  );
end;
$$;

comment on function public.ensure_initial_seed(text)
  is 'Legt kontrolliert Initialdaten für Onboarding an (dev/prod), wenn books/campaigns/posts leer sind.';

commit;
