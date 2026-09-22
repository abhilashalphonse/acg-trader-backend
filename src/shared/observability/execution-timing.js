'use strict';

const { performance } = require('node:perf_hooks');

function createExecutionTiming({ requestId = null, operation = null } = {}) {
  return {
    requestId: requestId || null,
    operation: operation || null,
    startedAt: performance.now(),
    metrics: Object.create(null),
    context: Object.create(null),
    finalized: false,
    snapshot: null,
  };
}

async function timeAsync(timing, name, work) {
  if (!timing) return work();
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    addDuration(timing, name, performance.now() - startedAt);
  }
}

function addDuration(timing, name, durationMs) {
  if (!timing || timing.finalized) return;
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value < 0) return;
  timing.metrics[name] = (Number(timing.metrics[name]) || 0) + value;
}

function setDuration(timing, name, durationMs) {
  if (!timing || timing.finalized) return;
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value < 0) return;
  timing.metrics[name] = value;
}

function setExecutionContext(timing, values = {}) {
  if (!timing || timing.finalized || !values || typeof values !== 'object') return;
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') timing.context[key] = value;
  }
}

function elapsedSince(startedAt) {
  return Math.max(0, performance.now() - Number(startedAt || 0));
}

function nowMs() {
  return performance.now();
}

function finalizeExecutionTiming(timing, { statusCode = null } = {}) {
  if (!timing) return null;
  if (timing.finalized) return timing.snapshot;

  setDuration(timing, 'request_total', performance.now() - timing.startedAt);
  const metrics = Object.fromEntries(
    Object.entries(timing.metrics)
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([key, value]) => [key, roundMs(value)]),
  );

  timing.finalized = true;
  timing.snapshot = Object.freeze({
    requestId: timing.requestId,
    operation: timing.operation,
    statusCode: Number(statusCode) || null,
    context: Object.freeze({ ...timing.context }),
    metrics: Object.freeze(metrics),
  });
  return timing.snapshot;
}

function serverTimingHeader(timing) {
  const snapshot = timing?.snapshot || finalizeExecutionTiming(timing);
  if (!snapshot) return '';
  return Object.entries(snapshot.metrics)
    .map(([name, duration]) => `${metricToken(name)};dur=${Number(duration).toFixed(1)}`)
    .join(', ');
}

function marketExecutionTimingMiddleware({ logger = null } = {}) {
  return (req, res, next) => {
    const operation = marketExecutionOperation(req);
    if (!operation) return next();

    const timing = createExecutionTiming({
      requestId: req.id || null,
      operation,
    });
    req.executionTiming = timing;

    const originalWriteHead = res.writeHead;
    res.writeHead = function wrappedWriteHead(...args) {
      if (!timing.finalized) {
        finalizeExecutionTiming(timing, { statusCode: res.statusCode });
        if (!res.headersSent) {
          const header = serverTimingHeader(timing);
          if (header) res.setHeader('Server-Timing', header);
        }
      }
      return originalWriteHead.apply(this, args);
    };

    res.once('finish', () => {
      const snapshot = timing.snapshot || finalizeExecutionTiming(timing, { statusCode: res.statusCode });
      (req.log || logger)?.info?.({
        executionTiming: snapshot,
      }, 'Market execution timing');
    });

    next();
  };
}

function marketExecutionOperation(req) {
  if (String(req.method || '').toUpperCase() !== 'POST') return null;
  const path = String(req.path || '');
  if (path === '/orders/market') return 'MARKET_OPEN';
  if (/^\/positions\/[^/]+\/close$/.test(path)) return 'MARKET_CLOSE';
  return null;
}

function metricToken(value) {
  return String(value || 'metric').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function roundMs(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = {
  createExecutionTiming,
  timeAsync,
  addDuration,
  setDuration,
  setExecutionContext,
  elapsedSince,
  nowMs,
  finalizeExecutionTiming,
  serverTimingHeader,
  marketExecutionTimingMiddleware,
  marketExecutionOperation,
};
