import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import {
  DIRECT_FALLBACK_TRIGGERS,
  DIRECT_PLATFORM_CAPABILITIES,
  isAllowedDirectFallbackTrigger,
  MediaInput,
  PublishProviderError,
  PublishVia,
  publishWithProvider,
} from '../_shared/publish-providers.ts';

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

const resolvePublishVia = (requestedPublishVia: unknown, fallbackReasonCode: unknown): {
  ok: boolean;
  publishVia: PublishVia;
  error?: string;
  diagnosticPath?: string;
} => {
  if (requestedPublishVia !== 'direct') return { ok: true, publishVia: 'buffer' };
  const triggerCode = typeof fallbackReasonCode === 'string' ? fallbackReasonCode : null;
  if (!isAllowedDirectFallbackTrigger(triggerCode)) {
    return {
      ok: false,
      publishVia: 'direct',
      error: 'direct_requires_functional_gap',
      diagnosticPath: 'publish/routing/fallback_trigger',
    };
  }
  return { ok: true, publishVia: 'direct' };
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
  const {
    post_id: postId,
    buffer_profile_id: profileId,
    platform_account_id: platformAccountId,
    publish_via: requestedPublishVia,
    fallback_reason_code: fallbackReasonCode,
    text,
    platform = 'other',
    media = [],
    scheduled_at: scheduledAt,
  } = payload;

  const publishViaDecision = resolvePublishVia(requestedPublishVia, fallbackReasonCode);
  const publishVia: PublishVia = publishViaDecision.publishVia;
  const validation = validateMedia(media);

  const baseJob = {
    post_id: postId,
    buffer_profile_id: profileId ?? null,
    platform_account_id: platformAccountId ?? null,
    initiated_by: userId,
    status: 'running',
    attempts: 1,
    provider: publishVia,
    debug_payload: {
      requested_at: new Date().toISOString(),
      publish_via: publishVia,
      fallback_reason_code: fallbackReasonCode ?? null,
      fallback_triggers: DIRECT_FALLBACK_TRIGGERS,
      direct_capabilities: DIRECT_PLATFORM_CAPABILITIES,
    },
  };

  const { data: job } = await supabase.from('publish_jobs').insert(baseJob).select('id, attempts, max_attempts').single();

  if (!publishViaDecision.ok) {
    await supabase.from('publish_jobs').update({
      status: 'failed',
      last_error: JSON.stringify({
        code: publishViaDecision.error,
        retriable: false,
        detail: 'publish_via=direct is only allowed for documented functional Buffer gaps.',
        fallback_reason_code: fallbackReasonCode ?? null,
      }),
      last_error_code: publishViaDecision.error,
      debug_payload: { routing: 'blocked', fallback_reason_code: fallbackReasonCode ?? null, publish_via: publishVia },
      diagnostic_path: publishViaDecision.diagnosticPath,
    }).eq('id', job?.id);

    return new Response(JSON.stringify({
      ok: false,
      error: publishViaDecision.error,
      retriable: false,
      diagnostic_path: publishViaDecision.diagnosticPath,
      job_id: job?.id,
      allowed_fallback_triggers: DIRECT_FALLBACK_TRIGGERS,
    }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (!validation.ok) {
    await supabase.from('publish_jobs').update({
      status: 'failed',
      last_error: JSON.stringify({ code: 'media_validation_failed', retriable: false, errors: validation.errors }),
      last_error_code: 'media_validation_failed',
      debug_payload: { validation_errors: validation.errors, publish_via: publishVia },
      diagnostic_path: 'publish/media_validation',
    }).eq('id', job?.id);

    return new Response(JSON.stringify({ ok: false, error: 'media_validation_failed', errors: validation.errors }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const result = await publishWithProvider(publishVia, supabase, {
      postId,
      text,
      media,
      scheduledAt,
      platform,
      profileId,
      platformAccountId,
      userId,
    });

    await supabase.from('publish_jobs').update({
      status: result.status,
      buffer_update_id: result.provider === 'buffer' ? result.externalId : null,
      direct_post_id: result.provider === 'direct' ? result.externalId : null,
      published_at: result.status === 'published' ? new Date().toISOString() : null,
      last_error: null,
      last_error_code: null,
      debug_payload: result.debug,
      diagnostic_path: null,
    }).eq('id', job?.id);

    return new Response(JSON.stringify({ ok: true, job_id: job?.id, publish_via: publishVia, external_id: result.externalId, buffer_update_id: result.provider === 'buffer' ? result.externalId : null, scheduled: result.scheduled }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    if (error instanceof PublishProviderError) {
      const mappedStatus = error.retriable ? 'queued' : 'failed';
      await supabase.from('publish_jobs').update({
        status: mappedStatus,
        attempts: error.retriable ? (job?.attempts ?? 1) + 1 : (job?.attempts ?? 1),
        next_attempt_at: error.retriable ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
        last_error: JSON.stringify({
          code: error.code,
          category: error.category,
          retriable: error.retriable,
          detail: error.message,
          diagnostic_path: error.diagnosticPath,
          provider_status: error.providerStatus ?? null,
          provider_payload: error.providerPayload ?? null,
        }),
        last_error_code: error.code,
        debug_payload: {
          provider: publishVia,
          diagnostic_path: error.diagnosticPath,
          error_category: error.category,
          provider_status: error.providerStatus ?? null,
        },
        diagnostic_path: error.diagnosticPath,
      }).eq('id', job?.id);

      return new Response(JSON.stringify({
        ok: false,
        error: error.code,
        error_category: error.category,
        retriable: error.retriable,
        diagnostic_path: error.diagnosticPath,
        provider_status: error.providerStatus ?? null,
        job_id: job?.id,
      }), { status: error.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const isRetriable = String(error).includes('buffer_api_failed_5') || String(error).includes('timeout');
    const attempts = (job?.attempts ?? 0) + 1;
    const maxAttempts = job?.max_attempts ?? 5;

    await supabase.from('publish_jobs').update({
      status: isRetriable && attempts <= maxAttempts ? 'queued' : 'failed',
      attempts,
      next_attempt_at: isRetriable ? new Date(Date.now() + 5 * 60_000).toISOString() : null,
      last_error: JSON.stringify({ code: 'publish_failed', retriable: isRetriable, detail: String(error) }),
      last_error_code: 'publish_failed',
      debug_payload: { provider: publishVia, attempts, last_error: String(error), diagnostic_path: 'publish/unhandled' },
      diagnostic_path: 'publish/unhandled',
    }).eq('id', job?.id);

    return new Response(JSON.stringify({ ok: false, error: 'publish_failed', retriable: isRetriable, diagnostic_path: 'publish/unhandled', job_id: job?.id }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
