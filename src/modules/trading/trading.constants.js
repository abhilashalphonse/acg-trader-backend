'use strict';

const ORDER_SIDES = Object.freeze(['BUY', 'SELL']);
const ORDER_TYPES = Object.freeze(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT']);
const ORDER_STATUSES = Object.freeze([
  'RECEIVED',
  'VALIDATING',
  'ACCEPTED',
  'PENDING',
  'TRIGGERED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED',
]);
const TIME_IN_FORCE = Object.freeze(['GTC', 'TODAY', 'SPECIFIED']);
const ORDER_SOURCES = Object.freeze(['WEB', 'MOBILE', 'API', 'SYSTEM']);

const POSITION_STATUSES = Object.freeze(['OPEN', 'CLOSED']);
const DEAL_TYPES = Object.freeze([
  'OPEN',
  'CLOSE',
  'PARTIAL_CLOSE',
  'REVERSE_CLOSE',
  'REVERSE_OPEN',
  'STOP_LOSS',
  'TAKE_PROFIT',
  'LIQUIDATION',
]);

const LEDGER_TYPES = Object.freeze([
  'DEPOSIT',
  'WITHDRAWAL',
  'REALIZED_PNL',
  'COMMISSION',
  'SWAP',
  'ADJUSTMENT',
]);

const IDEMPOTENCY_STATES = Object.freeze(['IN_PROGRESS', 'COMPLETED', 'FAILED']);

module.exports = {
  ORDER_SIDES,
  ORDER_TYPES,
  ORDER_STATUSES,
  TIME_IN_FORCE,
  ORDER_SOURCES,
  POSITION_STATUSES,
  DEAL_TYPES,
  LEDGER_TYPES,
  IDEMPOTENCY_STATES,
};
