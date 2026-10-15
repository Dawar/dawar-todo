import { markdownLiteralRanges } from './markdown-literals.mjs';
// Recognizes Markdown link destinations that point at the bot machine's
// filesystem. A recognized path is only a display identity: it is matched to an
// already registered artifact of the same bot and never grants a read or fetch.
const roots = /^\/(?:home|Users|tmp|private|var|mnt|opt|srv|root|workspace|workspaces|data|Volumes|media)\//;
const relativeOutputs = /^(?:\.\/)?(?:outputs|artifacts|output|exports|reports)\//;
const MAX_PATH = 2048;

function decode(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}
/** Drops editor-style line anchors (`file.ts:12`, `file.ts:12:3`, `#L12`). */
function withoutLineAnchor(path) {
  return path.replace(/#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/, '').replace(/:\d+(?::\d+)?$/, '');
}
function normalized(path) {
  if (!path.startsWith('/') || path.startsWith('//') || path.length > MAX_PATH || /[\x00-\x1f\x7f\\]/.test(path)) return null;
  const parts = path.split('/').slice(1);
  if (parts.some(part => part === '.' || part === '..') || !parts.at(-1)) return null;
  return `/${parts.filter(Boolean).join('/')}`;
}

/**
 * Returns `{ path, name }` for a local filesystem destination, or null for web,
 * app, mail and other ordinary links. `cwd` (the bot workspace) resolves the
 * supported relative output shapes such as `outputs/report.txt`.
 */
export function localFileLink(href, cwd = '') {
  if (typeof href !== 'string' || !href || href.length > MAX_PATH * 3) return null;
  let path = null;
  if (/^file:/i.test(href)) {
    let url; try { url = new URL(href); } catch { return null; }
    if (url.hostname && url.hostname !== 'localhost') return null;
    path = decode(url.pathname);
  } else if (/^sandbox:/i.test(href)) {
    path = decode(href.slice(8));
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('?') || href.startsWith('//')) {
    return null;
  } else {
    if (/[?]/.test(href)) return null;
    const value = decode(href);
    if (value === null) return null;
    if (value.startsWith('/')) {
      const stripped = withoutLineAnchor(value);
      if (!roots.test(stripped) && !(cwd && stripped.startsWith(`${cwd.replace(/\/$/, '')}/`))) return null;
      path = stripped;
    } else if (value.startsWith('~/')) {
      return { path: null, name: basename(value), unresolved: true };
    } else if (relativeOutputs.test(value)) {
      if (!cwd || !cwd.startsWith('/')) return { path: null, name: basename(value), unresolved: true };
      path = `${cwd.replace(/\/$/, '')}/${withoutLineAnchor(value).replace(/^\.\//, '')}`;
    } else return null;
  }
  if (path === null) return null;
  path = normalized(withoutLineAnchor(path));
  return path ? { path, name: basename(path) } : null;
}
function basename(path) {
  return path.split('/').filter(Boolean).at(-1) || 'File';
}

/**
 * Exact owner-loaded attachment match: same bot, ready, bot output, and the
 * resolved path is one of its registered source/copy/visualization paths.
 * Basename-only or foreign-bot matches never count.
 */
export function matchLocalArtifact(link, botId, attachments) {
  if (!link?.path || !botId || !Array.isArray(attachments)) return { state: 'unregistered' };
  const matches = attachments.filter(file => file && file.botId === botId && file.ready && (file.artifact || file.direction === 'output') &&
    (file.localReferences?.includes(link.path) || file.visualizationReferences?.includes(link.path)));
  if (matches.length === 1) return { state: 'registered', attachment: matches[0] };
  if (matches.length > 1) {
    // A re-published source with changed bytes leaves several registered copies.
    // Prefer the single newest one only when creation times identify it.
    const dated = matches.map(file => ({ file, at: Date.parse(file.createdAt ?? '') })).filter(entry => Number.isFinite(entry.at)).sort((a, b) => b.at - a.at);
    if (dated.length === matches.length && dated[0].at !== dated[1].at) return { state: 'registered', attachment: dated[0].file, versions: matches.length };
    return { state: 'ambiguous', count: matches.length };
  }
  return { state: 'unregistered' };
}

/** Link destinations of inline Markdown links outside code (used to de-duplicate returned file cards). */
export function markdownLinkDestinations(text) {
  if (typeof text !== 'string' || !text.includes('](')) return [];
  const literals = markdownLiteralRanges(text);
  return Array.from(text.matchAll(/\]\(\s*(?:<([^>\n]{1,6144})>|([^\s)]{1,6144}))/g))
    .filter(match => !literals.some(range => range.start <= match.index && range.end > match.index))
    .map(match => match[1] ?? match[2]).slice(0, 256);
}
