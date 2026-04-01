# Setup Guide

## Voraussetzungen
- Supabase CLI installiert
- Zugriff auf Supabase Projekt (dev/staging/prod)
- Node/Python für statisches Frontend-Hosting

## Lokales Setup
1. `supabase start`
2. `supabase db reset`
3. Frontend lokal starten (`cd frontend && python3 -m http.server 4173`)
4. `frontend/config/dev.js` mit lokaler URL/Anon-Key pflegen.

## Datenbank-Migrationen
- Neue Migrationen über `supabase db push` anwenden.
- Für neue Features enthalten:
  - CSV-Exportfunktionen (`export_*_csv`)
  - Admin-Settings (`admin_settings`)
  - Job-Operation-Audit (`job_operation_audit`)
  - Dead-Letter/Retry/Cancel-Funktionen.

## Smoke-Checks
- Login als Owner
- Lesen/Ändern von `admin_settings`
- `select public.list_dead_letter_jobs();`
- CSV-Test: `select public.export_posts_csv();`
