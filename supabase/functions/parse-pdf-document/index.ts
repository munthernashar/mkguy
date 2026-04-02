import { createHash } from 'node:crypto';
import { createClient } from 'npm:@supabase/supabase-js@2.49.8';
import mammoth from 'npm:mammoth@1.8.0';
import pdf from 'npm:pdf-parse@1.1.1';
import { buildCorsHeaders } from '../_shared/cors.ts';
import { log } from '../_shared/logger.ts';

type ParseRequest = { document_id?: string; job_id?: string; force?: boolean };

const MIN_TEXT_LENGTH = 1200;
const CHUNK_MIN = 1500;
const CHUNK_MAX = 2500;
const INSERT_BATCH_SIZE = 50;

class ParseError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ParseError';
  }
}

const sha256 = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const normalizeText = (value: string) =>
  value
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .trim();

const splitChunks = (text: string) => {
  const chunks: string[] = [];
  let pointer = 0;
  while (pointer < text.length) {
    const remaining = text.length - pointer;
    const targetSize = remaining > CHUNK_MAX ? CHUNK_MAX : remaining;
    let end = pointer + targetSize;

    if (targetSize >= CHUNK_MIN && end < text.length) {
      const searchStart = Math.max(pointer + CHUNK_MIN, end - 120);
      const window = text.slice(searchStart, Math.min(text.length, end + 120));
      const boundary = window.search(/[.!?]\s|\n\n/);
      if (boundary > 0) end = searchStart + boundary + 1;
    }

    chunks.push(text.slice(pointer, end).trim());
    pointer = end;
  }
  return chunks.filter(Boolean);
};

const json = (payload: unknown, status: number, corsHeaders: Record<string, string>) =>
  new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const detectDocumentType = (fileName: string | null, mimeType: string | null): 'pdf' | 'docx' | 'doc' | null => {
  const normalizedName = (fileName ?? '').toLowerCase();
  const normalizedMime = (mimeType ?? '').toLowerCase();

  if (normalizedMime === 'application/pdf' || normalizedName.endsWith('.pdf')) return 'pdf';
  if (
    normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || normalizedName.endsWith('.docx')
  ) return 'docx';
  if (normalizedMime === 'application/msword' || normalizedName.endsWith('.doc')) return 'doc';
  return null;
};

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  const corsHeaders = buildCorsHeaders(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, corsHeaders);

  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

  try {
    const payload = (await request.json()) as ParseRequest;
    if (!payload.document_id) return json({ ok: false, error: 'document_id_required' }, 400, corsHeaders);

    const { data: document, error: docError } = await supabase
      .from('book_documents')
      .select('id, book_id, source_uri, source_type, file_name, mime_type, parse_status, created_by')
      .eq('id', payload.document_id)
      .single();

    if (docError || !document) return json({ ok: false, error: 'document_not_found' }, 404, corsHeaders);

    const bucketPath = (document.source_uri ?? '').replace(/^book-pdfs\//, '');
    if (!bucketPath) throw new Error('parse_error: source_uri fehlt für Dokument.');

    const { data: fileBlob, error: dlError } = await supabase.storage.from('book-pdfs').download(bucketPath);
    if (dlError || !fileBlob) throw new ParseError('storage_download_failed', `Datei konnte nicht geladen werden (${dlError?.message ?? 'unknown'}).`);

    const fileBytes = new Uint8Array(await fileBlob.arrayBuffer());
    const fileHash = sha256(fileBytes);

    if (!payload.force) {
      const { data: duplicate } = await supabase
        .from('book_documents')
        .select('id')
        .eq('book_id', document.book_id)
        .eq('file_sha256', fileHash)
        .neq('id', document.id)
        .is('deleted_at', null)
        .maybeSingle();
      if (duplicate) {
        throw new ParseError('duplicate_document', `Duplikat erkannt (SHA256 bereits in Dokument ${duplicate.id}).`);
      }
    }

    const documentType = detectDocumentType(document.file_name ?? null, document.mime_type ?? null);
    if (!documentType) {
      throw new ParseError(
        'unsupported_document_type',
        'Dokumenttyp nicht unterstützt. Erlaubt sind PDF und DOCX. Für DOC bitte zuerst in DOCX oder PDF konvertieren.',
      );
    }

    if (documentType === 'doc') {
      throw new ParseError(
        'unsupported_document_type',
        'Legacy DOC wird nicht direkt unterstützt. Bitte Datei vor dem Upload in DOCX oder PDF konvertieren.',
      );
    }

    let cleanedText = '';
    let extractionMetadata: Record<string, unknown> = { document_type: documentType };

    if (documentType === 'pdf') {
      const parsed = await pdf(Buffer.from(fileBytes));
      cleanedText = normalizeText(parsed.text ?? '');
      const isLikelyImagePdf = cleanedText.length < 300
        || ((parsed.numpages ?? 1) > 0 && cleanedText.length / (parsed.numpages ?? 1) < 90);

      if (isLikelyImagePdf) {
        throw new ParseError('pdf_image_based', 'PDF wirkt bildbasiert. Bitte OCR durchführen und erneut hochladen.');
      }

      extractionMetadata = {
        ...extractionMetadata,
        numpages: parsed.numpages,
      };
    } else if (documentType === 'docx') {
      const extracted = await mammoth.extractRawText({ buffer: Buffer.from(fileBytes) });
      cleanedText = normalizeText(extracted.value ?? '');
      extractionMetadata = {
        ...extractionMetadata,
        warnings: extracted.messages ?? [],
      };
    }

    if (cleanedText.length < MIN_TEXT_LENGTH) {
      throw new ParseError('text_too_short', `Zu wenig extrahierter Text (${cleanedText.length} Zeichen, Minimum ${MIN_TEXT_LENGTH}).`);
    }

    const chunks = splitChunks(cleanedText);
    if (!chunks.length) throw new ParseError('chunking_failed', 'Keine verwertbaren Text-Chunks erzeugt.');

    await supabase.from('book_document_chunks').delete().eq('document_id', document.id);

    for (let start = 0; start < chunks.length; start += INSERT_BATCH_SIZE) {
      const batch = chunks.slice(start, start + INSERT_BATCH_SIZE).map((content, offset) => ({
        document_id: document.id,
        chunk_index: start + offset,
        content,
        token_count: Math.ceil(content.length / 4),
        metadata: { source: documentType, batch: Math.floor(start / INSERT_BATCH_SIZE) },
      }));

      const { error: insertError } = await supabase.from('book_document_chunks').insert(batch);
      if (insertError) throw new ParseError('chunk_insert_failed', `Chunk-Speicherung fehlgeschlagen (${insertError.message}).`);
    }

    await supabase
      .from('book_documents')
      .update({
        parse_status: 'parsed',
        parse_error: null,
        file_sha256: fileHash,
        parsed_at: new Date().toISOString(),
        document_metadata: {
          extraction: {
            ...extractionMetadata,
            chunk_count: chunks.length,
            text_length: cleanedText.length,
          },
        },
      })
      .eq('id', document.id);

    await supabase
      .from('generation_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', payload.job_id ?? '');

    const insightsUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/generate-book-insights`;
    fetch(insightsUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ document_id: document.id, job_id: payload.job_id }),
    }).catch((error) => log('error', 'parse_pdf_enqueue_insights_failed', { error: String(error), documentId: document.id }));

    return json({ ok: true, document_id: document.id, chunks: chunks.length }, 200, corsHeaders);
  } catch (error) {
    const body = (await request.clone().json().catch(() => ({}))) as ParseRequest;
    const parseErrorCode = error instanceof ParseError ? error.code : String(error).slice(0, 500);
    if (body.document_id) {
      await supabase
        .from('book_documents')
        .update({ parse_status: 'failed', parse_error: parseErrorCode })
        .eq('id', body.document_id);
    }
    if (body.job_id) {
      await supabase
        .from('generation_jobs')
        .update({ status: 'failed', error_message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), completed_at: new Date().toISOString() })
        .eq('id', body.job_id);
    }
    log('error', 'parse_pdf_document_failed', { error: String(error), documentId: body.document_id });
    return json({ ok: false, error: parseErrorCode }, 422, corsHeaders);
  }
});
