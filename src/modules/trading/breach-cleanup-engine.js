'use strict';

const mongoose = require('mongoose');
const { AccountBreachCleanupJob } = require('./account-breach-cleanup-job.model');

class BreachCleanupEngine {
  constructor({
    accountControlService,
    jobModel = AccountBreachCleanupJob,
    logger = null,
    pollIntervalMs = 1000,
    leaseMs = 30000,
    batchSize = 10,
    now = () => new Date(),
  } = {}) {
    this.accountControlService = accountControlService;
    this.jobModel = jobModel;
    this.logger = logger;
    this.pollIntervalMs = pollIntervalMs;
    this.leaseMs = leaseMs;
    this.batchSize = batchSize;
    this.now = now;
    this.started = false;
    this.running = false;
    this.timer = null;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this.flush();
    this.timer = setInterval(() => {
      void this.flush().catch(error => this.logger?.error({ err: error }, 'Breach cleanup flush failed'));
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }

  health() {
    return { started: this.started, running: this.running };
  }

  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      for (let index = 0; index < this.batchSize; index += 1) {
        const job = await this.#claimNext();
        if (!job) break;
        await this.#process(job);
      }
    } finally {
      this.running = false;
    }
  }

  async #claimNext() {
    const now = this.now();
    const filter = mongoose.trusted({
      $or: [
        { state: { $in: ['PENDING', 'RETRY'] }, nextAttemptAt: { $lte: now } },
        { state: 'PROCESSING', leaseExpiresAt: { $lte: now } },
      ],
    });
    return this.jobModel.findOneAndUpdate(
      filter,
      {
        $set: {
          state: 'PROCESSING',
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          lastAttemptAt: now,
          lastError: null,
        },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1, _id: 1 }, new: true },
    );
  }

  async #process(job) {
    try {
      await this.accountControlService.breach(String(job.accountId), {
        reason: job.reason,
        action: job.breachAction,
        evidence: job.evidence,
      });
      await this.jobModel.updateOne(
        { _id: job._id, state: 'PROCESSING' },
        {
          $set: {
            state: 'COMPLETED',
            completedAt: this.now(),
            leaseExpiresAt: null,
            lastError: null,
          },
        },
      );
    } catch (error) {
      const delay = retryDelayMs(Number(job.attempts || 1));
      await this.jobModel.updateOne(
        { _id: job._id, state: 'PROCESSING' },
        {
          $set: {
            state: 'RETRY',
            nextAttemptAt: new Date(this.now().getTime() + delay),
            leaseExpiresAt: null,
            lastError: String(error?.message || error).slice(0, 2000),
          },
        },
      );
      this.logger?.warn?.({ err: error, jobId: job.jobId, accountId: String(job.accountId) }, 'Breach cleanup will retry');
    }
  }
}

function retryDelayMs(attempt) {
  return Math.min(60000, 500 * (2 ** Math.max(0, attempt - 1)));
}

module.exports = { BreachCleanupEngine, retryDelayMs };
