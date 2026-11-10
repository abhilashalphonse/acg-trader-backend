#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
echo "ACG_BACKUP_START"
: "\${TARGET_MONGODB_URI:?missing TARGET_MONGODB_URI}"
: "\${BUCKET_ENDPOINT:?missing BUCKET_ENDPOINT}"
: "\${BUCKET_NAME:?missing BUCKET_NAME}"
: "\${BUCKET_ACCESS_KEY:?missing BUCKET_ACCESS_KEY}"
: "\${BUCKET_SECRET_KEY:?missing BUCKET_SECRET_KEY}"
export MC_CONFIG_DIR=/tmp/mc-acg-credentials
mkdir -p "$MC_CONFIG_DIR"
mc alias set acg "$BUCKET_ENDPOINT" "$BUCKET_ACCESS_KEY" "$BUCKET_SECRET_KEY" --api S3v4 --path off >/dev/null
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
prefix="acg-trader-baselines/\${stamp}"
for db in acg_trader acg_trader_staging; do
  echo "BACKUP_DB_BEGIN \${db}"
  mongodump --uri="$TARGET_MONGODB_URI" --db="$db" --archive --gzip --numParallelCollections=2 2>/tmp/dump.error |
      mc pipe "acg/\${BUCKET_NAME}/\${prefix}/\${db}.archive.gz" >/dev/null
  mc stat "acg/\${BUCKET_NAME}/\${prefix}/\${db}.archive.gz" >/dev/null
  echo "BACKUP_DB_UPLOADED \${db}"
done
echo "BACKUP_OBJECTS_UPLOAD_COMPLETE prefix=\${prefix}"
mc cat "acg/\${BUCKET_NAME}/\${prefix}/acg_trader.archive.gz" | gzip -t
mc cat "acg/\${BUCKET_NAME}/\${prefix}/acg_trader_staging.archive.gz" | gzip -t
echo "BACKUP_ARCHIVES_READBACK_OK"
mkdir -p /tmp/acg-restore-test
mongod --dbpath /tmp/acg-restore-test --bind_ip 127.0.0.1 --port 27019 \
  --logpath /tmp/acg-restore-mongod.log --fork --wiredTigerCacheSizeGB 0.25 >/dev/null
for db in acg_trader acg_trader_staging; do
  echo "BACKUP_VERIFY_RESTORE_BEGIN \${db}"
  mc cat "acg/\${BUCKET_NAME}/\${prefix}/\${db}.archive.gz" |
      mongorestore --uri="mongodb://127.0.0.1:27019" --archive --gzip --stopOnError \
      --nsInclude="\${db}.tradingaccounts" --nsInclude="\${db}.positions" \
      --nsInclude="\${db}.orders" --nsInclude="\${db}.deals" \
      --nsInclude="\${db}.accountledgers" --nsInclude="\${db}.idempotencyrecords" \
      2>/tmp/restore.error
  TARGET_DB="$db" mongosh "mongodb://127.0.0.1:27019" --quiet --eval '
    const d=db.getSiblingDB(process.env.TARGET_DB);
    for(const n of ["tradingaccounts","positions","orders","deals","accountledgers","idempotencyrecords"]) {
      print("BACKUP_RESTORE_COUNT "+process.env.TARGET_DB+"."+n+"="+d.getCollection(n).countDocuments({}));
    }
  '
done
mongod --shutdown --dbpath /tmp/acg-restore-test >/dev/null || true
echo "ACG_BACKUP_AND_RESTORE_TEST_COMPLETED prefix=\${prefix}"
