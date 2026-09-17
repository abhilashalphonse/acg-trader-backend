'use strict';

const crypto = require('crypto');
const { AppError } = require('../../shared/errors/app-error');
const { Position } = require('./position.model');

class TradingCommandService {
  constructor({ marketOrderService, positionModel = Position, logger }) {
    this.marketOrderService = marketOrderService;
    this.positionModel = positionModel;
    this.logger = logger;
  }

  async reversePosition(command) {
    const accountId = String(command.accountId || '');
    const positionId = String(command.positionId || '');
    const position = await this.positionModel.findOne({ _id: positionId, accountId, status: 'OPEN' }).lean();
    if (!position) throw new AppError('Open position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' });

    const volume = String(position.openVolume);
    const oppositeSide = String(position.side).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    const closeOrderId = childId(command.clientRequestId, 'reverse-close');
    const openOrderId = childId(command.clientRequestId, 'reverse-open');

    const close = await this.marketOrderService.closeMarketPosition({
      accountId,
      positionId,
      clientOrderId: closeOrderId,
      volume: null,
      requestedPrice: command.requestedPrice ?? null,
      source: command.source || 'API',
    });

    try {
      const open = await this.marketOrderService.openMarketOrder({
        accountId,
        clientOrderId: openOrderId,
        symbol: position.symbol,
        side: oppositeSide,
        volume,
        stopLoss: command.stopLoss ?? null,
        takeProfit: command.takeProfit ?? null,
        requestedPrice: command.requestedPrice ?? null,
        source: command.source || 'API',
      });
      return {
        operation: 'REVERSE',
        complete: true,
        originalPositionId: positionId,
        close,
        open,
      };
    } catch (error) {
      this.logger?.error({ err: error, accountId, positionId, closeOrderId, openOrderId }, 'Reverse position closed the original position but could not open the opposite position');
      throw new AppError('Position was closed but the opposite position could not be opened', {
        statusCode: 409,
        code: 'REVERSE_OPEN_FAILED',
        details: {
          originalPositionId: positionId,
          closeOrderId,
          openOrderId,
          recovery: 'Retry the same reverse command. Child command idempotency prevents the close leg from executing twice.',
          causeCode: error?.code || null,
        },
      });
    }
  }

  async closeAllPositions(command) {
    const accountId = String(command.accountId || '');
    const positions = await this.positionModel.find({ accountId, status: 'OPEN' }).sort({ openedAt: 1, _id: 1 }).lean();
    if (!positions.length) {
      return { operation: 'CLOSE_ALL', complete: true, requested: 0, closed: 0, failed: 0, results: [] };
    }

    const results = [];
    for (const position of positions) {
      const positionId = String(position._id);
      const clientOrderId = childId(command.clientRequestId, `close-${positionId}`);
      try {
        const result = await this.marketOrderService.closeMarketPosition({
          accountId,
          positionId,
          clientOrderId,
          volume: null,
          requestedPrice: null,
          source: command.source || 'API',
        });
        results.push({ positionId, status: 'CLOSED', clientOrderId, result });
      } catch (error) {
        this.logger?.warn({ err: error, accountId, positionId, clientOrderId }, 'Close-all could not close a position');
        results.push({
          positionId,
          status: 'FAILED',
          clientOrderId,
          error: { code: error?.code || 'COMMAND_FAILED', message: error?.message || 'Position close failed' },
        });
      }
    }

    const failed = results.filter(item => item.status === 'FAILED').length;
    return {
      operation: 'CLOSE_ALL',
      complete: failed === 0,
      requested: positions.length,
      closed: positions.length - failed,
      failed,
      results,
    };
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
