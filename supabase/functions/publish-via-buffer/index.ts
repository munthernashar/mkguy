import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { bufferApi, decodeOpaqueToken } from '../_shared/buffer.ts';

type MediaInput = { url: string; mime_type?: string; width?: number; height?: number };

const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'];

const validateMedia = (media: MediaInput[]) => {
  const errors: Array<{ code: string; message: string; retriable: boolean; field: string }> = [];
  media.forEach((item, index) => {
    if (!/^https?:\/\//.test(item.url)) {
      errors.push({ code: 'media_invalid_url', message: 'Media URL must be http/https.', retriable: false, field: `media[${index}].url` });
    }
    if (item.mime_type && !ALLOWED_MEDIA.includes(item.mime_type)) {
      errors.push({ code: 'media_invalid_format', message: `Unsupported format ${item.mime_type}.`, retriable: false, field: `media[${index}].mime_type` });
    }
    if (item.width && item.height) {
      const ratio = item.width / item.height;
      if (ratio < 0.8 || ratio > 1.91) {
        errors.push({ code: 'media_invalid_ratio', message: 'Media ratio must be between 0.8 and 1.91.', retriable: false, field: `media[${index}]` });
      }
    }
  });
  return { ok: errors.length === 0, errors };
};

Deno.serve(async (request) => {
  const corsHeaders = buildCorsHeaders(request.headers.get('origin'));
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'invalid_request' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const authHeader = request.headers.get('Authorization');
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { global: { headers: { Authorization: authHeader ?? '' } } });
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const payload = await request.json();
  const { post_id: postId, buffer_profile_id: profileId, text, media = [], scheduled_at: scheduledAt } = payload;
  const validation = validateMedia(media);

  const { data: profile } = await supabase.from('buffer_profiles').select('id, external_profile_id, buffer_account_id').eq('id', profileId).single();
  const { data: account } = await supabase.from('buffer_accounts').select('id, owner_user_id, access_token_ref').eq('id', profile?.buffer_account_id).single();
  if (!profile || !account || account.owner_user_id !== userId) return new Response(JSON.stringify({ ok: false, error: 'missing_profile' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const baseJob = {
    post_id: postId,
    buffer_profile_id: profileId,
    initiated_by: userId,
    status: 'running',
    attempts: 1,
    provider: 'buffer',
    debug_payload: { requested_at: new Date().toISOString() },
  };

  const { data: job } = await supabase.from('publish_jobs').insert(baseJob).select('id, attempts, max_attempts').single();

  if (!validation.ok) {
    await supabase.from('publish_jobs').update({
      status: 'failed',
      last_error: JSON.stringify({ code: 'media_validation_failed', retriable: false, errors: validation.errors }),
      last_error_code: 'media_validation_failed',
      debug_payload: { validation_errors: validation.errors },
    }).eq('id', job?.id);

    return new Response(JSON.stringify({ ok: false, error: 'media_validation_failed', errors: validation.errors }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const accessToken = decodeOpaqueToken(account.access_token_ref);
    if (!accessToken) throw new Error('missing_access_token');

    const requestBody: Record<string, unknown> = {
      profile_ids: [profile.external_profile_id],
      text,
      media,
    };
    if (scheduledAt) requestBody.scheduled_at = scheduledAt;

    const response = await bufferApi('/updates/create.json', accessToken, {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });

    const update = await response.json();
    await supabase.from('publish_jobs').update({
      status: scheduledAt ? 'queued' : 'published',
      buffer_update_id: update?.updates?.[0]?.id ?? update?.id ?? null,
      published_at: scheduledAt ? null : new Date().toISOString(),
      last_error: null,
      last_error_code: null,
      debug_payload: { provider: 'buffer', response: update },
    }).eq('id', job?.id);

    return new Response(JSON.stringify({ ok: true, job_id: job?.id, buffer_update_id: update?.updates?.[0]?.id ?? update?.id ?? null, scheduled: Boolean(scheduledAt) }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    const isRetriable = String(error).includes('buffer_api_failed_5') || String(error).includes('timeout');
    const attempts = (job?.attempts ?? 0) + 1;
    const maxAttempts = job?.max_attempts ?? 5;

    await supabase.from('publish_jobs').update({
      status: isRetriable && attempts <= maxAttempts ? 'queued' : 'failed',
      attempts,
      next_attempt_at: isRetriable ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
      last_error: JSON.stringify({ code: 'publish_failed', retriable: isRetriable, detail: String(error) }),
      last_error_code: 'publish_failed',
      debug_payload: { provider: 'buffer', attempts, last_error: String(error) },
    }).eq('id', job?.id);

    return new Response(JSON.stringify({ ok: false, error: 'publish_failed', retriable: isRetriable, job_id: job?.id }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
