#!/usr/bin/env bash
set -Eeuo pipefail

echo "ACG_STAGING_COPY_STARTED"
: "${SOURCE_MONGODB_URI:?SOURCE_MONGODB_URI is missing}"
: "${TARGET_MONGODB_URI:?TARGET_MONGODB_URI is missing}"

# Production baseline already copied (2,785,121 restored). Never overwrite it.
mongosh "$TARGET_MONGODB_URI" --quiet --eval '
  const prod = db.getSiblingDB("acg_trader");
  const staging = db.getSiblingDB("acg_trader_staging");
  if (prod.getCollectionNames().length === 0) {
    print("PRODUCTION_BASELINE_MISSING"); quit(18);
  }
  if (staging.getCollectionNames().length !== 0) {
    print("STAGING_TARGET_NOT_EMPTY"); quit(17);
  }
  print("PRODUCTION_PRESERVED_STAGING_EMPTY");
' || { echo "TARGET_GUARD_FAILED"; exit 17; }

# Atlas URI embeds /acg_trader; the database in --db must match.
SOURCE_STAGING_URI="${SOURCE_MONGODB_URI/\/acg_trader/\/acg_trader_staging}"
if [[ "$SOURCE_STAGING_URI" == "$SOURCE_MONGODB_URI" ]]; then
  echo "SOURCE_DB_PATH_UNEXPECTED"; exit 19;
fi

dump_log="/tmp/staging-dump.log"
restore_log="/tmp/staging-restore.log"
echo "COPY_BEGIN acg_trader_staging"
if mongodump --uri="$SOURCE_STAGING_URI" --db=acg_trader_staging --archive --gzip --numParallelCollections=2 2>"$dump_log" |
     mongorestore --uri="$TARGET_MONGODB_URI" --archive --gzip --stopOnError --numInsertionWorkersPerCollection=2 2>"$restore_log"; then
  echo "COPY_COMPLETE acg_trader_staging"
  tail -n 5 "$restore_log" | sed -E 's#mongodb(\\+srv)?://[^[:space:]]+#<REDACTED>#g' || true
else
  echo "COPY_FAILED acg_trader_staging"
  for log in "$dump_log" "$restore_log"; do
    grep -Ei 'error|failed|cannot|server selection|restore' "$log" | tail -n 7 | sed -E 's#mongodb(\\+srv)?://[^[:space:]]+#<REDACTED>#g' || true
  done
  exit 22
fi

echo "TARGET_SUMMARY_BEGIN"
mongosh "$TARGET_MONGODB_URI" --quiet --eval '
  for (const name of ["acg_trader", "acg_trader_staging"]) {
    const stats = db.getSiblingDB(name).stats();
    print(name + " collections=" + stats.collections + " documents=" + stats.objects + " indexes=" + stats.indexes + " dataBytes=" + stats.dataSize);
  }
'
echo "ACG_BASELINE_COPY_COMPLETED"
