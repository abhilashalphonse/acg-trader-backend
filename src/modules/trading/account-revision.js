'use strict';

const { AppError } = require('../../shared/errors/app-error');

function financialRevisionOf(account) {
  const value = Number(account?.financialRevision ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function bumpFinancialRevision(account) {
  if (!account) throw new TypeError('account is required');
  const next = financialRevisionOf(account) + 1;
  account.financialRevision = next;
  return next;
}

function assertFinancialRevision(account, expectedRevision) {
  const expected = Number(expectedRevision);
  const actual = financialRevisionOf(account);
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== actual) {
    throw new AppError('Valuation was calculated from a stale financial revision', {
      statusCode: 409,
      code: 'STALE_VALUATION_REVISION',
      details: {
        expectedFinancialRevision: Number.isSafeInteger(expected) && expected >= 0 ? expected : null,
        currentFinancialRevision: actual,
      },
    });
  }
  return actual;
}

module.exports = {
  financialRevisionOf,
  bumpFinancialRevision,
  assertFinancialRevision,
};
