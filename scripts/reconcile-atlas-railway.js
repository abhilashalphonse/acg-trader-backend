// Read-only cross-cluster reconciliation. Never prints credentials or document contents.
const srcUri = process.env.SOURCE_MONGODB_URI;
const dstUri = process.env.TARGET_MONGODB_URI;
if (!srcUri || !dstUri) throw new Error("MISSING_CONNECTION_URI");
const srcConn = new Mongo(srcUri);
const dstConn = new Mongo(dstUri);
let missingCollections = 0, indexMismatches = 0, sampleMismatches = 0;
const critical = new Set([
  "tradingaccounts","positions","orders","deals","accountledgers","idempotencyrecords",
  "accountlifecycleevents","platformeventoutboxes","accountpolicytransitions",
  "users","tenants","tradersessions","accountaccessgrants","accountbreachcleanupjobs",
  "marginstopoutjobs","weekendaccountactions","accountriskevents"
]);
const summary = {};
function compactIndexes(indexes) {
  return indexes.map(ix => ({
    name: ix.name, key: ix.key, unique: ix.unique === true,
    sparse: ix.sparse === true, expireAfterSeconds: ix.expireAfterSeconds ?? null,
    partialFilterExpression: ix.partialFilterExpression ?? null,
    collation: ix.collation ?? null
  })).sort((a,b)=>a.name.localeCompare(b.name));
}
function equal(a,b){return EJSON.stringify(a) === EJSON.stringify(b);}
for (const name of ["acg_trader","acg_trader_staging"]) {
  const sdb=srcConn.getDB(name), tdb=dstConn.getDB(name);
  const snames=sdb.getCollectionNames().filter(x=>!x.startsWith("system.")).sort();
  const tnames=tdb.getCollectionNames().filter(x=>!x.startsWith("system.")).sort();
  print("RECON_DB " + name + " source_collections=" + snames.length + " target_collections=" + tnames.length);
  let sourceTotal=0,targetTotal=0, criticalIssues=0;
  for(const collName of snames) {
    if (!tnames.includes(collName)) { print("RECON_MISSING_COLLECTION " + name+"."+collName); missingCollections++; continue; }
    const sc=sdb.getCollection(collName), tc=tdb.getCollection(collName);
    const si=sc.getIndexes(), ti=tc.getIndexes();
    const match=equal(compactIndexes(si),compactIndexes(ti));
    if(!match) { indexMismatches++; print("RECON_INDEX_MISMATCH "+name+"."+collName+" source_indexes="+si.length+" target_indexes="+ti.length); }
    const srcCount=sc.estimatedDocumentCount(), dstCount=tc.estimatedDocumentCount();
    sourceTotal += srcCount; targetTotal += dstCount;
    const delta=srcCount-dstCount;
    if (critical.has(collName)) {
      const a=sc.find({}).sort({_id:1}).limit(3).toArray();
      const b=tc.find({}).sort({_id:1}).limit(3).toArray();
      const sampleMatch=equal(a,b);
      if(!sampleMatch){sampleMismatches++;criticalIssues++;}
      print("RECON_CRITICAL "+name+"."+collName+" atlas="+srcCount+" railway="+dstCount+" delta="+delta+" indexes="+(match?"OK":"MISMATCH")+" earliest_sample="+(sampleMatch?"OK":"DIFF"));
    } else if(delta!==0){
      print("RECON_COUNT_DELTA "+name+"."+collName+" atlas="+srcCount+" railway="+dstCount+" delta="+delta);
    }
  }
  for(const extra of tnames.filter(x=>!snames.includes(x))){
    print("RECON_EXTRA_COLLECTION "+name+"."+extra);
  }
  print("RECON_TOTAL "+name+" atlas="+sourceTotal+" railway="+targetTotal+" delta="+(sourceTotal-targetTotal)+" critical_sample_mismatches="+criticalIssues);
  summary[name]={sourceTotal,targetTotal};
}
print("RECON_SUMMARY missing_collections="+missingCollections+" index_mismatches="+indexMismatches+" critical_sample_mismatches="+sampleMismatches);
if(missingCollections||indexMismatches) quit(30);
