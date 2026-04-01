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

    const storagePath = `generated/${payload.post_id}/${payload.platform}_${payload.aspect_ratio.replace(':', 'x')}.png`;

    const { data: media, error } = await supabase
      .from('media_assets')
      .insert({
        post_id: payload.post_id,
        owner_user_id: post?.created_by,
        asset_type: 'image',
        provider: 'edge-function-placeholder',
        storage_path: storagePath,
        mime_type: 'image/png',
        status: 'processing',
        metadata: {
          platform: payload.platform,
          aspect_ratio: payload.aspect_ratio,
          prompt: payload.prompt ?? null,
          generated_by: 'generate-image',
        },
      })
      .select('id')
      .single();

    if (error) throw error;

    return jsonResponse({ ok: true, media_asset_id: media.id, storage_path: storagePath }, 200, corsHeaders);
  } catch (error) {
    log('error', 'generate_image_failed', { error: String(error) });
    return jsonResponse({ ok: false, error: String(error) }, 422, corsHeaders);
  }
});
