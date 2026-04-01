# User Guide

## CSV-Exporte
Exports sind filterbar nach Zeitraum, Buch, Kampagne und Plattform.

Verfügbare Exporte:
- Posts: `export_posts_csv`
- Publish Jobs: `export_publish_jobs_csv`
- KPI-Metriken: `export_kpi_metrics_csv`
- Kampagnen: `export_campaigns_csv`
- Optional Buch/Seed-Überblick: `export_book_seed_overview_csv`

## Admin-Einstellungen
Globale Einstellungen in `admin_settings`:
- globale Limits
- Default-UTM-Regeln
- Feature-Toggles
- Wartungsmodus

Nur Owner dürfen schreiben; alle Rollen dürfen lesen.

## Operative Job-Kontrollen
- Dead-Letter einsehen: `list_dead_letter_jobs`
- Gezielt erneut einreihen: `retry_selected_jobs`
- Laufende Jobs kontrolliert stoppen: `cancel_running_job`

Jede Aktion ist auditierbar (`job_operation_audit`, `audit_logs`).
