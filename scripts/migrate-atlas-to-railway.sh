#!/usr/bin/env bash
set -Eeuo pipefail

echo "ACG_BASELINE_COPY_STARTED"
: "${SOURCE_MONGODB_URI:?SOURCE_MONGODB_URI is missing}"
: "${TARGET_MONGODB_URI:?TARGET_MONGODB_URI is missing}"

# Never rerun into existing data. A second pass requires a separate reconciliation plan.
mongosh "$TARGET_MONGODB_URI" --quiet --eval '
  for (const name of ["acg_trader", "acg_trader_staging"]) {
    const count = db.getSiblingDB(name).getCollectionNames().length;
    if (count !== 0) { print("TARGET_NOT_EMPTY " + name + " count=" + count); quit(17); }
  }
  print("TARGET_EMPTY_VERIFIED");
' || { echo "TARGET_GUARD_FAILED"; exit 17; }

for database in acg_trader acg_trader_staging; do
  echo "COPY_BEGIN ${database}"
  dump_log="/tmp/dump-${database}.log"
  restore_log="/tmp/restore-${database}.log"
  if mongodump --uri="$SOURCE_MONGODB_URI" --db="$database" --archive --gzip --numParallelCollections=2 2>"$dump_log" |
       mongorestore --uri="$TARGET_MONGODB_URI" --archive --gzip --stopOnError --numInsertionWorkersPerCollection=2 2>"$restore_log"; then
    echo "COPY_COMPLETE ${database}"
    tail -n 4 "$restore_log" | sed -E 's#mongodb(\\+srv)?://[^[:space:]]+#<REDACTED>#g' || true
  else
    echo "COPY_FAILED ${database}"
    for log in "$dump_log" "$restore_log"; do
      grep -Ei 'error|failed|cannot|server selection|restore' "$log" | tail -n 7 | sed -E 's#mongodb(\\+srv)?://[^[:space:]]+#<REDACTED>#g' || true
    done
    exit 22
  fi
done

echo "TARGET_SUMMARY_BEGIN"
mongosh "$TARGET_MONGODB_URI" --quiet --eval '
  for (const name of ["acg_trader", "acg_trader_staging"]) {
    const stats = db.getSiblingDB(name).stats();
    print(name + " collections=" + stats.collections + " documents=" + stats.objects + " indexes=" + stats.indexes + " dataBytes=" + stats.dataSize);
  }
'
echo "ACG_BASELINE_COPY_COMPLETED"
