#!/usr/bin/env bash
set -Eeuo pipefail
: "${CANDIDATE_MONGO_PASSWORD:?missing CANDIDATE_MONGO_PASSWORD}"
: "${SOURCE_MONGO_URI:?missing SOURCE_MONGO_URI}"
export MONGODB_CANDIDATE_HOST="acg-mongo-single-candidate.railway.internal"
export MONGODB_CANDIDATE_USER="acgadmin"
echo "ACG_SINGLE_MONGO_VERIFY_START"

mongosh --host "$MONGODB_CANDIDATE_HOST" --port 27017 \
  --username "$MONGODB_CANDIDATE_USER" --password "$CANDIDATE_MONGO_PASSWORD" \
  --authenticationDatabase admin --quiet --eval '
const status=rs.status();
if(status.ok!==1 || status.members.length!==1 || status.members[0].stateStr!=="PRIMARY") {
  throw new Error("Candidate not a one-member primary");
}
print("CANDIDATE_SINGLE_PRIMARY_CONFIRMED");
const d=db.getSiblingDB("acg_single_migration_test");
const session=db.getMongo().startSession();
try {
  session.withTransaction(() => {
    const target=session.getDatabase("acg_single_migration_test");
    target.getCollection("transaction_probes").insertOne({_id:"test", at:new Date()});
  }, {writeConcern:{w:"majority"},readConcern:{level:"snapshot"}});
  if(!d.getCollection("transaction_probes").findOne({_id:"test"})) {
    throw new Error("Transaction verification write not visible");
  }
  d.getCollection("transaction_probes").deleteOne({_id:"test"});
  d.dropDatabase();
  print("CANDIDATE_MAJORITY_TRANSACTION_PASS");
} finally { session.endSession(); }
const cache=db.serverStatus().wiredTiger?.cache||{};
print("CANDIDATE_WT_CACHE_MAX_BYTES="+(cache["maximum bytes configured"]||"UNKNOWN"));
'

mongosh "$SOURCE_MONGO_URI" --quiet --eval '
const hello=db.hello();
if(!hello.isWritablePrimary && !hello.secondary) throw new Error("Source not an active replica-set member");
print("SOURCE_REPLICA_SET="+(hello.setName||"UNKNOWN"));
for(const dbName of ["acg_trader","acg_trader_staging"]) {
 const d=db.getSiblingDB(dbName);
 for(const collection of ["tradingaccounts","positions","orders","deals","accountledgers","idempotencyrecords"]) {
  print("SOURCE_COUNT "+dbName+"."+collection+"="+d.getCollection(collection).countDocuments({}));
 }
}
print("ACG_SINGLE_MONGO_VERIFY_PASS");
'
