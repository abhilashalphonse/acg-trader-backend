'use strict';

class AccountCommandQueue {
  constructor() {
    this.tails = new Map();
  }

  run(accountId, task) {
    const key = String(accountId || '');
    if (!key) return Promise.reject(new TypeError('accountId is required'));
    if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'));

    const previous = this.tails.get(key) || Promise.resolve();
    const execution = previous.catch(() => undefined).then(() => task());
    const tail = execution.catch(() => undefined);
    this.tails.set(key, tail);

    return execution.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  async drain(accountId) {
    const key = String(accountId || '');
    const tail = this.tails.get(key);
    if (tail) await tail;
  }

  async drainAll() {
    await Promise.all([...this.tails.values()]);
  }

  get pendingAccounts() {
    return this.tails.size;
  }
}

module.exports = { AccountCommandQueue };
