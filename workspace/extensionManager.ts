/** User-imported local add-on library and stopped-profile assignment policy.
 * Imported code executes only inside the selected browser; this is not a sandbox
 * for malicious add-ons. Never download third-party packages implicitly. */
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertSafeProfileId } from '../profile-id.ts';
import { approvedOrigin } from './protocol.ts';
import { boundedLocalFile, EXTENSION_LIMITS, extensionFilesDigest, extensionRelativePath, readExtensionDirectory, readExtensionXpi, type ExtensionFile } from './extensionArchive.ts';

export type ExtensionEngine = 'chromium' | 'firefox';
export type ExtensionSiteAccess = 'requested' | 'sites';
export interface ExtensionView {
  id: string; name: string; version: string; engine: ExtensionEngine; manifestVersion: 2 | 3;
  sha256: string; sizeBytes: number; fileCount: number; importedAt: string;
  permissions: string[]; hostPermissions: string[]; optionalPermissions: string[]; optionalHostPermissions: string[];
  warnings: string[]; sourceFormat: 'directory' | 'xpi'; assignedProfiles: number;
  loadMode: 'unpacked' | 'unpacked-temporary';
  browserExtensionId?: string;
  ui: { popup?: string; options?: string };
}
type LibraryEntry = Omit<ExtensionView, 'assignedProfiles'>;
export interface ExtensionAssignment { extensionId: string; enabled: boolean; siteAccess: ExtensionSiteAccess; origins: string[]; reviewedSha256?: string; }
export interface ExtensionManagerOptions {
  stateRoot: string;
  isProfileStopped(profileId: string): boolean;
  getProfileEngine(profileId: string): ExtensionEngine | undefined;
}
export interface PreparedExtensionLaunch {
  chromiumDirectories: string[];
  firefoxDirectories: string[];
  contentDigest: string;
  extensionIds: string[];
  /** Private persisted engine preference input, never dashboard metadata. */
  firefoxAddonUUIDs: Record<string, string>;
  /** Private local launch metadata. Never serialize local paths to the dashboard. */
  entries: Array<{ id: string; engine: ExtensionEngine; directory: string; browserExtensionId?: string; browserOrigin?: string; ui: ExtensionView['ui'] }>;
}
type Manifest = Record<string, any>;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const maxRegistryBytes = 8 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max: number): value is string { return typeof value === 'string' && !!value && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
function validGeckoId(value: unknown): value is string { return text(value, 200) && /^[a-zA-Z0-9@._{}-]+$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value); }
function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 || value.some((item) => !text(item, 2048))) throw new Error('Extension manifest has invalid permission declarations');
  return [...new Set(value)];
}
function isHostPattern(value: string): boolean { return value === '<all_urls>' || /^(?:\*|https?|file|ftp):\/\//.test(value); }
function assertPattern(value: string): string {
  if (value === '<all_urls>') return value;
  const parsed = /^(\*|https?|file|ftp):\/\/([^/]*)(\/[^\u0000-\u001f]*)$/.exec(value);
  if (!parsed || /[\\#]/.test(value) || (parsed[1] !== 'file' && !/^(?:\*|(?:\*\.)?[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])$/.test(parsed[2]!)) || (parsed[1] === 'file' && parsed[2] !== '')) throw new Error('Extension manifest has an invalid website match pattern');
  return value;
}
function matchOrigin(pattern: string, origin: string): boolean {
  if (pattern === '<all_urls>') return true;
  const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!match) return false;
  const url = new URL(origin), scheme = url.protocol.slice(0, -1), host = url.hostname.toLowerCase();
  if (match[1] !== '*' && match[1] !== scheme) return false;
  if (match[1] === '*' && !['http', 'https'].includes(scheme)) return false;
  const requested = match[2]!.toLowerCase();
  return requested === '*' || requested === host || (requested.startsWith('*.') && (host === requested.slice(2) || host.endsWith(`.${requested.slice(2)}`)));
}
function narrowPatterns(patterns: string[], origins: string[]): string[] {
  return [...new Set(patterns.flatMap((pattern) => origins.filter((origin) => matchOrigin(pattern, origin)).map((origin) => {
    const url = new URL(origin);
    // Match patterns operate on hosts, not exact ports. Scope descriptions make
    // this limitation explicit; no exact-origin sandbox is claimed.
    const path = pattern === '<all_urls>' ? '/*' : /^(?:\*|https?|file|ftp):\/\/[^/]*(\/.*)$/.exec(pattern)![1]!;
    return `${url.protocol}//${url.hostname}${path}`;
  })))];
}
function manifestFile(files: ExtensionFile[]): Manifest {
  const file = files.find((item) => item.name === 'manifest.json');
  if (!file || file.bytes.length > EXTENSION_LIMITS.manifestBytes) throw new Error('Select an extension folder or XPI with a bounded root manifest.json');
  try { const value = JSON.parse(file.bytes.toString('utf8')); if (!record(value)) throw new Error(); return value; }
  catch { throw new Error('Extension manifest.json is invalid'); }
}
function relativeUiPath(value: unknown, files: ExtensionFile[]): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!text(value, 220) || value.startsWith('/') || /[:?#]/.test(value)) throw new Error('Extension UI must reference a local packaged file');
  const path = extensionRelativePath(value);
  if (!files.some((file) => file.name === path)) throw new Error('Extension UI file is missing');
  return path;
}
function metadata(id: string, engine: ExtensionEngine, format: LibraryEntry['sourceFormat'], files: ExtensionFile[], importedAt: string): LibraryEntry {
  const manifest = manifestFile(files);
  if (![2, 3].includes(manifest.manifest_version) || (engine === 'chromium' && manifest.manifest_version !== 3)) throw new Error('Chromium requires Manifest V3; Firefox supports WebExtension Manifest V2 or V3');
  if (!text(manifest.name, 160) || !text(manifest.version, 80) || !/^\d+(?:\.\d+){0,3}(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('Extension name or version is invalid');
  if (engine === 'chromium') {
    const components = manifest.version.split('.');
    if (components.length > 4 || components.some((component: string) => !/^(?:0|[1-9]\d{0,4})$/.test(component) || Number(component) > 65535) || components.every((component: string) => Number(component) === 0)) throw new Error('Chromium extension version must contain one to four integers from 0 to 65535, without leading zeroes, and at least one nonzero component');
  }
  const allPermissions = stringList(manifest.permissions), allOptional = stringList(manifest.optional_permissions);
  const hostPermissions = [...new Set([...allPermissions.filter(isHostPattern), ...stringList(manifest.host_permissions)])].map(assertPattern);
  const optionalHostPermissions = [...new Set([...allOptional.filter(isHostPattern), ...stringList(manifest.optional_host_permissions)])].map(assertPattern);
  const permissions = allPermissions.filter((permission) => !isHostPattern(permission)), optionalPermissions = allOptional.filter((permission) => !isHostPattern(permission));
  if (manifest.content_scripts !== undefined && (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length > 256)) throw new Error('Extension content script declarations are invalid');
  for (const content of manifest.content_scripts ?? []) {
    if (!record(content)) throw new Error('Extension content script declaration is invalid');
    const contentMatches = stringList(content.matches).map(assertPattern); stringList(content.exclude_matches).map(assertPattern);
    for (const match of contentMatches) if (!hostPermissions.includes(match)) hostPermissions.push(match);
    for (const path of [...stringList(content.js), ...stringList(content.css)]) if (!files.some((file) => file.name === extensionRelativePath(path))) throw new Error('Extension content script file is missing');
  }
  if (manifest.background !== undefined) {
    if (!record(manifest.background)) throw new Error('Extension background declaration is invalid');
    for (const path of [...stringList(manifest.background.scripts), ...manifest.background.service_worker ? [manifest.background.service_worker] : [], ...manifest.background.page ? [manifest.background.page] : []]) relativeUiPath(path, files);
  }
  let browserExtensionId: string | undefined;
  if (engine === 'firefox') {
    const geckoId = manifest.browser_specific_settings?.gecko?.id ?? manifest.applications?.gecko?.id;
    if (!validGeckoId(geckoId)) throw new Error('Firefox add-ons require a stable browser_specific_settings.gecko.id');
    browserExtensionId = geckoId;
    if (manifest.background?.service_worker && !manifest.background?.scripts) throw new Error('Firefox add-ons require background.scripts instead of a Chromium-only service worker');
  } else if (manifest.key !== undefined) {
    try {
      if (!text(manifest.key, 16384) || !/^[a-zA-Z0-9+/=]+$/.test(manifest.key)) throw new Error();
      const key = Buffer.from(manifest.key, 'base64'); createPublicKey({ key, format: 'der', type: 'spki' });
      browserExtensionId = [...createHash('sha256').update(key).digest().subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
    } catch { throw new Error('Extension public identity key is invalid'); }
  }
  const ui = {
    ...relativeUiPath(manifest.action?.default_popup ?? manifest.browser_action?.default_popup, files) && { popup: relativeUiPath(manifest.action?.default_popup ?? manifest.browser_action?.default_popup, files) },
    ...relativeUiPath(manifest.options_ui?.page ?? manifest.options_page, files) && { options: relativeUiPath(manifest.options_ui?.page ?? manifest.options_page, files) },
  };
  const warnings = ['Only import add-ons you trust. Website access restrictions do not sandbox background, proxy, debugger, native messaging, active-tab, or other global capabilities.'];
  if (engine === 'firefox') warnings.push('Firefox loads this XPI as an extracted temporary add-on on each launch. This does not preserve or verify an XPI signing claim.');
  if ([...permissions, ...optionalPermissions].some((permission) => ['proxy', 'debugger', 'nativeMessaging', 'management', 'activeTab', 'tabs', 'declarativeNetRequest', 'webRequest', 'webRequestBlocking'].includes(permission))) warnings.push('This add-on requests account-wide or browser-wide capabilities. Review every declared permission before enabling it.');
  if (manifest.externally_connectable) warnings.push('This add-on declares external messaging endpoints. Browser extension messaging policy still applies.');
  return { id, name: manifest.name, version: manifest.version, engine, manifestVersion: manifest.manifest_version, sha256: extensionFilesDigest(files), sizeBytes: files.reduce((sum, file) => sum + file.bytes.length, 0), fileCount: files.length, importedAt, permissions, hostPermissions, optionalPermissions, optionalHostPermissions, warnings, sourceFormat: format, loadMode: engine === 'firefox' ? 'unpacked-temporary' : 'unpacked', ...browserExtensionId && { browserExtensionId }, ui };
}
function scopedManifest(original: Manifest, assignment: ExtensionAssignment): Manifest {
  const manifest = clone(original);
  if (assignment.siteAccess !== 'sites') return manifest;
  const origins = assignment.origins;
  if (manifest.host_permissions) manifest.host_permissions = narrowPatterns(stringList(manifest.host_permissions), origins);
  if (manifest.optional_host_permissions) manifest.optional_host_permissions = narrowPatterns(stringList(manifest.optional_host_permissions), origins);
  for (const key of ['permissions', 'optional_permissions']) if (manifest[key]) manifest[key] = stringList(manifest[key]).flatMap((permission) => isHostPattern(permission) ? narrowPatterns([permission], origins) : [permission]);
  if (manifest.content_scripts) manifest.content_scripts = manifest.content_scripts.flatMap((content: Manifest) => {
    const matches = narrowPatterns(stringList(content.matches), origins);
    return matches.length ? [{ ...content, matches }] : [];
  });
  if (Array.isArray(manifest.web_accessible_resources)) manifest.web_accessible_resources = manifest.web_accessible_resources.flatMap((resource: unknown) => {
    if (!record(resource) || !Array.isArray(resource.matches)) return [resource];
    const matches = narrowPatterns(stringList(resource.matches), origins);
    return matches.length ? [{ ...resource, matches }] : [];
  });
  return manifest;
}

export class ExtensionManager {
  private readonly root: string;
  private readonly registry: string;
  private library = new Map<string, LibraryEntry>();
  private assignments = new Map<string, ExtensionAssignment[]>();
  private firefoxUUIDs = new Map<string, Record<string, string>>();
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ExtensionManagerOptions) {
    this.root = resolve(options.stateRoot, 'workspace', 'extensions'); this.registry = join(this.root, 'registry.json');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('Extension library storage must not be a symbolic link');
    if (!existsSync(this.registry)) return;
    try {
      if (lstatSync(this.registry).isSymbolicLink() || lstatSync(this.registry).size > maxRegistryBytes) throw new Error();
      const saved = JSON.parse(readFileSync(this.registry, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.library) || saved.library.length > EXTENSION_LIMITS.library || !Array.isArray(saved.profiles) || saved.profiles.length > 256) throw new Error();
      for (const entry of saved.library) {
        if (!record(entry) || !idPattern.test(entry.id) || this.library.has(entry.id) || !['chromium', 'firefox'].includes(entry.engine) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !text(entry.name, 160) || !text(entry.version, 80) || ![2, 3].includes(entry.manifestVersion) || !['directory', 'xpi'].includes(entry.sourceFormat) || !text(entry.importedAt, 80) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > EXTENSION_LIMITS.expandedBytes || !Number.isSafeInteger(entry.fileCount) || entry.fileCount < 1 || entry.fileCount > EXTENSION_LIMITS.files) throw new Error();
        if ((entry.engine === 'chromium' && (entry.manifestVersion !== 3 || entry.sourceFormat !== 'directory')) || (entry.engine === 'firefox' && entry.sourceFormat !== 'xpi') || !record(entry.ui)) throw new Error();
        const permissions = stringList(entry.permissions), optionalPermissions = stringList(entry.optionalPermissions), hostPermissions = stringList(entry.hostPermissions).map(assertPattern), optionalHostPermissions = stringList(entry.optionalHostPermissions).map(assertPattern), warnings = stringList(entry.warnings);
        const ui: ExtensionView['ui'] = {};
        for (const key of ['popup', 'options'] as const) if (entry.ui[key] !== undefined) ui[key] = extensionRelativePath(entry.ui[key]);
        if (entry.browserExtensionId !== undefined && (entry.engine === 'chromium' ? !/^[a-p]{32}$/.test(entry.browserExtensionId) : !validGeckoId(entry.browserExtensionId))) throw new Error();
        this.library.set(entry.id, { id: entry.id, name: entry.name, version: entry.version, engine: entry.engine, manifestVersion: entry.manifestVersion, sha256: entry.sha256, sizeBytes: entry.sizeBytes, fileCount: entry.fileCount, importedAt: entry.importedAt, permissions, hostPermissions, optionalPermissions, optionalHostPermissions, warnings, sourceFormat: entry.sourceFormat, loadMode: entry.engine === 'firefox' ? 'unpacked-temporary' : 'unpacked', ...entry.browserExtensionId && { browserExtensionId: entry.browserExtensionId }, ui });
      }
      for (const row of saved.profiles) {
        assertSafeProfileId(row.profileId);
        if (this.assignments.has(row.profileId) || !Array.isArray(row.extensions) || row.extensions.length > EXTENSION_LIMITS.assignmentsPerProfile) throw new Error();
        const ids = new Set<string>();
        const assignments = row.extensions.map((value: unknown) => { const assignment = this.normalizeAssignment(value); if (ids.has(assignment.extensionId)) throw new Error(); ids.add(assignment.extensionId); return assignment; });
        this.assignments.set(row.profileId, assignments);
        if (row.firefoxAddonUUIDs !== undefined) {
          if (!record(row.firefoxAddonUUIDs) || Object.keys(row.firefoxAddonUUIDs).length > 256) throw new Error();
          const uuids: Record<string, string> = Object.create(null);
          for (const [addonId, uuid] of Object.entries(row.firefoxAddonUUIDs)) {
            if (!validGeckoId(addonId) || typeof uuid !== 'string' || !idPattern.test(uuid)) throw new Error();
            uuids[addonId] = uuid;
          }
          this.firefoxUUIDs.set(row.profileId, uuids);
        }
      }
    } catch { throw new Error('Extension library storage is invalid; repair it before using browser add-ons'); }
  }
  list(): ExtensionView[] { return [...this.library.values()].map((entry) => ({ ...clone(entry), assignedProfiles: [...this.assignments.values()].filter((rows) => rows.some((row) => row.extensionId === entry.id)).length })); }
  listAssignments(profileId: string): ExtensionAssignment[] { this.requireProfile(profileId); return clone(this.assignments.get(profileId) ?? []); }
  async importLocal(input: { path: string; engine: ExtensionEngine }): Promise<ExtensionView> {
    return this.exclusive(async () => {
      if (!input || !['chromium', 'firefox'].includes(input.engine) || !text(input.path, 32767) || !isAbsolute(input.path)) throw new Error('Select an absolute local extension folder or XPI path');
      if (this.library.size >= EXTENSION_LIMITS.library) throw new Error('Extension library is full');
      let files: ExtensionFile[], format: LibraryEntry['sourceFormat'];
      try {
        const info = await lstat(input.path);
        if (info.isSymbolicLink()) throw new Error();
        if (input.engine === 'chromium' && info.isDirectory()) { files = await readExtensionDirectory(input.path); format = 'directory'; }
        else if (input.engine === 'firefox' && info.isFile() && /\.xpi$/i.test(input.path)) { files = readExtensionXpi(await boundedLocalFile(input.path, EXTENSION_LIMITS.archiveBytes)); format = 'xpi'; }
        else throw new Error();
      } catch { throw new Error(input.engine === 'firefox' ? 'Unable to import local XPI: use a regular bounded WebExtension XPI without unsafe paths or links' : 'Unable to import extension: use an unpacked Manifest V3 folder without unsafe paths or links'); }
      if (input.engine === 'chromium') {
        const manifest = manifestFile(files);
        if (manifest.key === undefined) {
          // A stable public key gives all profile copies the same browser ID.
          // No private key is written and no publisher-signature claim is made.
          const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
          manifest.key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
          files = files.map((file) => file.name === 'manifest.json' ? { name: file.name, bytes: Buffer.from(JSON.stringify(manifest)) } : file);
        }
      }
      const id = randomUUID(), entry = metadata(id, input.engine, format, files, new Date().toISOString());
      const duplicate = [...this.library.values()].find((row) => row.engine === entry.engine && row.sha256 === entry.sha256);
      if (duplicate) return this.list().find((row) => row.id === duplicate.id)!;
      const staging = join(this.root, `import-${id}`), final = this.sourceDirectory(id);
      try {
        await this.writeFiles(staging, files);
        if (extensionFilesDigest(await readExtensionDirectory(staging)) !== entry.sha256) throw new Error('Extension import integrity check failed');
        await mkdir(dirname(final), { recursive: true, mode: 0o700 }); await rename(staging, final);
        const next = new Map(this.library); next.set(id, entry); this.persist(next, this.assignments); this.library = next;
      } catch (error) { await rm(staging, { recursive: true, force: true }); await rm(dirname(final), { recursive: true, force: true }); throw error; }
      return this.list().find((row) => row.id === id)!;
    });
  }
  assign(profileId: string, value: ExtensionAssignment): ExtensionAssignment {
    this.requireStopped(profileId);
    const assignment = this.normalizeAssignment(value), engine = this.requireProfile(profileId), entry = this.library.get(assignment.extensionId)!;
    if (entry.engine !== engine) throw new Error('This add-on is incompatible with the selected browser engine');
    const rows = [...this.assignments.get(profileId) ?? []].filter((row) => row.extensionId !== assignment.extensionId);
    if (rows.length >= EXTENSION_LIMITS.assignmentsPerProfile) throw new Error('Profile extension limit reached');
    rows.push(assignment); const next = new Map(this.assignments); next.set(profileId, rows); this.persist(this.library, next); this.assignments = next;
    return clone(assignment);
  }
  unassign(profileId: string, extensionId: string): void {
    this.requireStopped(profileId); this.requireExtension(extensionId);
    const next = new Map(this.assignments); next.set(profileId, (next.get(profileId) ?? []).filter((row) => row.extensionId !== extensionId)); this.persist(this.library, next); this.assignments = next;
  }
  delete(extensionId: string): void {
    this.requireExtension(extensionId);
    if ([...this.assignments.values()].some((rows) => rows.some((row) => row.extensionId === extensionId))) throw new Error('Remove this add-on from every profile before deleting it from the library');
    const next = new Map(this.library); next.delete(extensionId); this.persist(next, this.assignments); this.library = next;
    rmSync(dirname(this.sourceDirectory(extensionId)), { recursive: true, force: true });
  }
  /** Internal lifecycle cleanup after the process manager proves browser teardown.
   * Do not expose this privileged cleanup operation as an HTTP route. */
  removeProfile(profileId: string): void {
    assertSafeProfileId(profileId);
    const next = new Map(this.assignments), uuids = new Map(this.firefoxUUIDs); next.delete(profileId); uuids.delete(profileId);
    this.persist(this.library, next, uuids); this.assignments = next; this.firefoxUUIDs = uuids;
    rmSync(join(this.root, 'profiles', profileId), { recursive: true, force: true });
  }
  async prepareLaunch(profileId: string, engine = this.requireProfile(profileId)): Promise<PreparedExtensionLaunch> {
    return this.exclusive(async () => {
      this.requireProfile(profileId);
      if (engine !== this.requireProfile(profileId)) throw new Error('Browser engine changed before extension preparation');
      const assignments = clone(this.assignments.get(profileId) ?? []).filter((row) => row.enabled);
      const profileUUIDs: Record<string, string> = Object.assign(Object.create(null), engine === 'firefox' ? this.firefoxUUIDs.get(profileId) ?? {} : {});
      const result: PreparedExtensionLaunch = { chromiumDirectories: [], firefoxDirectories: [], extensionIds: [], contentDigest: '', firefoxAddonUUIDs: {}, entries: [] };
      const profileRoot = join(this.root, 'profiles', profileId); await mkdir(profileRoot, { recursive: true, mode: 0o700 });
      const seenIdentities = new Set<string>();
      for (const assignment of assignments) {
        const entry = this.requireExtension(assignment.extensionId);
        if (entry.engine !== engine || assignment.reviewedSha256 !== entry.sha256) throw new Error('An enabled add-on no longer matches its reviewed browser assignment');
        let files: ExtensionFile[];
        try { files = await readExtensionDirectory(this.sourceDirectory(entry.id)); }
        catch { throw new Error('Imported add-on files are unavailable or unsafe; remove and import the add-on again before launching'); }
        if (extensionFilesDigest(files) !== entry.sha256) throw new Error('Imported add-on files changed; remove and import the add-on again before launching');
        const manifest = scopedManifest(manifestFile(files), assignment);
        const prepared = files.map((file) => file.name === 'manifest.json' ? { name: file.name, bytes: Buffer.from(JSON.stringify(manifest)) } : file);
        const preparedDigest = extensionFilesDigest(prepared);
        const directory = join(profileRoot, `${entry.id}-${preparedDigest}`), staging = join(profileRoot, `${entry.id}-${randomUUID()}.tmp`);
        try {
          if (existsSync(directory)) {
            if (extensionFilesDigest(await readExtensionDirectory(directory)) !== preparedDigest) throw new Error('Prepared add-on files changed; stop and repair the profile before launching');
          } else {
            await this.writeFiles(staging, prepared);
            if (extensionFilesDigest(await readExtensionDirectory(staging)) !== preparedDigest) throw new Error('Prepared add-on integrity verification failed');
            await rename(staging, directory);
          }
        }
        finally { await rm(staging, { recursive: true, force: true }); }
        // Chromium without a manifest key derives its id from the absolute
        // unpacked path; that id must be verified by the browser before UI use.
        if (entry.browserExtensionId) { if (seenIdentities.has(entry.browserExtensionId)) throw new Error('Assigned add-ons have conflicting browser identities'); seenIdentities.add(entry.browserExtensionId); }
        let browserOrigin: string | undefined;
        if (entry.browserExtensionId && engine === 'firefox') {
          if (!profileUUIDs[entry.browserExtensionId]) {
            if (Object.keys(profileUUIDs).length >= 256) throw new Error('Profile Firefox add-on identity limit reached; remove the profile before creating more add-on identities');
            profileUUIDs[entry.browserExtensionId] = randomUUID();
          }
          browserOrigin = `moz-extension://${profileUUIDs[entry.browserExtensionId]}`;
        } else if (entry.browserExtensionId) browserOrigin = `chrome-extension://${entry.browserExtensionId}`;
        result[engine === 'chromium' ? 'chromiumDirectories' : 'firefoxDirectories'].push(directory); result.extensionIds.push(entry.id);
        result.entries.push({ id: entry.id, engine, directory, ...entry.browserExtensionId && { browserExtensionId: entry.browserExtensionId }, ...browserOrigin && { browserOrigin }, ui: clone(entry.ui) });
      }
      if (engine === 'firefox') {
        const next = new Map(this.firefoxUUIDs); next.set(profileId, profileUUIDs);
        this.persist(this.library, this.assignments, next); this.firefoxUUIDs = next;
        result.firefoxAddonUUIDs = clone(profileUUIDs);
      }
      result.contentDigest = createHash('sha256').update(JSON.stringify({ assignments: assignments.map((assignment) => ({ ...assignment, sha256: this.requireExtension(assignment.extensionId).sha256 })), firefoxAddonUUIDs: result.firefoxAddonUUIDs })).digest('hex');
      return result;
    });
  }
  private normalizeAssignment(value: unknown): ExtensionAssignment {
    if (!record(value) || typeof value.enabled !== 'boolean' || !['requested', 'sites'].includes(value.siteAccess)) throw new Error('Extension assignment is invalid');
    const entry = this.requireExtension(value.extensionId);
    if (!Array.isArray(value.origins) || value.origins.length > 32) throw new Error('Select up to 32 website origins');
    const origins = [...new Set(value.origins.map((origin: unknown) => approvedOrigin(origin)))];
    if (value.siteAccess === 'sites' && !origins.length) throw new Error('Select at least one website for this add-on');
    if (value.siteAccess === 'requested' && origins.length) throw new Error('Requested-permission mode does not accept a separate website list');
    // Public host metadata also includes content-script matches. Reading the
    // manifest here would make one missing/quarantined package block the whole
    // library at application startup; launch preparation verifies actual bytes.
    const declaredHosts = [...entry.hostPermissions, ...entry.optionalHostPermissions];
    if (value.siteAccess === 'sites') for (const origin of origins) {
      if (!declaredHosts.some((pattern) => matchOrigin(pattern, origin))) throw new Error('Selected website is outside this add-on’s declared website access');
    }
    if (value.enabled && value.reviewedSha256 !== entry.sha256) throw new Error('Review the add-on permissions and approve its current SHA-256 before enabling it');
    if (value.reviewedSha256 !== undefined && value.reviewedSha256 !== entry.sha256) throw new Error('Add-on review does not match the imported version');
    return { extensionId: entry.id, enabled: value.enabled, siteAccess: value.siteAccess, origins, ...value.reviewedSha256 && { reviewedSha256: value.reviewedSha256 } };
  }
  private requireExtension(id: unknown): LibraryEntry { if (typeof id !== 'string' || !idPattern.test(id) || !this.library.has(id)) throw new Error('Extension was not found'); return this.library.get(id)!; }
  private requireProfile(id: string): ExtensionEngine { assertSafeProfileId(id); const engine = this.options.getProfileEngine(id); if (!engine || !['chromium', 'firefox'].includes(engine)) throw new Error('Browser profile was not found'); return engine; }
  private requireStopped(id: string): void { this.requireProfile(id); if (!this.options.isProfileStopped(id)) throw new Error('Stop the profile before changing its extensions'); }
  private sourceDirectory(id: string): string { if (!idPattern.test(id)) throw new Error('Extension identity is invalid'); return join(this.root, 'library', id, 'source'); }
  private async writeFiles(directory: string, files: ExtensionFile[]): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const name = extensionRelativePath(file.name), destination = resolve(directory, name);
      if (relative(directory, destination).startsWith('..')) throw new Error('Extension file path is outside its owned directory');
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 });
    }
  }
  private persist(library: Map<string, LibraryEntry>, assignments: Map<string, ExtensionAssignment[]>, uuids = this.firefoxUUIDs): void {
    const profileIds = new Set([...assignments.keys(), ...uuids.keys()]);
    if (profileIds.size > 256) throw new Error('Extension library profile limit reached');
    const data = JSON.stringify({ version: 1, library: [...library.values()], profiles: [...profileIds].map((profileId) => ({ profileId, extensions: assignments.get(profileId) ?? [], ...uuids.has(profileId) && { firefoxAddonUUIDs: uuids.get(profileId) } })) });
    if (Buffer.byteLength(data) > maxRegistryBytes) throw new Error('Extension library exceeds its storage limit');
    const temporary = `${this.registry}-${randomUUID()}.tmp`;
    try { writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.registry); }
    finally { rmSync(temporary, { force: true }); }
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> { const result = this.operations.then(operation); this.operations = result.catch(() => {}); return result; }
}
