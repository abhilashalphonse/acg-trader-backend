'use strict';
const { compareDecimal } = require('../../shared/decimal/decimal');
const samePrice = (left, right) => left == null || right == null ? left == null && right == null : compareDecimal(left, right) === 0;

function amendmentIncreasesRisk(order, amended) {
  if (compareDecimal(amended.volume, order.requestedVolume) > 0) return true;
  if (!samePrice(order.limitPrice, amended.limitPrice) || !samePrice(order.stopPrice, amended.stopPrice)) return true;
  if (order.stopLoss != null) {
    if (amended.stopLoss == null) return true;
    const movement = compareDecimal(amended.stopLoss, order.stopLoss);
    if (order.side === 'BUY' ? movement < 0 : movement > 0) return true;
  }
  if (order.expiresAt != null && (amended.expiresAt == null || Date.parse(amended.expiresAt) > Date.parse(order.expiresAt))) return true;
  return false;
}
module.exports = { amendmentIncreasesRisk };
