'use strict';

// Non-mutating Stage 3 capacity probe. This exercises the same quote recovery,
// account valuation overlay, FX conversion, margin/risk planner and permission
// policy used by execution, but only through the side-effect-free preview API.

const baseUrl = String(process.env.CAPACITY_TRADER_BASE_URL || '').replace(/\/+$/, '');
const bearer = String(process.env.CAPACITY_TRADER_BEARER || '');
const accountId = String(process.env.CAPACITY_ACCOUNT_ID || '');
const symbol = String(process.env.CAPACITY_SYMBOL || 'RELIANCE').trim().toUpperCase();
const volume = String(process.env.CAPACITY_VOLUME || '1');
const totalRequests = positiveInt(process.env.CAPACITY_REQUESTS, 100);
const concurrency = positiveInt(process.env.CAPACITY_CONCURRENCY, 10);
const maxP95Ms = optionalPositiveNumber(process.env.CAPACITY_MAX_P95_MS);
const maxErrorRate = optionalRate(process.env.CAPACITY_MAX_ERROR_RATE);

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function previewOnce(index) {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}/v1/trading/orders/market/preview`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accountId,
        symbol,
        side: index % 2 === 0 ? 'BUY' : 'SELL',
        volume,
        source: 'API',
      }),
    });
    const elapsedMs = performance.now() - started;
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

    return {
      ok: response.ok && payload?.previewVersion === 'ACG_ORDER_PREVIEW_V1',
      status: response.status,
      elapsedMs,
      code: payload?.error?.code || payload?.code || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      elapsedMs: performance.now() - started,
      code: error?.code || error?.name || 'NETWORK_ERROR',
    };
  }
}

async function runPool() {
  let cursor = 0;
  const results = new Array(totalRequests);

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= totalRequests) return;
      results[index] = await previewOnce(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, totalRequests) }, () => worker()));
  return results;
}

function summarize(results) {
  const latencies = results.map(item => item.elapsedMs).sort((a, b) => a - b);
  const errors = results.filter(item => !item.ok);
  const statusCounts = countBy(results, item => String(item.status));
  const errorCodes = countBy(errors, item => String(item.code || 'UNKNOWN'));
  const errorRate = results.length ? errors.length / results.length : 1;

  return {
    requests: results.length,
    concurrency,
    success: results.length - errors.length,
    errors: errors.length,
    errorRate,
    latencyMs: {
      min: round(latencies[0]),
      p50: round(percentile(latencies, 0.50)),
      p95: round(percentile(latencies, 0.95)),
      p99: round(percentile(latencies, 0.99)),
      max: round(latencies[latencies.length - 1]),
      mean: round(latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)),
    },
    statusCounts,
    errorCodes,
  };
}

function evaluate(summary) {
  const gates = [];
  if (maxP95Ms != null) {
    gates.push({
      name: 'p95',
      pass: summary.latencyMs.p95 <= maxP95Ms,
      observed: summary.latencyMs.p95,
      threshold: maxP95Ms,
      unit: 'ms',
    });
  }
  if (maxErrorRate != null) {
    gates.push({
      name: 'errorRate',
      pass: summary.errorRate <= maxErrorRate,
      observed: summary.errorRate,
      threshold: maxErrorRate,
      unit: 'ratio',
    });
  }
  return {
    thresholdsConfigured: gates.length > 0,
    pass: gates.length ? gates.every(item => item.pass) : null,
    gates,
  };
}

async function main() {
  required('CAPACITY_TRADER_BASE_URL', baseUrl);
  required('CAPACITY_TRADER_BEARER', bearer);
  required('CAPACITY_ACCOUNT_ID', accountId);

  const startedAt = new Date().toISOString();
  const wallStarted = performance.now();
  const results = await runPool();
  const summary = summarize(results);
  const evaluation = evaluate(summary);
  const report = {
    acceptance: 'GLOBAL-MARKETS-M1-PREVIEW-CAPACITY',
    mode: 'NON_MUTATING',
    symbol,
    volume,
    startedAt,
    completedAt: new Date().toISOString(),
    wallTimeMs: round(performance.now() - wallStarted),
    ...summary,
    evaluation,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (evaluation.pass === false || summary.errors > 0) process.exitCode = 1;
}

function percentile(values, quantile) {
  if (!values.length) return NaN;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * quantile) - 1));
  return values[index];
}

function countBy(items, keyOf) {
  return items.reduce((counts, item) => {
    const key = keyOf(item);
    counts[key] = Number(counts[key] || 0) + 1;
    return counts;
  }, {});
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('CAPACITY_MAX_P95_MS must be a positive number');
  return parsed;
}

function optionalRate(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error('CAPACITY_MAX_ERROR_RATE must be between 0 and 1');
  return parsed;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({
      acceptance: 'GLOBAL-MARKETS-M1-PREVIEW-CAPACITY',
      status: 'FAIL',
      message: error.message,
    }, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  percentile,
  summarize,
  evaluate,
};
