# Setup Guide

## Voraussetzungen
- Supabase CLI installiert
- Zugriff auf Supabase Projekt (dev/staging/prod)
- Node/Python für statisches Frontend-Hosting
- Zugriff auf GitHub Pages Repository-Settings (Deploy-Quelle/Branch)

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
Kurzer Smoke-Check nach jedem Deploy (oder nach Konfigurationsänderung):

1. **Frontend-Bundle prüfen (`frontend/`)**
   - Produktion lädt aus `frontend/` (GitHub Pages-Artefakt).
   - `frontend/config/prod.js` enthält valide `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_ENV`, `APP_VERSION`.
2. **Health-Endpoint prüfen (`supabase/functions/health`)**
   - Function deployt und erreichbar:
     - `supabase functions deploy health`
     - `curl -i https://<project-ref>.functions.supabase.co/health`
   - Erwartung: `2xx` und Health-Status ohne Secret-Leaks.
3. **CORS-Origins validieren**
   - Erlaubte Origins enthalten die produktive GitHub-Pages-URL (`https://<org>.github.io/<repo>`).
   - Preflight prüfen:
     - `curl -i -X OPTIONS https://<project-ref>.functions.supabase.co/health -H "Origin: https://<org>.github.io" -H "Access-Control-Request-Method: GET"`
   - Erwartung: passender `access-control-allow-origin` Header.
4. **Öffentliche Config-Keys validieren**
   - Im Frontend dürfen nur Public Keys liegen (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `APP_ENV`, `APP_VERSION`).
   - Kein `SUPABASE_SERVICE_ROLE_KEY`/keine Provider-Secrets in `frontend/config/*.js`.
5. **Fachliche Kurztests**
   - Login als Owner.
   - Lesen/Ändern von `admin_settings`.
   - `select public.list_dead_letter_jobs();`
   - CSV-Test: `select public.export_posts_csv();`

## RLS + Erst-Daten (Onboarding) verifizieren
Ziel: Sicherstellen, dass RLS aktiv bleibt und der kontrollierte Initial-Seed trotzdem nur im leeren System greift.

1. **Mit authentifiziertem Owner/Editor testen**
   - RLS bleibt aktiv, daher immer als eingeloggter User prüfen.
   - Beispiel in SQL-Editor (mit JWT-Kontext) oder via App-Login + Frontend:
     - `select auth.uid();` → darf nicht `null` sein.
     - `select public.current_app_role();` → sollte `owner` oder `editor` sein.

2. **Leeren Zustand prüfen**
   - `select count(*) as books from public.books where deleted_at is null;`
   - `select count(*) as campaigns from public.campaigns where deleted_at is null;`
   - `select count(*) as posts from public.posts where deleted_at is null;`
   - Erwartung vor Onboarding-Test: alle drei Counts = `0`.

3. **Kontrollierten Seed manuell auslösen**
   - Development:
     - `select public.ensure_initial_seed('dev');`
   - Produktion:
     - `select public.ensure_initial_seed('prod');`
   - Erwartung:
     - Rückgabe enthält `"seeded": true` und `"inserted"` mit mindestens `books=1`, `campaigns=1`, `posts=1`.
     - Optional auch `utm_profiles=1` (wenn Tabelle vorhanden/aktiv genutzt).

4. **Idempotenz prüfen (kein Doppel-Seed)**
   - Funktion direkt erneut ausführen:
     - `select public.ensure_initial_seed('dev');`
   - Erwartung:
     - `"seeded": false`
     - `"existing_before"` zeigt bereits vorhandene Datensätze.

5. **RLS weiterhin wirksam prüfen**
   - Mit einem User ohne Schreibrechte (z. B. `viewer`) testen:
     - `select public.ensure_initial_seed('prod');`
   - Erwartung:
     - Fehler wegen fehlender Rolle (`insufficient_role_for_seed`) oder RLS-Block.
   - Damit ist bestätigt: Seed umgeht keine Rollen-/RLS-Regeln.

## Deploy-Run (Reihenfolge + Rollback)

### Empfohlene Reihenfolge (Prod)
1. **Wartungsfenster/Freeze aktivieren (optional, empfohlen)**
   Content-Änderungen kurz einfrieren, damit Schemawechsel konsistent bleiben.
2. **Datenbank-Migrationen deployen**
   `supabase db push`
3. **Edge Functions deployen**
   Mindestens `health` plus produktiv genutzte Functions deployen, z. B.:
   - `supabase functions deploy health`
   - `supabase functions deploy auth-health`
   - `supabase functions deploy set-user-role`
   - `supabase functions deploy audit-log-write`
4. **Secrets/Runtime-Config serverseitig prüfen/setzen**
   `supabase secrets set ...` (keine Secrets im Frontend).
5. **Frontend auf GitHub Pages ausrollen (`frontend/`)**
   Produktionsartefakt veröffentlichen und `frontend/config/prod.js` auf reale Produktionswerte prüfen.
6. **Smoke-Check ausführen**
   Vollständig gemäß Abschnitt oben (inkl. CORS, Health, Public Config Keys).

### Rollback-Hinweise
- **Frontend-Rollback:** auf letzten bekannten GitHub-Pages-Stand zurück (letzter funktionierender Commit/Release).
- **Functions-Rollback:** vorherige Function-Version erneut deployen (aus Git-Historie tag/commit).
- **Migration-Rollback:** keine ad-hoc-Manipulation in Prod; stattdessen dedizierte Gegenmigration erstellen und deployen.
- **Kommunikation:** Incident im Betriebskanal dokumentieren (Zeitpunkt, Scope, betroffene Komponenten, getroffene Maßnahmen).
