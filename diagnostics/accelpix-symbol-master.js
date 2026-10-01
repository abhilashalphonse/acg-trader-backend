'use strict';

require('dotenv').config();

const API_KEY = process.env.ACCELPIX_API_KEY;
const HOST = process.env.ACCELPIX_HOST || 'apidata.accelpix.in';

if (!API_KEY || API_KEY === 'your-api-key-here') {
  console.error('Missing ACCELPIX_API_KEY.');
  process.exit(1);
}

const baseHost = HOST.replace(/^https?:\/\//i, '').replace(/\/$/, '');
const url = new URL(`https://${baseHost}/api/hsd/Masters/2`);
url.searchParams.set('fmt', 'json');
url.searchParams.set('api_token', API_KEY);

async function main() {
  console.log('============================================================');
  console.log(' ACG Trader - Accelpix Symbol Master Diagnostic');
  console.log('============================================================');
  console.log(`Host: ${baseHost}`);
  console.log('Endpoint: /api/hsd/Masters/2?fmt=json');
  console.log('API key: configured (value hidden)');
  console.log('============================================================\n');

  const started = Date.now();
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'acg-trader-backend/accelpix-diagnostic',
    },
    signal: AbortSignal.timeout(15000),
  });

  console.log(`HTTP: ${response.status} ${response.statusText}`);
  console.log(`Latency: ${Date.now() - started}ms`);

  const raw = await response.text();

  if (!response.ok) {
    console.error('Accelpix request failed.');
    console.error(raw.slice(0, 2000));
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    console.error('Response was not valid JSON:', error.message);
    console.error(raw.slice(0, 2000));
    process.exit(1);
  }

  const rows = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.result)
        ? data.result
        : null;

  if (!rows) {
    console.log('Unexpected response shape.');
    console.dir(data, { depth: 3 });
    process.exit(1);
  }

  const normalized = rows.map((item) => ({
    xid: item?.xid ?? null,
    tkr: item?.tkr ?? null,
    atkr: item?.atkr ?? null,
    inst: item?.inst ?? null,
    tk: item?.tk ?? item?.tkn ?? null,
  }));

  const equities = normalized.filter((item) => String(item.inst || '').toUpperCase() === 'EQUITY');
  const indices = normalized.filter((item) => String(item.inst || '').toUpperCase() === 'INDEX');

  console.log(`Records: ${normalized.length}`);
  console.log(`Equities: ${equities.length}`);
  console.log(`Indices: ${indices.length}`);

  const probes = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'NIFTY', 'BANKNIFTY'];
  const matches = normalized.filter((item) => {
    const haystack = `${item.tkr || ''} ${item.atkr || ''}`.toUpperCase();
    return probes.some((probe) => haystack.includes(probe));
  });

  console.log('\nSample records:');
  console.table(normalized.slice(0, 10));

  console.log('\nProbe matches:');
  if (matches.length) {
    console.table(matches.slice(0, 50));
  } else {
    console.log('No common probe symbols matched. This may reflect entitlement or ticker naming.');
  }

  console.log('\nPASS: Accelpix Symbol Master is reachable and returned JSON.');
}

main().catch((error) => {
  console.error('Accelpix diagnostic failed:', error?.message || error);
  process.exit(1);
});
