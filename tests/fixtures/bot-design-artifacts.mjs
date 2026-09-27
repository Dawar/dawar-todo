// Fresh temporary native runtime and public synthetic files. Never connects to Codex/accounts.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { Store } from '../../bot-bridge/store.mjs';
import { BotRuntime } from '../../bot-bridge/runtime.mjs';
function documentPdf() {
  const stream = `0.99 0.99 0.97 rg 0 0 612 792 re f 0.22 0.38 0.28 rg 48 735 54 6 re f
BT /F1 28 Tf 48 650 Td (A considered plan) Tj /F1 12 Tf 0 -30 Td (A little clarity. A thoughtful next step.) Tj ET
0.91 0.94 0.88 rg 48 350 516 225 re f 0.4 0.55 0.42 RG 4 w 85 385 m 165 450 l 245 425 l 340 510 l 500 540 l S
0.83 0.87 0.8 rg 48 295 490 4 re f 48 275 490 4 re f 48 255 305 4 re f 48 215 490 4 re f 48 195 490 4 re f 48 175 330 4 re f`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = '%PDF-1.4\n', offsets = [0]; objects.forEach((value, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${value}\nendobj\n`; }); const xref = text.length;
  return Buffer.from(text + `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10,'0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
export async function designArtifacts() {
  const root = await mkdtemp(join(tmpdir(), 'bot-design-artifacts-')), store = new Store(join(root, 'state.sqlite'));
  const codex = new EventEmitter(); codex.call = async () => ({ data: [], nextCursor: null });
  const runtime = new BotRuntime({ store, codex, root }), calls = [];
  const botNames = ['Studio · Planning & ideas', 'Field notes'];
  for (const [i, id] of ['design-a', 'design-b'].entries()) {
    const cwd = join(root, id); await mkdir(cwd); store.saveBot({ id, slug: id, name: botNames[i], threadId: `thread-${id}`, cwd, color: i ? '#a98454' : '#3d8065', archived: false, updatedAt: '2026-09-27T00:00:00Z' });
  }
  const image = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#e4eadb"/><circle cx="600" cy="145" r="74" fill="#f8f1de"/><path d="M0 430Q170 230 390 390T800 330V600H0" fill="#a2b396"/><path d="M0 520Q210 330 460 500T800 430V600H0" fill="#63866c"/><path d="M530 600Q575 430 670 470" stroke="#e6eada" stroke-width="12" fill="none"/><text x="45" y="70" font-family="Arial" letter-spacing="4" font-size="18" fill="#58725b">FIELD NOTES / 026</text></svg>')).png().toBuffer();
  const pdf = documentPdf(), text = Buffer.from('A synthetic document. No user data.');
  for (let i = 0; i < 80; i++) {
    const botId = i % 4 ? 'design-a' : 'design-b', kind = i % 3, bytes = kind === 0 ? image : kind === 1 ? pdf : text;
    const name = ['Quiet morning.png', 'A considered plan.pdf', 'Launch story.md', 'Forest study.png', 'Weekly field notes.pdf', 'Creative brief.txt'][i % 6];
    const path = join(root, botId, `file-${i}`); await writeFile(path, bytes);
    store.put('attachment', { id: `file-${i}`, botId, name, mimeType: kind === 0 ? 'image/png' : kind === 1 ? 'application/pdf' : 'text/plain', size: bytes.length, path, ready: true,
      createdAt: i > 77 ? null : new Date(Date.UTC(2026, i < 8 ? 8 : i < 36 ? 7 : 6, 27 - i % 8)).toISOString(), artifact: Boolean(i % 4), provenance: { itemId: i === 1 ? 'tool-0' : `output-${i}`, turnId: 'design-turn' } });
  }
  return {
    calls,
    async handle(request) {
      const start = performance.now(); const result = await runtime.handle(request);
      calls.push({ method: request.method, botId: request.botId, ms: performance.now() - start, bytes: Buffer.byteLength(JSON.stringify(result)), mimeType: result?.mimeType, preview: result?.status, id: request.params?.id });
      return result;
    },
    async close() { store.close(); await rm(root, { recursive: true, force: true }); },
  };
}
