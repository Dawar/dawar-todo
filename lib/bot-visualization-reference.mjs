// A display reference is not permission to read a filesystem path.
export function visualizationReferences(text) {
  if (typeof text !== 'string') return [];
  const result = [];
  for (const match of text.matchAll(/\uE200visualize\uE202([^\uE201]{0,4096})\uE201/g)) {
    let path = null;
    try {
      const value = JSON.parse(match[1]);
      if (value && typeof value === 'object' && !Array.isArray(value) &&
          Object.keys(value).every(key => ['path', 'mode'].includes(key)) &&
          (value.mode === undefined || value.mode === 'wide') &&
          typeof value.path === 'string' && value.path.length <= 2048 &&
          /^\/[^\x00-\x1f\x7f?#]*\.html?$/i.test(value.path) &&
          !value.path.split('/').some(part => part === '..' || part === '.')) path = value.path;
    } catch { /* Unsupported references remain visible as an honest fallback. */ }
    result.push({ start: match.index, end: match.index + match[0].length, path });
    if (result.length === 6) break;
  }
  return result;
}
