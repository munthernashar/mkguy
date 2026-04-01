import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { bufferApi, decryptTokenRef, encryptTokenRef, refreshBufferToken } from '../_shared/buffer.ts';

type PublishJobRow = {
  id: string;
  buffer_update_id: string;
  attempts: number;
  max_attempts: number;
  buffer_profile_id: string | null;
  buffer_profiles: { id: string; buffer_account_id: string } | null;
};

type BufferAccountRow = {
  id: string;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
  token_expires_at: string | null;
};

const mapUpdateStatus = (rawStatus: string | null | undefined): 'queued' | 'published' | 'failed' => {
  const value = String(rawStatus ?? '').toLowerCase();
  if (['sent', 'published', 'succeeded', 'success'].includes(value)) return 'published';
  if (['failed', 'error', 'rejected'].includes(value)) return 'failed';
  return 'queued';
};

const createSupabaseClient = (authHeader: string | null) => createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { global: { headers: { Authorization: authHeader ?? '' } } },
);

const ensureWorkerAuth = (request: Request): boolean => {
  const expectedSecret = Deno.env.get('BUFFER_STATUS_WORKER_SECRET');
  if (!expectedSecret) return true;
  const provided = request.headers.get('x-worker-secret') ?? '';
  return provided === expectedSecret;
};

Deno.serve(async (request) => {
  const corsHeaders = buildCorsHeaders(request.headers.get('origin'));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'invalid_request' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (!ensureWorkerAuth(request)) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const payload = await request.json().catch(() => ({}));
  const limit = Math.max(1, Math.min(Number(payload?.limit ?? 50), 200));
  const supabase = createSupabaseClient(request.headers.get('Authorization'));

  const { data: jobs, error } = await supabase
    .from('publish_jobs')
    .select('id, buffer_update_id, attempts, max_attempts, buffer_profile_id, buffer_profiles!inner(id, buffer_account_id)')
    .eq('provider', 'buffer')
    .eq('status', 'queued')
    .not('buffer_update_id', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: 'job_query_failed', details: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const job of (jobs ?? []) as PublishJobRow[]) {
    const accountId = job.buffer_profiles?.buffer_account_id;
    if (!accountId) continue;

    const { data: account } = await supabase
      .from('buffer_accounts')
      .select('id, access_token_ref, refresh_token_ref, token_expires_at')
      .eq('id', accountId)
      .single();

    const accountRow = account as BufferAccountRow | null;
    if (!accountRow) continue;

    let accessToken = await decryptTokenRef(accountRow.access_token_ref);
    const refreshToken = await decryptTokenRef(accountRow.refresh_token_ref);
    const tokenExpired = accountRow.token_expires_at && Date.parse(accountRow.token_expires_at) <= Date.now();

    if ((!accessToken || tokenExpired) && refreshToken) {
      try {
        const refreshed = await refreshBufferToken(refreshToken);
        accessToken = refreshed.access_token;
        await supabase.from('buffer_accounts').update({
          access_status: 'connected',
          access_token_ref: await encryptTokenRef(refreshed.access_token),
          refresh_token_ref: await encryptTokenRef(refreshed.refresh_token ?? refreshToken),
          token_expires_at: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : null,
          token_rotated_at: new Date().toISOString(),
          auth_retry_at: null,
          last_sync_error: null,
        }).eq('id', accountId);
      } catch (refreshError) {
        await supabase.from('buffer_accounts').update({
          access_status: 'expired',
          auth_retry_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          last_sync_error: String(refreshError),
        }).eq('id', accountId);
        results.push({ job_id: job.id, state: 'skipped', reason: 'token_refresh_failed' });
        continue;
      }
    }

    if (!accessToken) {
      results.push({ job_id: job.id, state: 'skipped', reason: 'missing_access_token' });
      continue;
    }

    try {
      const response = await bufferApi(`/updates/${job.buffer_update_id}.json`, accessToken);
      const updatePayload = await response.json();
      const resolvedStatus = mapUpdateStatus(updatePayload?.status ?? updatePayload?.state);

      await supabase.from('publish_jobs').update({
        status: resolvedStatus,
        published_at: resolvedStatus === 'published' ? new Date().toISOString() : null,
        provider_status: updatePayload?.status ?? updatePayload?.state ?? null,
        provider_status_checked_at: new Date().toISOString(),
        last_error_code: resolvedStatus === 'failed' ? 'buffer_update_failed' : null,
        last_error: resolvedStatus === 'failed' ? JSON.stringify({ code: 'buffer_update_failed', payload: updatePayload }) : null,
        debug_payload: {
          worker: 'sync-buffer-publish-status',
          buffer_status: updatePayload?.status ?? updatePayload?.state ?? null,
          polled_at: new Date().toISOString(),
        },
      }).eq('id', job.id);

      results.push({ job_id: job.id, state: resolvedStatus, buffer_status: updatePayload?.status ?? null });
    } catch (pollError) {
      const status = Number(String(pollError).split('_').pop() ?? 0);
      if (status === 401 || status === 403) {
        await supabase.from('buffer_accounts').update({
          access_status: status === 401 ? 'expired' : 'revoked',
          auth_retry_at: status === 401 ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
          last_sync_error: String(pollError),
        }).eq('id', accountId);
      }

      const nextAttempts = (job.attempts ?? 0) + 1;
      const canRetry = nextAttempts <= (job.max_attempts ?? 5);
      await supabase.from('publish_jobs').update({
        attempts: nextAttempts,
        status: canRetry ? 'queued' : 'failed',
        next_attempt_at: canRetry ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
        provider_status_checked_at: new Date().toISOString(),
        last_error_code: 'buffer_status_poll_failed',
        last_error: JSON.stringify({ code: 'buffer_status_poll_failed', detail: String(pollError), retriable: canRetry }),
      }).eq('id', job.id);

      results.push({ job_id: job.id, state: 'error', retriable: canRetry, error: String(pollError) });
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: results.length, results }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
