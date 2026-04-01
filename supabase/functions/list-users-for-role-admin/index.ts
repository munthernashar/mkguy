import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { log } from '../_shared/logger.ts';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_request' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rateKey = `${origin ?? 'no-origin'}:${request.headers.get('x-forwarded-for') ?? 'ip-unknown'}:list-users-for-role-admin`;
  if (!checkRateLimit(rateKey)) {
    return new Response(JSON.stringify({ ok: false, error: 'too_many_requests' }), {
      status: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: userData } = await supabaseUser.auth.getUser();
    const actorId = userData.user?.id;

    if (!actorId) {
      return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: actorRole } = await admin
      .from('user_roles')
      .select('role')
      .eq('user_id', actorId)
      .maybeSingle();

    if (actorRole?.role !== 'owner') {
      return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const users: { id: string; email: string | null }[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
      if (error) {
        log('error', 'list_users_for_role_admin_list_users_failed', { reason: error.message, actorId, page });
        return new Response(JSON.stringify({ ok: false, error: 'operation_failed', error_message: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const currentUsers = (data?.users ?? []).map((entry) => ({
        id: entry.id,
        email: entry.email ?? null,
      }));

      users.push(...currentUsers);
      if (currentUsers.length < perPage) break;
      page += 1;
    }

    const userIds = users.map((entry) => entry.id);

    const { data: roles, error: rolesError } = userIds.length > 0
      ? await admin.from('user_roles').select('user_id, role').in('user_id', userIds)
      : { data: [], error: null };
    if (rolesError) {
      log('error', 'list_users_for_role_admin_join_failed', {
        reason: rolesError.message ?? 'unknown',
        actorId,
      });
      return new Response(JSON.stringify({ ok: false, error: 'operation_failed', error_message: rolesError.message ?? 'unknown' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: profiles, error: profilesError } = userIds.length > 0
      ? await admin.from('profiles').select('user_id, display_name').in('user_id', userIds)
      : { data: [], error: null };
    if (profilesError) {
      log('warn', 'list_users_for_role_admin_profiles_join_failed', {
        reason: profilesError.message ?? 'unknown',
        actorId,
      });
    }

    const currentRoleByUserId = (roles ?? []).reduce<Record<string, string>>((acc, entry) => {
      acc[entry.user_id] = entry.role;
      return acc;
    }, {});

    const displayNameByUserId = (profiles ?? []).reduce<Record<string, string | null>>((acc, entry) => {
      acc[entry.user_id] = entry.display_name ?? null;
      return acc;
    }, {});

    const result = users.map((entry) => ({
      user_id: entry.id,
      email: entry.email,
      display_name: displayNameByUserId[entry.id] ?? null,
      current_role: currentRoleByUserId[entry.id] ?? null,
    }));

    return new Response(JSON.stringify({ ok: true, users: result }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log('error', 'list_users_for_role_admin_exception', { reason: String(error) });
    return new Response(JSON.stringify({ ok: false, error: 'operation_failed', error_message: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
