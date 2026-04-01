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

  const rateKey = `${origin ?? 'no-origin'}:${request.headers.get('x-forwarded-for') ?? 'ip-unknown'}:set-user-role`;
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

    const body = await request.json();
    const { user_id: userId, role } = body;

    if (!userId || !['owner', 'editor', 'viewer'].includes(role)) {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_request' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { error } = await admin.from('user_roles').upsert({ user_id: userId, role }, { onConflict: 'user_id' });

    if (error) {
      log('error', 'set_user_role_failed', { reason: error.message, actorId });
      return new Response(JSON.stringify({ ok: false, error: 'operation_failed' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log('error', 'set_user_role_exception', { reason: String(error) });
    return new Response(JSON.stringify({ ok: false, error: 'operation_failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
