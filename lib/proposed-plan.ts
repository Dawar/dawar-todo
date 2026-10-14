/** Display ranges in the original message; source text and native identities stay intact. */
export type ProposedPlanPart = {
  kind: "text" | "plan";
  start: number;
  end: number;
  key: number;
};

const opening = "<proposed_plan>", closing = "</proposed_plan>";

/** Recognize Codex's standalone opener, excluding Markdown examples. */
export function proposedPlanParts(text: string, partial = false): ProposedPlanPart[] {
  if (!text.includes(opening)) {
    const tail = text.lastIndexOf("<");
    if (!partial || tail < 0 || !opening.startsWith(text.slice(tail))) {
      return text ? [{ kind: "text", start: 0, end: text.length, key: 0 }] : [];
    }
  }
  const lines: { start: number; end: number; protected: boolean }[] = [];
  const ticks: { start: number; end: number; paragraph: number; next?: number }[] = [];
  let paragraph = 0;
  let fence: { character: string; length: number } | null = null;
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start), end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, end);
    const quoted = /^ {0,3}(?:>|(?:[-+*]|\d+[.)])\s+>)/.test(line);
    const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
    const protectedLine = quoted || Boolean(fence) || /^(?: {4}|\t)/.test(line) || Boolean(marker);
    if (!quoted && fence) {
      if (marker?.[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (!quoted && marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = { character: marker[1][0], length: marker[1].length };
    }
    lines.push({ start, end, protected: protectedLine });
    if (protectedLine || !line.trim()) paragraph++;
    if (!protectedLine) {
      for (const match of line.matchAll(/`+/g)) {
        ticks.push({ start: start + match.index, end: start + match.index + match[0].length, paragraph });
      }
    }
    start = end;
  }
  // Pair equal-length backtick runs in linear time, including multiline spans.
  const nextTick = new Map<string, number>();
  for (let i = ticks.length - 1; i >= 0; i--) {
    const tick = ticks[i], key = `${tick.paragraph}:${tick.end - tick.start}`;
    tick.next = nextTick.get(key);
    nextTick.set(key, i);
  }
  const code: { start: number; end: number }[] = [];
  for (let i = 0; i < ticks.length; i++) {
    const next = ticks[i].next;
    if (next !== undefined) {
      code.push({ start: ticks[i].start, end: ticks[next].end });
      i = next;
    }
  }
  const plans: { start: number; end: number; bodyStart: number; bodyEnd: number }[] = [];
  let pending: { start: number; bodyStart: number; nested: boolean } | null = null;
  let lineIndex = 0, codeIndex = 0;
  function eligible(position: number) {
    while (lineIndex + 1 < lines.length && lines[lineIndex].end <= position) lineIndex++;
    while (codeIndex < code.length && code[codeIndex].end <= position) codeIndex++;
    if (lines[lineIndex]?.protected || code[codeIndex] && code[codeIndex].start <= position) return false;
    let escapes = 0;
    for (let i = position - 1; i >= 0 && text[i] === "\\"; i--) escapes++;
    return escapes % 2 === 0;
  }
  for (const match of text.matchAll(/<\/?proposed_plan>/g)) {
    const start = match.index;
    if (!eligible(start)) continue;
    if (match[0] === opening) {
      // Inline mentions are examples, not a native plan boundary.
      const line = lines[lineIndex];
      if (text.slice(line.start, start).trim() || text.slice(start + opening.length, line.end).trim()) continue;
      if (pending) pending.nested = true;
      else pending = { start, bodyStart: start + opening.length, nested: false };
    } else if (pending) {
      if (!pending.nested) plans.push({ start: pending.start, end: start + closing.length, bodyStart: pending.bodyStart, bodyEnd: start });
      pending = null;
    }
  }
  let heldStart = text.length;
  if (partial) {
    const start = text.lastIndexOf("<"), tail = text.slice(start);
    if (start >= 0 && eligible(start) && tail !== opening && tail !== closing &&
        (pending ? closing.startsWith(tail) : opening.startsWith(tail))) {
      const line = lines[lineIndex];
      if (pending || !text.slice(line.start, start).trim()) heldStart = start;
    }
    if (pending && !pending.nested) {
      plans.push({ start: pending.start, end: text.length, bodyStart: pending.bodyStart, bodyEnd: heldStart });
      heldStart = text.length;
    }
  }
  const parts: ProposedPlanPart[] = [];
  let cursor = 0;
  for (const plan of plans) {
    if (cursor < plan.start) parts.push({ kind: "text", start: cursor, end: plan.start, key: cursor });
    parts.push({ kind: "plan", start: plan.bodyStart, end: plan.bodyEnd, key: plan.start });
    cursor = plan.end;
  }
  if (cursor < heldStart) parts.push({ kind: "text", start: cursor, end: heldStart, key: cursor });
  return parts;
}
