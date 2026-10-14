const folders: Record<string, string> = { cMapUrl:"cmaps",standardFontDataUrl:"standard_fonts",wasmUrl:"wasm" };
export class PdfBinaryDataFactory {
  async fetch({ kind,filename }: { kind:string;filename:string }) {
    const folder=folders[kind];
    if(!folder || !/^[A-Za-z0-9_.-]{1,180}$/.test(filename) || filename.startsWith(".")) throw Error("This PDF requested an unavailable rendering resource.");
    const response=await window.fetch(`/portable-assets/pdf/${folder}/${encodeURIComponent(filename)}`,{redirect:"error"});
    if(!response.ok)throw Error("A PDF rendering resource could not load. Reopen the review to retry.");
    return new Uint8Array(await response.arrayBuffer());
  }
}
