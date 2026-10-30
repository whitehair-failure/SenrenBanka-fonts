import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function assertSha256(value, label = 'sha256') {
  if (!SHA256_PATTERN.test(value ?? '')) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function verifySha256(data, expected, label = 'file') {
  assertSha256(expected, `${label} sha256`);
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

export function sidecarContent(sha, fileName) {
  assertSha256(sha);
  if (!fileName || /[\r\n]/.test(fileName)) {
    throw new Error('checksum file name is invalid');
  }
  return `${sha}  ${fileName}\n`;
}

export function parseSidecar(content, expectedFileName) {
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\r?\n?$/.exec(content);
  if (!match) throw new Error('checksum sidecar is malformed');
  if (expectedFileName && match[2] !== expectedFileName) {
    throw new Error(
      `checksum sidecar names ${match[2]}, expected ${expectedFileName}`,
    );
  }
  return { sha256: match[1], fileName: match[2] };
}
