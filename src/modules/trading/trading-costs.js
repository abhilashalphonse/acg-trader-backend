'use strict';

const { AppError } = require('../../shared/errors/app-error');
const {
  normalizeDecimal,
  addDecimal,
  multiplyDecimal,
  compareDecimal,
} = require('../../shared/decimal/decimal');

function calculateCommission(instrument, volume, {
  account = null,
  fillPrice = null,
  currencyConverter = null,
  nowMs = Date.now(),
} = {}) {
  const perLot = instrument?.commissionPerLotPerSide ?? instrument?.commissionPerLot ?? '0';
  let total = multiplyDecimal(normalizeDecimal(perLot), volume);
  const rate = normalizeDecimal(instrument?.commissionRate ?? '0');

  if (compareDecimal(rate, '0') > 0) {
    if (fillPrice == null || !account) {
      throw new AppError('Commission-rate calculation requires account and fill price', {
        statusCode: 409,
        code: 'COMMISSION_PRICING_UNAVAILABLE',
      });
    }
    const notionalQuote = multiplyDecimal(
      multiplyDecimal(fillPrice, instrument?.contractSize ?? '0'),
      volume,
    );
    const rateChargeQuote = multiplyDecimal(notionalQuote, rate);
    const rateCharge = convertTradingCurrency(
      rateChargeQuote,
      instrument?.quoteCurrency,
      account?.currency,
      currencyConverter,
      nowMs,
    );
    total = addDecimal(total, rateCharge);
  }

  return total;
}

function convertTradingCurrency(
  amount,
  fromCurrency,
  toCurrency,
  currencyConverter = null,
  nowMs = Date.now(),
) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (from && to && from === to) return normalizeDecimal(amount);

  const converter = currencyConverter
    || require('./currency-conversion-engine').getDefaultCurrencyConversionEngine();

  if (!converter?.convert) {
    throw new AppError('Live currency conversion path is unavailable', {
      statusCode: 409,
      code: 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
      details: { fromCurrency: from || null, toCurrency: to || null },
    });
  }

  return converter.convert(amount, from, to, { nowMs });
}

module.exports = {
  calculateCommission,
  convertTradingCurrency,
};
