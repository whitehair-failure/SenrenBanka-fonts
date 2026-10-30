export function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort(compareText)) {
      result[key] = sortValue(value[key]);
    }
    return result;
  }
  return value;
}

export function stableStringify(value, { pretty = true } = {}) {
  return `${JSON.stringify(sortValue(value), null, pretty ? 2 : 0)}${pretty ? '\n' : ''}`;
}

export function parseJson(text, label = 'JSON') {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}
