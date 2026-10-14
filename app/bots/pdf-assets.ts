// Resolve only packaged PDF.js resources. PDF-provided filenames cannot fetch
// arbitrary origins; font/decoder assets stay on the application's own host.
const resources = import.meta.glob<string>("../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*.{bcmap,pfb,ttf,wasm,js}", { query: "?url", import: "default", eager: true });
const folders: Record<string, string> = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts", wasmUrl: "wasm" };
export class PdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const folder = folders[kind];
    const url = folder && resources[`../../node_modules/pdfjs-dist/${folder}/${filename}`];
    if (!url) throw Error("This PDF requested an unavailable rendering resource.");
    const response = await window.fetch(url, { redirect: "error" });
    if (!response.ok) throw Error("A PDF rendering resource could not load. Reopen the review to retry.");
    return new Uint8Array(await response.arrayBuffer());
  }
}
