'use strict';
// Read-only external-provider smoke test; never starts the trading engine.
const { normalizeShowMyTrades, parseBlsIcs, combineVerifiedCalendar } =
  require('../src/modules/trading/free-calendar-sources');
const now = Date.now();
const start = now - 5 * 3600000;
const end = now + 2 * 86400000;
const source = new URL('https://showmytrades.com/api/public/calendar/v1');
source.searchParams.set('impact', 'high');
source.searchParams.set('days', '3');
async function get(url, accept) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { Accept: accept },
  });
  if (!response.ok) throw new Error(new URL(String(url)).hostname + ' HTTP ' + response.status);
  return accept === 'text/calendar' ? response.text() : response.json();
}
(async () => {
  const response = await get(source, 'application/json');
  const primary = normalizeShowMyTrades(response, Date.now()).filter(event => {
    const at = Date.parse(event.timestamp);
    return at >= start && at < end;
  });
  let bls = [];
  let officialStatus = 'UNAVAILABLE';
  try {
    const content = await get('https://www.bls.gov/schedule/news_release/bls.ics', 'text/calendar');
    bls = parseBlsIcs(content, { fromMs:start, toMs:end });
    officialStatus = 'AVAILABLE';
  } catch (error) {
    process.stdout.write('BLS optional verification unavailable: ' + error.message + '\n');
  }
  const joined = combineVerifiedCalendar(primary, bls);
  console.log(JSON.stringify({
    provider: 'showmytrades+bls',
    primaryCount: primary.length,
    BLS: officialStatus,
    officialCount: bls.length,
    confirmed: joined.verification.confirmed,
    conflicts: joined.verification.conflicts,
    mergedCount: joined.events.length,
    earliest: joined.events.map(e => e.timestamp).sort()[0] || null,
    note: 'Provider reachability smoke; not full official-event verification or enforcement approval',
  }));
})().catch(error => {
  console.error('FREE_CALENDAR_PROBE_FAILED', error.message);
  process.exitCode = 1;
});
