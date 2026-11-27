#!/usr/bin/env bash
set -euo pipefail
# Disposable staging only. Never run with inherited production or provider configuration.
[[ "${RAILWAY_PROJECT_ID:-}" == "239ac3db-d871-4862-a1e6-ddd35a21133c" ]]
[[ "${RAILWAY_ENVIRONMENT_ID:-}" == "8362c789-033d-4543-9523-39f8a141436a" ]]
[[ "${RAILWAY_SERVICE_ID:-}" == "afad1fc2-2040-4f26-86a9-d0dd7f69466c" ]]
node -e 'const bad=Object.keys(process.env).filter(k=>/OPENAI|ANTHROPIC|GEMINI|DEEPSEEK|OPENROUTER|API_KEY|MONGODB_URI|MONGO_URL|SUPABASE|JWT_SECRET|ACG_AI_LIVE_PROVIDER_ENABLED/i.test(k));if(bad.length)process.exit(1)'
export NODE_ENV=test ACG_AI_ISOLATED_CI=true MARKET_GATEWAY_ENABLED=false
export PLATFORM_EVENTS_ENABLED=false TRADING_API_ENABLED=true ACG_ALERTS_ENABLED=false ACG_AI_READ_GATEWAY_ENABLED=false ACG_AI_LIVE_PROVIDER_ENABLED=false
export MONGODB_URI='mongodb://127.0.0.1:27017/acg_trader_test?replicaSet=rs0'
export B2B_TEST_MONGODB_URI='mongodb://127.0.0.1:27017/acg_b2b_isolation_test?replicaSet=rs0'
export CORS_ORIGINS=http://localhost:5173
unset RAILWAY_MONGODB_URI ACG_MONGO_RAILWAY_CUTOVER
db="$(mktemp -d)"
cleanup(){ mongod --shutdown --dbpath "$db" >/dev/null 2>&1 || true; rm -rf "$db"; }
trap cleanup EXIT
start(){ mongod --bind_ip 127.0.0.1 --port 27017 --replSet rs0 --dbpath "$db" --fork --logpath "$db/mongod.log" --wiredTigerCacheSizeGB 0.25 >/dev/null; }
primary(){ for i in $(seq 1 45); do if mongosh --quiet --host 127.0.0.1 --eval 'if (!db.hello().isWritablePrimary) quit(1)' >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }
echo "READINESS_STAGING_START base=9672fa9e8e9ee8fa5d3c89917dae5cf781ebf154 no_provider_credentials=true live_runtime_disabled=true"
start
mongosh --quiet --host 127.0.0.1 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})' >/dev/null
primary
timeout 60 node --test tests/ai-live-runtime-config.test.js tests/ai-live-openai-transport.test.js tests/ai-restricted-pilot-policy.test.js
timeout 120 node scripts/ai-phase1-acceptance.js
timeout 60 node scripts/ai-phase2-default-off.js
# Verify restart on the same disposable database server; never claim multi-node failover.
mongod --shutdown --dbpath "$db" >/dev/null
start
primary
timeout 120 node scripts/ai-phase1-acceptance.js
echo "READINESS_STAGING_PASS synthetic_only=true public_inference=false"
