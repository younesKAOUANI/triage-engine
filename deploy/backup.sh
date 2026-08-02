#!/usr/bin/env bash
#
# Nightly Postgres backup for the single-host deployment.
#
#   ./deploy/backup.sh [destination-dir]
#
# Install as a cron entry on the server, e.g. 03:17 daily:
#   17 3 * * * cd /srv/triage-engine && ./deploy/backup.sh >> /var/log/triage-backup.log 2>&1
#
# Redis is deliberately not backed up. It holds queue state, which is
# reconstructible: the database is the source of truth, and the reconciliation
# sweep re-drives anything the queue lost. Postgres is the only thing here whose
# loss is unrecoverable.
set -euo pipefail

cd "$(dirname "$0")/.."

DEST="${1:-./backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
COMPOSE="docker compose -f docker-compose.prod.yml"

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

: "${POSTGRES_USER:?POSTGRES_USER not set (is .env present?)}"
: "${POSTGRES_DB:?POSTGRES_DB not set}"

mkdir -p "$DEST"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$DEST/${POSTGRES_DB}-${stamp}.sql.gz"

# Write to a temp name and rename only on success, so an interrupted run can
# never leave a truncated file that looks like a usable backup.
tmp="${target}.partial"
$COMPOSE exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  | gzip -9 > "$tmp"

# gzip of an empty dump is still ~20 bytes, so check for something plausible.
if [ "$(stat -c%s "$tmp" 2>/dev/null || stat -f%z "$tmp")" -lt 1000 ]; then
  echo "backup looks truncated ($(stat -c%s "$tmp" 2>/dev/null || stat -f%z "$tmp") bytes); keeping as $tmp" >&2
  exit 1
fi

mv "$tmp" "$target"
echo "wrote $target ($(du -h "$target" | cut -f1))"

# Prune old backups. Runs only after a successful write, so a failing backup
# never erodes the history you still have.
find "$DEST" -name "${POSTGRES_DB}-*.sql.gz" -mtime "+${RETAIN_DAYS}" -print -delete

# Restore, for when you need it and are not in a state to work it out:
#   gunzip -c BACKUP.sql.gz | docker compose -f docker-compose.prod.yml \
#     exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
