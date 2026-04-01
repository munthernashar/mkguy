import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { log } from '../_shared/logger.ts';
import {
  VARIANT_LABELS,
  enforcePlatformLength,
  estimateTokens,
  evaluateGuardrails,
  jsonResponse,
  normalizeWordList,
  requestHash,
} from '../_shared/social-generation.ts';

type RequestPayload = {
  book_id: string;
  campaign_id?: string;
  seed_ids?: string[];
  platforms?: string[];
  languages?: Array<'de' | 'en'>;
  variants_per_platform?: number;
  batch_size?: number;
  token_budget?: { book?: number; campaign?: number };
  use_cache?: boolean;
};

const templateFor = (platform: string, language: 'de' | 'en', seed: string, insight: string, ctaLink: string, variantLabel: string) => {
  const intro = language === 'de' ? `Variante ${variantLabel}: ${seed}` : `Variant ${variantLabel}: ${seed}`;
  const proofPrefix = language === 'de' ? 'Beleg aus dem Buch' : 'Evidence from the book';
  const cta = language === 'de' ? `Jetzt mehr erfahren: ${ctaLink}` : `Learn more now: ${ctaLink}`;
  const platformHint = language === 'de' ? `Für ${platform} optimiert.` : `Optimized for ${platform}.`;
  return `${intro}\n\n${proofPrefix}: ${insight}\n${platformHint}\n${cta}`;
};

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  try {
    const payload = (await request.json()) as RequestPayload;
    if (!payload.book_id) return jsonResponse({ ok: false, error: 'book_id_required' }, 400, corsHeaders);

    const platforms = (payload.platforms?.length ? payload.platforms : ['linkedin', 'x', 'threads', 'instagram']).map((v) => v.toLowerCase());
    const languages = payload.languages?.length ? payload.languages : ['de', 'en'];
    const variantsPerPlatform = Math.min(3, Math.max(1, payload.variants_per_platform ?? 3));
    const batchSize = Math.min(20, Math.max(1, payload.batch_size ?? 10));

    const cacheKeyPayload = {
      book_id: payload.book_id,
      campaign_id: payload.campaign_id,
      seed_ids: payload.seed_ids,
      platforms,
      languages,
      variantsPerPlatform,
      batchSize,
    };
    const cacheHash = requestHash(cacheKeyPayload);

    if (payload.use_cache !== false) {
      const { data: cached } = await supabase
        .from('generation_request_cache')
        .select('response_payload, expires_at')
        .eq('request_hash', cacheHash)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();
      if (cached?.response_payload) return jsonResponse({ ok: true, cached: true, ...cached.response_payload }, 200, corsHeaders);
    }

    const { data: book } = await supabase.from('books').select('id, title, description, created_by').eq('id', payload.book_id).single();
    if (!book) return jsonResponse({ ok: false, error: 'book_not_found' }, 404, corsHeaders);

    let brandKit: { do_words?: unknown; dont_words?: unknown } | null = null;
    if (payload.campaign_id) {
      const { data: campaign } = await supabase.from('campaigns').select('brand_kit_id').eq('id', payload.campaign_id).maybeSingle();
      if (campaign?.brand_kit_id) {
        const { data } = await supabase
          .from('brand_kits')
          .select('do_words, dont_words')
          .eq('id', campaign.brand_kit_id)
          .maybeSingle();
        brandKit = data;
      }
    }

    const [{ data: promptTemplate }, { data: seeds }, { data: insights }] = await Promise.all([
      supabase
        .from('prompt_templates')
        .select('id, body')
        .eq('template_type', 'post')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      (payload.seed_ids?.length
        ? supabase.from('content_seeds').select('id, seed_text, source_link').eq('book_id', payload.book_id).in('id', payload.seed_ids).limit(batchSize)
        : supabase.from('content_seeds').select('id, seed_text, source_link').eq('book_id', payload.book_id).limit(batchSize)),
      supabase
        .from('book_insights')
        .select('content, summary_short, quote_candidates')
        .eq('book_id', payload.book_id)
        .order('updated_at', { ascending: false })
        .limit(5),
    ]);

    const seedRows = seeds && seeds.length ? seeds : [{ id: null, seed_text: book.title ?? 'Buch-Insight', source_link: 'https://example.com' }];
    const sourceFacts = (insights ?? []).flatMap((i) => [i.summary_short, i.content]).filter(Boolean) as string[];

    const doWords = normalizeWordList(brandKit?.do_words);
    const dontWords = normalizeWordList(brandKit?.dont_words);

    const usedTokens = estimateTokens(JSON.stringify(seedRows), JSON.stringify(sourceFacts));
    if (payload.token_budget?.book && usedTokens > payload.token_budget.book) {
      return jsonResponse({ ok: false, error: 'token_budget_book_exceeded', used_tokens: usedTokens }, 422, corsHeaders);
    }

    if (payload.campaign_id && payload.token_budget?.campaign) {
      const { data: campaignJobs } = await supabase
        .from('generation_jobs')
        .select('result_payload')
        .eq('campaign_id', payload.campaign_id)
        .order('created_at', { ascending: false })
        .limit(200);
      const campaignUsed = (campaignJobs ?? []).reduce((acc, job) => {
        const val = Number((job.result_payload as Record<string, unknown>)?.estimated_tokens ?? 0);
        return acc + (Number.isFinite(val) ? val : 0);
      }, 0);
      if (campaignUsed + usedTokens > payload.token_budget.campaign) {
        return jsonResponse({ ok: false, error: 'token_budget_campaign_exceeded', used_tokens: campaignUsed + usedTokens }, 422, corsHeaders);
      }
    }

    const createdPostIds: string[] = [];
    const createdVariantIds: string[] = [];

    for (const seed of seedRows.slice(0, batchSize)) {
      for (const platform of platforms) {
        for (const language of languages) {
          const baseTitle = `${book?.title ?? 'Book'} · ${platform.toUpperCase()} · ${language.toUpperCase()}`;
          const { data: post, error: postError } = await supabase
            .from('posts')
            .insert({
              campaign_id: payload.campaign_id ?? null,
              book_id: payload.book_id,
              seed_id: seed.id,
              title: baseTitle,
              body: null,
              platform,
              language,
              cta_required: true,
              link_required: true,
              status: 'draft',
              workflow_status: 'draft',
              created_by: book?.created_by,
              updated_by: book?.created_by,
            })
            .select('id')
            .single();

          if (postError) throw postError;
          createdPostIds.push(post.id);

          const variants = VARIANT_LABELS.slice(0, variantsPerPlatform);
          for (const variantLabel of variants) {
            const rendered = templateFor(
              platform,
              language,
              seed.seed_text,
              sourceFacts[0] ?? (language === 'de' ? 'Keine belastbaren Erkenntnisse verfügbar.' : 'No proven insight available.'),
              seed.source_link ?? 'https://example.com',
              variantLabel,
            );

            const lengthCheck = enforcePlatformLength(platform, rendered);
            const guardrail = evaluateGuardrails({
              text: lengthCheck.truncated,
              sourceFacts,
              mustIncludeCta: true,
              mustIncludeLink: true,
              disallowedWords: dontWords,
              preferredWords: doWords,
            });

            if (!guardrail.ok) continue;

            const { data: variant, error: variantError } = await supabase
              .from('post_variants')
              .insert({
                post_id: post.id,
                prompt_template_id: promptTemplate?.id ?? null,
                variant_type: 'copy',
                content: lengthCheck.truncated,
                status: 'draft',
                created_by: book?.created_by,
                updated_by: book?.created_by,
                metadata: {
                  variant_label: variantLabel,
                  language,
                  platform,
                  guardrail_score: guardrail.score,
                  guardrail_violations: guardrail.violations,
                  truncated: !lengthCheck.ok,
                },
              })
              .select('id')
              .single();

            if (variantError) throw variantError;
            createdVariantIds.push(variant.id);
          }
        }
      }
    }

    const responsePayload = {
      created_posts: createdPostIds.length,
      created_variants: createdVariantIds.length,
      variants_per_platform: variantsPerPlatform,
      batch_size: batchSize,
      estimated_tokens: usedTokens,
    };

    await supabase.from('generation_jobs').insert({
      campaign_id: payload.campaign_id ?? null,
      provider: 'internal',
      model: 'template-v1',
      initiated_by: book.created_by,
      status: 'completed',
      request_payload: cacheKeyPayload,
      result_payload: responsePayload,
      completed_at: new Date().toISOString(),
    });

    await supabase.from('generation_request_cache').upsert({
      request_hash: cacheHash,
      request_kind: 'generate_post_text',
      response_payload: responsePayload,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    return jsonResponse({ ok: true, ...responsePayload }, 200, corsHeaders);
  } catch (error) {
    log('error', 'generate_post_text_failed', { error: String(error) });
    return jsonResponse({ ok: false, error: String(error) }, 422, corsHeaders);
  }
});
