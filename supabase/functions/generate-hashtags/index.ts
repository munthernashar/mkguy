import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { log } from '../_shared/logger.ts';
import { jsonResponse } from '../_shared/social-generation.ts';

type Payload = { post_id: string; language?: 'de' | 'en'; max_tags?: number };

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  try {
    const payload = (await request.json()) as Payload;
    if (!payload.post_id) return jsonResponse({ ok: false, error: 'post_id_required' }, 400, corsHeaders);

    const { data: post } = await supabase
      .from('posts')
      .select('id, title, platform, language, created_by')
      .eq('id', payload.post_id)
      .single();

    const language = payload.language ?? (post?.language as 'de' | 'en') ?? 'de';
    const maxTags = Math.min(15, Math.max(3, payload.max_tags ?? 8));

    const base = language === 'de'
      ? ['#buchmarketing', '#contentstrategie', '#leadgenerierung', '#wissensmarketing', '#onlinebusiness', '#cta', '#growth']
      : ['#bookmarketing', '#contentstrategy', '#leadgeneration', '#thoughtleadership', '#onlinemarketing', '#cta', '#growth'];

    const tags = base.slice(0, maxTags).join(' ');

    const { data: variant, error } = await supabase
      .from('post_variants')
      .insert({
        post_id: payload.post_id,
        variant_type: 'hashtag_set',
        content: tags,
        created_by: post?.created_by,
        updated_by: post?.created_by,
      })
      .select('id')
      .single();

    if (error) throw error;
    return jsonResponse({ ok: true, variant_id: variant.id, hashtags: tags }, 200, corsHeaders);
  } catch (error) {
    log('error', 'generate_hashtags_failed', { error: String(error) });
    return jsonResponse({ ok: false, error: String(error) }, 422, corsHeaders);
  }
});
