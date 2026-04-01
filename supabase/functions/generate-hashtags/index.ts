import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { log } from '../_shared/logger.ts';
import { jsonResponse } from '../_shared/social-generation.ts';

type Payload = { post_id: string; campaign_id?: string; job_id?: string; language?: 'de' | 'en'; max_tags?: number; token_budget?: { campaign?: number } };
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL_SOCIAL') ?? Deno.env.get('OPENAI_MODEL') ?? 'gpt-4.1-mini';
const PLATFORM_TAG_LIMITS: Record<string, number> = { x: 4, linkedin: 6, instagram: 15, threads: 8 };

const qualityFilterTags = (tags: string[], maxTags: number) => {
  const seen = new Set<string>();
  return tags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => /^#[a-z0-9äöüß_]{3,40}$/i.test(tag))
    .filter((tag) => !/^\d+$/.test(tag.slice(1)))
    .filter((tag) => {
      if (seen.has(tag)) return false;
      seen.add(tag);
      return true;
    })
    .slice(0, maxTags);
};

const generateTags = async (params: { platform: string; language: 'de' | 'en'; title: string; maxTags: number }) => {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('openai_key_missing');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.4,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'hashtag_set',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['hashtags'],
            properties: {
              hashtags: { type: 'array', minItems: 3, maxItems: 20, items: { type: 'string' } },
            },
          },
        },
      },
      messages: [
        { role: 'system', content: 'Generate high-quality social hashtags and return only JSON.' },
        {
          role: 'user',
          content: `platform=${params.platform}\nlanguage=${params.language}\ntitle=${params.title}\nmax_tags=${params.maxTags}\nOnly hashtags, each starts with #, no spaces.`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai_hashtags_failed:${res.status}:${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const parsed = JSON.parse(String(body?.choices?.[0]?.message?.content ?? '{}')) as { hashtags?: string[] };
  if (!Array.isArray(parsed.hashtags)) throw new Error('openai_hashtags_invalid_json');
  return parsed.hashtags;
};

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  let parsedPayload: Payload = { post_id: '' };

  try {
    const payload = (await request.json()) as Payload;
    parsedPayload = payload;
    if (!payload.post_id) return jsonResponse({ ok: false, error: 'post_id_required' }, 400, corsHeaders);

    const { data: post } = await supabase
      .from('posts')
      .select('id, title, platform, language, created_by')
      .eq('id', payload.post_id)
      .single();

    const language = payload.language ?? (post?.language as 'de' | 'en') ?? 'de';
    const platform = post?.platform ?? 'linkedin';
    const maxByPlatform = PLATFORM_TAG_LIMITS[platform] ?? 8;
    const maxTags = Math.min(maxByPlatform, Math.min(15, Math.max(3, payload.max_tags ?? maxByPlatform)));

    const estimatedTokens = 180 + maxTags * 8;
    if (payload.campaign_id && payload.token_budget?.campaign) {
      const { data: campaignJobs } = await supabase
        .from('generation_jobs')
        .select('result_payload')
        .eq('campaign_id', payload.campaign_id)
        .order('created_at', { ascending: false })
        .limit(200);
      const campaignUsed = (campaignJobs ?? []).reduce((acc, job) => acc + Number((job.result_payload as Record<string, unknown>)?.estimated_tokens ?? 0), 0);
      if (campaignUsed + estimatedTokens > payload.token_budget.campaign) {
        await supabase.from('generation_jobs').upsert({
          id: payload.job_id,
          campaign_id: payload.campaign_id,
          provider: 'openai',
          model: OPENAI_MODEL,
          initiated_by: post?.created_by,
          status: 'failed',
          error_message: 'token_budget_campaign_exceeded',
          result_payload: { estimated_tokens: estimatedTokens, used_tokens: campaignUsed + estimatedTokens },
          completed_at: new Date().toISOString(),
        });
        return jsonResponse({ ok: false, error: 'token_budget_campaign_exceeded' }, 422, corsHeaders);
      }
    }

    const generated = await generateTags({ platform, language, title: post?.title ?? '', maxTags });
    const filtered = qualityFilterTags(generated, maxTags);
    if (filtered.length < 3) throw new Error('hashtag_quality_filter_too_strict');
    const tags = filtered.join(' ');

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
    await supabase.from('generation_jobs').upsert({
      id: payload.job_id,
      campaign_id: payload.campaign_id ?? null,
      provider: 'openai',
      model: OPENAI_MODEL,
      initiated_by: post?.created_by,
      status: 'completed',
      result_payload: { estimated_tokens: estimatedTokens, tag_count: filtered.length },
      completed_at: new Date().toISOString(),
    });
    return jsonResponse({ ok: true, variant_id: variant.id, hashtags: tags }, 200, corsHeaders);
  } catch (error) {
    await supabase.from('generation_jobs').upsert({
      id: parsedPayload.job_id,
      campaign_id: parsedPayload.campaign_id ?? null,
      provider: 'openai',
      model: OPENAI_MODEL,
      status: 'failed',
      error_message: String(error).slice(0, 500),
      request_payload: parsedPayload,
      completed_at: new Date().toISOString(),
    });
    log('error', 'generate_hashtags_failed', { error: String(error) });
    return jsonResponse({ ok: false, error: String(error) }, 422, corsHeaders);
  }
});
