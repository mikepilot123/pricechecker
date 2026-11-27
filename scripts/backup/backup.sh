#!/usr/bin/env bash
# Daily database backup, run by .github/workflows/db-backup.yml (and by hand
# for a test). Dumps the database in pg_dump's compressed custom format,
# checks the dump looks complete, then encrypts it so it's safe to store as a
# GitHub Actions artifact (this repository is public, so artifacts are not
# private on their own). See RESTORE.md for getting a backup back.
#
# Needs:  DATABASE_URL_UNPOOLED  the direct (not pooled) connection string
#         BACKUP_PASSPHRASE      long random passphrase; also needed to restore
# Optional: PG_BIN (directory holding pg_dump/pg_restore/psql, default: PATH)
#           BACKUP_MIN_BYTES (smallest believable dump, default 20000)
#           BACKUP_DIR (where to write, default ./backup-out)
# Writes:  <dir>/pricechecker-<UTC timestamp>.dump.enc  and  .sha256
# Exits non-zero, with a ::error:: line GitHub shows, on any problem.
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }

[ -n "${DATABASE_URL_UNPOOLED:-}" ] || fail "DATABASE_URL_UNPOOLED is not set (add it as a GitHub Actions secret)."
[ -n "${BACKUP_PASSPHRASE:-}" ] || fail "BACKUP_PASSPHRASE is not set (add it as a GitHub Actions secret)."
[ "${#BACKUP_PASSPHRASE}" -ge 20 ] || fail "BACKUP_PASSPHRASE is too short — use at least 20 characters."

bin="${PG_BIN:+$PG_BIN/}"
min_bytes="${BACKUP_MIN_BYTES:-20000}"
out_dir="${BACKUP_DIR:-backup-out}"
mkdir -p "$out_dir"
stamp="$(date -u +%Y-%m-%dT%H%MZ)"
dump="$out_dir/pricechecker-$stamp.dump"

echo "pg_dump: $("${bin}pg_dump" --version)"

# The tables that matter most must be there and not empty. Read-only queries.
for table in tickets custom_invoices; do
  count="$("${bin}psql" "$DATABASE_URL_UNPOOLED" -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM $table" 2>&1)" \
    || fail "Couldn't read $table before dumping: $count"
  echo "$table rows: $count"
  [ "$count" -gt 0 ] || fail "$table is empty — refusing to treat this as a good backup."
done

"${bin}pg_dump" --format=custom --compress=9 --no-owner --no-privileges \
  --file="$dump" "$DATABASE_URL_UNPOOLED" || fail "pg_dump failed."

bytes="$(stat -c%s "$dump")"
echo "Dump size: $bytes bytes"
[ "$bytes" -ge "$min_bytes" ] || fail "Dump is only $bytes bytes (expected at least $min_bytes) — something is wrong."

# The archive must be readable and hold the data of the key tables.
toc="$("${bin}pg_restore" --list "$dump")" || fail "The dump can't be read back by pg_restore."
for table in tickets custom_invoices bank_transactions expenses; do
  grep -Eq "TABLE DATA public $table " <<<"$toc" || fail "The dump has no data section for $table."
done

# AES-256 with a key derived from the passphrase (PBKDF2). See RESTORE.md.
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$dump" -out "$dump.enc" -pass env:BACKUP_PASSPHRASE || fail "Encrypting the dump failed."
rm -f "$dump"
( cd "$out_dir" && sha256sum "$(basename "$dump.enc")" > "$(basename "$dump.enc").sha256" )

echo "Backup ready: $dump.enc ($(stat -c%s "$dump.enc") bytes)"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "name=pricechecker-db-$stamp" >> "$GITHUB_OUTPUT"
fi
