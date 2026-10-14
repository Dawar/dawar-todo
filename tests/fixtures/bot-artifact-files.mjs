export function syntheticArtifactPdf() {
  // Two colored pages, no external resources or private fixture content.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 26 >>\nstream\n1 0 0 rg 0 0 600 800 re f\nendstream',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> /Contents 6 0 R >>',
    '<< /Length 26 >>\nstream\n0 0 1 rg 0 0 600 800 re f\nendstream',
  ];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(body);
  body += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}
