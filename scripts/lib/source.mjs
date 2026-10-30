import fs from 'node:fs';
import path from 'node:path';
import { extractArchiveMember } from './archive.mjs';
import { sha256, verifySha256 } from './hash.mjs';
import { resolveInside } from './paths.mjs';

const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

function assertHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS`);
  }
  return parsed;
}

async function readResponseBytes(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('download exceeds size limit');
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new Error('download exceeds size limit');
    return data;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error('download exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function downloadBytes(
  url,
  {
    fetchImpl = globalThis.fetch,
    maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES,
    timeoutMs = 120_000,
  } = {},
) {
  assertHttpsUrl(url, 'source URL');
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation is available');
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`failed to download ${url}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  if (response.url) assertHttpsUrl(response.url, 'redirected source URL');
  return readResponseBytes(response, maxBytes);
}

async function readBootstrapFile(bootstrapDir, bootstrapKey, expected) {
  const filePath = resolveInside(bootstrapDir, bootstrapKey, 'bootstrap key');
  let stat;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`bootstrap input must be a regular file: ${bootstrapKey}`);
  }
  if (stat.size !== expected.size) {
    throw new Error(
      `bootstrap input size mismatch for ${bootstrapKey}: expected ${expected.size}, got ${stat.size}`,
    );
  }
  const data = await fs.promises.readFile(filePath);
  verifySha256(data, expected.sha256, `bootstrap input ${bootstrapKey}`);
  return data;
}

async function writeDownloadCache(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, data);
  await fs.promises.rename(temporary, filePath);
}

async function getDownloaded(
  download,
  { fetchImpl, cacheDir, maxBytes },
) {
  assertHttpsUrl(download.url, 'download URL');
  const cacheRoot = cacheDir ?? path.resolve('.cache', 'downloads');
  const cacheName = `${download.sha256}${path.extname(new URL(download.url).pathname)}`;
  const cacheFile = resolveInside(cacheRoot, cacheName, 'download cache path');
  let data = null;
  try {
    const stat = await fs.promises.lstat(cacheFile);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      const cached = await fs.promises.readFile(cacheFile);
      if (sha256(cached) === download.sha256) data = cached;
    }
    if (!data) await fs.promises.rm(cacheFile, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!data) {
    data = await downloadBytes(download.url, { fetchImpl, maxBytes });
    verifySha256(data, download.sha256, `download ${download.url}`);
    await writeDownloadCache(cacheFile, data);
  }
  return data;
}

export async function resolveSourceFile(
  sourceFile,
  {
    bootstrapDir,
    fetchImpl,
    cacheDir,
    maxDownloadBytes = DEFAULT_MAX_DOWNLOAD_BYTES,
  } = {},
) {
  if (bootstrapDir) {
    const data = await readBootstrapFile(bootstrapDir, sourceFile.bootstrapKey, sourceFile);
    if (data) return { data, origin: 'bootstrap' };
  }
  if (!sourceFile.download) {
    throw new Error(
      `source ${sourceFile.fileName} has no download URL; provide --bootstrap-dir with ${sourceFile.bootstrapKey}`,
    );
  }

  const downloaded = await getDownloaded(sourceFile.download, {
    fetchImpl,
    cacheDir,
    maxBytes: maxDownloadBytes,
  });
  let data = downloaded;
  if (sourceFile.download.archiveMember) {
    data = await extractArchiveMember(downloaded, sourceFile.download.archiveMember, {
      label: `source archive for ${sourceFile.fileName}`,
      limits: {
        maxArchiveBytes: maxDownloadBytes,
        maxExpandedBytes: maxDownloadBytes,
        maxEntries: 4096,
      },
    });
  }
  if (data.length !== sourceFile.size) {
    throw new Error(
      `source size mismatch for ${sourceFile.fileName}: expected ${sourceFile.size}, got ${data.length}`,
    );
  }
  verifySha256(data, sourceFile.sha256, `source ${sourceFile.fileName}`);
  return { data, origin: 'download' };
}

export async function resolveFamilySources(descriptor, options = {}) {
  const resolved = new Map();
  for (const sourceFile of descriptor.source.files) {
    const result = await resolveSourceFile(sourceFile, options);
    resolved.set(sourceFile.fileName, result);
  }
  return resolved;
}

export { assertHttpsUrl };
