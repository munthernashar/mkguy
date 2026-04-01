import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { bufferApi, decodeOpaqueToken, serviceFromNetwork } from '../_shared/buffer.ts';

Deno.serve(async (request) => {
  const corsHeaders = buildCorsHeaders(request.headers.get('origin'));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'invalid_request' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const authHeader = request.headers.get('Authorization');
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { global: { headers: { Authorization: authHeader ?? '' } } });
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const { buffer_account_id: accountId } = await request.json().catch(() => ({}));
  const query = supabase.from('buffer_accounts').select('id, access_token_ref').eq('owner_user_id', userId).eq('status', 'active');
  const { data: accounts } = accountId ? await query.eq('id', accountId) : await query;
  if (!accounts?.length) return new Response(JSON.stringify({ ok: false, error: 'missing_account' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const synced: Array<Record<string, unknown>> = [];
  for (const account of accounts) {
    const accessToken = decodeOpaqueToken(account.access_token_ref);
    if (!accessToken) continue;
    const response = await bufferApi('/profiles.json', accessToken);
    const profiles = await response.json();

    for (const profile of profiles) {
      const payload = {
        buffer_account_id: account.id,
        external_profile_id: profile.id,
        profile_name: profile.formatted_username ?? profile.service_username ?? profile.service_id,
        service: serviceFromNetwork(profile.service),
        is_active: profile.service_connected !== false,
        raw_payload: profile,
        last_synced_at: new Date().toISOString(),
        status: 'active',
      };
      await supabase.from('buffer_profiles').upsert(payload, { onConflict: 'buffer_account_id,external_profile_id' });
      synced.push(payload);
    }

    await supabase.from('buffer_accounts').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', account.id);
  }

  return new Response(JSON.stringify({ ok: true, synced_count: synced.length, profiles: synced }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
