begin;

alter table public.book_documents
  drop constraint if exists book_documents_source_type_check;

alter table public.book_documents
  add constraint book_documents_source_type_check
  check (source_type in ('upload', 'upload_pdf', 'upload_docx', 'upload_doc', 'url', 'import'));

commit;
