import { createHash } from 'node:crypto';
import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { log } from '../_shared/logger.ts';

type InsightRequest = { document_id?: string; job_id?: string };

type InsightPayload = {
  summary_short: string;
  summary_long: string;
  key_topics: string[];
  quote_candidates: string[];
  content_seeds: string[];
};

const json = (payload: unknown, status: number, corsHeaders: Record<string, string>) =>
  new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const deriveFallback = (text: string): InsightPayload => {
  const paragraphs = text.split(/\n\n+/).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);
  const sentenceCandidates = text.split(/(?<=[.!?])\s+/).filter((v) => v.length > 50);
  return {
    summary_short: (sentenceCandidates[0] ?? text.slice(0, 220)).slice(0, 280),
    summary_long: paragraphs.slice(0, 3).join('\n\n').slice(0, 2200),
    key_topics: [...new Set(words.filter((word) => word.length > 7).slice(0, 8))],
    quote_candidates: sentenceCandidates.slice(0, 5),
    content_seeds: [
      'LinkedIn-Post: wichtigste These mit Call-to-Action.',
      'Karussell: 5 Kernideen aus dem Buch.',
      'Newsletter-Teaser mit zentralem Zitat.',
    ],
  };
};
const OPENAI_MODEL = Deno.env.get('OPENAI_MODEL_INSIGHTS') ?? Deno.env.get('OPENAI_MODEL') ?? 'gpt-4.1-mini';

const validateInsight = (value: InsightPayload) => {
  if (!value.summary_short || !value.summary_long) return false;
  if (!Array.isArray(value.key_topics) || !Array.isArray(value.quote_candidates) || !Array.isArray(value.content_seeds)) return false;
  return true;
};

const generateInsightWithModel = async (sourceText: string) => {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('openai_key_missing');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'book_insights',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['summary_short', 'summary_long', 'key_topics', 'quote_candidates', 'content_seeds'],
            properties: {
              summary_short: { type: 'string', minLength: 50, maxLength: 400 },
              summary_long: { type: 'string', minLength: 200, maxLength: 3000 },
              key_topics: { type: 'array', minItems: 3, maxItems: 12, items: { type: 'string' } },
              quote_candidates: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string' } },
              content_seeds: { type: 'array', minItems: 3, maxItems: 10, items: { type: 'string' } },
            },
          },
        },
      },
      messages: [
        { role: 'system', content: 'Extrahiere belastbare Buch-Insights. Antworte nur mit validem JSON im geforderten Schema.' },
        { role: 'user', content: `Source text:\n${sourceText.slice(0, 120_000)}` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`openai_insights_failed:${response.status}:${(await response.text()).slice(0, 300)}`);
  const json = await response.json();
  const parsed = JSON.parse(String(json?.choices?.[0]?.message?.content ?? '{}')) as InsightPayload;
  if (!validateInsight(parsed)) throw new Error('insight_error: JSON-Schema-Validierung fehlgeschlagen.');
  return parsed;
};

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  let parsedPayload: InsightRequest = {};

  try {
    const payload = (await request.json()) as InsightRequest;
    parsedPayload = payload;
    if (!payload.document_id) return json({ ok: false, error: 'document_id_required' }, 400, corsHeaders);

    const { data: chunks, error: chunksError } = await supabase
      .from('book_document_chunks')
      .select('content, chunk_index')
      .eq('document_id', payload.document_id)
      .order('chunk_index', { ascending: true });

    if (chunksError || !chunks?.length) throw new Error('insight_error: Keine Chunks für Dokument vorhanden.');

    const { data: document } = await supabase
      .from('book_documents')
      .select('id, book_id, created_by')
      .eq('id', payload.document_id)
      .single();

    const merged = chunks.map((chunk) => chunk.content).join('\n\n');
    const estimatedTokens = Math.ceil(merged.length / 4) + 900;
    const { data: budgetConfig } = await supabase
      .from('books')
      .select('settings')
      .eq('id', document.book_id)
      .maybeSingle();
    const bookBudget = Number((budgetConfig?.settings as Record<string, unknown> | null)?.insights_token_budget ?? 120000);
    if (estimatedTokens > bookBudget) {
      throw new Error(`token_budget_book_exceeded:${estimatedTokens}/${bookBudget}`);
    }

    let output: InsightPayload;
    let usedFallback = false;
    try {
      output = await generateInsightWithModel(merged);
    } catch (modelError) {
      usedFallback = true;
      log('warn', 'generate_book_insights_fallback', { error: String(modelError), documentId: payload.document_id });
      output = deriveFallback(merged);
      if (!validateInsight(output)) throw modelError;
    }

    const sourceHash = sha256(merged);

    const record = {
      book_id: document.book_id,
      document_id: payload.document_id,
      insight_type: 'summary',
      title: 'Automatisch generierte Buchanalyse',
      content: output.summary_long,
      summary_short: output.summary_short,
      summary_long: output.summary_long,
      key_topics: output.key_topics,
      quote_candidates: output.quote_candidates,
      content_seeds: output.content_seeds,
      source_hash: sourceHash,
      created_by: document.created_by,
      updated_by: document.created_by,
    };

    const { error: upsertError } = await supabase
      .from('book_insights')
      .upsert(record, { onConflict: 'document_id' });

    if (upsertError) throw new Error(`insight_error: Speicherung fehlgeschlagen (${upsertError.message}).`);

    if (payload.job_id) {
      await supabase
        .from('generation_jobs')
        .update({
          status: 'completed',
          provider: 'openai',
          model: OPENAI_MODEL,
          result_payload: { summary_short: output.summary_short, key_topics_count: output.key_topics.length, estimated_tokens: estimatedTokens, used_fallback: usedFallback },
          completed_at: new Date().toISOString(),
        })
        .eq('id', payload.job_id);
    }

    return json({ ok: true, document_id: payload.document_id }, 200, corsHeaders);
  } catch (error) {
    if (parsedPayload.job_id) {
      await supabase
        .from('generation_jobs')
        .update({
          status: 'failed',
          provider: 'openai',
          model: OPENAI_MODEL,
          error_message: String(error).slice(0, 500),
          result_payload: { failed_at: new Date().toISOString() },
          completed_at: new Date().toISOString(),
        })
        .eq('id', parsedPayload.job_id);
    }
    log('error', 'generate_book_insights_failed', { error: String(error), documentId: parsedPayload.document_id });
    return json({ ok: false, error: String(error) }, 422, corsHeaders);
  }
});
