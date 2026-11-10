const src=new Mongo(process.env.SOURCE_MONGODB_URI).getDB("acg_trader");
const dst=new Mongo(process.env.TARGET_MONGODB_URI).getDB("acg_trader");
const sNames=src.getCollectionNames().filter(x=>!x.startsWith("system.")).sort();
const tNames=dst.getCollectionNames().filter(x=>!x.startsWith("system.")).sort();
if (EJSON.stringify(sNames)!==EJSON.stringify(tNames)) throw new Error("COLLECTION_NAME_MISMATCH");
const critical=["tradingaccounts","positions","orders","deals","accountledgers","idempotencyrecords",
"platformeventoutboxes","accountlifecycleevents","accountpolicytransitions","tenants",
"tradersessions","weekendaccountactions"];
for(const n of critical) {
  const a=src.getCollection(n).find({}).sort({_id:1}).toArray();
  const b=dst.getCollection(n).find({}).sort({_id:1}).toArray();
  if(EJSON.stringify(a)!==EJSON.stringify(b))throw new Error("CRITICAL_RECORD_MISMATCH_"+n);
  print("VERIFIED_CRITICAL "+n+" count="+a.length);
}
let indexCountS=0,indexCountT=0;
for(const n of sNames){
  const a=src.getCollection(n).getIndexes();
  const b=dst.getCollection(n).getIndexes();
  const normalize=x=>x.map(y=>({name:y.name,key:y.key,unique:y.unique||false,expireAfterSeconds:y.expireAfterSeconds??null})).sort((x,y)=>x.name.localeCompare(y.name));
  if(EJSON.stringify(normalize(a))!==EJSON.stringify(normalize(b)))throw new Error("INDEX_MISMATCH_"+n);
  indexCountS+=a.length;indexCountT+=b.length;
}
const risks=src.getCollection("accountriskevents").estimatedDocumentCount();
const risksTarget=dst.getCollection("accountriskevents").estimatedDocumentCount();
if(risks!==risksTarget) throw new Error("RISK_EVENT_COUNT_MISMATCH");
print("VERIFIED_INDEXES "+indexCountS+"/"+indexCountT+" collections="+sNames.length);
print("VERIFIED_RISK_EVENT_COUNT "+risks);
print("FINAL_CRITICAL_RECONCILIATION_PASS");
