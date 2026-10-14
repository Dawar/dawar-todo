import { markdownLiteralRanges } from './markdown-literals.mjs';

const marker = ':codex-followup[';
export type CodexFollowup = { start: number; end: number; label: string; prompt: string; href: string; displayStart: number; displayEnd: number };
const escapeLabel = (label: string) => label.replace(/[\\`*_[\]<>]/g, '\\$&');

function candidate(text: string, start: number) {
  const limit = Math.min(text.length, start + 16384);
  let i = start + marker.length, label = '';
  for (; i < limit && text[i] !== ']'; i++) {
    if (text[i] === '\n' || text[i] === '\r' || label.length > 160) return null;
    if (text[i] === '\\' && /[\\\[\]]/.test(text[i + 1] ?? '')) i++;
    label += text[i];
  }
  label = label.trim();
  if (!label || label.length > 160 || /[\x00-\x1f\x7f]/.test(label) || text[i] !== ']') return null;
  i++; while (i < limit && /\s/.test(text[i])) i++;
  if (text[i++] !== '{') return null;
  const bodyStart = i; let quote = false, escape = false;
  for (; i < limit; i++) {
    const char = text[i];
    if (escape) { escape = false; continue; }
    if (quote && char === '\\') { escape = true; continue; }
    if (char === '"') { quote = !quote; continue; }
    if (char !== '}' || quote) continue;
    const field = /^\s*prompt\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(text.slice(bodyStart, i));
    if (!field) return null;
    try {
      const prompt: unknown = JSON.parse(field[1].replace(/\r\n|\r|\n/g, '\\n'));
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) return null;
      return { start, end: i + 1, label, prompt };
    } catch { return null; }
  }
  return null;
}

/** Pure message projection: only generated link positions may become controls. */
export function codexFollowupProjection(text: string): { text: string; references: CodexFollowup[] } {
  if (!text.includes(marker)) return { text, references: [] };
  const literals = markdownLiteralRanges(text), references: CodexFollowup[] = [];
  let offset = 0, output = '', range = 0, attempts = 0;
  for (let i = 0; i < text.length && references.length < 32 && attempts < 256;) {
    while (literals[range] && literals[range].end <= i) range++;
    if (literals[range] && i >= literals[range].start) { i = literals[range].end; continue; }
    if (!text.startsWith(marker, i)) { i++; continue; }
    attempts++;
    const ref = candidate(text, i);
    if (!ref || literals.some(part => part.start < ref.end && part.end > ref.start)) { i++; continue; }
    output += text.slice(offset, ref.start);
    const href = `bot-followup:${ref.start}`, displayStart = output.length;
    const link = `[${escapeLabel(ref.label)}](${href})`;
    output += link;
    references.push({ ...ref, href, displayStart, displayEnd: output.length });
    offset = ref.end; i = ref.end;
  }
  return { text: output + text.slice(offset), references };
}
