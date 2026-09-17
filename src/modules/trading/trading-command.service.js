'use strict';

const crypto = require('crypto');
const { Position } = require('./position.model');

class TradingCommandService {
  constructor({ marketOrderService, atomicReverseService, positionModel = Position, logger }) {
    this.marketOrderService = marketOrderService;
    this.atomicReverseService = atomicReverseService;
    this.positionModel = positionModel;
    this.logger = logger;
  }

  async reversePosition(command) {
    if (!this.atomicReverseService) throw new Error('Atomic reverse service is not configured');
    return this.atomicReverseService.reversePosition(command);
  }

  async closeAllPositions(command) {
    const accountId = String(command.accountId || '');
    const positions = await this.positionModel.find({ accountId, status: 'OPEN' }).sort({ openedAt: 1, _id: 1 }).lean();
    if (!positions.length) return { operation: 'CLOSE_ALL', complete: true, requested: 0, closed: 0, failed: 0, results: [] };

    const results = [];
    for (const position of positions) {
      const positionId = String(position._id);
      const clientOrderId = childId(command.clientRequestId, `close-${positionId}`);
      try {
        const result = await this.marketOrderService.closeMarketPosition({ accountId, positionId, clientOrderId, volume: null, requestedPrice: null, source: command.source || 'API' });
        results.push({ positionId, status: 'CLOSED', clientOrderId, result });
      } catch (error) {
        this.logger?.warn({ err: error, accountId, positionId, clientOrderId }, 'Close-all could not close a position');
        results.push({ positionId, status: 'FAILED', clientOrderId, error: { code: error?.code || 'COMMAND_FAILED', message: error?.message || 'Position close failed' } });
      }
    }

    const failed = results.filter(item => item.status === 'FAILED').length;
    return { operation: 'CLOSE_ALL', complete: failed === 0, requested: positions.length, closed: positions.length - failed, failed, results };
  }
}

function childId(parent, purpose) {
  const base = String(parent || '').trim();
  const suffix = String(purpose || '').trim();
  const digest = crypto.createHash('sha256').update(`${base}:${suffix}`).digest('hex').slice(0, 12);
  const readable = suffix.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  return `${base.slice(0, 70)}:${readable}:${digest}`.slice(0, 128);
}

module.exports = { TradingCommandService, childId };
