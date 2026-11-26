'use strict';
const { z } = require('zod');
const { AppError } = require('../../shared/errors/app-error');
const { READ_TOOLS } = require('./read-tool-policy');
const { assertPhaseOneRead, PHASE_ONE_READS } = require('./financial-safety-boundary');
const noArgs = z.object({}).strict();
const pageArgs = z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict();
const text = v => v == null ? null : String(v);
const unavailable = () => new AppError('Read tool is unavailable', { statusCode: 403, code: 'AI_TOOL_NOT_AVAILABLE' });
const definitions = Object.freeze({
  'account.valuation.read': Object.freeze({ args: noArgs, async run({ account }) {
    const state = account.state || {};
    return { kind: 'PERSISTED_ACCOUNT_STATE', live: false, asOf: account.updatedAt || null,
      currency: account.currency, financialRevision: account.financialRevision ?? null,
      balance: text(state.balance), equity: text(state.equity), floatingPnl: text(state.floatingPnl),
      usedMargin: text(state.usedMargin), freeMargin: text(state.freeMargin) };
  } }),
  'account.positions.read': Object.freeze({ args: pageArgs, async run({ args, reads }) {
    const rows = await reads.positions(args.limit + 1);
    return { kind: 'PERSISTED_OPEN_POSITIONS', truncated: rows.length > args.limit,
      positions: rows.slice(0,args.limit).map(p => ({
        id: text(p._id), symbol: p.symbol, side: p.side, volume: text(p.openVolume),
        entryPrice: text(p.entryPrice), stopLoss: text(p.stopLoss), takeProfit: text(p.takeProfit),
        openedAt: p.openedAt, updatedAt: p.updatedAt,
      })) };
  } }),
  'account.orders.read': Object.freeze({ args: pageArgs, async run({ args, reads }) {
    const rows = await reads.orders(args.limit + 1);
    return { kind: 'PERSISTED_PENDING_ORDERS', truncated: rows.length > args.limit,
      orders: rows.slice(0,args.limit).map(o => ({
        id: text(o._id), symbol: o.symbol, side: o.side, type: o.type, status: o.status,
        volume: text(o.requestedVolume), limitPrice: text(o.limitPrice), stopPrice: text(o.stopPrice),
        stopLoss: text(o.stopLoss), takeProfit: text(o.takeProfit), expiresAt: o.expiresAt,
      })) };
  } }),
});
const AVAILABLE_READ_TOOLS = Object.freeze(Object.keys(definitions).filter(id => PHASE_ONE_READS.includes(id)));
function resolveReadTool(toolId, args) {
  assertPhaseOneRead(toolId);
  if (!READ_TOOLS.includes(toolId) || !Object.hasOwn(definitions, toolId)) throw unavailable();
  const tool = definitions[toolId];
  const parsed = tool.args.safeParse(args);
  if (!parsed.success) throw new AppError('Invalid tool arguments', { statusCode: 400, code: 'AI_INVALID_TOOL_ARGUMENTS' });
  return { run: tool.run, args: parsed.data };
}
module.exports = { AVAILABLE_READ_TOOLS, resolveReadTool };
