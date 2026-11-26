#!/usr/bin/env bash
set -euo pipefail
# One-shot isolated acceptance. No external DB, credentials, public port or provider.
export NODE_ENV=test ACG_AI_ISOLATED_CI=true MARKET_GATEWAY_ENABLED=false
export PLATFORM_EVENTS_ENABLED=false TRADING_API_ENABLED=true ACG_ALERTS_ENABLED=false ACG_AI_READ_GATEWAY_ENABLED=false
export MONGODB_URI='mongodb://127.0.0.1:27017/acg_trader_test?replicaSet=rs0'
export B2B_TEST_MONGODB_URI='mongodb://127.0.0.1:27017/acg_b2b_isolation_test?replicaSet=rs0'
export CORS_ORIGINS=http://localhost:5173
unset RAILWAY_MONGODB_URI ACG_MONGO_RAILWAY_CUTOVER
db="$(mktemp -d)"
cleanup(){ mongod --shutdown --dbpath "$db" >/dev/null 2>&1 || true; rm -rf "$db"; }
trap cleanup EXIT
start(){ mongod --bind_ip 127.0.0.1 --port 27017 --replSet rs0 --dbpath "$db" --fork --logpath "$db/mongod.log" --wiredTigerCacheSizeGB 0.25 >/dev/null; }
primary(){ for i in $(seq 1 45); do if mongosh --quiet --host 127.0.0.1 --eval 'if (!db.hello().isWritablePrimary) quit(1)' >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }
echo "PHASE3K_RUN_START accepted_base=68f445e43dcd642ad66500bb63fbba478d3c62f3"
start
mongosh --quiet --host 127.0.0.1 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})' >/dev/null
primary
timeout 120 node scripts/ai-phase1-acceptance.js
timeout 90 node --test tests/integration/b2b-two-tenant.test.js
# Separate full application mount/origin/error-boundary test.
timeout 60 node scripts/ai-phase2-default-off.js
timeout 60 node scripts/ai-intelligence-benchmark.js
timeout 120 node scripts/ai-phase3-financial-acceptance.js
timeout 60 node scripts/ai-phase3-provider-benchmark.js
# Restart disposable Mongo and rerun the core acceptance; no claim of multi-node failover.
mongod --shutdown --dbpath "$db" >/dev/null
start
primary
timeout 120 node scripts/ai-phase1-acceptance.js
timeout 120 node scripts/ai-phase3-financial-acceptance.js
echo "PHASE3K_ISOLATED_RAILWAY_PASS"
