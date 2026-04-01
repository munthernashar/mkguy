#!/usr/bin/env bash
set -euo pipefail

# Operativer Ablauf für DB-Backup/Restore-Verifikation.
# Modi:
#   backup         - erzeugt pg_dump + Manifest (Checksums, Kern-Rowcounts)
#   restore-check  - spielt Dump in Staging ein und führt standardisierte Checks aus

MODE="${1:-}"

: "${BACKUP_DIR:=./artifacts/backups}"
: "${RETENTION_DAYS:=14}"
: "${REQUIRED_TABLES:=posts publish_jobs post_metrics}"

usage() {
  cat <<USAGE
Usage:
  BACKUP_DB_URL=postgres://... ./scripts/ops/backup_restore_ops.sh backup
  STAGING_DB_URL=postgres://... DUMP_FILE=... ./scripts/ops/backup_restore_ops.sh restore-check

Environment:
  BACKUP_DB_URL             Connection-URL für Produktions-Backup (nur für backup)
  STAGING_DB_URL            Connection-URL für Staging-Restore (nur für restore-check)
  DUMP_FILE                 Pfad zur Dump-Datei (restore-check)
  BACKUP_DIR                Zielverzeichnis für Dumps/Manifeste (default: ./artifacts/backups)
  RETENTION_DAYS            Löschfrist für alte Artefakte (default: 14)
  REQUIRED_TABLES           Tabellen für Pflichtprüfungen (default: posts publish_jobs post_metrics)
USAGE
}

ts_utc() {
  date -u +"%Y%m%dT%H%M%SZ"
}

backup() {
  : "${BACKUP_DB_URL:?BACKUP_DB_URL fehlt}"

  local ts dump_file manifest_file sha_file
  ts="$(ts_utc)"
  mkdir -p "${BACKUP_DIR}"

  dump_file="${BACKUP_DIR}/db_${ts}.dump"
  manifest_file="${BACKUP_DIR}/db_${ts}_manifest.json"
  sha_file="${dump_file}.sha256"

  echo "[backup] Erzeuge Dump: ${dump_file}"
  pg_dump --format=custom --no-owner --no-privileges --dbname="${BACKUP_DB_URL}" --file="${dump_file}"

  echo "[backup] Erzeuge SHA256"
  sha256sum "${dump_file}" > "${sha_file}"

  echo "[backup] Erfasse Kern-Rowcounts (${REQUIRED_TABLES})"
  local table_json
  table_json="$(
    psql "${BACKUP_DB_URL}" -At <<SQL
with t as (
  select unnest(string_to_array('${REQUIRED_TABLES}', ' ')) as table_name
)
select jsonb_object_agg(table_name, row_count)
from (
  select t.table_name,
         (xpath('/row/cnt/text()', query_to_xml(format('select count(*) as cnt from public.%I', t.table_name), true, false, '')))[1]::text::bigint as row_count
  from t
) s;
SQL
  )"

  cat > "${manifest_file}" <<JSON
{
  "created_at_utc": "${ts}",
  "dump_file": "$(basename "${dump_file}")",
  "checksum_file": "$(basename "${sha_file}")",
  "required_tables": "${REQUIRED_TABLES}",
  "rowcounts": ${table_json}
}
JSON

  echo "[backup] Retention: lösche Artefakte älter als ${RETENTION_DAYS} Tage"
  find "${BACKUP_DIR}" -type f -mtime +"${RETENTION_DAYS}" -delete

  echo "[backup] Fertig"
  echo "  Dump: ${dump_file}"
  echo "  Manifest: ${manifest_file}"
}

restore_check() {
  : "${STAGING_DB_URL:?STAGING_DB_URL fehlt}"
  : "${DUMP_FILE:?DUMP_FILE fehlt}"

  if [[ ! -f "${DUMP_FILE}" ]]; then
    echo "[restore-check] Dump nicht gefunden: ${DUMP_FILE}" >&2
    exit 1
  fi

  echo "[restore-check] Spiele Dump in Staging ein"
  pg_restore --clean --if-exists --no-owner --no-privileges --dbname="${STAGING_DB_URL}" "${DUMP_FILE}"

  echo "[restore-check] Prüfe Tabellenanzahl und Kern-Tabellen"
  psql "${STAGING_DB_URL}" -v ON_ERROR_STOP=1 <<'SQL'
-- 1) Grundcheck: Tabellen vorhanden
select count(*) as public_tables
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE';

-- 2) Pflichttabellen vorhanden + Rowcounts
select 'posts' as table_name, count(*) as row_count from public.posts
union all
select 'publish_jobs' as table_name, count(*) as row_count from public.publish_jobs
union all
select 'post_metrics' as table_name, count(*) as row_count from public.post_metrics;

-- 3) Stichproben
select id, status, created_at from public.posts order by created_at desc nulls last limit 5;
select id, post_id, status, created_at from public.publish_jobs order by created_at desc nulls last limit 5;
select id, post_id, metric_date, impressions from public.post_metrics order by metric_date desc nulls last limit 5;

-- 4) RLS-Status: aktiviert und Policies vorhanden
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('posts', 'publish_jobs', 'post_metrics', 'admin_settings', 'audit_logs', 'user_roles')
order by tablename;

select schemaname, tablename, policyname, permissive, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('posts', 'publish_jobs', 'post_metrics', 'admin_settings', 'audit_logs', 'user_roles')
order by tablename, policyname;
SQL

  echo "[restore-check] Fertig: Restore + Standardchecks ausgeführt"
}

case "${MODE}" in
  backup)
    backup
    ;;
  restore-check)
    restore_check
    ;;
  *)
    usage
    exit 1
    ;;
esac
