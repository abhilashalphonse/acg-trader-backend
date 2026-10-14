'use strict';

// Read-only PR72 pre/post/rollback release inventory. No database writes.
// Output contains aggregate counts only; never log account identifiers.
const { MongoClient } = require('mongodb');
const { ACG_LEVERAGE_BY_ASSET_CLASS } = require('../src/modules/instruments/instrument-catalog');
const { addDecimal, compareDecimal } = require('../src/shared/decimal/decimal');

async function main() {
  if (process.env.PR72_READONLY_RELEASE_AUDIT !== '1') {
    throw new Error('Explicit PR72_READONLY_RELEASE_AUDIT=1 required');
  }
  const uri = process.env.MONGODB_URI;
  const database = process.env.PR72_AUDIT_DATABASE;
  const expectApproved = process.argv.includes('--expect-approved');
  if (!uri || !['acg_trader', 'acg_trader_staging'].includes(database)) {
    throw new Error('Provide MONGODB_URI and explicit approved PR72_AUDIT_DATABASE');
  }
  const client = new MongoClient(uri,{serverSelectionTimeoutMS:10000,retryWrites:false});
  try {
    await client.connect();
    const db=client.db(database);
    const [accounts,positions,instruments,latestLedgers,orderStatus] = await Promise.all([
      db.collection('tradingaccounts').find({}, {projection:{_id:1,state:1,status:1,accountType:1}}).toArray(),
      db.collection('positions').find({status:'OPEN'}, {projection:{accountId:1,margin:1,symbol:1}}).toArray(),
      db.collection('instruments').find({}, {projection:{assetClass:1,defaultLeverage:1,executionEnabled:1}}).toArray(),
      db.collection('accountledgers').aggregate([
        {$sort:{accountId:1,createdAt:-1,_id:-1}},
        {$group:{_id:'$accountId',balance:{$first:'$balanceAfter'}}},
      ]).toArray(),
      db.collection('orders').aggregate([
        {$match:{status:{$in:['PENDING','TRIGGERED']}}},
        {$group:{_id:'$status',count:{$sum:1}}},
      ]).toArray(),
    ]);
    const id=x=>String(x);
    const balanceByAccount=new Map(latestLedgers.map(x=>[id(x._id),x.balance]));
    const marginsByAccount=new Map();
    for(const p of positions) {
      const key=id(p.accountId);
      marginsByAccount.set(key,addDecimal(marginsByAccount.get(key)||'0',p.margin||'0'));
    }
    let ledgerMismatches=0, marginMismatches=0, flatCachedValuationWarnings=0;
    for(const a of accounts) {
      const key=id(a._id);
      const latest=balanceByAccount.get(key);
      if(latest!=null&&compareDecimal(a.state.balance,latest)!==0)ledgerMismatches++;
      if(compareDecimal(a.state.usedMargin||'0',marginsByAccount.get(key)||'0')!==0)marginMismatches++;
      if(!marginsByAccount.has(key)&&compareDecimal(a.state.floatingPnl||'0','0')!==0)flatCachedValuationWarnings++;
    }
    const policyViolations=instruments.filter(i=>Number(i.defaultLeverage)!==ACG_LEVERAGE_BY_ASSET_CLASS[i.assetClass]);
    const report={
      mode:expectApproved?'POST_RELEASE_OR_ROLLBACK':'PRE_RELEASE',
      database,
      accounts:accounts.length,
      openPositions:positions.length,
      catalogInstruments:instruments.length,
      catalogPolicyViolations:policyViolations.length,
      ledgerBalanceMismatches:ledgerMismatches,
      storedPositionMarginMismatches:marginMismatches,
      flatSavedValuationWarnings:flatCachedValuationWarnings,
      pendingOrders:orderStatus.reduce((sum,x)=>sum+x.count,0),
      readOnly:true,
    };
    console.log('PR72_READONLY_RELEASE_INVENTORY',JSON.stringify(report));
    if(ledgerMismatches||marginMismatches||(expectApproved&&policyViolations.length)) {
      process.exitCode=1;
      console.error('PR72_RELEASE_GATE_FAILED: ledger, margin, or asset-class ceiling mismatch');
    }
  } finally {
    await client.close();
  }
}
main().catch(error=>{
  console.error('PR72_RELEASE_INVENTORY_ERROR',error.code||error.name||'unknown');
  process.exitCode=2;
});
