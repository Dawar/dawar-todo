// Shared file classification; no paths, credentials or execution records.
const extensions = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm' };
export function artifactMime(name, mime) {
  return typeof mime === 'string' && mime !== 'application/octet-stream' && /^[\w.+-]+\/[\w.+-]+$/.test(mime)
    ? mime.toLowerCase() : extensions[String(name).split('.').at(-1).toLowerCase()] ?? 'application/octet-stream';
}
export function artifactKind(name, mime) {
  mime = artifactMime(name, mime);
  if (mime === 'application/pdf') return 'pdf';
  for (const kind of ['image', 'audio', 'video']) if (mime.startsWith(`${kind}/`)) return kind;
  return mime.startsWith('text/') || /json|officedocument|msword|opendocument|rtf/.test(mime) ? 'document' : 'other';
}
