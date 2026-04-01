# Betriebsdoku

## 1) Basisstruktur

```text
frontend/
supabase/functions/
supabase/migrations/
```

## 2) Konfiguration (nur öffentliche Variablen)

Das Frontend verwendet ausschließlich diese Public-Variablen:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `APP_ENV`
- `APP_VERSION`

**Wichtig:** Weder `SUPABASE_SERVICE_ROLE_KEY` noch Provider-Secrets (SMTP/OAuth-Client-Secrets) dürfen im Frontend liegen.
Diese Werte werden ausschließlich als Supabase Secrets serverseitig gesetzt.

Trennung dev/prod erfolgt über:

- `frontend/config/dev.js`
- `frontend/config/prod.js`

`frontend/src/config.js` lädt automatisch `prod.js`, wenn der Host auf `github.io` endet, sonst `dev.js`.

## 3) Lokale Entwicklung

### Frontend lokal starten

Beispiel:

```bash
cd frontend
python3 -m http.server 4173
```

Danach im Browser öffnen:

- `http://127.0.0.1:4173`

### Supabase lokal starten

```bash
supabase start
supabase functions serve auth-health --env-file ./supabase/.env.local
supabase functions serve set-user-role --env-file ./supabase/.env.local
supabase functions serve audit-log-write --env-file ./supabase/.env.local
```

Empfohlene `.env.local` für Functions:

```env
APP_ENV=development
APP_VERSION=0.1.0-dev
LOG_LEVEL=debug
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<public-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<server-side-only>
```

## 4) GitHub-Pages Deploy (Frontend)

1. Inhalte aus `frontend/` als statische Seite veröffentlichen.
2. In `frontend/config/prod.js` echte Produktionswerte setzen:
   - `SUPABASE_URL=https://<project-ref>.supabase.co`
   - `SUPABASE_ANON_KEY=<public anon key>`
   - `APP_ENV=production`
   - `APP_VERSION=<release version>`
3. GitHub Pages aktivieren und auf die gewünschte Branch/Folder-Quelle zeigen.

## 5) Supabase Deploy (Functions + Migrations)

Migrationen deployen:

```bash
supabase db push
```

Functions deployen:

```bash
supabase functions deploy auth-health
supabase functions deploy set-user-role
supabase functions deploy audit-log-write
```

Secrets/Env setzen (serverseitig):

```bash
supabase secrets set \
  APP_ENV=production \
  APP_VERSION=0.1.0 \
  LOG_LEVEL=info \
  SUPABASE_URL=https://<project-ref>.supabase.co \
  SUPABASE_ANON_KEY=<public-anon-key> \
  SUPABASE_SERVICE_ROLE_KEY=<never-in-frontend>
```

## 6) Auth & Rollenmodell

- Login via Magic-Link **und** optional E-Mail/Passwort (`LoginView`), Callback-Verarbeitung (`AuthCallbackView`) und Zugriffsschutz (`SessionGuard`) im Frontend.
- Rollen in `user_roles` mit `owner | editor | viewer`.
- Standardregel: Ohne Rollen-Eintrag kein Zugriff auf inhaltliche Tabellen.
- Initiales Owner-Seed: Der erste Benutzer in `auth.users` wird automatisch als `owner` in `user_roles` angelegt.
- Rollenänderung nur über Edge Function `set-user-role` (owner-only).

## 7) RLS-Status

RLS ist aktiv auf:

- `user_roles`
- `books`
- `campaigns`
- `posts`
- `audit_logs`

Policy-Logik:

- `owner`: Vollzugriff inkl. Rollenverwaltung und Audit-Read.
- `editor`: CRUD auf `books`, `campaigns`, `posts`.
- `viewer`: Read-only auf `books`, `campaigns`, `posts`.
- Ohne Rolle: kein Zugriff.

## 8) Audit Logging

`audit_logs` enthält sicherheits- und inhaltsrelevante Ereignisse:

- Login/Logout über `audit-log-write`
- Rollenänderungen via Trigger auf `user_roles`
- Content CRUD via Trigger auf `books`, `campaigns`, `posts`
- Publishing-Aktionen (Statuswechsel auf `published`) via `posts`-Trigger

## 9) Sicherheitsdetails

- Auth-nahe Endpunkte (`auth-health`, `set-user-role`, `audit-log-write`) haben ein In-Memory-Rate-Limit.
- Fehlermeldungen sind bewusst generisch (`invalid_request`, `unauthorized`, `operation_failed`) und leaken keine internen Details.
- Logging maskiert Schlüssel, Tokens und Secrets.


## 10) Magic-Link Redirects (dynamische Domain)

Wenn in der Mail `http://localhost:3000/...` erscheint, kommt der Link **nicht** aus dem Frontend-Code, sondern aus den Supabase Auth-URL-Einstellungen.

So wird es stabil und domain-flexibel:

1. **Supabase Dashboard → Authentication → URL Configuration**
   - `Site URL` auf die aktuelle Produktions-URL setzen (nicht localhost).
2. **Redirect allow list** pflegen (auch Wildcards möglich), z. B.:
   - `https://mkguy.github.io/**`
   - `https://<org>.github.io/<repo>/**`
   - `https://*.deinedomain.tld/**` (für zukünftige Subdomains)
3. Frontend sendet `emailRedirectTo` zur **aktuellen Runtime-URL** (`window.location.origin + pathname`) mit Callback-View.

Hinweis: Supabase akzeptiert Redirects nur, wenn sie in der Allow-List liegen. Komplett beliebige Domains sind daher aus Sicherheitsgründen nicht möglich.


## 11) Troubleshooting Login

### Symptom: Link enthält `redirect_to=http://localhost:3000`
Ursache: In Supabase Auth ist noch eine lokale URL als `Site URL`/Redirect hinterlegt.

Fix:
- `Authentication -> URL Configuration`
- `Site URL` auf die reale Frontend-URL setzen, z. B. `https://munthernashar.github.io/mkguy/frontend/index.html`
- Redirect-URL erlauben: `https://munthernashar.github.io/mkguy/frontend/**`

### Symptom: `otp_expired` nach Klick auf Mail-Link
- Der Magic-Link ist One-Time und zeitlich begrenzt.
- Link nicht mehrfach öffnen, keine Voransicht-Scanner verwenden, direkt im gleichen Browser klicken.
- Danach neuen Link anfordern.

### Symptom: `429` beim `/auth/v1/otp`
- Supabase limitiert E-Mail-Versandrate.
- 60+ Sekunden warten, dann neuen Link senden.

### Browser-Extension Fehler (`background.js`, `FrameDoesNotExistError`)
Diese Meldungen stammen typischerweise von Browser-Extensions, nicht aus der App selbst.
Für Auth-Tests am besten im Inkognito-Fenster ohne Extensions testen.


### Symptom: Magic-Link korrekt, aber trotzdem „ungültig oder abgelaufen“
- Im Frontend gibt es nun zusätzlich E-Mail/Passwort-Login als Fallback.
- Ursache ist oft ein bereits konsumierter PKCE-Link (z. B. durch Vorschau-Scanner) oder mehrfaches Öffnen des gleichen Links.
- Workaround: neuen Link anfordern oder Passwort-Login verwenden.
