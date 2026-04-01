begin;

alter table public.book_documents
  drop constraint if exists book_documents_parse_status_check;

alter table public.book_documents
  add constraint book_documents_parse_status_check
  check (parse_status in ('uploaded', 'processing', 'parsed', 'failed', 'archived', 'deleted'));

alter table public.book_documents
  add column if not exists file_sha256 text,
  add column if not exists parsed_at timestamptz;

create unique index if not exists idx_book_documents_book_id_file_sha256
  on public.book_documents (book_id, file_sha256)
  where file_sha256 is not null and deleted_at is null;

alter table public.generation_jobs
  add column if not exists book_id uuid references public.books (id) on delete cascade,
  add column if not exists document_id uuid references public.book_documents (id) on delete cascade,
  add column if not exists job_type text not null default 'post_generation';

alter table public.generation_jobs
  drop constraint if exists generation_jobs_job_type_check;

alter table public.generation_jobs
  add constraint generation_jobs_job_type_check
  check (job_type in ('post_generation', 'pdf_parse', 'pdf_insight'));

create index if not exists idx_generation_jobs_document_job_type
  on public.generation_jobs (document_id, job_type, created_at desc);

alter table public.book_insights
  add column if not exists summary_short text,
  add column if not exists summary_long text,
  add column if not exists key_topics jsonb not null default '[]'::jsonb,
  add column if not exists quote_candidates jsonb not null default '[]'::jsonb,
  add column if not exists content_seeds jsonb not null default '[]'::jsonb,
  add column if not exists source_hash text;

create unique index if not exists idx_book_insights_document_unique
  on public.book_insights (document_id)
  where document_id is not null and deleted_at is null;

insert into storage.buckets (id, name, public)
values ('book-pdfs', 'book-pdfs', false)
on conflict (id) do update set public = false;

drop policy if exists "book_pdfs_read_authenticated" on storage.objects;
create policy "book_pdfs_read_authenticated" on storage.objects
for select
using (bucket_id = 'book-pdfs' and auth.role() = 'authenticated');

drop policy if exists "book_pdfs_write_authenticated" on storage.objects;
create policy "book_pdfs_write_authenticated" on storage.objects
for insert
with check (bucket_id = 'book-pdfs' and auth.role() = 'authenticated');

drop policy if exists "book_pdfs_update_authenticated" on storage.objects;
create policy "book_pdfs_update_authenticated" on storage.objects
for update
using (bucket_id = 'book-pdfs' and auth.role() = 'authenticated')
with check (bucket_id = 'book-pdfs' and auth.role() = 'authenticated');

commit;
