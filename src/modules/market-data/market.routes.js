'use strict';

const express = require('express');
const { AppError } = require('../../shared/errors/app-error');
const { requireTraderSession } = require('../auth/auth.middleware');
const { normalizeSymbol, clampInteger, resolveCandleVolume } = require('./market.utils');

function createMarketRouter(runtime, authService = null) {
  const router = express.Router();

  router.get('/status', (_req, res) => {
    res.json(runtime.health());
  });

  router.get('/quotes', (req, res) => {
    requireEnabled(runtime);
    const requested = String(req.query.symbols || '')
      .split(',')
      .map(normalizeSymbol)
      .filter(Boolean);
    const symbols = requested.length ? [...new Set(requested)] : runtime.symbols;
    validateSymbols(runtime, symbols);

    const quotes = runtime.quoteStore.getMany(symbols);
    const available = new Set(quotes.map(item => item.symbol));
    res.json({
      quotes,
      missing: symbols.filter(symbol => !available.has(symbol)),
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/quote/refresh', authService ? requireTraderSession(authService) : (_req, _res, next) => next(), async (req, res) => {
    requireEnabled(runtime);
    const symbol = normalizeSymbol(req.body?.symbol);
    validateSymbols(runtime, [symbol]);
    const quote = await runtime.ensureFreshQuote(symbol, { reason: 'client-selected-refresh' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      symbol,
      quote,
      recovered: Boolean(quote && quote.isStale !== true),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/candles', async (req, res) => {
    requireEnabled(runtime);
    const symbol = normalizeSymbol(req.query.symbol);
    const timeframe = String(req.query.timeframe || '').toLowerCase();
    const limit = clampInteger(req.query.limit, 1, 1000, 160);

    validateSymbols(runtime, [symbol]);
    if (!runtime.timeframes.includes(timeframe)) {
      throw new AppError(`Unsupported timeframe: ${timeframe || '(missing)'}`, {
        statusCode: 400,
        code: 'INVALID_TIMEFRAME',
        details: { supported: runtime.timeframes },
      });
    }

    const history = await runtime.historyService.getCandles({ symbol, timeframe, limit });
    const historyVolumeMode = history[history.length - 1]?.volumeMode || null;
    if (historyVolumeMode) runtime.candleEngine.setVolumeMode?.(symbol, timeframe, historyVolumeMode);
    let current = runtime.candleEngine.getCurrent(symbol, timeframe);
    let candles = history;

    if (current) {
      const last = history[history.length - 1];
      if (last?.openTimeMs === current.openTimeMs) {
        runtime.candleEngine.reconcileCurrentVolume?.(symbol, timeframe, last);
        current = runtime.candleEngine.getCurrent(symbol, timeframe) || current;
        candles = [...history.slice(0, -1), mergeCurrentCandle(last, current)];
      } else {
        const inheritedMode = last?.volumeMode || null;
        if (inheritedMode) current = applyVolumeMode(current, inheritedMode);
        candles = [...history, current];
      }
    }

    if (candles.length > limit) candles = candles.slice(candles.length - limit);
    res.json({ symbol, timeframe, volumeMode: candles[0]?.volumeMode || null, candles });
  });

  return router;
}

function requireEnabled(runtime) {
  if (!runtime.enabled) {
    throw new AppError('Market gateway is disabled', {
      statusCode: 503,
      code: 'MARKET_GATEWAY_DISABLED',
    });
  }
}

function validateSymbols(runtime, symbols) {
  const invalid = symbols.filter(symbol => !symbol || !runtime.symbols.includes(symbol));
  if (invalid.length) {
    throw new AppError('One or more market symbols are not configured', {
      statusCode: 400,
      code: 'INVALID_MARKET_SYMBOL',
      details: { invalid, available: runtime.symbols },
    });
  }
}

function applyVolumeMode(candle, volumeMode) {
  const carriesAuthoritativeDisplay = candle?.volumeMode === volumeMode
    && Object.prototype.hasOwnProperty.call(candle, 'displayVolume')
    && (candle.volumeSource === volumeMode || candle.volumeSource === 'unavailable');

  if (carriesAuthoritativeDisplay) {
    return { ...candle, volumeMode };
  }

  const resolved = resolveCandleVolume({ ...candle, volumeMode }, volumeMode);
  return {
    ...candle,
    volumeMode,
    displayVolume: resolved.displayVolume,
    volumeSource: resolved.volumeSource,
  };
}

function mergeCurrentCandle(historyBar, currentBar) {
  if (!historyBar) return currentBar;
  if (!currentBar) return historyBar;
  if (Number(historyBar.openTimeMs) !== Number(currentBar.openTimeMs)) return currentBar;

  const numeric = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const historyOpen = numeric(historyBar.open);
  const historyHigh = numeric(historyBar.high);
  const historyLow = numeric(historyBar.low);
  const historyClose = numeric(historyBar.close);
  const currentOpen = numeric(currentBar.open);
  const currentHigh = numeric(currentBar.high);
  const currentLow = numeric(currentBar.low);
  const currentClose = numeric(currentBar.close);
  const volumeMode = currentBar.volumeMode || historyBar.volumeMode || null;

  const highs = [historyHigh, historyOpen, historyClose, currentHigh, currentOpen, currentClose].filter(Number.isFinite);
  const lows = [historyLow, historyOpen, historyClose, currentLow, currentOpen, currentClose].filter(Number.isFinite);

  const merged = {
    ...historyBar,
    ...currentBar,
    open: historyOpen ?? currentOpen,
    high: highs.length ? Math.max(...highs) : (currentHigh ?? historyHigh),
    low: lows.length ? Math.min(...lows) : (currentLow ?? historyLow),
    close: currentClose ?? historyClose,
    tickCount: Number(currentBar.tickCount || historyBar.tickCount || 0),
    providerVolume: currentBar.providerVolume ?? historyBar.providerVolume ?? null,
    complete: false,
    synthetic: Boolean(currentBar.synthetic && historyBar.synthetic),
    source: 'LIVE_MERGED',
    provider: currentBar.provider || historyBar.provider || null,
  };
  return applyVolumeMode(merged, volumeMode);
}

module.exports = { createMarketRouter, mergeCurrentCandle, applyVolumeMode };
