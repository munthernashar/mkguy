import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { log } from '../_shared/logger.ts';
import { jsonResponse, ratioAllowed } from '../_shared/social-generation.ts';

type Payload = {
  post_id: string;
  platform: 'instagram' | 'linkedin' | 'x' | 'threads';
  aspect_ratio: string;
  prompt?: string;
};

type ProviderErrorCode =
  | 'PROVIDER_KEY_MISSING'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_TEMPORARY'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'PROVIDER_REQUEST_FAILED'
  | 'STORAGE_UPLOAD_FAILED';

type ProviderResult = {
  bytes: Uint8Array;
  mimeType: string;
  provider: 'openai';
  model: string;
  width: number;
  height: number;
  providerRequestId: string | null;
  attempts: number;
  durationMs: number;
};

const DEFAULT_IMAGE_PROMPT =
  'Create a clean, modern social media visual that supports the post message. Avoid text-heavy compositions.';
const IMAGE_PROVIDER_MODEL = Deno.env.get('OPENAI_IMAGE_MODEL') ?? 'gpt-image-1';
const IMAGE_PROVIDER_TIMEOUT_MS = Number(Deno.env.get('IMAGE_PROVIDER_TIMEOUT_MS') ?? 30_000);
const IMAGE_PROVIDER_MAX_RETRIES = Number(Deno.env.get('IMAGE_PROVIDER_MAX_RETRIES') ?? 2);
const IMAGE_PROVIDER_RETRY_DELAY_MS = Number(Deno.env.get('IMAGE_PROVIDER_RETRY_DELAY_MS') ?? 800);
const IMAGE_STORAGE_BUCKET = Deno.env.get('IMAGE_ASSETS_BUCKET') ?? 'media-assets';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseAspectRatio = (ratio: string) => {
  const [w, h] = ratio.split(':').map((v) => Number(v));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
};

const dimensionsForAspectRatio = (aspectRatio: string): { width: number; height: number; size: string } => {
  const normalized = parseAspectRatio(aspectRatio);
  if (!normalized) return { width: 1024, height: 1024, size: '1024x1024' };
  if (Math.abs(normalized - 1) < 0.01) return { width: 1024, height: 1024, size: '1024x1024' };
  if (normalized > 1) return { width: 1536, height: 1024, size: '1536x1024' };
  return { width: 1024, height: 1536, size: '1024x1536' };
};

const mapProviderFailure = (status: number, bodyText: string) => {
  if (status === 429) return { code: 'PROVIDER_RATE_LIMIT' as const, retryable: true };
  if (status === 408) return { code: 'PROVIDER_TIMEOUT' as const, retryable: true };
  if (status >= 500) return { code: 'PROVIDER_TEMPORARY' as const, retryable: true };
  return {
    code: 'PROVIDER_REQUEST_FAILED' as const,
    retryable: false,
    details: `status=${status}; body=${bodyText.slice(0, 300)}`,
  };
};

const callOpenAIImageProvider = async (params: {
  prompt: string;
  aspectRatio: string;
}): Promise<ProviderResult> => {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('PROVIDER_KEY_MISSING');

  const dim = dimensionsForAspectRatio(params.aspectRatio);
  const maxAttempts = Math.max(1, IMAGE_PROVIDER_MAX_RETRIES + 1);
  const startedAt = Date.now();
  let lastError = 'unknown_provider_error';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort('provider_timeout'), IMAGE_PROVIDER_TIMEOUT_MS);

    try {
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: IMAGE_PROVIDER_MODEL,
          prompt: params.prompt,
          size: dim.size,
          quality: 'high',
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const bodyText = await response.text();
        const mapped = mapProviderFailure(response.status, bodyText);
        lastError = `${mapped.code}${mapped.details ? `:${mapped.details}` : ''}`;

        if (mapped.retryable && attempt < maxAttempts) {
          await sleep(IMAGE_PROVIDER_RETRY_DELAY_MS * attempt);
          continue;
        }

        throw new Error(lastError);
      }

      const providerRequestId = response.headers.get('x-request-id');
      const json = await response.json();
      const b64Json = json?.data?.[0]?.b64_json;
      if (!b64Json || typeof b64Json !== 'string') {
        throw new Error('PROVIDER_RESPONSE_INVALID:missing_b64_json');
      }

      const bytes = Uint8Array.from(atob(b64Json), (char) => char.charCodeAt(0));
      return {
        bytes,
        mimeType: 'image/png',
        provider: 'openai',
        model: IMAGE_PROVIDER_MODEL,
        width: dim.width,
        height: dim.height,
        providerRequestId,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const errText = String(error);
      const isTimeout = errText.includes('provider_timeout') || errText.includes('AbortError');
      const retryable = isTimeout || errText.includes('PROVIDER_TEMPORARY') || errText.includes('PROVIDER_RATE_LIMIT');
      lastError = isTimeout ? 'PROVIDER_TIMEOUT' : errText;

      if (retryable && attempt < maxAttempts) {
        await sleep(IMAGE_PROVIDER_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw new Error(lastError);
    }
  }

  throw new Error(lastError);
};

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  try {
    const payload = (await request.json()) as Payload;
    if (!payload.post_id) return jsonResponse({ ok: false, error: 'post_id_required' }, 400, corsHeaders);
    if (!ratioAllowed(payload.platform, payload.aspect_ratio)) {
      return jsonResponse({ ok: false, error: 'invalid_aspect_ratio_for_platform' }, 422, corsHeaders);
    }

    const { data: post } = await supabase
      .from('posts')
      .select('id, created_by')
      .eq('id', payload.post_id)
      .single();

    if (!post?.id || !post.created_by) return jsonResponse({ ok: false, error: 'post_not_found' }, 404, corsHeaders);

    const storagePath = `generated/${payload.post_id}/${payload.platform}_${payload.aspect_ratio.replace(':', 'x')}_${Date.now()}.png`;

    const { data: media, error } = await supabase
      .from('media_assets')
      .insert({
        post_id: payload.post_id,
        owner_user_id: post.created_by,
        asset_type: 'image',
        provider: 'openai',
        storage_path: storagePath,
        mime_type: 'image/png',
        status: 'processing',
        metadata: {
          platform: payload.platform,
          aspect_ratio: payload.aspect_ratio,
          prompt: payload.prompt ?? null,
          generated_by: 'generate-image',
          state: 'queued',
        },
      })
      .select('id')
      .single();

    if (error) throw error;

    const prompt = payload.prompt?.trim() || DEFAULT_IMAGE_PROMPT;

    try {
      const generated = await callOpenAIImageProvider({ prompt, aspectRatio: payload.aspect_ratio });

      const { error: uploadError } = await supabase.storage
        .from(IMAGE_STORAGE_BUCKET)
        .upload(storagePath, generated.bytes, {
          contentType: generated.mimeType,
          upsert: true,
          cacheControl: '31536000',
        });

      if (uploadError) {
        await supabase
          .from('media_assets')
          .update({
            status: 'failed',
            metadata: {
              platform: payload.platform,
              aspect_ratio: payload.aspect_ratio,
              prompt,
              generated_by: 'generate-image',
              error: {
                code: 'STORAGE_UPLOAD_FAILED',
                retryable: true,
                message: uploadError.message,
              },
              retry: {
                suggested_after_seconds: 30,
                max_retries: 3,
              },
            },
          })
          .eq('id', media.id);

        return jsonResponse(
          {
            ok: false,
            error: 'STORAGE_UPLOAD_FAILED',
            media_asset_id: media.id,
            retryable: true,
            retry: { suggested_after_seconds: 30, max_retries: 3 },
          },
          502,
          corsHeaders,
        );
      }

      await supabase
        .from('media_assets')
        .update({
          status: 'ready',
          provider: generated.provider,
          storage_path: storagePath,
          mime_type: generated.mimeType,
          metadata: {
            platform: payload.platform,
            aspect_ratio: payload.aspect_ratio,
            prompt,
            generated_by: 'generate-image',
            dimensions: { width: generated.width, height: generated.height },
            provider: {
              name: generated.provider,
              model: generated.model,
              request_id: generated.providerRequestId,
              attempts: generated.attempts,
              duration_ms: generated.durationMs,
            },
            state: 'ready',
          },
        })
        .eq('id', media.id);

      return jsonResponse(
        {
          ok: true,
          media_asset_id: media.id,
          storage_path: storagePath,
          status: 'ready',
          width: generated.width,
          height: generated.height,
        },
        200,
        corsHeaders,
      );
    } catch (providerError) {
      const normalized = String(providerError);
      const code = (normalized.match(/PROVIDER_[A-Z_]+|STORAGE_UPLOAD_FAILED/)?.[0] ??
        'PROVIDER_REQUEST_FAILED') as ProviderErrorCode;
      const retryable = ['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMIT', 'PROVIDER_TEMPORARY', 'STORAGE_UPLOAD_FAILED'].includes(code);

      await supabase
        .from('media_assets')
        .update({
          status: 'failed',
          metadata: {
            platform: payload.platform,
            aspect_ratio: payload.aspect_ratio,
            prompt,
            generated_by: 'generate-image',
            error: {
              code,
              retryable,
              message: normalized.slice(0, 500),
            },
            retry: retryable
              ? {
                  suggested_after_seconds: code === 'PROVIDER_RATE_LIMIT' ? 60 : 20,
                  max_retries: code === 'PROVIDER_RATE_LIMIT' ? 5 : 3,
                }
              : null,
            state: 'failed',
          },
        })
        .eq('id', media.id);

      return jsonResponse(
        {
          ok: false,
          error: code,
          media_asset_id: media.id,
          retryable,
          retry: retryable
            ? {
                suggested_after_seconds: code === 'PROVIDER_RATE_LIMIT' ? 60 : 20,
                max_retries: code === 'PROVIDER_RATE_LIMIT' ? 5 : 3,
              }
            : null,
        },
        retryable ? 502 : 422,
        corsHeaders,
      );
    }
  } catch (error) {
    log('error', 'generate_image_failed', { error: String(error) });
    return jsonResponse({ ok: false, error: String(error) }, 422, corsHeaders);
  }
});
