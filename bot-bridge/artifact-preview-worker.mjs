// A disposable subprocess bounds decoder CPU/lifetime and keeps malformed
// images away from the bridge event loop. Input is an already authorized fd.
import { readSync } from 'node:fs';
import sharp from 'sharp';
sharp.cache(false);
sharp.concurrency(1);
const chunks = []; let size = 0;
for (;;) {
  const part = Buffer.alloc(256 * 1024), count = readSync(3, part);
  if (!count) break;
  size += count;
  if (size > 20 * 1024 * 1024) throw new Error('Preview input is too large.');
  chunks.push(part.subarray(0, count));
}
const bytes = Buffer.concat(chunks);
const options = { limitInputPixels: 32_000_000, failOn: 'error', pages: 1 };
const metadata = await sharp(bytes, options).metadata();
// In particular, do not decode SVG documents with external resource references.
if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'heif', 'tiff'].includes(metadata.format)) throw new Error('Unsupported preview format.');
const { data, info } = await sharp(bytes, options).rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
  .webp({ quality: 65, effort: 2 }).toBuffer({ resolveWithObject: true });
if (data.length > 128 * 1024) throw new Error('Preview output is too large.');
process.stdout.write(JSON.stringify({ data: data.toString('base64'), width: info.width, height: info.height }));
