const uri=process.env.TARGET_MONGODB_URI;
if (!uri) throw new Error("TARGET_MONGODB_URI_MISSING");
const client=new Mongo(uri);
const admin=client.getDB("admin");
const status=admin.runCommand({replSetGetStatus:1});
if(status.ok!==1) throw new Error("REPLICA_SET_STATUS_FAILED");
const members=(status.members||[]).map(m=>m.stateStr);
const primary=members.filter(v=>v==="PRIMARY").length;
const secondaries=members.filter(v=>v==="SECONDARY").length;
print("HA_STATUS replica_set="+status.set+" members="+members.length+" primary="+primary+" secondaries="+secondaries);
if(primary!==1||secondaries!==2) throw new Error("HA_MEMBER_TOPOLOGY_NOT_HEALTHY");
const session=client.startSession();
try {
  session.startTransaction({readConcern:{level:"snapshot"},writeConcern:{w:"majority"}});
  const row=session.getDatabase("acg_trader").getCollection("tradingaccounts").findOne({});
  session.commitTransaction();
  print("TRANSACTION_SNAPSHOT_MAJORITY_READ_OK sample_present="+Boolean(row));
} catch(err){try{session.abortTransaction();}catch{}; throw err;}
finally{session.endSession();}
print("ACG_RAILWAY_DB_PREFLIGHT_PASS");
