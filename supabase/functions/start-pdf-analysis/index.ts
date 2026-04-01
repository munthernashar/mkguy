import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { log } from '../_shared/logger.ts';

type StartRequest = {
  document_id?: string;
  force?: boolean;
};

const json = (payload: unknown, status: number, corsHeaders: Record<string, string>) =>
  new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const body = (await request.json()) as StartRequest;
    if (!body.document_id) return json({ ok: false, error: 'document_id_required' }, 400, corsHeaders);

    const { data: doc, error: docError } = await supabase
      .from('book_documents')
      .select('id, book_id, parse_status, source_uri, created_by')
      .eq('id', body.document_id)
      .maybeSingle();

    if (docError || !doc) return json({ ok: false, error: 'document_not_found' }, 404, corsHeaders);

    if (!body.force && doc.parse_status === 'processing') {
      return json({ ok: false, error: 'document_already_processing' }, 409, corsHeaders);
    }

    const { data: job, error: jobError } = await supabase
      .from('generation_jobs')
      .insert({
        book_id: doc.book_id,
        document_id: doc.id,
        initiated_by: doc.created_by,
        job_type: 'pdf_insight',
        status: 'queued',
        request_payload: { force: Boolean(body.force) },
      })
      .select('id')
      .single();

    if (jobError) {
      log('error', 'start_pdf_analysis_job_insert_failed', { error: jobError.message, documentId: doc.id });
      return json({ ok: false, error: 'job_insert_failed' }, 500, corsHeaders);
    }

    await supabase
      .from('book_documents')
      .update({ parse_status: 'processing', parse_error: null })
      .eq('id', doc.id);

    const fnUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/parse-pdf-document`;
    fetch(fnUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ document_id: doc.id, job_id: job.id, force: Boolean(body.force) }),
    }).catch((error) => log('error', 'start_pdf_analysis_enqueue_failed', { error: String(error), documentId: doc.id }));

    return json({ ok: true, job_id: job.id, document_id: doc.id }, 202, corsHeaders);
  } catch (error) {
    log('error', 'start_pdf_analysis_unhandled', { error: String(error) });
    return json({ ok: false, error: 'unexpected_error' }, 500, corsHeaders);
  }
});
