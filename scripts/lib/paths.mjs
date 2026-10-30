import path from 'node:path';

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/**
 * Validate and return a portable archive path. Backslashes are rejected rather
 * than normalized so callers cannot smuggle platform-specific separators.
 */
export function assertSafeRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > 240) {
    throw new Error(`${label} is too long: ${value}`);
  }
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    WINDOWS_DRIVE.test(value)
  ) {
    throw new Error(`${label} must be a relative POSIX path: ${value}`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`${label} contains an unsafe path segment: ${value}`);
  }
  return value;
}

export function assertSafeFileName(value, label = 'fileName') {
  const name = assertSafeRelativePath(value, label);
  if (name.includes('/')) {
    throw new Error(`${label} must be a file name, not a path: ${value}`);
  }
  return name;
}

export function resolveInside(root, relativePath, label = 'path') {
  assertSafeRelativePath(relativePath, label);
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...relativePath.split('/'));
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return resolved;
}

export function assertReplaceableDirectory(
  value,
  { protectedRoot = process.cwd(), label = 'output directory' } = {},
) {
  const target = path.resolve(value);
  const root = path.resolve(protectedRoot);
  const { root: filesystemRoot } = path.parse(target);
  if (
    target === filesystemRoot ||
    target === root ||
    root.startsWith(`${target}${path.sep}`)
  ) {
    throw new Error(`refusing to replace unsafe ${label}: ${target}`);
  }
  return target;
}
