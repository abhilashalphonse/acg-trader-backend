#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
: "${SOURCE_MONGO_URI:?missing SOURCE_MONGO_URI}"
: "${CANDIDATE_MONGO_PASSWORD:?missing CANDIDATE_MONGO_PASSWORD}"
mode="${ACG_COPY_MODE:-BASELINE}"
[[ "$mode" == "BASELINE" || "$mode" == "FINAL" ]] || { echo "COPY_MODE_INVALID"; exit 20; }
if [[ "$mode" == "FINAL" ]]; then
  if [[ "${ACG_WRITES_FROZEN_CONFIRMED:-}" != "true" ]]; then
    echo "FINAL_COPY_REQUIRES_CONFIRMED_MAINTENANCE"
    exit 21
  fi
  # Independent server-side guard: prevent an accidental final copy while the
  # ACG Trader backend is still accepting orders and database writes.
  maintenance="$(curl --fail --silent --show-error --max-time 8 \
    http://acg-trader-backend.railway.internal:4000/health/ready)" || {
    echo "FINAL_COPY_MAINTENANCE_UNREACHABLE"
    exit 25
  }
  if [[ "$maintenance" != *'"status":"maintenance"'* || "$maintenance" != *'"databaseWritesEnabled":false'* ]]; then
    echo "FINAL_COPY_MAINTENANCE_NOT_ACTIVE"
    exit 26
  fi
  echo "FINAL_COPY_MAINTENANCE_CONFIRMED"
fi
target_host="acg-mongo-single-candidate.railway.internal"
target_user="acgadmin"
target_args=(--host "$target_host" --port 27017 --username "$target_user" --password "$CANDIDATE_MONGO_PASSWORD" --authenticationDatabase admin)
candidate_set="$(mongosh "${target_args[@]}" --quiet --eval 'print(db.hello().setName)')"
source_set="$(mongosh "$SOURCE_MONGO_URI" --quiet --eval 'print(db.hello().setName)')"
if [[ "$candidate_set" != "acg_single" || "$source_set" != "rs0" ]]; then
  echo "REPLICA_IDENTITY_MISMATCH source=${source_set} candidate=${candidate_set}"
  exit 22
fi
echo "MIGRATION_COPY_START mode=${mode} source_set=${source_set} target_set=${candidate_set}"

for db_name in acg_trader acg_trader_staging; do
  echo "MIGRATION_COPY_DB_BEGIN ${db_name}"
  # The target is a disposable candidate. --drop never runs against the source.
  # Pipefail prevents an unsuccessful dump from being mistaken for a valid restore.
  mongodump --uri "$SOURCE_MONGO_URI" --authenticationDatabase admin \
    --db "$db_name" --archive --gzip --numParallelCollections=2 \
    2>/tmp/acg-copy-dump.err | \
    mongorestore "${target_args[@]}" --archive --gzip --drop --stopOnError \
    --numInsertionWorkersPerCollection=2 2>/tmp/acg-copy-restore.err || {
      echo "MIGRATION_COPY_FAILED ${db_name}"
      # Deliberately avoid printing raw connection strings or passwords.
      exit 23
    }
  echo "MIGRATION_COPY_DB_RESTORED ${db_name}"

  export ACG_COMPARE_DB="$db_name"
  compare_js='
    const d=db.getSiblingDB(process.env.ACG_COMPARE_DB);
    const names=d.getCollectionNames().filter(n => !n.startsWith("system.")).sort();
    for(const name of names) {
      const col=d.getCollection(name);
      const count=col.countDocuments({});
      const indexes=col.getIndexes().map(i=>JSON.stringify(i.key)).sort().join(",");
      print(name+"|"+count+"|"+indexes);
    }
  '
  mongosh "$SOURCE_MONGO_URI" --quiet --eval "$compare_js" | LC_ALL=C sort >"/tmp/${db_name}.source.txt"
  mongosh "${target_args[@]}" --quiet --eval "$compare_js" | LC_ALL=C sort >"/tmp/${db_name}.target.txt"
  if cmp -s "/tmp/${db_name}.source.txt" "/tmp/${db_name}.target.txt"; then
    echo "MIGRATION_COLLECTION_COUNTS_INDEXES_MATCH ${db_name}"
  else
    echo "MIGRATION_COLLECTION_COUNTS_OR_INDEXES_DIFF ${db_name}"
    # In BASELINE, the source may change while it is being copied.
    if [[ "$mode" == "FINAL" ]]; then
      echo "MIGRATION_FINAL_RECONCILIATION_FAILED ${db_name}"
      exit 24
    fi
  fi
done
echo "MIGRATION_COPY_FINISHED mode=${mode}"
