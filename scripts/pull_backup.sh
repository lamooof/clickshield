#!/usr/bin/env bash
set -euo pipefail
umask 077

backup_host="${CLICKSHIELD_BACKUP_HOST:?set CLICKSHIELD_BACKUP_HOST to an SSH host}"
backup_dir="${CLICKSHIELD_BACKUP_DIR:-$HOME/backups/clickshield}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
exec 9>"$backup_dir/.pull.lock"
flock -n 9 || exit 0
temporary="$(mktemp -d "$backup_dir/.pull.XXXXXXXX")"
trap 'rm -rf "$temporary"' EXIT

name="$(ssh -o BatchMode=yes "$backup_host" "find /opt/clickshield/backups -maxdepth 1 -type f \\( -name 'clickshield-*.dump' -o -name 'clickshield-*.dump.age' \\) -printf '%f\\n' | sort | tail -1")"
[[ "$name" =~ ^clickshield-[0-9]{8}T[0-9]{6}Z\.dump(\.age)?$ ]] || { echo 'No valid remote backup found' >&2; exit 1; }

names=("$name")
objects="${name%.age}"
objects="${objects%.dump}.replay.tar.gz"
if [[ "$name" == *.age ]]; then objects+=.age; fi
if ssh -o BatchMode=yes "$backup_host" "test -f /opt/clickshield/backups/$objects"; then names=("$objects" "$name"); fi
for name in "${names[@]}"; do
  target="$backup_dir/$name"
  remote_hash="$(ssh -o BatchMode=yes "$backup_host" "sha256sum /opt/clickshield/backups/$name" | cut -d ' ' -f 1)"
  candidate="$target"
  if [[ ! -f "$target" ]] || [[ "$(sha256sum "$target" | cut -d ' ' -f 1)" != "$remote_hash" ]]; then
    candidate="$temporary/$name"
    rsync -a --chmod=F600 "$backup_host:/opt/clickshield/backups/$name" "$candidate"
  fi
  local_hash="$(sha256sum "$candidate" | cut -d ' ' -f 1)"
  [[ "$remote_hash" == "$local_hash" ]] || { echo 'Backup checksum mismatch' >&2; exit 1; }
  chmod 600 "$candidate"
  if [[ "$candidate" != "$target" ]]; then mv "$candidate" "$target"; fi
  echo "Verified off-server copy: $target"
done
find "$backup_dir" -maxdepth 1 -type f \( -name 'clickshield-*.dump' -o -name 'clickshield-*.replay.tar.gz' -o -name 'clickshield-*.dump.age' -o -name 'clickshield-*.replay.tar.gz.age' \) -mtime +29 -delete
