#!/usr/bin/env bash
# Nightly Postgres backup with rotation (the ledger is money — losing it is not an option).
# Installed on the host via cron:  0 3 * * *  /opt/asoptimus/infra/backup.sh
# Restore:  gunzip -c aso-YYYYmmdd-HHMM.sql.gz | docker compose exec -T postgres psql -U asoptimus asoptimus
# TODO(off-site): also push the newest dump to object storage (R2/S3) once credentials exist.
set -euo pipefail

DIR=/opt/asoptimus/backups
KEEP=14
mkdir -p "$DIR"
cd /opt/asoptimus/infra

docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-asoptimus}" "${POSTGRES_DB:-asoptimus}" \
  | gzip > "$DIR/aso-$(date +%Y%m%d-%H%M).sql.gz"

# rotation: keep the newest $KEEP dumps
ls -1t "$DIR"/aso-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

echo "[backup] $(date -u +%FT%TZ) ok: $(ls -1 "$DIR" | wc -l) dumps kept"
