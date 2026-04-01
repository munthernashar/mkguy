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
supabase functions serve health --env-file ./supabase/.env.local
```

Empfohlene `.env.local` für Functions:

```env
APP_ENV=development
APP_VERSION=0.1.0-dev
LOG_LEVEL=debug
```

## 4) GitHub-Pages Deploy (Frontend)

1. Inhalte aus `frontend/` als statische Seite veröffentlichen.
2. In `frontend/config/prod.js` echte Produktionswerte setzen:
   - `SUPABASE_URL=https://<project-ref>.supabase.co`
   - `SUPABASE_ANON_KEY=<public anon key>`
   - `APP_ENV=production`
   - `APP_VERSION=<release version>`
3. GitHub Pages aktivieren und auf die gewünschte Branch/Folder-Quelle zeigen.

> Hinweis: `SUPABASE_ANON_KEY` ist öffentlich und darf clientseitig genutzt werden; Service-Keys dürfen **nie** im Frontend landen.

## 5) Supabase Deploy (Functions + Migrations)

Migrationen deployen:

```bash
supabase db push
```

Function deployen:

```bash
supabase functions deploy health
```

Secrets/Env setzen:

```bash
supabase secrets set APP_ENV=production APP_VERSION=0.1.0 LOG_LEVEL=info
```

## 6) CORS-Whitelisting (Edge Function `health`)

Die Function erlaubt nur explizit konfigurierte GitHub-Pages-Origins. Aktuell:

- `https://mkguy.github.io`
- `https://www.mkguy.github.io`

Nicht erlaubte Origins erhalten `403` mit `{ "ok": false, "error": "origin_not_allowed" }`.

## 7) Logging-Basis und Redaction-Regeln

Frontend und Functions nutzen gleiche Log-Level:

- `debug`
- `info`
- `warn`
- `error`

Redaction-Regel in beiden Implementierungen:

- Schlüssel, die auf `(key|token|secret|authorization|password)` matchen, werden zu `[REDACTED]` maskiert.

Damit sind sensible Werte (z. B. API Keys/Tokens) standardisiert geschützt.
