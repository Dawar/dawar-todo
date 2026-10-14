/** Display directives inside Markdown examples remain ordinary source text. */
export function markdownLiteralRanges(text) {
  const ranges = []; let fence = null, quote = false;
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(start, end), mark = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
    if (fence) {
      ranges.push({ start, end });
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
    } else if (mark) { fence = mark[1]; ranges.push({ start, end }); }
    else if (/^ {0,3}>/.test(line)) { quote = true; ranges.push({ start, end }); }
    else if (quote && line.trim()) ranges.push({ start, end });
    else { quote = false; if (/^(?: {4}|\t)/.test(line)) ranges.push({ start, end }); }
    start = end;
  }
  let range = 0;
  for (let i = 0; i < text.length;) {
    while (ranges[range] && ranges[range].end <= i) range++;
    if (ranges[range] && i >= ranges[range].start) { i = ranges[range].end; continue; }
    if (text[i] !== '`') { i++; continue; }
    let size = 1; while (text[i + size] === '`') size++;
    const run = '`'.repeat(size); let close = text.indexOf(run, i + size);
    while (close >= 0 && (text[close - 1] === '`' || text[close + size] === '`')) close = text.indexOf(run, close + size);
    if (close < 0) { i += size; continue; }
    ranges.push({ start: i, end: close + size }); i = close + size;
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const next of ranges) {
    const last = merged.at(-1);
    if (last && next.start <= last.end) last.end = Math.max(last.end, next.end);
    else merged.push({ ...next });
  }
  return merged;
}
