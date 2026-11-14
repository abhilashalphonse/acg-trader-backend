'use strict';
// Offline report decryption. Never run this in GitHub Actions or on a public host.
const fs = require('node:fs');
const crypto = require('node:crypto');
function main() {
  const keyText = process.env.PR72_AUDIT_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(keyText)) throw new Error('AUDIT_DECRYPTION_KEY_REQUIRED');
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('INPUT_OUTPUT_REQUIRED');
  const envelope = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (envelope.format !== 'acg-audit-gcm-v1') throw new Error('UNSUPPORTED_REPORT_FORMAT');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyText, 'hex'), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  fs.writeFileSync(output, plaintext, { mode: 0o600, flag: 'wx' });
}
try { main(); } catch (error) {
  console.error('AUDIT_DECRYPTION_FAILED', error.code || error.message || error.name);
  process.exitCode = 2;
}
