import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { log } from '../_shared/logger.ts';
import { evaluateGuardrails, jsonResponse, normalizeWordList } from '../_shared/social-generation.ts';

type Payload = { post_variant_id: string; source_facts?: string[]; do_words?: string[]; dont_words?: string[] };

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  try {
    const payload = (await request.json()) as Payload;
    if (!payload.post_variant_id) return jsonResponse({ ok: false, error: 'post_variant_id_required' }, 400, corsHeaders);

    const { data: variant, error } = await supabase
      .from('post_variants')
      .select('id, content, post_id')
      .eq('id', payload.post_variant_id)
      .single();
    if (error) throw error;

    const { data: insightRows } = await supabase
      .from('posts')
      .select('book_id')
      .eq('id', variant.post_id)
      .single()
      .then(async (result) => {
        if (!result.data?.book_id) return { data: [] };
        return await supabase.from('book_insights').select('summary_short, content').eq('book_id', result.data.book_id).limit(5);
      });

    const facts = payload.source_facts?.length
      ? payload.source_facts
      : (insightRows ?? []).flatMap((row) => [row.summary_short, row.content]).filter(Boolean) as string[];

    const guardrail = evaluateGuardrails({
      text: variant.content,
      sourceFacts: facts,
      mustIncludeCta: true,
      mustIncludeLink: true,
      disallowedWords: normalizeWordList(payload.dont_words),
      preferredWords: normalizeWordList(payload.do_words),
    });

    await supabase
      .from('post_variants')
      .update({
        metadata: {
          quality_score: guardrail.score,
          guardrail_ok: guardrail.ok,
          violations: guardrail.violations,
          scored_at: new Date().toISOString(),
        },
      })
      .eq('id', variant.id);

    return jsonResponse({ ok: true, score: guardrail.score, violations: guardrail.violations }, 200, corsHeaders);
  } catch (error) {
    log('error', 'quality_score_post_failed', { error: String(error) });
    return jsonResponse({ ok: false, error: String(error) }, 422, corsHeaders);
  }
});
