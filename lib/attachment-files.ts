export const FILE_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  zip: "application/zip",
  "7z": "application/x-7z-compressed",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  rtf: "application/rtf",
  ics: "text/calendar",
};

export const GENERIC_FILE_ACCEPT = Object.keys(FILE_MIME_BY_EXTENSION).map((extension) => `.${extension}`).join(",");

export function attachmentFileExtension(fileName: string) {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (!FILE_MIME_BY_EXTENSION[extension]) {
    throw new Error("Choose a PDF, Office document, text file, calendar file, ZIP, or 7z archive.");
  }
  return extension;
}

export function attachmentFileMimeType(fileName: string, suppliedValue = "") {
  const extension = attachmentFileExtension(fileName);
  const canonical = FILE_MIME_BY_EXTENSION[extension];
  const supplied = suppliedValue.toLowerCase().split(";", 1)[0].trim();
  const aliases = new Set([
    canonical,
    "application/octet-stream",
    ...(extension === "zip" ? ["application/x-zip-compressed"] : []),
    ...(["docx", "xlsx", "pptx", "odt", "ods", "odp"].includes(extension) ? ["application/zip", "application/x-zip-compressed"] : []),
    ...(extension === "csv" ? ["application/csv", "text/plain"] : []),
    ...(extension === "rtf" ? ["text/rtf"] : []),
    ...(extension === "md" || extension === "ics" ? ["text/plain"] : []),
  ]);
  if (supplied && !aliases.has(supplied)) throw new Error("The file extension and content type do not match.");
  return canonical;
}

export function detectAttachmentFileFormat(bytes: Uint8Array) {
  const pdfHeader = [0x25, 0x50, 0x44, 0x46, 0x2d];
  const pdfSearchLimit = Math.min(bytes.length - pdfHeader.length, 1024);
  for (let offset = 0; offset <= pdfSearchLimit; offset += 1) {
    if (pdfHeader.every((byte, index) => bytes[offset + index] === byte)) return "pdf";
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]) && [0x04, 0x06, 0x08].includes(bytes[3])) return "zip";
  if (bytes.length >= 8 && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte)) return "compound";
  if (bytes.length >= 6 && [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c].every((byte, index) => bytes[index] === byte)) return "7z";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 128)).replace(/^\uFEFF/, "").trimStart();
  if (/^\{\\rtf/i.test(text)) return "rtf";
  if (!bytes.slice(0, Math.min(bytes.length, 4096)).includes(0)) return "text";
  return null;
}
