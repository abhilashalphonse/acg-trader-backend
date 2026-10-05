'use strict';
function policyMetadata(decision) {
  if (!decision?.status) return {};
  const s = decision.status;
  return { executionPolicy: JSON.stringify({ evaluatedAt: s.generatedAt, allowed: decision.allowed,
    permissionVersion: s.permissionVersion, calendarSnapshotVersion: s.news?.snapshotVersion || null,
    calendarStatus: s.news?.dataStatus, scheduleVersion: s.scheduleVersion, scheduleHash: s.scheduleHash, policyEngineVersion: s.policyEngineVersion,
    effectivePolicies: s.effectivePolicies, decisions: decision.decisions,
    enforcementControl: s.enforcementControl,
    eventId: s.news?.event?.id || null, blockedFrom: s.news?.blockedFrom || null, blockedUntil: s.news?.blockedUntil || null,
    weekendCutoff: s.weekend?.autoCloseAt || null, weekendRequiredFlatAt: s.weekend?.requiredFlatAt || null }) };
}
function attachPolicyEvidence(document, decision) {
  const metadata = policyMetadata(decision);
  for (const [key, value] of Object.entries(metadata)) {
    if (document.metadata instanceof Map) document.metadata.set(key, value);
    else document.metadata = { ...(document.metadata || {}), [key]: value };
  }
}
module.exports = { policyMetadata, attachPolicyEvidence };
