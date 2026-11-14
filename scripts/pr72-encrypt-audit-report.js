'use strict';
// AES-256-GCM envelope for report artifacts from a public GitHub repository.
// Only encrypted output is uploaded. The key must be in a protected secret.
const fs = require('node:fs');
const crypto = require('node:crypto');
function main() {
  const keyText = process.env.PR72_AUDIT_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(keyText)) throw new Error('AUDIT_ENCRYPTION_KEY_MUST_BE_32_BYTES_HEX');
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Expected input and output paths');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyText, 'hex'), nonce);
  const plain = fs.readFileSync(input);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  fs.writeFileSync(output, JSON.stringify({
    format: 'acg-audit-gcm-v1', iv: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64'),
  }) + '\n', { mode: 0o600, flag: 'wx' });
}
try { main(); } catch (error) {
  console.error('AUDIT_ENCRYPTION_FAILED', error.code || error.message || error.name);
  process.exitCode = 2;
}
