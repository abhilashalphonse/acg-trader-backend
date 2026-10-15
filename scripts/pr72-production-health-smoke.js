'use strict';
// Public, unauthenticated GET-only production readiness smoke. This does NOT
// prove each quote is fresh or that customer account valuations are correct.
async function main() {
  const url = new URL(process.env.ACG_PRODUCTION_READINESS_URL || '');
  if (url.protocol !== 'https:' || url.pathname !== '/health/ready') throw new Error('INVALID_HEALTH_URL');
  const response = await fetch(url, { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('PRODUCTION_READINESS_HTTP_FAILURE');
  const data = await response.json();
  const checks = data.checks || {};
  if (data.status !== 'ready' || checks.databaseConnected !== true ||
      checks.marketGatewayLive !== true || checks.marketOperational !== true ||
      checks.tradingRuntimeReady !== true || checks.reconciliationOperational !== true ||
      checks.platformEventsOperational !== true || checks.recoveryConsistent === false) {
    throw new Error('PRODUCTION_READINESS_GATE_FAILED');
  }
  console.log('ACG_PRODUCTION_READINESS_PASS');
}
main().catch(error => {
  console.error('ACG_PRODUCTION_READINESS_FAIL', error.code || error.message || error.name);
  process.exitCode = 1;
});
