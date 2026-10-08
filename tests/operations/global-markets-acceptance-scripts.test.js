'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  MUTATION_ACK, assertStagingAcceptanceEnvironment,
} = require('../../src/modules/operations/global-markets-acceptance-contract');

const root = path.resolve(__dirname, '../..');

test('Stage 6 acceptance scripts parse and are explicit runnable project commands', () => {
  const pkg = require('../../package.json');
  for (const name of ['final', 'mixed-market']) {
    const file = `scripts/acceptance-global-markets-${name === 'final' ? 'final' : 'mixed-market'}.js`;
    const scriptName = `acceptance:global-markets:${name}`;
    assert.equal(pkg.scripts[scriptName], `node ${file}`);
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(text, { filename: file }));
    assert.match(text, /assertStagingAcceptanceEnvironment/);
    assert.match(text, /cleanup/);
  }
});

test('mixed-market execution may omit RELIANCE stop only with the same explicit staging-only gate', () => {
  const base = {
    baseUrl: 'https://discerning-presence-staging.up.railway.app',
    deploymentEnvironment: 'staging',
    mutationAcknowledgement: MUTATION_ACK,
    bearer: 'testing-token',
    accountId: '507f1f77bcf86cd799439011',
    requireStopLoss: false,
  };
  assert.equal(assertStagingAcceptanceEnvironment(base),
    'https://discerning-presence-staging.up.railway.app');
  assert.throws(() => assertStagingAcceptanceEnvironment({
    ...base, deploymentEnvironment: 'production',
  }), /acknowledgement/);
  assert.throws(() => assertStagingAcceptanceEnvironment({
    ...base, baseUrl: 'https://backend-production.up.railway.app',
  }), /non-staging/);
});
