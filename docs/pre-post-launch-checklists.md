# Pre-/Post-Launch-Checklisten

## Pre-Launch
- [ ] Migrationen in Staging angewendet.
- [ ] RLS-Policies auf neuen Tabellen geprüft.
- [ ] CSV-Exportfunktionen mit Filtern getestet.
- [ ] Admin-Settings CRUD (Owner) + Read (Editor/Viewer) geprüft.
- [ ] Dead-Letter/Retry/Cancel-End-to-End getestet.
- [ ] Backup erstellt und Restore in Staging validiert.
- [ ] OAuth Redirects + Token-Rotation getestet.
- [ ] Monitoring/Alerting für Job-Queues aktiv.

## Post-Launch
- [ ] Erste 24h Error-Rate für publish/generation Jobs beobachtet.
- [ ] Dead-Letter-Volumen unter Schwellwert.
- [ ] CSV-Exportnutzung und Laufzeiten geprüft.
- [ ] Audit-Logs auf Admin-/Ops-Aktionen geprüft.
- [ ] Restore-Test-Termin für nächsten Zyklus geplant.
