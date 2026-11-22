#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${MONGO_INITDB_ROOT_USERNAME:?missing MONGO_INITDB_ROOT_USERNAME}"
: "${MONGO_INITDB_ROOT_PASSWORD:?missing MONGO_INITDB_ROOT_PASSWORD}"
: "${RAILWAY_PRIVATE_DOMAIN:?missing RAILWAY_PRIVATE_DOMAIN}"

replica_set="${MONGO_REPLICA_SET_NAME:-rs0}"
cache_gb="${WT_CACHE_GB:-1.5}"
keyfile="/data/db/.acg-replica-key"
mkdir -p /data/db

# Keyfile stays on the persistent database volume across restarts. Do not log
# the material or regenerate a key while there is an existing member.
if [[ ! -s "$keyfile" ]]; then
  tmp="$(mktemp /data/db/.acg-replica-key.XXXXXX)"
  head -c 756 /dev/urandom | base64 -w 0 >"$tmp"
  chmod 0400 "$tmp"
  chown mongodb:mongodb "$tmp"
  mv "$tmp" "$keyfile"
fi
chmod 0400 "$keyfile"
chown mongodb:mongodb "$keyfile"

# Docker's Mongo entrypoint handles root-user bootstrap exactly once, when the
# attached data directory is empty. We wait for the *final* replSet mongod;
# its temporary bootstrap mongod does not have replSetGetStatus enabled.
docker-entrypoint.sh mongod --replSet "$replica_set" --auth \
  --keyFile "$keyfile" --bind_ip_all \
  --wiredTigerCacheSizeGB "$cache_gb" &
mongo_pid=$!
forward_term() { kill -TERM "$mongo_pid" 2>/dev/null || true; }
trap forward_term TERM INT
trap 'forward_term; wait "$mongo_pid" 2>/dev/null || true' EXIT

ready=0
for i in $(seq 1 180); do
  if ! kill -0 "$mongo_pid" 2>/dev/null; then
    echo "ACG_SINGLE_MONGO_PROCESS_EXITED_BEFORE_READY"
    exit 71
  fi
  if MONGODB_REPL_STATUS="$(mongosh --host 127.0.0.1 --port 27017 \
     --username "$MONGO_INITDB_ROOT_USERNAME" \
     --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
     --quiet --eval 'try { const s=db.adminCommand({replSetGetStatus:1}); print(s.ok===1?"READY":"WAIT"); } catch(e) { print(e.code===94 || /not yet initialized|no replset config/i.test(e.message)?"NOT_INITIALIZED":"WAIT"); }' 2>/dev/null)"; then
    if [[ "$MONGODB_REPL_STATUS" == *READY* || "$MONGODB_REPL_STATUS" == *NOT_INITIALIZED* ]]; then
      ready=1
      break
    fi
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "ACG_SINGLE_MONGO_STARTUP_TIMEOUT"
  exit 72
fi

if [[ "$MONGODB_REPL_STATUS" == *NOT_INITIALIZED* ]]; then
  echo "ACG_SINGLE_MONGO_INIT_BEGIN"
  export ACG_INIT_REPLICA_NAME="$replica_set"
  mongosh --host 127.0.0.1 --port 27017 \
    --username "$MONGO_INITDB_ROOT_USERNAME" \
    --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
    --quiet --eval '
    const hostname=process.env.RAILWAY_PRIVATE_DOMAIN;
    if (!hostname || !hostname.endsWith(".railway.internal")) {
      throw new Error("Expected private Railway hostname");
    }
    const result=db.adminCommand({replSetInitiate:{
      _id:process.env.ACG_INIT_REPLICA_NAME,
      members:[{_id:0,host:hostname+":27017"}]
    }});
    if(result.ok!==1) throw new Error("Replica set initiation failed: "+result.codeName);
    print("ACG_SINGLE_MONGO_INIT_OK");
  '
fi

primary=0
for i in $(seq 1 60); do
  if mongosh --host 127.0.0.1 --port 27017 \
     --username "$MONGO_INITDB_ROOT_USERNAME" \
     --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin \
     --quiet --eval 'if(!db.hello().isWritablePrimary) quit(2)' >/dev/null 2>&1; then
    primary=1
    break
  fi
  sleep 1
done
if [[ "$primary" != 1 ]]; then
  echo "ACG_SINGLE_MONGO_PRIMARY_TIMEOUT"
  exit 73
fi
echo "ACG_SINGLE_MONGO_READY replset=$replica_set"
wait "$mongo_pid"
