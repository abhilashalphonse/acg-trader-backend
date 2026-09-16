'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountCommandQueue } = require('../../src/modules/trading/account-command-queue');

test('serializes commands for the same account in submission order', async () => {
  const queue = new AccountCommandQueue();
  const events = [];

  const first = queue.run('account-a', async () => {
    events.push('first:start');
    await new Promise(resolve => setTimeout(resolve, 20));
    events.push('first:end');
  });

  const second = queue.run('account-a', async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(queue.pendingAccounts, 0);
});

test('does not let a failed command block the next command', async () => {
  const queue = new AccountCommandQueue();
  const events = [];

  const first = queue.run('account-a', async () => {
    events.push('first');
    throw new Error('expected failure');
  });
  const second = queue.run('account-a', async () => {
    events.push('second');
    return 'ok';
  });

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 'ok');
  assert.deepEqual(events, ['first', 'second']);
});

test('allows independent accounts to progress concurrently', async () => {
  const queue = new AccountCommandQueue();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let accountBCompleted = false;

  const accountA = queue.run('account-a', async () => gate);
  await queue.run('account-b', async () => { accountBCompleted = true; });

  assert.equal(accountBCompleted, true);
  release();
  await accountA;
});
