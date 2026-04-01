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

const validateInsight = (value: InsightPayload) => {
  if (!value.summary_short || !value.summary_long) return false;
  if (!Array.isArray(value.key_topics) || !Array.isArray(value.quote_candidates) || !Array.isArray(value.content_seeds)) return false;
  return true;
};

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  try {
    const payload = (await request.json()) as InsightRequest;
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
    const output = deriveFallback(merged);

    if (!validateInsight(output)) throw new Error('insight_error: JSON-Schema-Validierung fehlgeschlagen.');

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
          result_payload: { summary_short: output.summary_short, key_topics_count: output.key_topics.length },
          completed_at: new Date().toISOString(),
        })
        .eq('id', payload.job_id);
    }

    return json({ ok: true, document_id: payload.document_id }, 200, corsHeaders);
  } catch (error) {
    const parsed = (await request.clone().json().catch(() => ({}))) as InsightRequest;
    if (parsed.job_id) {
      await supabase
        .from('generation_jobs')
        .update({ status: 'failed', error_message: String(error).slice(0, 500), completed_at: new Date().toISOString() })
        .eq('id', parsed.job_id);
    }
    log('error', 'generate_book_insights_failed', { error: String(error), documentId: parsed.document_id });
    return json({ ok: false, error: String(error) }, 422, corsHeaders);
  }
});
