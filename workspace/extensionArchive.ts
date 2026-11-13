/** Bounded local extension snapshots. Does not execute extension code. */
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const EXTENSION_LIMITS = Object.freeze({ archiveBytes: 64 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, manifestBytes: 1024 * 1024, files: 4096, depth: 20, library: 128, assignmentsPerProfile: 32 });
export interface ExtensionFile { name: string; bytes: Buffer; }
async function validateSourcePath(path: string): Promise<void> {
  const canonical = await realpath(path), absolute = resolve(path);
  if (process.platform !== 'win32') {
    // Preserve the strict POSIX spelling rule, including linked parent paths.
    if (canonical !== absolute) throw new Error('Extension source path must not traverse symbolic links');
    return;
  }
  // Windows expands legitimate 8.3 names (e.g. RUNNER~1) in realpath(). A text
  // comparison cannot distinguish those aliases from junction traversal. Walk
  // every supplied component with lstat, then prove that both spellings refer
  // to the same filesystem object. No symbolic link or junction is accepted.
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  let cursor = root;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) cursor = join(cursor, parts[index]!);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new Error('Extension source path must not traverse symbolic links or junctions');
  }
  const supplied = await lstat(absolute), resolved = await lstat(canonical);
  if (supplied.isSymbolicLink() || resolved.isSymbolicLink() || supplied.dev !== resolved.dev || supplied.ino !== resolved.ino || supplied.isDirectory() !== resolved.isDirectory() || supplied.isFile() !== resolved.isFile()) throw new Error('Extension source path identity changed during validation');
}
export function extensionRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 220 || isAbsolute(value) || /[\\\u0000-\u001f\u007f:<>"|?*]/.test(value)) throw new Error('Extension contains an unsafe file path');
  const parts = value.split('/');
  if (parts.length > EXTENSION_LIMITS.depth || parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Extension contains an unsafe file path');
  return parts.join('/');
}
export async function boundedLocalFile(path: string, maximum = EXTENSION_LIMITS.fileBytes): Promise<Buffer> {
  await validateSourcePath(path);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new Error('Extension file is unsupported or exceeds its size limit');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size || current.size > maximum) throw new Error('Extension source changed during import');
    const bytes = Buffer.alloc(current.size);
    let position = 0;
    while (position < bytes.length) { const result = await handle.read(bytes, position, bytes.length - position, position); if (!result.bytesRead) throw new Error('Extension file is truncated'); position += result.bytesRead; }
    const after = await handle.stat();
    await validateSourcePath(path);
    const finalPath = await lstat(path);
    if (after.size !== current.size || after.mtimeMs !== current.mtimeMs || finalPath.isSymbolicLink() || finalPath.ino !== current.ino || finalPath.dev !== current.dev) throw new Error('Extension source changed during import');
    return bytes;
  } finally { await handle.close(); }
}
export async function readExtensionDirectory(root: string): Promise<ExtensionFile[]> {
  await validateSourcePath(root);
  const files: ExtensionFile[] = [];
  const names = new Set<string>();
  let expanded = 0;
  let directories = 0;
  async function visit(directory: string, prefix = ''): Promise<void> {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || ++directories > EXTENSION_LIMITS.files) throw new Error('Extension directories must not contain symbolic links or excessive entries');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = extensionRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const key = name.toLowerCase();
      if (names.has(key)) throw new Error('Extension contains colliding file names');
      names.add(key);
      const path = join(directory, entry.name), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Extension symbolic links are not supported');
      if (info.isDirectory()) await visit(path, name);
      else if (info.isFile()) {
        if (files.length >= EXTENSION_LIMITS.files || info.size > EXTENSION_LIMITS.fileBytes || expanded + info.size > EXTENSION_LIMITS.expandedBytes) throw new Error('Extension exceeds file count or expanded size limits');
        const bytes = await boundedLocalFile(path);
        expanded += bytes.length; files.push({ name, bytes });
      } else throw new Error('Extension contains an unsupported file type');
    }
    const after = await lstat(directory);
    if (after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev) throw new Error('Extension source changed during import');
  }
  await visit(root);
  await validateSourcePath(root);
  return files;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => { let result = value; for (let bit = 0; bit < 8; bit++) result = (result & 1) ? 0xedb88320 ^ (result >>> 1) : result >>> 1; return result >>> 0; });
function crc32(bytes: Buffer): number { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
export function readExtensionXpi(bytes: Buffer): ExtensionFile[] {
  if (bytes.length > EXTENSION_LIMITS.archiveBytes || bytes.length < 22) throw new Error('Add-on archive exceeds its size limit or is invalid');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error('Add-on must be a valid XPI ZIP archive');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || !count || count > EXTENSION_LIMITS.files * 2 || centralStart + centralSize !== end) throw new Error('Unsupported add-on archive layout');
  const files: ExtensionFile[] = [], names = new Set<string>(), spans: Array<[number, number]> = [];
  let position = centralStart, expanded = 0;
  try {
    for (let index = 0; index < count; index++) {
      if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) throw new Error();
      const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10), checksum = bytes.readUInt32LE(position + 16);
      const compressed = bytes.readUInt32LE(position + 20), size = bytes.readUInt32LE(position + 24), length = bytes.readUInt16LE(position + 28), extra = bytes.readUInt16LE(position + 30), comment = bytes.readUInt16LE(position + 32);
      const external = bytes.readUInt32LE(position + 38), local = bytes.readUInt32LE(position + 42);
      const entryEnd = position + 46 + length + extra + comment;
      if (entryEnd > end || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(position + 34) || compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff || (external >>> 16 & 0o170000) === 0o120000) throw new Error();
      const rawName = bytes.subarray(position + 46, position + 46 + length);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
      const isDirectory = decoded.endsWith('/'), name = extensionRelativePath(isDirectory ? decoded.slice(0, -1) : decoded);
      if (names.has(name.toLowerCase())) throw new Error(); names.add(name.toLowerCase());
      if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw new Error();
      const localLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localLength + localExtra;
      if (localLength !== length || !bytes.subarray(local + 30, local + 30 + localLength).equals(rawName) || start + compressed > centralStart) throw new Error();
      if (size > EXTENSION_LIMITS.fileBytes || expanded + size > EXTENSION_LIMITS.expandedBytes || (compressed && size / compressed > 1000)) throw new Error();
      if (spans.some(([left, right]) => local < right && start + compressed > left)) throw new Error(); spans.push([local, start + compressed]);
      if (isDirectory) { if (size || compressed) throw new Error(); }
      else {
        if (files.length >= EXTENSION_LIMITS.files) throw new Error();
        const encoded = bytes.subarray(start, start + compressed);
        const decodedBytes = method === 0 ? Buffer.from(encoded) : inflateRawSync(encoded, { maxOutputLength: Math.min(size + 1, EXTENSION_LIMITS.fileBytes + 1) });
        if (decodedBytes.length !== size || crc32(decodedBytes) !== checksum) throw new Error();
        expanded += size; files.push({ name, bytes: decodedBytes });
      }
      position = entryEnd;
    }
    if (position !== end || !files.length) throw new Error();
  } catch { throw new Error('Add-on archive contains unsafe, corrupt, or oversized entries'); }
  return files;
}
export function extensionFilesDigest(files: ExtensionFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) hash.update(`${file.name}\0${file.bytes.length}\0${createHash('sha256').update(file.bytes).digest('hex')}\n`);
  return hash.digest('hex');
}
