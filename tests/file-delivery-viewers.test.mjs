import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { localFileLink, matchLocalArtifact, markdownLinkDestinations } from '../lib/local-file-link.mjs';
import { TEXT_PREVIEW_LIMITS, filePreviewKind, decodePreviewText, previewLines, searchLines, parseDelimited, formatJson, highlightTokens, tokenLines } from '../lib/file-preview.mjs';

const cwd = '/home/dawar/bots/paige';
const sha = value => createHash('sha256').update(value).digest('hex');

test('local filesystem destinations are recognized; web, app and mail links are not', () => {
  assert.deepEqual(localFileLink('/home/dawar/bots/.teams/team/website-marketing/Paige/2026-10-13/BASELINE_REVIEW.txt', cwd),
    { path: '/home/dawar/bots/.teams/team/website-marketing/Paige/2026-10-13/BASELINE_REVIEW.txt', name: 'BASELINE_REVIEW.txt' });
  assert.equal(localFileLink('file:///Users/dawar/Desktop/Report%20Q3.pdf', cwd).path, '/Users/dawar/Desktop/Report Q3.pdf');
  assert.equal(localFileLink('file://localhost/tmp/a.txt', cwd).path, '/tmp/a.txt');
  assert.equal(localFileLink('file://other-host/tmp/a.txt', cwd), null);
  assert.equal(localFileLink('sandbox:/mnt/data/chart.png', cwd).path, '/mnt/data/chart.png');
  assert.equal(localFileLink('./outputs/report.csv', cwd).path, `${cwd}/outputs/report.csv`);
  assert.equal(localFileLink('/home/dawar/bots/paige/src/app.ts#L12', cwd).path, '/home/dawar/bots/paige/src/app.ts');
  assert.equal(localFileLink('outputs/report.csv', '').unresolved, true);
  assert.equal(localFileLink('~/Desktop/notes.txt', cwd).unresolved, true);
  for (const href of ['https://example.com/a.txt', 'https://docs.google.com/document/d/1/edit', 'mailto:a@b.c', '/bots?bot=x', '/tasks', '#section',
    '//cdn.example.com/a.js', 'bot-artifact:artifact-1', 'docs/readme.md', '/home/dawar/../etc/passwd', '/home/dawar/./x', '/home/dawar/'])
    assert.equal(localFileLink(href, cwd), null, href);
});

test('only an exact same-bot registered output matches; ambiguity and partial pages stay honest', () => {
  const link = localFileLink(`${cwd}/outputs/BASELINE_REVIEW.txt`, cwd);
  const file = (id, extra = {}) => ({ id, botId: 'paige', name: 'BASELINE_REVIEW.txt', mimeType: 'text/plain', size: 5651, ready: true, artifact: true, localReferences: [link.path], ...extra });
  assert.equal(matchLocalArtifact(link, 'paige', [file('a')]).attachment.id, 'a');
  assert.equal(matchLocalArtifact(link, 'paige', [file('a', { botId: 'jim' })]).state, 'unregistered');
  assert.equal(matchLocalArtifact(link, 'paige', [file('a', { localReferences: ['/elsewhere/BASELINE_REVIEW.txt'] })]).state, 'unregistered', 'basename alone never matches');
  assert.equal(matchLocalArtifact(link, 'paige', [file('a', { ready: false })]).state, 'unregistered');
  assert.equal(matchLocalArtifact(link, 'paige', [file('a', { artifact: false, direction: 'input' })]).state, 'unregistered');
  assert.equal(matchLocalArtifact(link, 'paige', [file('a'), file('b')]).state, 'ambiguous');
  const dated = matchLocalArtifact(link, 'paige', [file('a', { createdAt: '2026-10-13T00:00:00Z' }), file('b', { createdAt: '2026-10-14T00:00:00Z' })]);
  assert.equal(dated.attachment.id, 'b'); assert.equal(dated.versions, 2);
  assert.equal(matchLocalArtifact(link, 'paige', []).state, 'unregistered');
});

test('link destinations inside code examples stay literal for card de-duplication', () => {
  const text = 'See [report](/home/dawar/bots/paige/outputs/r.txt).\n\n```md\n[x](/home/dawar/bots/paige/outputs/hidden.txt)\n```\nand `[y](/tmp/inline.txt)` plus [z](<file:///tmp/a b.txt>)';
  assert.deepEqual(markdownLinkDestinations(text), ['/home/dawar/bots/paige/outputs/r.txt', 'file:///tmp/a b.txt']);
});

test('viewer classification uses precise names and MIME types and keeps existing viewers', () => {
  const kind = (name, mimeType = 'application/octet-stream') => filePreviewKind({ name, mimeType })?.kind ?? null;
  const language = (name) => filePreviewKind({ name, mimeType: '' })?.language;
  assert.equal(kind('BASELINE_REVIEW.txt', 'text/plain'), 'text');
  assert.equal(kind('receipt.json', 'application/json'), 'json');
  assert.equal(kind('x', 'application/ld+json'), 'json');
  assert.equal(kind('data.csv', 'text/csv'), 'csv'); assert.equal(kind('data.tsv'), 'tsv'); assert.equal(kind('server.log', 'text/plain'), 'log');
  for (const [name, lang] of [['a.yaml', 'yaml'], ['a.yml', 'yaml'], ['a.toml', 'toml'], ['a.ini', 'ini'], ['a.xml', 'xml'], ['a.js', 'js'], ['a.ts', 'ts'], ['a.tsx', 'ts'], ['a.py', 'py'], ['a.css', 'css'], ['a.sql', 'sql'], ['a.sh', 'sh']])
    assert.equal(language(name), lang, name);
  assert.equal(kind('song.mp3', 'audio/mpeg'), 'audio'); assert.equal(kind('take.wav'), 'audio'); assert.equal(kind('clip.mp4', 'video/mp4'), 'video'); assert.equal(kind('clip.webm'), 'video');
  // Existing image/PDF/HTML/Markdown viewers and conflicting explicit types are unchanged.
  for (const [name, mime] of [['a.png', 'image/png'], ['a.pdf', 'application/pdf'], ['a.html', 'text/html'], ['a.md', 'text/markdown'], ['a.txt', 'image/png'],
    ['a.mp3', 'text/plain'], ['a.json', 'video/mp4'], ['a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['a.bin', 'application/octet-stream']])
    assert.equal(kind(name, mime), null, name);
});

test('text decoding is strict and bounded; Unicode and long lines are preserved for display', () => {
  const encoder = new TextEncoder();
  assert.deepEqual(decodePreviewText(encoder.encode('héllo 👋\n\ttabs  kept\n')), { status: 'ok', text: 'héllo 👋\n\ttabs  kept\n' });
  assert.equal(decodePreviewText(new Uint8Array([0xff, 0xfe, 0x00])).status, 'encoding');
  assert.equal(decodePreviewText(encoder.encode('a\0b')).status, 'binary');
  assert.equal(decodePreviewText(new Uint8Array(TEXT_PREVIEW_LIMITS.bytes + 1)).status, 'large');
  assert.deepEqual(decodePreviewText(new Uint8Array()), { status: 'ok', text: '' });
  const long = previewLines(`${'x'.repeat(TEXT_PREVIEW_LIMITS.lineChars + 5)}\nb\r\nc`);
  assert.equal(long.lines.length, 3); assert.equal(long.clippedLines, 1); assert.equal(long.lines[0].length, TEXT_PREVIEW_LIMITS.lineChars);
  const many = previewLines('l\n'.repeat(TEXT_PREVIEW_LIMITS.lines + 10));
  assert.equal(many.lines.length, TEXT_PREVIEW_LIMITS.lines); assert.equal(many.hiddenLines, 10);
  // Paige-shaped 5651-byte text fixture: decoded exactly, original bytes untouched.
  let body = ''; for (let i = 0; encoder.encode(`${body}Line ${i}: baseline review — “quoted” <b>not html</b>\n`).byteLength < 5651; i++) body += `Line ${i}: baseline review — “quoted” <b>not html</b>\n`;
  const fixture = encoder.encode(body + '.'.repeat(5651 - encoder.encode(body).byteLength));
  const before = sha(fixture); assert.equal(fixture.byteLength, 5651);
  assert.equal(decodePreviewText(fixture).text, new TextDecoder().decode(fixture)); assert.equal(sha(fixture), before);
});

test('log search is case-insensitive and bounded', () => {
  const lines = ['INFO start', 'error: disk', 'warn', 'ERROR again'];
  assert.deepEqual(searchLines(lines, 'error'), { matches: [1, 3], clipped: false });
  assert.deepEqual(searchLines(lines, ''), { matches: [], clipped: false });
  assert.deepEqual(searchLines(Array(5).fill('x'), 'x', 3), { matches: [0, 1, 2], clipped: true });
});

test('CSV/TSV parsing handles quoting, multiline values, ragged rows and formula-looking cells as data', () => {
  const csv = parseDelimited('name,note,total\r\n"Doe, Jane","said ""hi""\nthen left",=SUM(A1:A9)\nshort\n"",+1,-2,@cmd\n');
  assert.deepEqual(csv.rows, [['name', 'note', 'total'], ['Doe, Jane', 'said "hi"\nthen left', '=SUM(A1:A9)'], ['short'], ['', '+1', '-2', '@cmd']]);
  assert.equal(csv.columns, 4); assert.equal(csv.ragged, true); assert.equal(csv.unterminated, false); assert.equal(csv.hiddenRows, false);
  assert.deepEqual(parseDelimited('a\tb\n1\t"2\t3"').rows, [['a\tb'], ['1\t"2\t3"']], 'comma parser leaves tabs literal');
  assert.deepEqual(parseDelimited('a\tb\n1\t"2\t3"', '\t').rows, [['a', 'b'], ['1', '2\t3']]);
  assert.equal(parseDelimited('a,"open\nnever closed').unterminated, true);
  assert.deepEqual(parseDelimited('').rows, []);
  const big = parseDelimited('x\n'.repeat(TEXT_PREVIEW_LIMITS.tableRows + 3));
  assert.equal(big.rows.length, TEXT_PREVIEW_LIMITS.tableRows); assert.equal(big.hiddenRows, true);
  const wide = parseDelimited(Array(TEXT_PREVIEW_LIMITS.tableColumns + 4).fill('c').join(','));
  assert.equal(wide.columns, TEXT_PREVIEW_LIMITS.tableColumns); assert.equal(wide.hiddenColumns, 4);
});

test('JSON formatting keeps exact number/string spelling; invalid JSON reports a positioned error', () => {
  const raw = '{"big":12345678901234567890,"float":1.0,"exp":1E+2,"neg":-0,"s":"\\u00e9\\n","nested":{"a":[],"b":{}},"list":[true,false,null]}';
  const { formatted } = formatJson(raw);
  assert.equal(formatted, '{\n  "big": 12345678901234567890,\n  "float": 1.0,\n  "exp": 1E+2,\n  "neg": -0,\n  "s": "\\u00e9\\n",\n  "nested": {\n    "a": [],\n    "b": {}\n  },\n  "list": [\n    true,\n    false,\n    null\n  ]\n}');
  assert.deepEqual(JSON.parse(formatted), JSON.parse(raw));
  assert.equal(formatJson(' 42 ').formatted, '42');
  for (const [bad, message] of [['{"a":1,}', /line 1, column 8/], ['{"a" 1}', /Expected ":"/], ['[1 2]', /Expected "," or "\]"/], ['{"a":', /Unexpected end/], ['{} x', /after JSON/], ["{'a':1}", /property name/], ['', /Unexpected end/], ['{"a":01}', /Expected/]])
    assert.match(formatJson(bad).error, message, bad);
  assert.match(formatJson('['.repeat(TEXT_PREVIEW_LIMITS.jsonDepth + 2)).error, /too deep/);
  // Paige-shaped 16 KiB receipt fixture formats without changing values.
  const receipt = JSON.stringify({ version: 1, items: Array.from({ length: 380 }, (_, i) => ({ id: `item-${i}`, ok: i % 2 === 0, at: 1760400000.125 + i })) });
  assert.ok(receipt.length > 16 * 1024 - 1024);
  assert.deepEqual(JSON.parse(formatJson(receipt).formatted), JSON.parse(receipt));
});

test('syntax highlighting is lexical, lossless and bounded; unknown languages stay plain', () => {
  const samples = {
    js: 'const a = "x"; // note\n/* block\n */ let n = 0x1F + 2n; `tpl ${a}`',
    ts: 'interface A { b: string }\nexport type C = A;',
    py: 'def f(x):\n    """doc\n    string"""\n    return x  # comment\n@decorator\nclass B: pass',
    css: '.a { color: #fff; margin: 0 2px; } @media (max-width: 1px) {}',
    sql: "SELECT name FROM users WHERE note = 'it''s' -- trailing\n/* c */",
    sh: 'echo "$HOME" ${PATH} # comment\nif [ -f x ]; then exit 1; fi',
    yaml: '---\nkey: value # c\nlist:\n  - &anchor "q"\n  - true',
    toml: '[server]\nport = 8080\nname = "x" # c\nwhen = 2026-10-14T19:00:00Z',
    ini: '; comment\n[section]\nkey = value',
    xml: '<?xml version="1.0"?>\n<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>\n<a href="&e;"><!-- c --><![CDATA[<b>]]></a>',
    json: '{"k": [1, "v", true]}',
  };
  for (const [language, text] of Object.entries(samples)) {
    const tokens = highlightTokens(text, language);
    assert.equal(tokens.map(([, value]) => value).join(''), text, language);
    assert.ok(tokens.some(([type]) => type !== 'plain'), language);
    assert.equal(tokenLines(tokens).length, text.split('\n').length, language);
  }
  // CRLF files: a line comment ending in \r must not split one line break into two.
  for (const [language, text] of [['js', '// header\r\nconst a = 1;\r\nconst b = 2;\r\n'], ['py', '# header\r\na = 1\r\nb = 2'], ['sql', '-- c\r\nselect 1']]) {
    const rendered = tokenLines(highlightTokens(text, language)).map(line => line.map(([, value]) => value).join(''));
    assert.deepEqual(rendered, previewLines(text).lines, language);
  }
  assert.ok(highlightTokens('SELECT 1', 'sql').some(([type, value]) => type === 'keyword' && value === 'SELECT'));
  assert.ok(highlightTokens('select 1', 'sql').some(([type, value]) => type === 'keyword' && value === 'select'));
  assert.deepEqual(highlightTokens('plain words', 'cobol'), [['plain', 'plain words']]);
  const huge = 'a'.repeat(TEXT_PREVIEW_LIMITS.highlightBytes + 1);
  assert.deepEqual(highlightTokens(huge, 'js'), [['plain', huge]]);
});

test('viewer source renders text as inert nodes, never autoplays, and keeps the original Download', () => {
  const preview = readFileSync(new URL('../app/bots/file-preview.tsx', import.meta.url), 'utf8');
  const viewer = readFileSync(new URL('../app/bots/artifact-viewer.tsx', import.meta.url), 'utf8');
  const message = readFileSync(new URL('../app/bots/message.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(preview, /dangerouslySetInnerHTML|innerHTML|autoPlay|eval\(|new Function|fetch\(/);
  assert.match(preview, /preload="metadata"/);
  assert.match(preview, /media\.pause\(\); media\.removeAttribute\("src"\)/);
  assert.match(viewer, /saveArtifact\(blob\.current, item\.name\)/);
  assert.match(viewer, /<FilePreview file=\{loadedFile\} url=\{url\} viewer=\{viewer\}/);
  assert.match(message, /<LocalFileLink botId=\{botId\} link=\{local\}/);
  assert.match(message, /bot-local-file:\$\{encodeURIComponent\(url\)\}/);
});
