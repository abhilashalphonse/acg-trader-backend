#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
echo "ACG_BACKUP_START"
: "${TARGET_MONGODB_URI:?missing TARGET_MONGODB_URI}"
: "${BUCKET_ENDPOINT:?missing BUCKET_ENDPOINT}"
: "${BUCKET_NAME:?missing BUCKET_NAME}"
: "${BUCKET_ACCESS_KEY:?missing BUCKET_ACCESS_KEY}"
: "${BUCKET_SECRET_KEY:?missing BUCKET_SECRET_KEY}"
export AWS_ACCESS_KEY_ID="$BUCKET_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$BUCKET_SECRET_KEY"
export AWS_DEFAULT_REGION=auto
export AWS_EC2_METADATA_DISABLED=true
export AWS_PAGER=""
aws configure set default.s3.addressing_style virtual
s3() { aws --endpoint-url="$BUCKET_ENDPOINT" "$@"; }
echo "ACG_BUCKET_DIAGNOSTIC_START"
probe_key="acg-backup-probe/$(date -u +%Y%m%dT%H%M%SZ).txt"
printf 'acg-backup-probe\\n' | s3 s3 cp - "s3://${BUCKET_NAME}/${probe_key}" --no-progress >/dev/null || { echo "BUCKET_WRITE_FAILED"; exit 35; }
s3 s3api head-object --bucket "$BUCKET_NAME" --key "$probe_key" >/dev/null || { echo "BUCKET_READ_FAILED"; exit 36; }
echo "ACG_BUCKET_DIAGNOSTIC_OK"
if [ "${ACG_PROBE_ONLY:-false}" = "true" ]; then echo "ACG_PROBE_FINISHED"; exit 0; fi
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
prefix="acg-trader-baselines/${stamp}"
for db in acg_trader acg_trader_staging; do
  echo "BACKUP_DB_BEGIN ${db}"
  if mongodump --uri="$TARGET_MONGODB_URI" --authenticationDatabase=admin --db="$db" --archive --gzip --numParallelCollections=2 2>/tmp/dump.error |
      s3 s3 cp - "s3://${BUCKET_NAME}/${prefix}/${db}.archive.gz" --no-progress >/dev/null; then
    echo "BACKUP_STREAM_OK ${db}"
  else
    echo "BACKUP_STREAM_FAILED ${db}"
    grep -Ei 'error|failed|invalid|cannot|connection|timeout|not authorized|auth' /tmp/dump.error | tail -n 8 | sed -E 's#mongodb(\\+srv)?://[^[:space:]]+#<REDACTED>#g' || true
    exit 31
  fi
  s3 s3api head-object --bucket "$BUCKET_NAME" --key "${prefix}/${db}.archive.gz" >/dev/null || { echo "BACKUP_OBJECT_HEAD_FAILED ${db}"; exit 32; }
  echo "BACKUP_DB_UPLOADED ${db}"
done
echo "BACKUP_OBJECTS_UPLOAD_COMPLETE prefix=${prefix}"
s3 s3 cp "s3://${BUCKET_NAME}/${prefix}/acg_trader.archive.gz" - --no-progress | gzip -t
s3 s3 cp "s3://${BUCKET_NAME}/${prefix}/acg_trader_staging.archive.gz" - --no-progress | gzip -t
echo "BACKUP_ARCHIVES_READBACK_OK"
# Download each archive completely before selective restore. mongorestore can
# stop reading early once the requested namespaces are restored, which causes
# 'aws s3 cp ... - | mongorestore' to fail with a Broken pipe even for a
# valid archive. A local file also makes download/validation failures distinct.
verify_dir="$(mktemp -d /tmp/acg-backup-verify.XXXXXX)"
mkdir -p "$verify_dir/mongo"
cleanup() {
  mongod --shutdown --dbpath "$verify_dir/mongo" >/dev/null 2>&1 || true
  rm -rf "$verify_dir"
}
trap cleanup EXIT

mongod --dbpath "$verify_dir/mongo" --bind_ip 127.0.0.1 --port 27019 \
  --logpath "$verify_dir/mongod.log" --fork --wiredTigerCacheSizeGB 0.25 >/dev/null
for db in acg_trader acg_trader_staging; do
  echo "BACKUP_VERIFY_RESTORE_BEGIN ${db}"
  archive="$verify_dir/${db}.archive.gz"
  if ! s3 s3 cp "s3://${BUCKET_NAME}/${prefix}/${db}.archive.gz" "$archive" --no-progress >/dev/null; then
    echo "BACKUP_VERIFY_DOWNLOAD_FAILED ${db}"
    exit 40
  fi
  if ! gzip -t "$archive"; then
    echo "BACKUP_VERIFY_GZIP_FAILED ${db}"
    exit 41
  fi
  echo "BACKUP_VERIFY_LOCAL_ARCHIVE_OK ${db}"
  if ! mongorestore --uri="mongodb://127.0.0.1:27019" --archive="$archive" --gzip --stopOnError \
      --nsInclude="${db}.tradingaccounts" --nsInclude="${db}.positions" \
      --nsInclude="${db}.orders" --nsInclude="${db}.deals" \
      --nsInclude="${db}.accountledgers" --nsInclude="${db}.idempotencyrecords" \
      2>"$verify_dir/${db}.restore.log"; then
    echo "BACKUP_VERIFY_RESTORE_FAILED ${db}"
    tail -n 12 "$verify_dir/${db}.restore.log" | sed -E 's#mongodb(\\+srv)?://[^[:space:]]+#<REDACTED>#g' || true
    exit 42
  fi
  TARGET_DB="$db" mongosh "mongodb://127.0.0.1:27019" --quiet --eval '
    const d=db.getSiblingDB(process.env.TARGET_DB);
    for(const n of ["tradingaccounts","positions","orders","deals","accountledgers","idempotencyrecords"]) {
      print("BACKUP_RESTORE_COUNT "+process.env.TARGET_DB+"."+n+"="+d.getCollection(n).countDocuments({}));
    }
  '
  rm -f "$archive"
done
echo "ACG_BACKUP_AND_RESTORE_TEST_COMPLETED prefix=${prefix}"
