import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { getBufferConfig } from '../_shared/buffer.ts';

Deno.serve(async (request) => {
  const corsHeaders = buildCorsHeaders(request.headers.get('origin'));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'invalid_request' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const { reconnect_buffer_account_id: reconnectId } = await request.json().catch(() => ({}));
  const cfg = getBufferConfig();
  const nonce = crypto.randomUUID();

  const upsertPayload: Record<string, unknown> = {
    owner_user_id: userId,
    access_status: 'expired',
    status: 'active',
    metadata: { oauth_nonce: nonce, oauth_started_at: new Date().toISOString() },
  };

  if (reconnectId) upsertPayload.id = reconnectId;

  const { data: account, error } = await supabase.from('buffer_accounts').upsert(upsertPayload).select('id').single();
  if (error) return new Response(JSON.stringify({ ok: false, error: 'operation_failed', details: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const stateObj = { nonce, account_id: account.id, user_id: userId, ts: Date.now() };
  const state = btoa(JSON.stringify(stateObj));
  const authUrl = `${cfg.authorizeUrl}?client_id=${encodeURIComponent(cfg.clientId)}&redirect_uri=${encodeURIComponent(cfg.redirectUri)}&response_type=code&state=${encodeURIComponent(state)}`;

  return new Response(JSON.stringify({ ok: true, auth_url: authUrl, buffer_account_id: account.id, reconnect: Boolean(reconnectId) }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
