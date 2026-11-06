#!/usr/bin/env bash
set -euo pipefail
umask 077

app_dir="${CLICKSHIELD_APP_DIR:-/opt/clickshield}"
cd "$app_dir"
compose_file="${CLICKSHIELD_COMPOSE_FILE:-compose.yml}"
env_file="${CLICKSHIELD_ENV_FILE:-.env}"
backup_dir="${CLICKSHIELD_BACKUP_DIR:-$app_dir/backups}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
exec 9>"$backup_dir/.backup.lock"
flock -n 9 || exit 0

recipients_file="${CLICKSHIELD_BACKUP_RECIPIENTS_FILE:?set CLICKSHIELD_BACKUP_RECIPIENTS_FILE to an age recipients file}"
# Validate recipients before stopping the worker or reading any private data.
age --encrypt --recipients-file "$recipients_file" </dev/null >/dev/null
archive="$backup_dir/clickshield-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
objects="${archive%.dump.age}.replay.tar.gz.age"
[[ ! -e "$archive" && ! -e "$objects" ]] || { echo 'Backup already exists for this timestamp' >&2; exit 1; }
temporary="$(mktemp -d "$backup_dir/.backup.XXXXXXXX")"
resume_worker=false
objects_published=false
complete=false
cleanup() {
  rm -rf "$temporary"
  if "$objects_published" && ! "$complete"; then rm -f "$objects"; fi
  if "$resume_worker"; then
    docker compose --env-file "$env_file" -f "$compose_file" up -d --no-deps worker
  fi
}
trap cleanup EXIT
if [[ -n "${CLICKSHIELD_REPLAY_VOLUME:-}" ]]; then
  if [[ -n "$(docker compose --env-file "$env_file" -f "$compose_file" ps --status running -q worker)" ]]; then
    resume_worker=true
    docker compose --env-file "$env_file" -f "$compose_file" stop -t 15 worker
  fi
fi
docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres pg_dump -U clickshield -d clickshield -Fc \
  | age --encrypt --recipients-file "$recipients_file" >"$temporary/database.age"
if [[ -n "${CLICKSHIELD_REPLAY_VOLUME:-}" ]]; then
  docker run --rm --mount "type=volume,src=$CLICKSHIELD_REPLAY_VOLUME,dst=/data,readonly" \
    alpine:3.22 tar -czf - -C /data . \
    | age --encrypt --recipients-file "$recipients_file" >"$temporary/replay.age"
  mv "$temporary/replay.age" "$objects"
  objects_published=true
fi
# Publish the database last: pull_backup.sh only selects completed pairs.
mv "$temporary/database.age" "$archive"
complete=true
find "$backup_dir" -maxdepth 1 -type f \( -name 'clickshield-*.dump' -o -name 'clickshield-*.replay.tar.gz' -o -name 'clickshield-*.dump.age' -o -name 'clickshield-*.replay.tar.gz.age' \) -mtime +13 -delete
echo "Created encrypted backup: $archive"
if [[ -f "$objects" ]]; then echo "Created encrypted backup: $objects"; fi
