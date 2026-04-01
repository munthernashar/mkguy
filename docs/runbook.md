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

## 3. Operativer Backup/Restore-Ablauf

### 3.1 Script + Job-Definition
- Operatives Script: `scripts/ops/backup_restore_ops.sh`
  - `backup`: erstellt konsistenten `pg_dump` + SHA256 + Manifest mit Kern-Rowcounts.
  - `restore-check`: spielt Dump in Staging ein und führt Standard-Checks aus.
- Scheduler-Vorlage: `ops/jobs/db-backup.cron`
  - täglich 02:15 UTC Backup in `/var/backups/mkguy`
  - montags 03:00 UTC Staging-Restore-Probe mit letztem Dump

**Beispiel manuell ausführen**
```bash
BACKUP_DB_URL="postgres://..." BACKUP_DIR="./artifacts/backups" ./scripts/ops/backup_restore_ops.sh backup
STAGING_DB_URL="postgres://..." DUMP_FILE="./artifacts/backups/db_YYYYMMDDTHHMMSSZ.dump" ./scripts/ops/backup_restore_ops.sh restore-check
```

### 3.2 Verbindliche Prüfschritte nach Restore (Staging)
Der Restore ist nur bestanden, wenn alle folgenden Punkte dokumentiert wurden:

1. **Tabellenanzahl**
   - `information_schema.tables` in `public` prüfen.
   - Erwartung: keine fehlenden Kernobjekte, keine Restore-Fehler.
2. **Stichproben auf Kerntabellen**
   - `posts` (5 letzte Einträge: `id/status/created_at`)
   - `publish_jobs` (5 letzte Einträge: `id/post_id/status/created_at`)
   - `post_metrics` (5 letzte Einträge: `id/post_id/metric_date/impressions`)
3. **RLS-Prüfung nach Restore**
   - `rowsecurity = true` für `posts/publish_jobs/post_metrics/admin_settings/audit_logs/user_roles`.
   - Vorhandene Policies via `pg_policies` für diese Tabellen nachweisen.
   - Owner-/Nicht-Owner-Sanity-Check über App/SQL-Session dokumentieren (z. B. Nicht-Owner darf `admin_settings` nicht schreiben).

### 3.3 Trigger (Wann wird Backup/Restore ausgelöst?)

**Reguläre Trigger**
- Tägliches Backup (02:15 UTC).
- Wöchentlicher Restore-Probelauf in Staging (Montag 03:00 UTC).

**Ereignis-Trigger zusätzlich**
- Vor jeder risikoreichen DB-Migration (DDL auf Kernobjekten, RLS-/Policy-Änderungen).
- Vor Bulk-Operationen auf `posts/publish_jobs/post_metrics`.
- Vor geplanter Wartung > 15 Minuten.
- Sofort bei Incident-Klasse `SEV-1`/`SEV-2` mit Datenkorruptionsverdacht.

### 3.4 Aufbewahrung (Retention)
- Standard: 14 Tage (`RETENTION_DAYS=14`) im Backup-Script.
- Monatlicher Snapshot zusätzlich 6 Monate aufbewahren (separates Bucket/Storage-Tier).
- Jeder Dump benötigt:
  - SHA256-Datei
  - Manifest mit Zeitstempel + Kern-Rowcounts
- Löschung nur automatisiert über Retention-Job (keine manuelle Einzel-Löschung ohne Ticket).

### 3.5 Notfallablauf Restore unter Zeitdruck (SEV-1)

1. **Incident ausrufen + Rollen klären (0-5 min)**
   - Incident Commander benennt DB-Operator + Protokollant.
2. **Schadensstopp (5-10 min)**
   - Schreibzugriffe stoppen (`set_maintenance_mode(true, 'SEV-1 restore in progress')`).
3. **Restore-Quelle festlegen (10-15 min)**
   - Letzten konsistenten Dump anhand Manifest + SHA256 auswählen.
4. **Schnell-Restore in Staging oder Direkt-Prod gemäß Incident-Entscheid (15-35 min)**
   - Primär erst Staging-Verifikation; Direkt-Prod nur mit IC-Freigabe.
5. **Mindest-Checks vor Freigabe (35-45 min)**
   - Tabellenanzahl ok
   - Stichproben `posts/publish_jobs/post_metrics` ok
   - RLS aktiv + Policies vorhanden
6. **Wiederanlauf (45-60 min)**
   - Wartungsmodus deaktivieren.
   - Smoke-Test (Login, Export-RPC, Publishing-Flow) durchführen.
7. **Nachbereitung (<24h)**
   - Incident-Report, Ursache, Datenlücke, Maßnahmen, nächster Restore-Probelauf terminieren.

### 3.6 Abnahmekriterien (Go/No-Go)
- **Go**, wenn alle Prüfschritte ohne kritische Abweichung bestanden sind.
- **No-Go**, wenn mindestens eine Bedingung zutrifft:
  - RLS verletzt (unerlaubter Zugriff möglich),
  - Kern-RPCs nicht ausführbar,
  - Rowcount-Differenzen ungeklärt,
  - referenzielle Integrität gebrochen.

## 4. Manueller Backfill fehlender User-Rollen

Für bestehende `auth.users` ohne Eintrag in `public.user_roles` steht eine Owner-only RPC bereit:

```sql
select public.backfill_missing_user_roles('viewer'::public.app_role);
```

Hinweise:
- Idempotent: Der Backfill nutzt `on conflict (user_id) do nothing`.
- Sichere Standardrolle: Standard ist `viewer` (alternativ z. B. `editor`).
- Audit: Jeder Lauf schreibt einen Eintrag in `public.audit_logs` (`action = 'user_roles_backfill'`) mit `default_role` und `inserted_count`.
