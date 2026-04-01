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
- `direct_<platform>_auth_expired|auth_revoked|auth_error|auth_not_connected`: Account-Auth ist nicht publish-fähig.
- `direct_<platform>_token_missing|refresh_token_missing|token_expired`: Tokenzustand ist unvollständig/abgelaufen.
- `direct_<platform>_platform_not_supported`: Plattform liegt außerhalb des implementierten Direct-Minimums.
- `direct_requires_functional_gap`: `publish_via=direct` ohne gültigen funktionalen Fallback-Trigger angefordert.

## Betrieb
- Ablaufdaten (`token_expires_at`) monitoren.
- Reconnect-Flow für abgelaufene Authorisierungen bereitstellen.
