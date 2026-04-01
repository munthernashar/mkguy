# OAuth Guide

## Ziel
Anbindung von Plattformkonten (Buffer + optional Direct) über sichere Token-Referenzen.

## Konfiguration
1. OAuth App im Provider anlegen.
2. Redirect URI auf Supabase Edge Function Endpoint setzen.
3. Provider-Client-Secret ausschließlich in Supabase Secrets hinterlegen.

## Persistenz
- Tabellen: `platform_accounts`, `buffer_accounts`, `buffer_profiles`.
- Token nur als Referenzen (`access_token_ref`, `refresh_token_ref`), keine Klartext-Tokens im Frontend.

## Fehlerbilder
- `direct_auth_not_connected`: Konto nicht aktiv verbunden.
- `direct_token_missing`: Token-Referenz fehlt.
- `direct_platform_not_supported`: Plattform nicht im Direct-Publishing Scope.

## Betrieb
- Ablaufdaten (`token_expires_at`) monitoren.
- Reconnect-Flow für abgelaufene Authorisierungen bereitstellen.
