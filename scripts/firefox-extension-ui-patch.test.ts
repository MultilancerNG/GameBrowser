import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { readExtensionXpi } from '../workspace/extensionArchive';
import { patchFirefoxExtensionUi } from './firefox-extension-ui-patch';

const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const sourceRoot = fileURLToPath(new URL('../patches/firefox-extension-ui/', import.meta.url));
const actorNames = ['JugglerFrameChild.sys.mjs'];
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function archive(files: Array<{ name: string; bytes: Buffer }>, optimized = false, descriptor = false): Buffer {
  const crc = (bytes: Buffer) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
  const local: Buffer[] = [], central: Buffer[] = [];
  const centralSize = files.reduce((total, file) => total + 46 + Buffer.byteLength(file.name), 0);
  let offset = optimized ? 4 + centralSize + 22 : 0;
  for (const file of files) {
    const name = Buffer.from(file.name), payload = deflateRawSync(file.bytes), checksum = crc(file.bytes), flags = descriptor ? 8 : 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(name.length, 26);
    if (!descriptor) { header.writeUInt32LE(checksum, 14); header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(file.bytes.length, 22); }
    const tail = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor) { tail.writeUInt32LE(0x08074b50); tail.writeUInt32LE(checksum, 4); tail.writeUInt32LE(payload.length, 8); tail.writeUInt32LE(file.bytes.length, 12); }
    local.push(header, name, payload, tail);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(payload.length, 20); entry.writeUInt32LE(file.bytes.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + payload.length + tail.length;
  }
  const body = Buffer.concat(local), table = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(optimized ? 4 : body.length, 16);
  const preload = Buffer.alloc(4); preload.writeUInt32LE(offset);
  return optimized ? Buffer.concat([preload, table, end, body, end]) : Buffer.concat([body, table, end]);
}
async function fixture(optimized = false, descriptor = false, jar = false) {
  const root = await mkdtemp(join(tmpdir(), 'stakemode-actor-test-'));
  const prefix = 'modules/juggler/';
  const files = await Promise.all(actorNames.map(async (name) => ({ name: prefix + name, bytes: await readFile(join(sourceRoot, 'original', name)) })));
  files.push({ name: 'unrelated/resource.bin', bytes: Buffer.from([0, 1, 2, 255, 128]) });
  const directory = jar ? join(root, 'chrome') : root; await mkdir(directory, { recursive: true });
  const path = join(directory, jar ? 'juggler.jar' : 'omni.ja');
  const bytes = archive(files, optimized, descriptor); await writeFile(path, bytes);
  await writeFile(join(root, 'aliasmode.exe'), 'pinned-native-binary');
  return { root, path, files, bytes, cleanup: () => rm(root, { recursive: true, force: true }) };
}
for (const [label, optimized, descriptor, jar] of [['standard', false, false, false], ['optimized Gecko', true, false, false], ['descriptor', false, true, false]] as const) {
  test(`patches ${label} actors while preserving all other content and the native executable`, async () => {
    const f = await fixture(optimized, descriptor, jar);
    try {
      const metadata = await patchFirefoxExtensionUi(f.root, python);
      expect(metadata.patchId).toBe('gamebrowser-firefox-extension-ui-v1');
      expect(metadata.archives).toHaveLength(1);
      expect(metadata.archives[0]!.beforeSha256).toBe(hash(f.bytes));
      expect(metadata.archives[0]!.afterSha256).toBe(hash(await readFile(f.path)));
      const updated = readExtensionXpi(await readFile(f.path));
      for (const file of updated) {
        const name = file.name.split('/').at(-1)!;
        expect(file.bytes).toEqual(actorNames.includes(name) ? await readFile(join(sourceRoot, 'modified', name)) : f.files.find((entry) => entry.name === file.name)!.bytes);
      }
      expect(await readFile(join(f.root, 'aliasmode.exe'), 'utf8')).toBe('pinned-native-binary');
      await expect(patchFirefoxExtensionUi(f.root, python)).rejects.toThrow('pinned upstream');
    } finally { await f.cleanup(); }
  });
}
test('output is deterministic across identical original archives', async () => {
  const a = await fixture(true), b = await fixture(true);
  try { expect(await patchFirefoxExtensionUi(a.root, python)).toEqual(await patchFirefoxExtensionUi(b.root, python)); expect(await readFile(a.path)).toEqual(await readFile(b.path)); } finally { await a.cleanup(); await b.cleanup(); }
});
test('unknown actor bytes or an absent copy reject before changing either archive', async () => {
  const f = await fixture();
  try {
    f.files[0]!.bytes = Buffer.from('unexpected replacement');
    const bytes = archive(f.files); await writeFile(f.path, bytes);
    await expect(patchFirefoxExtensionUi(f.root, python)).rejects.toThrow('pinned upstream');
    expect((await readFile(f.path)).equals(bytes)).toBe(true);
    await writeFile(f.path, archive(f.files.filter(file => !file.name.endsWith('JugglerFrameChild.sys.mjs'))));
    const missing = await readFile(f.path);
    await expect(patchFirefoxExtensionUi(f.root, python)).rejects.toThrow('the pinned actor');
    expect(await readFile(f.path)).toEqual(missing);
  } finally { await f.cleanup(); }
});
test('duplicate actor installations and unsafe traversal names reject without modification', async () => {
  const f = await fixture();
  try {
    const second = join(f.root, 'browser'); await mkdir(second); await writeFile(join(second, 'omni.ja'), f.bytes);
    await expect(patchFirefoxExtensionUi(f.root, python)).rejects.toThrow('ambiguous');
    expect((await readFile(f.path)).equals(f.bytes)).toBe(true);
    await rm(second, { recursive: true });
    await writeFile(f.path, archive([...f.files, { name: '../escape', bytes: Buffer.from('no') }]));
    await expect(patchFirefoxExtensionUi(f.root, python)).rejects.toThrow('unsafe archive');
  } finally { await f.cleanup(); }
});
