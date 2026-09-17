'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('ACG Trader does not own the prop-firm challenge risk engine', () => {
  assert.equal(fs.existsSync(path.join(root, 'src/modules/trading/challenge-risk-engine.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/modules/trading/challenge-risk-decision.model.js')), false);

  const runtime = fs.readFileSync(path.join(root, 'src/modules/trading/trading.runtime.js'), 'utf8');
  assert.doesNotMatch(runtime, /ChallengeRiskEngine/);
  assert.doesNotMatch(runtime, /challengeRiskPolicy/);
  assert.match(runtime, /executionRiskPolicy:\s*true/);
  assert.match(runtime, /propChallengeRiskEngine:\s*false/);
  assert.match(runtime, /riskEngine:\s*false/);
});

test('ACG Trader relays authoritative facts to ACG Funded rather than challenge decisions', () => {
  const relay = fs.readFileSync(path.join(root, 'src/modules/integration/platform-event-relay.js'), 'utf8');
  assert.match(relay, /ACCOUNT_SNAPSHOT/);
  assert.match(relay, /DEAL_CREATED/);
  assert.match(relay, /ACCOUNT_CONTROLLED/);
  assert.doesNotMatch(relay, /challenge\.passed/);
  assert.doesNotMatch(relay, /challenge\.breached/);
  assert.doesNotMatch(relay, /CHALLENGE_PASSED/);
  assert.doesNotMatch(relay, /CHALLENGE_BREACHED/);
});
