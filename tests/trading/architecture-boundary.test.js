'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('ACG Trader owns local execution-safety breach enforcement but not challenge progression decisions', () => {
  assert.equal(fs.existsSync(path.join(root, 'src/modules/trading/challenge-risk-engine.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'src/modules/trading/challenge-risk-decision.model.js')), false);

  const runtime = fs.readFileSync(path.join(root, 'src/modules/trading/trading.runtime.js'), 'utf8');
  assert.match(runtime, /\bChallengeRiskEngine\b/);
  assert.doesNotMatch(runtime, /challengeRiskPolicy/);
  assert.match(runtime, /executionRiskPolicy:\s*true/);
  assert.match(runtime, /propChallengeRiskEngine:\s*true/);
  assert.match(runtime, /riskEngine:\s*true/);
});

test('ACG Trader relays authoritative facts to ACG Funded rather than pass/progression decisions', () => {
  const relay = fs.readFileSync(path.join(root, 'src/modules/integration/platform-event-relay.js'), 'utf8');
  assert.match(relay, /ACCOUNT_SNAPSHOT/);
  assert.match(relay, /DEAL_CREATED/);
  assert.match(relay, /ACCOUNT_CONTROLLED/);
  assert.doesNotMatch(relay, /challenge\.passed/);
  assert.doesNotMatch(relay, /CHALLENGE_PASSED/);
});
