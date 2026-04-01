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

### Dokumentierter Restore-Probelauf (Staging, konkret)

#### Ziel
Nachweisen, dass ein produktionsnaher Restore in Staging reproduzierbar funktioniert und die Kernfunktionen (Auth/RLS, Content, Jobs, KPI, Exporte) danach weiter nutzbar sind.

#### Voraussetzungen
- Backup-Manifest mit erwarteten Rowcounts je Tabelle liegt vor.
- DB-Dump (`.dump` oder `.sql`) und Storage-Metadaten-Export liegen lokal vor.
- Staging-Projekt ist erreichbar, und ein Owner-User ist vorhanden.

#### Durchführung (Schritt-für-Schritt)
1. **Staging in definierten Startzustand bringen**
   - Bestehende Schemas bereinigen oder frische DB instanziieren.
   - Erwartetes Ergebnis: Keine produktiven Alt-Daten mehr vorhanden.
2. **Datenbank-Restore ausführen**
   - Beispiel: `pg_restore --clean --if-exists --no-owner --no-privileges -d "$STAGING_DB_URL" backup.dump`
   - Erwartetes Ergebnis: Restore endet ohne `ERROR`, nur ggf. harmlose `NOTICE`.
3. **Migrationen/Extensions verifizieren**
   - Prüfen, dass alle erwarteten Funktionen/Tables vorhanden sind (inkl. `admin_settings`, Export-RPCs, Job-Ops-RPCs).
   - Erwartetes Ergebnis: Objekte vorhanden, keine fehlenden Abhängigkeiten.
4. **Storage-Metadaten spiegeln**
   - Bucket- und Objekt-Metadaten importieren bzw. mit realem Objektbestand abgleichen.
   - Erwartetes Ergebnis: Bucket-Liste und Objektanzahl stimmen mit Manifest überein.
5. **Integritätsprüfungen (SQL)**
   - Rowcount-Vergleich für Kernobjekte: `posts`, `publish_jobs`, `generation_jobs`, `post_metrics`, `campaigns`, `books`.
   - Stichprobe inhaltlich: 5 zufällige `post_id` prüfen (Variantenzuordnung, KPI-Bezug, Campaign-Link).
   - Erwartetes Ergebnis: Abweichung pro Tabelle = 0 (oder dokumentierte, freigegebene Differenz).
6. **RLS-/Rechte-Prüfung**
   - Mit Owner testen: Zugriff auf `admin_settings`, `audit_logs`, `job_operation_audit`.
   - Mit Nicht-Owner testen: Schreibzugriff auf `admin_settings` muss fehlschlagen.
   - Erwartetes Ergebnis: Policies verhalten sich exakt wie definiert.
7. **Funktionsprobe (Smoke Test)**
   - `set_maintenance_mode(true, 'Staging Restore Test')` und zurück auf `false`.
   - Je ein CSV-Export ausführen: `export_posts_csv`, `export_publish_jobs_csv`, `export_kpi_metrics_csv`, `export_campaigns_csv`, `export_book_seed_overview_csv`.
   - Dead-Letter-Operationen trocken prüfen (Detailabruf/Filter; kein produktiver Eingriff notwendig).
   - Erwartetes Ergebnis: RPCs antworten ohne Fehler, CSV enthält Header + Daten/leer aber valide.
8. **Abschluss & Dokumentation**
   - Restore-Dauer, verwendete Backup-Artefakte (Zeitpunkt/Hash), Prüfergebnis und Abweichungen dokumentieren.
   - Ticket/Changelog mit `passed` oder `failed` + Maßnahmen anlegen.

#### Abnahmekriterien (Go/No-Go)
- **Go**, wenn alle Prüfschritte ohne kritische Abweichung bestanden sind.
- **No-Go**, wenn mindestens eine Bedingung zutrifft:
  - RLS verletzt (unerlaubter Zugriff möglich),
  - Kern-RPCs nicht ausführbar,
  - Rowcount-Differenzen ungeklärt,
  - referenzielle Integrität gebrochen.
