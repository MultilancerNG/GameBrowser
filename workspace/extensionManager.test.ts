import { describe, expect, test } from 'bun:test';
import { lstat, mkdtemp, mkdir, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, parse, relative, resolve, sep, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { ExtensionManager } from './extensionManager';
import { boundedLocalFile, EXTENSION_LIMITS, extensionRelativePath, readExtensionDirectory, readExtensionXpi } from './extensionArchive';

const chromeManifest = () => ({ manifest_version: 3, name: 'Local Marker', version: '1.0.0', permissions: ['storage', 'proxy'], host_permissions: ['https://*/*'], optional_host_permissions: ['*://*.optional.example/*'], background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' }, options_ui: { page: 'options.html' }, content_scripts: [{ matches: ['*://*/*'], js: ['marker.js'] }] });
const firefoxManifest = () => ({ manifest_version: 2, name: 'Local Firefox Marker', version: '1.0', permissions: ['storage', '*://*/*'], browser_specific_settings: { gecko: { id: 'marker@stakemode.local' } }, background: { scripts: ['background.js'] }, browser_action: { default_popup: 'popup.html' }, content_scripts: [{ matches: ['*://*/*'], js: ['marker.js'] }] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stakemode-extension-test-'));
  const profiles = new Map<string, 'chromium' | 'firefox'>([['chrome_1', 'chromium'], ['chrome_2', 'chromium'], ['firefox_1', 'firefox'], ['firefox_2', 'firefox']]);
  const running = new Set<string>();
  const options = { stateRoot: root, isProfileStopped: (id: string) => !running.has(id), getProfileEngine: (id: string) => profiles.get(id) };
  const manager = new ExtensionManager(options);
  const source = join(root, 'source'); await mkdir(source);
  const manifest = chromeManifest();
  for (const [name, value] of Object.entries({ 'manifest.json': JSON.stringify(manifest), 'background.js': 'globalThis.marker = true;', 'marker.js': 'document.documentElement.dataset.localAddon = "installed";', 'popup.html': '<!doctype html><title>Marker</title>', 'options.html': '<!doctype html><title>Options</title>' })) await writeFile(join(source, name), value);
  return { root, source, manager, options, running, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function makeXpi(files: Array<{ name: string; bytes: Buffer; mode?: number }>): Buffer {
  const crc = (bytes: Buffer) => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), encoded = deflateRawSync(file.bytes), checksum = crc(file.bytes);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8); head.writeUInt32LE(checksum, 14); head.writeUInt32LE(encoded.length, 18); head.writeUInt32LE(file.bytes.length, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, encoded);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(encoded.length, 20); entry.writeUInt32LE(file.bytes.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(((file.mode ?? 0o100600) << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += head.length + name.length + encoded.length;
  }
  const body = Buffer.concat(local), table = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, table, end]);
}
function xpiFixture(manifest: unknown = firefoxManifest()) {
  return makeXpi(Object.entries({ 'manifest.json': JSON.stringify(manifest), 'background.js': 'globalThis.marker = true;', 'marker.js': 'document.documentElement.dataset.localAddon = "installed";', 'popup.html': '<!doctype html><title>Marker</title>' }).map(([name, data]) => ({ name, bytes: Buffer.from(data) })));
}
describe('managed local browser add-ons', () => {
  test('direct native extension reader accepts a regular temporary fixture without path aliases being misclassified', async () => {
    const f = await fixture();
    try {
      try {
        const files = await readExtensionDirectory(f.source);
        expect(files.map((file) => file.name)).toContain('manifest.json');
      } catch (error) {
        // Windows CI can diagnose platform path/flag/stat behavior before any
        // production guard changes. Report classifications, never local paths.
        const absolute = resolve(f.source), canonical = await realpath(f.source);
        const windowsSpelling = (value: string) => win32.normalize(value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')).toLowerCase();
        let symbolicAncestors = 0, nonDirectoryAncestors = 0;
        const root = parse(absolute).root;
        let cursor = root;
        for (const part of ['', ...relative(root, absolute).split(sep).filter(Boolean)]) {
          if (part) cursor = join(cursor, part);
          const info = await lstat(cursor);
          if (info.isSymbolicLink()) symbolicAncestors++;
          if (!info.isDirectory()) nonDirectoryAncestors++;
        }
        const file = join(f.source, 'manifest.json'), before = await lstat(file);
        let handleIdentity: Record<string, unknown>;
        try {
          const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try {
            const opened = await handle.stat();
            handleIdentity = { opened: true, regular: opened.isFile(), sameDevice: opened.dev === before.dev, sameInode: opened.ino === before.ino, sameSize: opened.size === before.size, sameMtime: opened.mtimeMs === before.mtimeMs };
          } finally { await handle.close(); }
        } catch (openError) { handleIdentity = { opened: false, code: (openError as NodeJS.ErrnoException).code ?? 'unknown' }; }
        const diagnostic = {
          platform: process.platform, phase: 'direct-directory-reader',
          failure: error instanceof Error && error.message.startsWith('Extension ') ? error.message : (error as NodeJS.ErrnoException)?.code ?? 'unknown',
          caseFoldedRealpathEqual: canonical.toLowerCase() === absolute.toLowerCase(),
          normalizedWindowsRealpathEqual: windowsSpelling(canonical) === windowsSpelling(absolute),
          lexicalHasShortAlias: /(?:^|[\\/])[^\\/]*~[1-9](?:[\\/]|$)/.test(absolute),
          realpathHasNamespace: /^\\\\\?\\/.test(canonical),
          symbolicAncestors, nonDirectoryAncestors,
          noFollowConstantDefined: constants.O_NOFOLLOW !== undefined,
          noFollowConstantValue: constants.O_NOFOLLOW ?? null,
          handleIdentity,
        };
        throw new Error(`Native extension reader diagnostic: ${JSON.stringify(diagnostic)}`);
      }
    } finally { await f.cleanup(); }
  });
  test('rejects a directory junction at the source root or any source parent', async () => {
    const f = await fixture();
    try {
      const rootLink = join(f.root, 'linked-addon');
      await symlink(f.source, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(readExtensionDirectory(rootLink)).rejects.toThrow(/symbolic links|junctions/);
      await expect(boundedLocalFile(join(rootLink, 'manifest.json'))).rejects.toThrow(/symbolic links|junctions/);
      const realParent = join(f.root, 'real-parent'), nested = join(realParent, 'nested');
      await mkdir(nested, { recursive: true }); await writeFile(join(nested, 'manifest.json'), JSON.stringify(chromeManifest()));
      const linkedParent = join(f.root, 'linked-parent');
      await symlink(realParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(readExtensionDirectory(join(linkedParent, 'nested'))).rejects.toThrow(/symbolic links|junctions/);
      await expect(boundedLocalFile(join(linkedParent, 'nested', 'manifest.json'))).rejects.toThrow(/symbolic links|junctions/);
    } finally { await f.cleanup(); }
  });
  test('imports inactive immutable copy, generates stable public identity and excludes paths from public metadata', async () => {
    const f = await fixture();
    try {
      const entry = await f.manager.importLocal({ path: f.source, engine: 'chromium' });
      expect(entry.engine).toBe('chromium'); expect(entry.assignedProfiles).toBe(0); expect(entry.loadMode).toBe('unpacked');
      expect(entry.browserExtensionId).toMatch(/^[a-p]{32}$/); expect(entry.ui).toEqual({ popup: 'popup.html', options: 'options.html' });
      expect(JSON.stringify(f.manager.list())).not.toContain(f.source); expect(JSON.stringify(f.manager.list())).not.toContain(f.root);
      expect(JSON.parse(await readFile(join(f.source, 'manifest.json'), 'utf8')).key).toBeUndefined();
      f.manager.assign('chrome_1', { extensionId: entry.id, enabled: true, siteAccess: 'requested', origins: [], reviewedSha256: entry.sha256 });
      await writeFile(join(f.source, 'marker.js'), 'changed by source owner');
      const launch = await f.manager.prepareLaunch('chrome_1');
      expect(await readFile(join(launch.chromiumDirectories[0]!, 'marker.js'), 'utf8')).toContain('localAddon');
      expect(launch.entries[0]!.browserExtensionId).toBe(entry.browserExtensionId);
      const second = new ExtensionManager(f.options);
      expect(second.listAssignments('chrome_1')[0]!.enabled).toBe(true);
      expect(second.list()[0]!.sha256).toBe(entry.sha256);
    } finally { await f.cleanup(); }
  });
  test('requires explicit reviewed hash, compatible engine, stopped profile and bounded assignments', async () => {
    const f = await fixture();
    try {
      const entry = await f.manager.importLocal({ path: f.source, engine: 'chromium' });
      const assignment = { extensionId: entry.id, enabled: true, siteAccess: 'requested' as const, origins: [] };
      expect(() => f.manager.assign('chrome_1', assignment)).toThrow('Review');
      expect(() => f.manager.assign('firefox_1', { ...assignment, reviewedSha256: entry.sha256 })).toThrow('incompatible');
      f.running.add('chrome_1'); expect(() => f.manager.assign('chrome_1', { ...assignment, reviewedSha256: entry.sha256 })).toThrow('Stop');
      f.running.delete('chrome_1'); f.manager.assign('chrome_1', { ...assignment, reviewedSha256: entry.sha256 });
      f.running.add('chrome_1'); expect(() => f.manager.unassign('chrome_1', entry.id)).toThrow('Stop');
      expect(() => f.manager.delete(entry.id)).toThrow('every profile');
    } finally { await f.cleanup(); }
  });
  test('narrows per-profile host/content matches without widening originals or changing imported source', async () => {
    const f = await fixture();
    try {
      const entry = await f.manager.importLocal({ path: f.source, engine: 'chromium' });
      f.manager.assign('chrome_1', { extensionId: entry.id, enabled: true, siteAccess: 'sites', origins: ['https://example.com'], reviewedSha256: entry.sha256 });
      f.manager.assign('chrome_2', { extensionId: entry.id, enabled: true, siteAccess: 'sites', origins: ['https://other.example'], reviewedSha256: entry.sha256 });
      const a = await f.manager.prepareLaunch('chrome_1'), b = await f.manager.prepareLaunch('chrome_2');
      const manifest = JSON.parse(await readFile(join(a.chromiumDirectories[0]!, 'manifest.json'), 'utf8'));
      expect(manifest.host_permissions).toEqual(['https://example.com/*']); expect(manifest.optional_host_permissions).toEqual([]);
      expect(manifest.content_scripts[0].matches).toEqual(['https://example.com/*']); expect(manifest.permissions).toEqual(['storage', 'proxy']);
      expect(JSON.parse(await readFile(join(b.chromiumDirectories[0]!, 'manifest.json'), 'utf8')).content_scripts[0].matches).toEqual(['https://other.example/*']);
      const original = JSON.parse(await readFile(join(f.root, 'workspace', 'extensions', 'library', entry.id, 'source', 'manifest.json'), 'utf8'));
      expect(original.host_permissions).toEqual(['https://*/*']); expect(original.key).toBe(manifest.key);
      expect(entry.warnings.join(' ')).toContain('not sandbox'); expect(a.contentDigest).not.toBe(b.contentDigest);
    } finally { await f.cleanup(); }
  });
  test('disabled assignments do not load and uninstall/cleanup removes managed assignment state', async () => {
    const f = await fixture();
    try {
      const entry = await f.manager.importLocal({ path: f.source, engine: 'chromium' });
      f.manager.assign('chrome_1', { extensionId: entry.id, enabled: false, siteAccess: 'requested', origins: [] });
      expect((await f.manager.prepareLaunch('chrome_1')).chromiumDirectories).toEqual([]);
      f.manager.unassign('chrome_1', entry.id); f.manager.delete(entry.id); expect(f.manager.list()).toEqual([]);
      expect(() => f.manager.listAssignments('../escape')).toThrow();
      // Internal lifecycle cleanup is called under an exclusive teardown lock.
      f.running.add('chrome_2'); f.manager.removeProfile('chrome_2');
      expect(f.manager.listAssignments('chrome_2')).toEqual([]);
    } finally { await f.cleanup(); }
  });
  test('imports Firefox XPI through extracted temporary add-on format without signed-install claims', async () => {
    const f = await fixture();
    try {
      const path = join(f.root, 'marker.xpi'); await writeFile(path, xpiFixture());
      const entry = await f.manager.importLocal({ path, engine: 'firefox' });
      expect(entry.sourceFormat).toBe('xpi'); expect(entry.loadMode).toBe('unpacked-temporary'); expect(entry.browserExtensionId).toBe('marker@stakemode.local');
      f.manager.assign('firefox_1', { extensionId: entry.id, enabled: true, siteAccess: 'sites', origins: ['https://example.com'], reviewedSha256: entry.sha256 });
      const prepared = await f.manager.prepareLaunch('firefox_1');
      expect(prepared.chromiumDirectories).toEqual([]); expect(prepared.firefoxDirectories).toHaveLength(1);
      const uuid = prepared.firefoxAddonUUIDs['marker@stakemode.local'];
      expect(uuid).toMatch(/^[a-f0-9-]{36}$/);
      expect(prepared.entries[0]!.browserOrigin).toBe(`moz-extension://${uuid}`);
      expect(JSON.stringify(f.manager.list())).not.toContain(uuid!);
      expect(JSON.parse(await readFile(join(prepared.firefoxDirectories[0]!, 'manifest.json'), 'utf8')).permissions).toEqual(['storage', 'https://example.com/*']);
      expect(entry.warnings.join(' ')).toContain('does not preserve or verify');
    } finally { await f.cleanup(); }
  });
  test('Firefox UUID preference map persists across disable and restart, isolates profiles, and clears on deletion', async () => {
    const f = await fixture();
    try {
      const path = join(f.root, 'identity.xpi'); await writeFile(path, xpiFixture());
      const entry = await f.manager.importLocal({ path, engine: 'firefox' });
      const assignment = { extensionId: entry.id, enabled: true, siteAccess: 'requested' as const, origins: [], reviewedSha256: entry.sha256 };
      f.manager.assign('firefox_1', assignment); f.manager.assign('firefox_2', assignment);
      const first = await f.manager.prepareLaunch('firefox_1'), other = await f.manager.prepareLaunch('firefox_2');
      const addonId = entry.browserExtensionId!;
      expect(first.firefoxAddonUUIDs[addonId]).not.toBe(other.firefoxAddonUUIDs[addonId]);
      f.manager.assign('firefox_1', { ...assignment, enabled: false });
      const disabled = await f.manager.prepareLaunch('firefox_1');
      expect(disabled.firefoxDirectories).toEqual([]);
      expect(disabled.firefoxAddonUUIDs[addonId]).toBe(first.firefoxAddonUUIDs[addonId]);
      const reloaded = new ExtensionManager(f.options); reloaded.assign('firefox_1', assignment);
      const resumed = await reloaded.prepareLaunch('firefox_1');
      expect(resumed.entries[0]!.browserOrigin).toBe(first.entries[0]!.browserOrigin);
      reloaded.removeProfile('firefox_1');
      expect((await reloaded.prepareLaunch('firefox_1')).firefoxAddonUUIDs).toEqual({});
      expect((await reloaded.prepareLaunch('firefox_2')).firefoxAddonUUIDs[addonId]).toBe(other.firefoxAddonUUIDs[addonId]);
      reloaded.unassign('firefox_2', entry.id); reloaded.delete(entry.id);
      expect((await reloaded.prepareLaunch('firefox_2')).firefoxAddonUUIDs[addonId]).toBe(other.firefoxAddonUUIDs[addonId]);
    } finally { await f.cleanup(); }
  });
  test('rejects reserved object-property names as Firefox add-on identities', async () => {
    const f = await fixture();
    try {
      for (const id of ['__proto__', 'constructor', 'prototype']) {
        const path = join(f.root, 'reserved.xpi');
        await writeFile(path, xpiFixture({ ...firefoxManifest(), browser_specific_settings: { gecko: { id } } }));
        await expect(f.manager.importLocal({ path, engine: 'firefox' })).rejects.toThrow('gecko.id');
      }
    } finally { await f.cleanup(); }
  });
  test('rejects symlink folders/files, unsafe manifest UI, missing scripts and changed managed source', async () => {
    const f = await fixture();
    try {
      if (process.platform !== 'win32') {
        const link = join(f.root, 'link'); await symlink(f.source, link); await expect(f.manager.importLocal({ path: link, engine: 'chromium' })).rejects.toThrow('Unable');
        const scriptLink = join(f.source, 'linked.js'); await symlink(join(f.source, 'marker.js'), scriptLink); await expect(f.manager.importLocal({ path: f.source, engine: 'chromium' })).rejects.toThrow('Unable'); await rm(scriptLink);
      }
      await writeFile(join(f.source, 'manifest.json'), JSON.stringify({ ...chromeManifest(), action: { default_popup: 'https://remote.example/popup' } }));
      await expect(f.manager.importLocal({ path: f.source, engine: 'chromium' })).rejects.toThrow('local');
      await writeFile(join(f.source, 'manifest.json'), JSON.stringify({ ...chromeManifest(), background: { service_worker: 'missing.js' } }));
      await expect(f.manager.importLocal({ path: f.source, engine: 'chromium' })).rejects.toThrow('missing');
      await writeFile(join(f.source, 'manifest.json'), JSON.stringify(chromeManifest()));
      const entry = await f.manager.importLocal({ path: f.source, engine: 'chromium' });
      f.manager.assign('chrome_1', { extensionId: entry.id, enabled: true, siteAccess: 'requested', origins: [], reviewedSha256: entry.sha256 });
      await writeFile(join(f.root, 'workspace', 'extensions', 'library', entry.id, 'source', 'marker.js'), 'tampered');
      await expect(f.manager.prepareLaunch('chrome_1')).rejects.toThrow('changed');
    } finally { await f.cleanup(); }
  });
  test('does not add website permissions absent from extension declarations', async () => {
    const f = await fixture();
    try {
      const manifest = { ...chromeManifest(), host_permissions: ['https://example.com/*'], optional_host_permissions: [], content_scripts: [{ matches: ['https://example.com/path/*'], js: ['marker.js'] }] };
      await writeFile(join(f.source, 'manifest.json'), JSON.stringify(manifest));
      const entry = await f.manager.importLocal({ path: f.source, engine: 'chromium' });
      expect(() => f.manager.assign('chrome_1', { extensionId: entry.id, enabled: true, siteAccess: 'sites', origins: ['https://elsewhere.example'], reviewedSha256: entry.sha256 })).toThrow('outside');
      f.manager.assign('chrome_1', { extensionId: entry.id, enabled: true, siteAccess: 'sites', origins: ['https://example.com'], reviewedSha256: entry.sha256 });
      const prepared = await f.manager.prepareLaunch('chrome_1');
      expect(JSON.parse(await readFile(join(prepared.chromiumDirectories[0]!, 'manifest.json'), 'utf8')).content_scripts[0].matches).toEqual(['https://example.com/path/*']);
    } finally { await f.cleanup(); }
  });
  test('rejects Chromium versions the native manifest loader cannot install', async () => {
    const f = await fixture();
    try {
      for (const version of ['0', '0.0', '1.0-beta', '01.2', '1.65536', '123456.1', '1.2.3.4.5']) {
        await writeFile(join(f.source, 'manifest.json'), JSON.stringify({ ...chromeManifest(), version }));
        await expect(f.manager.importLocal({ path: f.source, engine: 'chromium' })).rejects.toThrow(/version|Manifest/);
      }
    } finally { await f.cleanup(); }
  });
  test('a quarantined package remains removable and fails only its affected launch', async () => {
    const f = await fixture();
    try {
      const entry = await f.manager.importLocal({ path: f.source, engine: 'chromium' });
      f.manager.assign('chrome_1', { extensionId: entry.id, enabled: true, siteAccess: 'sites', origins: ['https://example.com'], reviewedSha256: entry.sha256 });
      await rm(join(f.root, 'workspace', 'extensions', 'library', entry.id, 'source'), { recursive: true });
      const reloaded = new ExtensionManager(f.options);
      expect(reloaded.list()[0]!.id).toBe(entry.id);
      await expect(reloaded.prepareLaunch('chrome_1')).rejects.toThrow('unavailable');
      expect((await reloaded.prepareLaunch('chrome_2')).chromiumDirectories).toEqual([]);
      reloaded.unassign('chrome_1', entry.id); reloaded.delete(entry.id); expect(reloaded.list()).toEqual([]);
    } finally { await f.cleanup(); }
  });
});
describe('bounded XPI archive validation', () => {
  test('accepts actual deflated ZIP and rejects traversal, symlinks, collisions and corruption', () => {
    expect(readExtensionXpi(xpiFixture()).map((file) => file.name)).toContain('manifest.json');
    for (const name of ['../escape', 'C:/escape', 'nested\\escape', 'nul.js', 'bad. /file']) expect(() => readExtensionXpi(makeXpi([{ name, bytes: Buffer.from('x') }]))).toThrow();
    expect(() => readExtensionXpi(makeXpi([{ name: 'link.js', bytes: Buffer.from('target'), mode: 0o120777 }]))).toThrow();
    expect(() => readExtensionXpi(makeXpi([{ name: 'A.js', bytes: Buffer.from('a') }, { name: 'a.js', bytes: Buffer.from('b') }]))).toThrow();
    const corrupt = xpiFixture(); corrupt[35] = (corrupt[35]! + 1) & 255; expect(() => readExtensionXpi(corrupt)).toThrow();
    expect(() => readExtensionXpi(Buffer.alloc(EXTENSION_LIMITS.archiveBytes + 1))).toThrow();
    expect(() => extensionRelativePath('safe/../../unsafe')).toThrow();
  });
});
