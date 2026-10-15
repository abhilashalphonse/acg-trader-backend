'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {applyCloseAccountAndPositionMutation}=require('../../src/modules/trading/market-order.service');

class Ledger {
  constructor(input) { Object.assign(this,input); }
}
const makeAccount=()=>({
  _id:'account-a',tenantId:'tenant-a',currency:'USD',
  financialRevision:4,
  state:{balance:'1000',equity:'1100',floatingPnl:'100',usedMargin:'80',freeMargin:'1020',realizedPnlToday:'0'},
});
const makePosition=()=>({
  status:'OPEN',openVolume:'1',margin:'80',realizedPnl:'0',commissionPaid:'0',
});
const makePlan=(partial=false)=>({
  realizedPnl:'20',commission:'1',releasedMargin:partial?'40':'80',
  remainingVolume:partial?'0.5':'0',fullClose:!partial,
});
function close(account,position,plan,options={}) {
  const entries=applyCloseAccountAndPositionMutation({
    account,position,plan,deal:{dealId:'deal-1'},
    clientOrderId:'close-1',ledgerModel:Ledger,now:new Date('2026-10-14T13:00:00Z'),
    ...options,
  });
  return entries;
}

test('final full close restores flat-account equity to ledger balance even if saved floating cache was stale',()=>{
  const account=makeAccount(),position=makePosition(),plan=makePlan();
  const entries=close(account,position,plan,{valuationComplete:true,flatAfterClose:true});
  assert.equal(account.state.balance,'1019');
  assert.equal(account.state.floatingPnl,'0');
  assert.equal(account.state.equity,'1019');
  assert.equal(account.state.usedMargin,'0');
  assert.equal(account.state.freeMargin,'1019');
  assert.equal(account.state.marginLevel,null);
  assert.equal(position.status,'CLOSED');
  assert.equal(position.margin,'0');
  assert.equal(entries.length,2);
  assert.equal(entries[0].type,'REALIZED_PNL');
  assert.equal(entries[1].type,'COMMISSION');
  assert.equal(entries[1].balanceAfter,'1019');
});

test('even incomplete quote valuation cannot preserve phantom PnL after verified final close',()=>{
  const account=makeAccount(),position=makePosition();
  close(account,position,makePlan(),{valuationComplete:false,flatAfterClose:true});
  assert.equal(account.state.balance,'1019');
  assert.equal(account.state.floatingPnl,'0');
  assert.equal(account.state.equity,'1019');
  assert.equal(account.state.usedMargin,'0');
  assert.equal(account.state.freeMargin,'1019');
});

test('other open positions keep residual exposure PnL, margin and equity',()=>{
  const account=makeAccount(),position=makePosition();
  close(account,position,makePlan(),{valuationComplete:true,flatAfterClose:false});
  assert.equal(account.state.balance,'1019');
  assert.equal(account.state.floatingPnl,'80');
  assert.equal(account.state.equity,'1099');
  assert.equal(account.state.usedMargin,'0'); // Snapshot example only; not used as a flatness test.
  assert.equal(position.status,'CLOSED');
});

test('partial close leaves remaining position reservation and never triggers flat reset',()=>{
  const account=makeAccount(),position=makePosition();
  close(account,position,makePlan(true),{valuationComplete:true,flatAfterClose:true});
  assert.equal(position.status,'OPEN');
  assert.equal(position.openVolume,'0.5');
  assert.equal(position.margin,'40');
  assert.equal(account.state.usedMargin,'40');
  assert.equal(account.state.floatingPnl,'80');
  assert.equal(account.state.equity,'1099');
});

test('financial revision and ledger remain deterministic across final close',()=>{
  const account=makeAccount(),position=makePosition();
  const out=close(account,position,makePlan(),{valuationComplete:true,flatAfterClose:true});
  assert.equal(account.financialRevision,5);
  assert.equal(out[0].balanceBefore,'1000');
  assert.equal(out[0].balanceAfter,'1020');
  assert.equal(out[1].balanceBefore,'1020');
  assert.equal(out[1].balanceAfter,account.state.balance);
});
