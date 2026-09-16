'use strict';

const { normalizeDecimal, compareDecimal } = require('../../shared/decimal/decimal');
const { normalizeSymbol } = require('../market-data/market.utils');

function detectProtectionTrigger({ position, tick }) {
  if (!position || String(position.status || 'OPEN').toUpperCase() !== 'OPEN') return null;
  if (!tick || tick.isStale) return null;

  const positionSymbol = normalizeSymbol(position.symbol);
  const tickSymbol = normalizeSymbol(tick.symbol);
  if (!positionSymbol || positionSymbol !== tickSymbol) return null;

  const side = String(position.side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) return null;

  const rawExecutable = side === 'BUY' ? tick.bid : tick.ask;
  const numericExecutable = Number(rawExecutable);
  if (!Number.isFinite(numericExecutable) || numericExecutable <= 0) return null;
  const executablePrice = normalizeDecimal(String(numericExecutable));

  const stopLoss = decimalOrNull(position.stopLoss);
  const takeProfit = decimalOrNull(position.takeProfit);

  if (side === 'BUY') {
    if (stopLoss != null && compareDecimal(executablePrice, stopLoss) <= 0) {
      return trigger('STOP_LOSS', stopLoss, executablePrice, tick);
    }
    if (takeProfit != null && compareDecimal(executablePrice, takeProfit) >= 0) {
      return trigger('TAKE_PROFIT', takeProfit, executablePrice, tick);
    }
  } else {
    if (stopLoss != null && compareDecimal(executablePrice, stopLoss) >= 0) {
      return trigger('STOP_LOSS', stopLoss, executablePrice, tick);
    }
    if (takeProfit != null && compareDecimal(executablePrice, takeProfit) <= 0) {
      return trigger('TAKE_PROFIT', takeProfit, executablePrice, tick);
    }
  }

  return null;
}

function trigger(reason, level, executablePrice, tick) {
  return Object.freeze({
    reason,
    triggerPrice: level,
    executablePrice,
    quoteSequence: tick.sequence ?? null,
    quoteReceivedAtMs: tick.receivedAtMs ?? null,
    quoteSource: tick.source ?? null,
  });
}

function decimalOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeDecimal(value?.toString ? value.toString() : String(value));
}

module.exports = { detectProtectionTrigger };
