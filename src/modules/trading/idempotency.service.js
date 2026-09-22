'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { IdempotencyRecord } = require('./idempotency.model');

const DEFAULT_LEASE_MS = 60_000;

function canonicalize(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (value?._bsontype === 'Decimal128' || value?.constructor?.name === 'Decimal128') return value.toString();
  if (typeof value?.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    return Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function hashCommandPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

class IdempotencyService {
  constructor({ model = IdempotencyRecord, leaseMs = DEFAULT_LEASE_MS, now = () => new Date() } = {}) {
    this.model = model;
    this.leaseMs = leaseMs;
    this.now = now;
  }

  async reserve({ accountId, tenantId = null, scope, key, payload, expiresAt }) {
    if (!accountId) throw new TypeError('accountId is required');
    if (!scope || !String(scope).trim()) throw new TypeError('idempotency scope is required');
    if (!key || !String(key).trim()) throw new TypeError('idempotency key is required');

    const resolvedScope = String(scope).trim();
    const resolvedKey = String(key).trim();
    const requestHash = hashCommandPayload(payload);
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);

    try {
      const record = await this.model.create({
        accountId,
        ...(tenantId ? { tenantId } : {}),
        scope: resolvedScope,
        key: resolvedKey,
        requestHash,
        leaseExpiresAt,
        ...(expiresAt ? { expiresAt } : {}),
      });
      return { created: true, replay: false, recovered: false, record };
    } catch (error) {
      if (error?.code !== 11000) throw error;

      const record = await this.model.findOne({ accountId, scope: resolvedScope, key: resolvedKey });
      if (!record) throw error;
      if (record.requestHash !== requestHash) {
        throw new AppError('Idempotency key was already used with a different command payload', {
          statusCode: 409,
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }

      if (record.state === 'IN_PROGRESS' && (!record.leaseExpiresAt || record.leaseExpiresAt <= now)) {
        const recovered = await this.model.findOneAndUpdate(
          {
            _id: record._id,
            state: 'IN_PROGRESS',
            $or: [
              { leaseExpiresAt: null },
              { leaseExpiresAt: mongoose.trusted({ $lte: now }) },
            ],
          },
          { $set: { leaseExpiresAt, retryable: false, failureCode: null, response: null } },
          { new: true },
        );
        if (recovered) return { created: true, replay: false, recovered: true, record: recovered };
      }

      if (record.state === 'FAILED' && record.retryable === true) {
        const recovered = await this.model.findOneAndUpdate(
          { _id: record._id, state: 'FAILED', retryable: true },
          {
            $set: {
              state: 'IN_PROGRESS',
              leaseExpiresAt,
              retryable: false,
              failureCode: null,
              response: null,
            },
          },
          { new: true },
        );
        if (recovered) return { created: true, replay: false, recovered: true, record: recovered };
      }

      return {
        created: false,
        replay: record.state === 'COMPLETED' || record.state === 'FAILED',
        inProgress: record.state === 'IN_PROGRESS',
        record,
      };
    }
  }

  async complete(recordId, { resourceType = null, resourceId = null, response = null } = {}, { session = null } = {}) {
    const query = this.model.findOneAndUpdate(
      { _id: recordId, state: 'IN_PROGRESS' },
      {
        $set: {
          state: 'COMPLETED',
          resourceType,
          resourceId,
          response,
          failureCode: null,
          retryable: false,
          leaseExpiresAt: null,
        },
      },
      { new: true },
    );
    if (session) query.session(session);
    return query;
  }

  async fail(recordId, { failureCode, response = null, retryable = undefined } = {}, { session = null } = {}) {
    const statusCode = Number(response?.error?.statusCode);
    const resolvedRetryable = retryable === undefined
      ? (Number.isFinite(statusCode) && statusCode >= 500)
      : Boolean(retryable);

    const query = this.model.findOneAndUpdate(
      { _id: recordId, state: 'IN_PROGRESS' },
      {
        $set: {
          state: 'FAILED',
          failureCode: failureCode || 'COMMAND_FAILED',
          response,
          retryable: resolvedRetryable,
          leaseExpiresAt: null,
        },
      },
      { new: true },
    );
    if (session) query.session(session);
    return query;
  }
}

module.exports = { IdempotencyService, hashCommandPayload, canonicalize, DEFAULT_LEASE_MS };
