'use strict';

const DEFAULT_POLICY = Object.freeze({
  FOREX: Object.freeze({ minMovePercent: 0.08, minPoints: 80 }),
  METAL: Object.freeze({ minMovePercent: 0.08, minPoints: 250 }),
  INDEX: Object.freeze({ minMovePercent: 0.12, minPoints: 80 }),
  ENERGY: Object.freeze({ minMovePercent: 0.15, minPoints: 100 }),
  EQUITY: Object.freeze({ minMovePercent: 0.25, minPoints: 50 }),
  CRYPTO: Object.freeze({ minMovePercent: 0.50, minPoints: 100 }),
  OTHER: Object.freeze({ minMovePercent: 0.25, minPoints: 100 }),
});

const RECENT_MOVE_WINDOW = 32;
const RECENT_MOVE_MULTIPLIER = 12;
const CONFIRMATION_BAND_FRACTION = 0.5;
const SAME_DIRECTION_CONFIRM_MULTIPLIER = 1.5;
const MAX_PENDING_AGE_MS = 5000;
const OUT_OF_ORDER_TOLERANCE_MS = 1000;

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function providerTimestamp(raw) {
  const numeric = Number(raw?.providerTimestampMs);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function isTrustedRecoverySource(raw) {
  return String(raw?.source || '').toLowerCase().endsWith('-rest');
}

class TickSanityFilter {
  constructor({
    policy = DEFAULT_POLICY,
    recentMoveWindow = RECENT_MOVE_WINDOW,
    recentMoveMultiplier = RECENT_MOVE_MULTIPLIER,
    confirmationBandFraction = CONFIRMATION_BAND_FRACTION,
    sameDirectionConfirmMultiplier = SAME_DIRECTION_CONFIRM_MULTIPLIER,
    maxPendingAgeMs = MAX_PENDING_AGE_MS,
    outOfOrderToleranceMs = OUT_OF_ORDER_TOLERANCE_MS,
  } = {}) {
    this.policy = policy;
    this.recentMoveWindow = Math.max(4, Number(recentMoveWindow) || RECENT_MOVE_WINDOW);
    this.recentMoveMultiplier = Math.max(2, Number(recentMoveMultiplier) || RECENT_MOVE_MULTIPLIER);
    this.confirmationBandFraction = Math.max(0.1, Number(confirmationBandFraction) || CONFIRMATION_BAND_FRACTION);
    this.sameDirectionConfirmMultiplier = Math.max(1, Number(sameDirectionConfirmMultiplier) || SAME_DIRECTION_CONFIRM_MULTIPLIER);
    this.maxPendingAgeMs = Math.max(250, Number(maxPendingAgeMs) || MAX_PENDING_AGE_MS);
    this.outOfOrderToleranceMs = Math.max(0, Number(outOfOrderToleranceMs) || OUT_OF_ORDER_TOLERANCE_MS);
    this.states = new Map();
  }

  inspect({ symbol, raw, instrument, receivedAtMs = Date.now() }) {
    const price = positiveNumber(raw?.price);
    if (!symbol || price == null) return { accepted: [], reason: 'INVALID_PRICE' };

    const state = this.#state(symbol);
    const timestamp = providerTimestamp(raw);

    if (
      timestamp != null
      && state.lastProviderTimestampMs != null
      && timestamp < state.lastProviderTimestampMs - this.outOfOrderToleranceMs
    ) {
      state.rejected += 1;
      return { accepted: [], reason: 'OUT_OF_ORDER' };
    }

    if (isTrustedRecoverySource(raw)) {
      if (state.pending) {
        state.rejected += 1;
        state.pending = null;
      }
      return {
        accepted: [this.#accept(state, raw, receivedAtMs, price, timestamp)],
        reason: 'TRUSTED_RECOVERY',
      };
    }

    if (state.lastAcceptedPrice == null) {
      return {
        accepted: [this.#accept(state, raw, receivedAtMs, price, timestamp)],
        reason: 'FIRST_TICK',
      };
    }

    if (state.pending && receivedAtMs - state.pending.receivedAtMs > this.maxPendingAgeMs) {
      state.rejected += 1;
      state.pending = null;
    }

    const anchor = state.lastAcceptedPrice;
    const threshold = this.#threshold(state, instrument, anchor);
    const distanceFromAnchor = Math.abs(price - anchor);

    if (!state.pending) {
      if (distanceFromAnchor <= threshold) {
        return {
          accepted: [this.#accept(state, raw, receivedAtMs, price, timestamp)],
          reason: 'NORMAL',
          threshold,
        };
      }

      state.pending = { raw, receivedAtMs, price, threshold, anchor, providerTimestampMs: timestamp };
      state.quarantined += 1;
      return { accepted: [], reason: 'QUARANTINED', threshold };
    }

    const pending = state.pending;
    const candidateDistance = Math.abs(price - pending.price);
    const confirmationBand = Math.max(
      pending.threshold * this.confirmationBandFraction,
      (positiveNumber(instrument?.tickSize) || 0) * 20,
    );
    const pendingDirection = Math.sign(pending.price - pending.anchor);
    const currentDirection = Math.sign(price - pending.anchor);
    const sameDirection = pendingDirection !== 0 && currentDirection === pendingDirection;
    const sustainedMove = sameDirection
      && Math.abs(price - pending.anchor) > pending.threshold
      && candidateDistance <= pending.threshold * this.sameDirectionConfirmMultiplier;

    if (candidateDistance <= confirmationBand || sustainedMove) {
      state.pending = null;
      state.confirmed += 1;
      const acceptedPending = this.#accept(
        state,
        pending.raw,
        pending.receivedAtMs,
        pending.price,
        pending.providerTimestampMs,
      );
      const acceptedCurrent = this.#accept(state, raw, receivedAtMs, price, timestamp);
      return {
        accepted: [acceptedPending, acceptedCurrent],
        reason: 'CONFIRMED_JUMP',
        threshold: pending.threshold,
      };
    }

    if (distanceFromAnchor <= threshold) {
      state.pending = null;
      state.rejected += 1;
      return {
        accepted: [this.#accept(state, raw, receivedAtMs, price, timestamp)],
        reason: 'REJECTED_ISOLATED_SPIKE',
        threshold,
      };
    }

    // A second unconfirmed outlier in another price region is not enough to
    // move executable state. Replace the candidate and wait for one coherent
    // follow-up tick rather than letting two unrelated bad ticks through.
    state.rejected += 1;
    state.pending = { raw, receivedAtMs, price, threshold, anchor, providerTimestampMs: timestamp };
    state.quarantined += 1;
    return { accepted: [], reason: 'REPLACED_QUARANTINE', threshold };
  }

  resetPending(symbol = null) {
    if (symbol == null) {
      for (const state of this.states.values()) state.pending = null;
      return;
    }
    const state = this.states.get(String(symbol));
    if (state) state.pending = null;
  }

  snapshot(symbol) {
    const state = this.states.get(String(symbol));
    if (!state) {
      return {
        pending: false,
        quarantined: 0,
        rejected: 0,
        confirmed: 0,
        threshold: null,
      };
    }
    return {
      pending: Boolean(state.pending),
      quarantined: state.quarantined,
      rejected: state.rejected,
      confirmed: state.confirmed,
      threshold: state.lastThreshold ?? null,
    };
  }

  #state(symbol) {
    const key = String(symbol);
    if (!this.states.has(key)) {
      this.states.set(key, {
        lastAcceptedPrice: null,
        lastProviderTimestampMs: null,
        recentMoves: [],
        lastThreshold: null,
        pending: null,
        quarantined: 0,
        rejected: 0,
        confirmed: 0,
      });
    }
    return this.states.get(key);
  }

  #threshold(state, instrument, anchor) {
    const assetClass = String(instrument?.assetClass || 'OTHER').toUpperCase();
    const policy = this.policy[assetClass] || this.policy.OTHER || DEFAULT_POLICY.OTHER;
    const tickSize = positiveNumber(instrument?.tickSize) || 0;
    const pointFloor = tickSize * Math.max(0, Number(policy.minPoints) || 0);
    const percentFloor = anchor * Math.max(0, Number(policy.minMovePercent) || 0) / 100;
    const recentMedian = median(state.recentMoves);
    const dynamicFloor = recentMedian * this.recentMoveMultiplier;
    const threshold = Math.max(pointFloor, percentFloor, dynamicFloor, tickSize || Number.EPSILON);
    state.lastThreshold = threshold;
    return threshold;
  }

  #accept(state, raw, receivedAtMs, price, timestamp) {
    if (state.lastAcceptedPrice != null) {
      const move = Math.abs(price - state.lastAcceptedPrice);
      if (Number.isFinite(move)) {
        state.recentMoves.push(move);
        if (state.recentMoves.length > this.recentMoveWindow) state.recentMoves.shift();
      }
    }
    state.lastAcceptedPrice = price;
    if (timestamp != null) {
      state.lastProviderTimestampMs = state.lastProviderTimestampMs == null
        ? timestamp
        : Math.max(state.lastProviderTimestampMs, timestamp);
    }
    return { raw, receivedAtMs };
  }
}

module.exports = {
  TickSanityFilter,
  DEFAULT_POLICY,
};
