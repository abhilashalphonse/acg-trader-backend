#!/usr/bin/env bash
set -Eeuo pipefail
: "${SOURCE_MONGODB_URI:?missing source}"
: "${TARGET_MONGODB_URI:?missing target}"
: "${BACKEND_MAINTENANCE_URL:?missing backend maintenance endpoint}"
echo "ACG_FINAL_SYNC_START"
if [[ "$SOURCE_MONGODB_URI" == "$TARGET_MONGODB_URI" ]]; then echo "SOURCE_TARGET_SAME"; exit 20; fi
check=$(curl -fsS --connect-timeout 5 --max-time 15 "$BACKEND_MAINTENANCE_URL") || { echo "BACKEND_MAINTENANCE_UNREACHABLE"; exit 21; }
if ! grep -q '"databaseWritesEnabled":false' <<<"$check"; then echo "BACKEND_IS_NOT_IN_WRITE_FREEZE"; exit 22; fi
echo "BACKEND_WRITE_FREEZE_CONFIRMED"
echo "FINAL_SYNC_PRODUCTION_BEGIN"
if mongodump --uri="$SOURCE_MONGODB_URI" --db=acg_trader --archive --gzip --numParallelCollections=2 2>/tmp/acg-final-dump.log |
    mongorestore --uri="$TARGET_MONGODB_URI" --archive --gzip --drop --stopOnError --numInsertionWorkersPerCollection=2 2>/tmp/acg-final-restore.log; then
  echo "FINAL_SYNC_PRODUCTION_RESTORED"
  tail -n 2 /tmp/acg-final-restore.log | sed -E 's#mongodb(\\+srv)?://[^[:space:]]+#<REDACTED>#g'
else
  echo "FINAL_SYNC_COPY_FAILED"
  for f in /tmp/acg-final-dump.log /tmp/acg-final-restore.log; do
    grep -Ei 'error|failed|cannot|timeout|auth' "$f" | tail -n 5 | sed -E 's#mongodb(\\+srv)?://[^[:space:]]+#<REDACTED>#g' || true
  done
  exit 23
fi
echo "FINAL_SYNC_VERIFY_START"
mongosh --nodb --quiet /usr/local/bin/acg-final-verify.js || { echo "FINAL_SYNC_VERIFY_FAILED"; exit 24; }
echo "ACG_FINAL_SYNC_VERIFIED"
