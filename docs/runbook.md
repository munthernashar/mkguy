# Runbook

## 1. Job-Betrieb

### Dead-Letter-Liste
```sql
select * from public.list_dead_letter_jobs(null, 200);
```

### Retry Selected
```sql
select public.retry_selected_jobs('publish', array['00000000-0000-0000-0000-000000000000'::uuid], 'ops_retry');
```

### Kontrolliertes Abbrechen laufender Jobs
```sql
select public.cancel_running_job('generation', '00000000-0000-0000-0000-000000000000'::uuid, 'manual_stop');
```

Alle Operationen werden in `job_operation_audit` plus `audit_logs` protokolliert.

## 2. Wartungsmodus
```sql
select public.set_maintenance_mode(true, 'Geplantes Wartungsfenster 22:00-22:30 UTC');
```

## 3. Backup/Restore-Prozess

### Backup (Produktiv)
1. Konsistenter DB Dump (Schema + Daten), z. B. via `pg_dump`.
2. Storage-Metadaten exportieren:
   - Bucket-Liste
   - Objekt-Metadaten (`name`, `bucket_id`, `metadata`, `created_at`)
3. Artefakte versioniert in gesichertem Storage ablegen.

### Restore (Staging)
1. Leere Staging-DB vorbereiten.
2. Dump einspielen (`psql`/`pg_restore`).
3. Storage-Metadaten importieren bzw. gegen Objektbestand spiegeln.
4. Integritätschecks:
   - Tabellenanzahl / Rowcount gegen Backup-Manifest
   - Stichprobe auf `posts`, `publish_jobs`, `post_metrics`, `campaigns`
   - RLS/Policies funktionsfähig

### Dokumentierter Test-Restore (Staging)
- Testdatum: 2026-04-01
- Scope: Schema + Kernobjekte + Storage-Metadaten
- Ergebnis: Restore erfolgreich, Validierung ohne Blocker.
- Offene Punkte: Automatisierung als CI-Job für quartalsweisen Restore-Test.
