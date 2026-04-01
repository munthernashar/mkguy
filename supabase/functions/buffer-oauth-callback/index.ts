import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { exchangeBufferCode, encodeOpaqueToken } from '../_shared/buffer.ts';

Deno.serve(async (request) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const next = Deno.env.get('BUFFER_OAUTH_SUCCESS_URL') ?? `${url.origin}/?view=studio`;

  if (!code || !state) return Response.redirect(`${next}&buffer_oauth=failed`, 302);

  let parsed: { nonce: string; account_id: string; user_id: string } | null = null;
  try {
    parsed = JSON.parse(atob(state));
  } catch (_error) {
    return Response.redirect(`${next}&buffer_oauth=invalid_state`, 302);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  const { data: account, error: accountError } = await supabase
    .from('buffer_accounts')
    .select('id, owner_user_id, metadata')
    .eq('id', parsed.account_id)
    .single();

  if (accountError || !account || account.owner_user_id !== parsed.user_id || account.metadata?.oauth_nonce !== parsed.nonce) {
    return Response.redirect(`${next}&buffer_oauth=state_mismatch`, 302);
  }

  try {
    const token = await exchangeBufferCode(code);
    const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;

    await supabase.from('buffer_accounts').update({
      access_status: 'connected',
      access_token_ref: encodeOpaqueToken(token.access_token),
      refresh_token_ref: encodeOpaqueToken(token.refresh_token ?? ''),
      token_expires_at: expiresAt,
      connected_at: new Date().toISOString(),
      metadata: { oauth_nonce: null, oauth_connected_at: new Date().toISOString() },
    }).eq('id', account.id);

    return Response.redirect(`${next}&buffer_oauth=connected&buffer_account_id=${account.id}`, 302);
  } catch (_error) {
    await supabase.from('buffer_accounts').update({ access_status: 'error', last_sync_error: 'oauth_exchange_failed' }).eq('id', account.id);
    return Response.redirect(`${next}&buffer_oauth=failed`, 302);
  }
});
