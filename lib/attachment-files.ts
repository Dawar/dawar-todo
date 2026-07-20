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
