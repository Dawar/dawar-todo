// Read-only file viewer helpers. Everything here treats file contents as inert
// data: nothing is executed, fetched, parsed as HTML or merged into app objects,
// and the original bytes used by Download are never rewritten.

/** Finite viewer limits; larger files keep the Download fallback. */
export const TEXT_PREVIEW_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024, // text read limit
  lines: 20_000, // rendered lines
  lineChars: 20_000, // rendered characters per line
  highlightBytes: 512 * 1024, // syntax highlighting above this falls back to plain text
  tableRows: 2_000, // CSV/TSV records rendered
  tableColumns: 100,
  cellChars: 2_000,
  jsonDepth: 256,
  searchResults: 1_000,
});

const extensions = {
  txt: ['text'], text: ['text'],
  json: ['json', 'json'], csv: ['csv'], tsv: ['tsv'], tab: ['tsv'], log: ['log'],
  yaml: ['config', 'yaml'], yml: ['config', 'yaml'], toml: ['config', 'toml'], ini: ['config', 'ini'], cfg: ['config', 'ini'], conf: ['config', 'ini'], xml: ['config', 'xml'],
  js: ['code', 'js'], mjs: ['code', 'js'], cjs: ['code', 'js'], jsx: ['code', 'js'], ts: ['code', 'ts'], tsx: ['code', 'ts'], mts: ['code', 'ts'], cts: ['code', 'ts'],
  py: ['code', 'py'], css: ['code', 'css'], sql: ['code', 'sql'], sh: ['code', 'sh'], bash: ['code', 'sh'], zsh: ['code', 'sh'],
  mp3: ['audio'], wav: ['audio'], mp4: ['video'], webm: ['video'],
};
const mimes = {
  'text/plain': ['text'], 'application/json': ['json', 'json'], 'text/json': ['json', 'json'], 'text/csv': ['csv'], 'text/tab-separated-values': ['tsv'],
  'application/xml': ['config', 'xml'], 'text/xml': ['config', 'xml'], 'application/yaml': ['config', 'yaml'], 'application/x-yaml': ['config', 'yaml'], 'text/yaml': ['config', 'yaml'],
  'application/toml': ['config', 'toml'], 'text/javascript': ['code', 'js'], 'application/javascript': ['code', 'js'], 'text/x-python': ['code', 'py'],
  'text/css': ['code', 'css'], 'application/sql': ['code', 'sql'], 'application/x-sh': ['code', 'sh'], 'text/x-shellscript': ['code', 'sh'],
  'audio/mpeg': ['audio'], 'audio/mp3': ['audio'], 'audio/wav': ['audio'], 'audio/x-wav': ['audio'], 'audio/wave': ['audio'], 'video/mp4': ['video'], 'video/webm': ['video'],
};
const generic = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const media = kind => kind === 'audio' || kind === 'video';

/**
 * Viewer for a file by precise name/MIME classification, or null to keep the
 * existing viewers/Download. Markdown/HTML stay with the document preview.
 */
export function filePreviewKind(file) {
  const mime = String(file?.mimeType ?? '').split(';', 1)[0].trim().toLowerCase();
  const name = String(file?.name ?? ''), extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase();
  const byName = extension && Object.hasOwn(extensions, extension) ? extensions[extension] : null;
  const byMime = Object.hasOwn(mimes, mime) ? mimes[mime] : mime.endsWith('+json') ? ['json', 'json'] : mime.endsWith('+xml') && !mime.startsWith('image/') ? ['config', 'xml'] : null;
  if (mime.startsWith('image/') || mime === 'application/pdf' || mime === 'text/html' || mime === 'text/markdown') return null;
  const pick = byName ?? byMime;
  if (!pick) return null;
  if (byName && !generic.has(mime)) {
    // An explicit conflicting media/text type keeps the safe Download fallback.
    const mimeMedia = mime.startsWith('audio/') || mime.startsWith('video/');
    if (media(byName[0]) !== mimeMedia) return null;
  }
  return { kind: pick[0], language: pick[1] ?? '' };
}

/** Strict UTF-8 decode within the byte limit; binary/invalid text is reported, never guessed. */
export function decodePreviewText(bytes, limits = TEXT_PREVIEW_LIMITS) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength > limits.bytes) return { status: 'large' };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(view); } catch { return { status: 'encoding' }; }
  if (text.includes('\0')) return { status: 'binary' };
  return { status: 'ok', text };
}

/** Display lines with honest clipping counts. */
export function previewLines(text, limits = TEXT_PREVIEW_LIMITS) {
  const all = text.split(/\r\n|\n|\r/);
  if (all.length > 1 && all.at(-1) === '') all.pop();
  let clippedLines = 0;
  const lines = all.slice(0, limits.lines).map(line => {
    if (line.length <= limits.lineChars) return line;
    clippedLines++; return line.slice(0, limits.lineChars);
  });
  return { lines, total: all.length, hiddenLines: Math.max(0, all.length - lines.length), clippedLines };
}

/** Case-insensitive bounded line search. */
export function searchLines(lines, query, limit = TEXT_PREVIEW_LIMITS.searchResults) {
  const needle = String(query ?? '').slice(0, 200).toLowerCase();
  if (!needle) return { matches: [], clipped: false };
  const matches = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].toLowerCase().includes(needle)) { if (matches.length === limit) return { matches, clipped: true }; matches.push(index); }
  }
  return { matches, clipped: false };
}

/**
 * RFC 4180-style records: quoted fields, doubled quotes, delimiters and line
 * breaks inside quotes, CRLF/LF/CR. Ragged rows keep their own lengths; every
 * cell stays a string (formula-looking values are not evaluated).
 */
export function parseDelimited(text, delimiter = ',', limits = TEXT_PREVIEW_LIMITS) {
  const rows = []; let row = [], field = '', quoted = false, wasQuoted = false, i = 0, hiddenRows = false;
  const endField = () => { row.push(field); field = ''; wasQuoted = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '' && !wasQuoted) { quoted = true; wasQuoted = true; i++; continue; }
    if (c === delimiter) { endField(); i++; continue; }
    if (c === '\n' || c === '\r') {
      endRow(); i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (rows.length === limits.tableRows) { hiddenRows = i < text.length; break; }
      continue;
    }
    field += c; i++;
  }
  const unterminated = quoted;
  if (!hiddenRows && (field !== '' || row.length || wasQuoted)) endRow();
  const columns = rows.reduce((max, value) => Math.max(max, value.length), 0);
  return { rows, columns: Math.min(columns, limits.tableColumns), hiddenColumns: Math.max(0, columns - limits.tableColumns), hiddenRows, unterminated,
    ragged: rows.some(value => value.length !== rows[0].length) };
}

export const clipCell = (value, limits = TEXT_PREVIEW_LIMITS) => value.length > limits.cellChars ? `${value.slice(0, limits.cellChars)}…` : value;

const jsonString = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const jsonNumber = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const jsonLiteral = /true|false|null/y;

/**
 * Pretty-prints JSON by re-indenting its exact source tokens, so numbers and
 * strings keep their original spelling (no float rounding or escape rewriting).
 * Invalid input returns a positioned error; the caller shows the raw text.
 */
export function formatJson(text, limits = TEXT_PREVIEW_LIMITS) {
  let i = 0; const out = [];
  const fail = (message) => {
    const before = text.slice(0, i), line = before.split('\n').length, column = i - before.lastIndexOf('\n');
    return { error: `${message} at line ${line}, column ${column}.`, line, column };
  };
  const space = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const token = (pattern) => { pattern.lastIndex = i; const match = pattern.exec(text); if (!match) return null; i = pattern.lastIndex; return match[0]; };
  const indent = depth => '\n' + '  '.repeat(depth);
  function value(depth) {
    if (depth > limits.jsonDepth) throw fail('Nesting is too deep to format');
    space();
    if (i >= text.length) throw fail('Unexpected end of JSON');
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'; i++; space();
      if (text[i] === close) { i++; out.push(c + close); return; }
      out.push(c);
      for (let first = true; ; first = false) {
        if (!first) out.push(',');
        out.push(indent(depth + 1));
        if (c === '{') {
          space(); const key = token(jsonString); if (key === null) throw fail('Expected a property name');
          space(); if (text[i] !== ':') throw fail('Expected ":"'); i++; out.push(key, ': ');
        }
        value(depth + 1); space();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === close) { i++; break; }
        throw fail(i >= text.length ? 'Unexpected end of JSON' : `Expected "," or "${close}"`);
      }
      out.push(indent(depth), close); return;
    }
    const scalar = c === '"' ? token(jsonString) : c === '-' || (c >= '0' && c <= '9') ? token(jsonNumber) : token(jsonLiteral);
    if (scalar === null) throw fail(c === '"' ? 'Invalid string' : 'Unexpected token');
    out.push(scalar);
  }
  try {
    value(0); space();
    if (i < text.length) throw fail('Unexpected content after JSON');
  } catch (error) { if (error && typeof error.error === 'string') return error; throw error; }
  return { formatted: out.join('') };
}

const keywordSets = {
  js: 'await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield async',
  ts: 'await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while with yield async abstract as declare keyof namespace never unknown any string number boolean satisfies',
  py: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self',
  sql: 'select from where and or not insert into values update set delete create table view index drop alter add primary key foreign references join left right inner outer full on as group by order having limit offset distinct union all case when then else end null is in like between exists with returning default unique check constraint begin commit rollback',
  sh: 'if then else elif fi for while until do done case esac in function return local export readonly declare unset shift exit set source echo true false',
  css: '', yaml: 'true false null yes no on off', toml: 'true false', ini: 'true false yes no on off', xml: '', json: 'true false null',
};
const keywordLookup = Object.fromEntries(Object.entries(keywordSets).map(([language, words]) => [language, new Set(language === 'sql' ? words.split(' ') : words.split(' ').filter(Boolean))]));
const str = { double: /"(?:[^"\\\n]|\\.)*"?/y, single: /'(?:[^'\\\n]|\\.)*'?/y };
const number = /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?(?![\w$])/y;
const rules = {
  js: [['comment', /\/\/[^\n]*/y], ['comment', /\/\*[\s\S]*?(?:\*\/|$)/y], ['string', str.double], ['string', str.single], ['string', /`(?:[^`\\]|\\[\s\S])*`?/y], ['number', number]],
  py: [['comment', /#[^\n]*/y], ['string', /[rRbBuUfF]{0,2}"""[\s\S]*?(?:"""|$)/y], ['string', /[rRbBuUfF]{0,2}'''[\s\S]*?(?:'''|$)/y], ['string', /[rRbBuUfF]{0,2}"(?:[^"\\\n]|\\.)*"?/y], ['string', /[rRbBuUfF]{0,2}'(?:[^'\\\n]|\\.)*'?/y], ['meta', /@[\w.]+/y], ['number', number]],
  css: [['comment', /\/\*[\s\S]*?(?:\*\/|$)/y], ['string', str.double], ['string', str.single], ['keyword', /@[\w-]+/y], ['number', /#[\da-fA-F]{3,8}(?![\w-])/y], ['key', /[\w-]+(?=\s*:(?!:))/y], ['number', /-?\d*\.?\d+(?:%|[a-z]+)?/y]],
  sql: [['comment', /--[^\n]*/y], ['comment', /\/\*[\s\S]*?(?:\*\/|$)/y], ['string', /'(?:[^']|'')*'?/y], ['string', /"(?:[^"]|"")*"?/y], ['number', number]],
  sh: [['comment', /(?:^|(?<=\s))#[^\n]*/y], ['string', str.double], ['string', /'[^']*'?/y], ['key', /\$(?:\{[^}\n]*\}?|[\w@#?*!$-])/y], ['number', number]],
  yaml: [['comment', /(?:^|(?<=\s))#[^\n]*/y], ['meta', /^(?:---|\.\.\.)(?=\s|$)/my], ['key', /[\w.$-][\w .$-]*(?=:(?:\s|$))/y], ['string', str.double], ['string', /'(?:[^']|'')*'?/y], ['meta', /[&*][\w-]+/y], ['number', number]],
  toml: [['comment', /#[^\n]*/y], ['tag', /^\s*\[\[?[^\]\n]*\]\]?/my], ['key', /[\w.-]+(?=\s*=)/y], ['string', /"""[\s\S]*?(?:"""|$)/y], ['string', /'''[\s\S]*?(?:'''|$)/y], ['string', str.double], ['string', /'[^'\n]*'?/y], ['number', /\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?/y], ['number', number]],
  ini: [['comment', /^\s*[;#][^\n]*/my], ['tag', /^\s*\[[^\]\n]*\]/my], ['key', /^\s*[^=\n[;#][^=\n]*?(?=\s*=)/my], ['string', str.double], ['number', number]],
  xml: [['comment', /<!--[\s\S]*?(?:-->|$)/y], ['string', /<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/y], ['meta', /<[!?][^>]*>?/y], ['tag', /<\/?[\w:.-]+/y], ['tag', /\/?>/y], ['key', /[\w:.-]+(?=\s*=)/y], ['string', str.double], ['string', str.single]],
  json: [['key', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y], ['string', str.double], ['number', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y]],
};
rules.ts = rules.js;
const word = /[A-Za-z_$][\w$]*/y;

/**
 * Bounded lexical highlighting as `[type, text]` pairs that concatenate back to
 * the exact input. Unknown languages and oversized input return plain text.
 */
export function highlightTokens(text, language, limits = TEXT_PREVIEW_LIMITS) {
  const list = rules[language];
  if (!list || text.length > limits.highlightBytes) return [['plain', text]];
  const keywords = keywordLookup[language], caseless = language === 'sql';
  const tokens = []; let plain = '', i = 0;
  const push = (type, value) => { if (plain) { tokens.push(['plain', plain]); plain = ''; } tokens.push([type, value]); };
  outer: while (i < text.length) {
    for (const [type, pattern] of list) {
      pattern.lastIndex = i; const match = pattern.exec(text);
      if (match && match[0]) { push(type, match[0]); i = pattern.lastIndex; continue outer; }
    }
    word.lastIndex = i; const match = word.exec(text);
    if (match) {
      if (keywords?.has(caseless ? match[0].toLowerCase() : match[0])) push('keyword', match[0]); else plain += match[0];
      i = word.lastIndex; continue;
    }
    plain += text[i++];
  }
  if (plain) tokens.push(['plain', plain]);
  return tokens;
}

/** Splits highlighted tokens into display lines (same line breaks as previewLines). */
export function tokenLines(tokens, limits = TEXT_PREVIEW_LIMITS) {
  const lines = [[]];
  // A token can end inside a CRLF (a line comment swallows the \r): the next
  // token's leading \n completes that same line break, not a new one.
  let openCR = false;
  for (const [type, token] of tokens) {
    const value = openCR && token.startsWith('\n') ? token.slice(1) : token;
    openCR = value.endsWith('\r');
    const parts = value.split(/\r\n|\n|\r/);
    parts.forEach((part, index) => {
      if (index) { if (lines.length === limits.lines + 1) return; lines.push([]); }
      if (part) lines.at(-1).push([type, part]);
    });
  }
  if (lines.length > 1 && !lines.at(-1).length) lines.pop();
  return lines.slice(0, limits.lines);
}
