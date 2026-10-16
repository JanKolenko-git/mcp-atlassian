// A local file as an upload. The server process reads it from the user's own disk, so only an
// absolute path to a regular file, and only up to a size the product would accept anyway.
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import type { Upload } from './http.ts';
import type { Product } from './registry.ts';
import { formatSize } from './text.ts';

// The products' own defaults: jira.attachment.size and Confluence's attachment limit.
const DEFAULT_MAX_MB: Record<Product, number> = { Jira: 10, Confluence: 100 };

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  har: 'application/json', xml: 'application/xml', html: 'text/html', patch: 'text/x-diff', diff: 'text/x-diff',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime',
};

export function uploadCapMb(product: Product): number {
  const configured = Number(process.env[`${product.toUpperCase()}_MAX_UPLOAD_MB`]);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_MB[product];
}

export async function readUpload(path: string, product: Product): Promise<Upload> {
  if (!isAbsolute(path)) throw new Error(`'${path}' is not an absolute path. Pass the full path of the file to upload.`);
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error(`cannot read '${path}': no such file.`);
  if (!info.isFile()) throw new Error(`'${path}' is not a file.`);
  const cap = uploadCapMb(product);
  if (info.size > cap * 1024 * 1024) {
    throw new Error(
      `'${path}' is ${formatSize(info.size)}, over the ${cap} MB upload cap. ` +
        `${product.toUpperCase()}_MAX_UPLOAD_MB raises the cap, within what ${product} itself accepts.`,
    );
  }
  return { name: basename(path), bytes: await readFile(path), mimeType: MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream' };
}
