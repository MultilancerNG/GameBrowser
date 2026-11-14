/** Explicit, offline full-state copies. Discovery never changes an installation. */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { dpapiKeysReadable, localStateDpapiKey } from "../dpapi.ts";
import { parseProcessCommandArgs } from "../firefox-lifecycle.ts";
import { readHostProcessSnapshot, type HostProcessSnapshot } from "../launcher.ts";
import { isSafeProfileId } from "../profile-id.ts";

export interface StateImportDiscoveryOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
}
export interface StateImportCandidate { kind: "stakemode" | "gamebrowser"; root: string; label: string; }
export interface StateImportOptions {
  /** Test seam; production callers must use the default complete host scan. */
  scanProcesses?: () => Promise<HostProcessSnapshot | null>;
  /** Test seam; production callers must use the same-account Windows DPAPI check. */
  validateDpapi?: (localStatePaths: string[]) => Promise<void>;
  rename?: (source: string, destination: string) => void;
}
export interface StateImportPlan {
  readonly version: 1;
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly profileCount: number;
  readonly fileCount: number;
  readonly bytes: number;
  readonly sourceFingerprint: string;
  readonly excludedFiles: readonly string[];
  readonly sameWindowsAccountRequired: true;
}
export interface StateImportResult { status: "imported"; profileCount: number; destinationRoot: string; backupRoot?: string; receipt: string; }
interface TreeEntry { path: string; directory: boolean; bytes: number; hash: string; }
interface Inspection { entries: TreeEntry[]; fingerprint: string; profileCount: number; localStates: string[]; }
const RECEIPT_PREFIX = ".gamebrowser-state-import-";
// A native runtime descriptor contains transient generation information, not user state.
const TRANSIENT = new Set(["agent-runtime.json"]);
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
function beneath(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
}
function noLinkedAncestors(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error("State import does not follow symbolic links or junctions");
      if (current !== resolve(path) && !info.isDirectory()) throw new Error("State import parent is not a directory");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(current) === current) return;
  }
}
function checkedRoots(sourceRoot: string, destinationRoot: string): { source: string; destination: string } {
  if (!sourceRoot || !destinationRoot || /[\0]/.test(sourceRoot + destinationRoot)) throw new Error("Choose explicit source and destination data folders");
  const source = resolve(sourceRoot), destination = resolve(destinationRoot);
  if (samePath(source, dirname(source)) || samePath(destination, dirname(destination)) || beneath(source, destination) || beneath(destination, source)) {
    throw new Error("Source and destination must be separate data folders, without nesting");
  }
  noLinkedAncestors(source); noLinkedAncestors(destination);
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error("Source data folder was not found");
  return { source, destination };
}
function emptyDestination(destination: string): void {
  noLinkedAncestors(destination);
  if (existsSync(destination) && (!lstatSync(destination).isDirectory() || readdirSync(destination).length)) {
    throw new Error("Destination already contains files; choose a new empty GameBrowser data folder");
  }
}
function digestFile(path: string): string {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, "r");
  try { for (let size; (size = readSync(descriptor, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, size)); }
  finally { closeSync(descriptor); }
  return hash.digest("hex");
}
function inventory(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  function visit(directory: string, depth: number): void {
    if (depth > 128) throw new Error("Source data has an unsupported directory depth");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), suffix = relative(root, path);
      if (TRANSIENT.has(suffix)) continue;
      if (!beneath(root, path)) throw new Error("Source entry escapes its data folder");
      const info = lstatSync(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink > 1)) {
        throw new Error("Source data contains a symbolic link, junction, hard link, or special file; close the old application and review it before importing");
      }
      entries.push({ path: suffix, directory: info.isDirectory(), bytes: info.isFile() ? info.size : 0, hash: info.isFile() ? digestFile(path) : "" });
      if (entries.length > 1_000_000) throw new Error("Source data has too many entries for a single safe import");
      if (info.isDirectory()) visit(path, depth + 1);
    }
  }
  visit(root, 0); return entries;
}
function fingerprint(entries: TreeEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(JSON.stringify([entry.path, entry.directory, entry.bytes, entry.hash]) + "\n");
  return hash.digest("hex");
}
function tableExists(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
/** Read a private copy so even WAL recovery cannot write the user's source. */
function databaseProfiles(root: string): Array<{ id: string; seeded?: number }> {
  const databasePath = join(root, "profiles.sqlite");
  if (!existsSync(databasePath) || !lstatSync(databasePath).isFile() || lstatSync(databasePath).isSymbolicLink()) throw new Error("Source has no regular profiles.sqlite file");
  const temporary = mkdtempSync(join(tmpdir(), "gamebrowser-state-check-")), snapshot = join(temporary, "profiles.sqlite");
  let db: Database | undefined;
  try {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const path = `${databasePath}${suffix}`;
      if (existsSync(path)) {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Source database contains linked or special files");
        copyFileSync(path, `${snapshot}${suffix}`, constants.COPYFILE_EXCL);
      }
    }
    db = new Database(snapshot);
    if (db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Source profile database failed its integrity check");
    if (!tableExists(db, "profiles")) throw new Error("Source database has no profiles table");
    if (tableExists(db, "launches") && Number((db.query("SELECT COUNT(*) AS count FROM launches").get() as { count: number }).count)) {
      throw new Error("Source has browser launch records; reopen and close the old application cleanly before importing");
    }
    const hasSeeded = db.query<{ name: string }, []>("PRAGMA table_info(profiles)").all().some(column => column.name === "seeded");
    const profiles = db.query<{ id: string; seeded?: number }, []>(`SELECT id${hasSeeded ? ",seeded" : ""} FROM profiles`).all();
    if (profiles.some(profile => !isSafeProfileId(profile.id)) || new Set(profiles.map(profile => profile.id.toLowerCase())).size !== profiles.length) {
      throw new Error("Source database contains unsafe or conflicting profile IDs");
    }
    return profiles;
  } finally { db?.close(); rmSync(temporary, { recursive: true, force: true }); }
}
function normalized(value: string): string { return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(); }
async function assertStopped(roots: string[], scan: () => Promise<HostProcessSnapshot | null>): Promise<void> {
  const snapshot = await scan();
  if (!snapshot || snapshot.incomplete) throw new Error("Process ownership could not be verified; close both applications and every managed browser, then retry");
  const paths = roots.map(normalized);
  for (const record of snapshot.records) {
    if (record.pid === process.pid || ["Z", "X"].includes(record.linuxState ?? "")) continue;
    const executable = normalized(record.executablePath ?? ""), name = normalized(record.processName ?? executable.split("/").at(-1) ?? "");
    const args = record.argv ?? parseProcessCommandArgs(record.commandLine ?? ""), command = normalized(args.join(" "));
    const app = /^(?:gamebrowser|stakemode|aliasmode)(?:-sidecar)?(?:\.exe)?$/.test(name);
    const browser = /^(?:(?:google-)?chrome|chromium(?:-browser)?|cloakbrowser|firefox|firefox-bin)(?:\.exe)?$/.test(name);
    const scriptRuntime = /^(?:bun|node|deno)(?:\.exe)?$/.test(name);
    if (app) throw new Error("GameBrowser or StakeMode is still running; close both applications before importing");
    if (browser && (!command || !record.executablePath || record.executablePathExact === false)) throw new Error("A browser process has unknown ownership; close it before importing");
    if (scriptRuntime && !command) throw new Error("A script runtime has unknown ownership; close it before importing");
    if (paths.some(root => executable === root || executable.startsWith(`${root}/`))) throw new Error("A process is running from a data folder; close it before importing");
    // --source belongs to this import command and is deliberately not an owner flag.
    for (const [index, arg] of args.entries()) {
      for (const flag of ["--state-root", "--desktop-root", "--data-root", "--user-data-dir", "--profile", "-profile"]) {
        const value = arg === flag ? args[index + 1] : arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
        if (value === undefined) continue;
        const path = normalized(value);
        if (paths.some(root => path === root || path.startsWith(`${root}/`))) throw new Error("A browser or application still uses an import data folder; close it before importing");
        // Its working directory is not part of the snapshot: a relative browser
        // profile flag cannot prove this source is unused.
        if (browser && !isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) throw new Error("A browser profile path has unknown ownership; close it before importing");
      }
    }
    const cliIndex = args.findIndex(arg => /(?:^|[\\/])(?:stakemode|gamebrowser)-cli\.(?:ts|js)$/i.test(arg));
    const cliCommand = cliIndex < 0 ? undefined : args[cliIndex + 1];
    if (cliIndex >= 0 && (!cliCommand || cliCommand.startsWith("--") || ["start", "serve"].includes(cliCommand))) {
      throw new Error("A standalone workspace is still running; close it before importing");
    }
  }
}
async function defaultDpapiCheck(localStates: string[]): Promise<void> {
  const keys: string[] = [];
  for (const path of localStates) {
    let data: any; try { data = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("A browser Local State file is unreadable"); }
    const key = localStateDpapiKey(path);
    if (key) keys.push(key);
    else if (process.platform === "win32" && data?.os_crypt?.encrypted_key) throw new Error("The browser uses unsupported Windows secret protection; use its original machine and browser export");
  }
  if (!keys.length) return;
  if (process.platform !== "win32") throw new Error("Windows browser secrets require importing on the same Windows machine and account");
  const readable = await dpapiKeysReadable(keys);
  if (!readable || readable.length !== keys.length || readable.some(value => !value)) throw new Error("Windows browser secrets cannot be verified; import requires the same machine and Windows account");
}
async function inspect(source: string, destination: string, options: StateImportOptions): Promise<Inspection> {
  await assertStopped([source, destination], options.scanProcesses ?? readHostProcessSnapshot);
  noLinkedAncestors(source);
  const entries = inventory(source), profiles = databaseProfiles(source), ids = new Set(profiles.map(profile => profile.id));
  const profileRoot = join(source, "profiles");
  if (existsSync(profileRoot)) {
    if (!lstatSync(profileRoot).isDirectory()) throw new Error("Source browser profiles entry is not a directory");
    for (const id of readdirSync(profileRoot)) if (!isSafeProfileId(id) || !ids.has(id) || !lstatSync(join(profileRoot, id)).isDirectory()) {
      throw new Error("Source contains an unrecognized browser profile directory");
    }
  }
  if (profiles.some(profile => profile.seeded && !existsSync(join(profileRoot, profile.id)))) throw new Error("An initialized profile is missing its browser data; a metadata-only copy would lose its session");
  const localStates = entries.filter(entry => !entry.directory && basename(entry.path) === "Local State" && entry.path.startsWith(`profiles${sep}`)).map(entry => join(source, entry.path));
  await (options.validateDpapi ?? defaultDpapiCheck)(localStates);
  return { entries, fingerprint: fingerprint(entries), profileCount: profiles.length, localStates };
}

/** Existing native GameBrowser data stays in place. Only other known roots are offered. */
export function detectStateImportCandidates(destinationRoot: string, options: StateImportDiscoveryOptions = {}): StateImportCandidate[] {
  const env = options.env ?? process.env, home = options.home ?? homedir(), platform = options.platform ?? process.platform;
  const applicationData = platform === "win32" ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
    : platform === "darwin" ? join(home, "Library", "Application Support") : (env.XDG_DATA_HOME ?? join(home, ".local", "share"));
  const candidates: StateImportCandidate[] = [
    { kind: "stakemode", root: env.STAKEMODE_STATE_ROOT ?? join(env.LOCALAPPDATA ?? home, "StakeMode"), label: "StakeMode preview (standalone)" },
    { kind: "stakemode", root: join(applicationData, "com.solomongs.stakemode"), label: "StakeMode preview (desktop)" },
    { kind: "gamebrowser", root: join(applicationData, "ng.solomon.gamebrowser"), label: "GameBrowser desktop" },
    { kind: "gamebrowser", root: join(env.LOCALAPPDATA ?? home, "GameBrowser"), label: "GameBrowser standalone" },
  ];
  const seen = new Set<string>();
  return candidates.map(candidate => ({ ...candidate, root: resolve(candidate.root) })).filter(candidate => {
    const key = platform === "win32" ? candidate.root.toLowerCase() : candidate.root;
    if (seen.has(key) || samePath(candidate.root, resolve(destinationRoot))) return false;
    seen.add(key);
    try { noLinkedAncestors(candidate.root); return lstatSync(join(candidate.root, "profiles.sqlite")).isFile() && !lstatSync(join(candidate.root, "profiles.sqlite")).isSymbolicLink(); } catch { return false; }
  });
}

/** Produces a reviewable plan without opening either installation for writing. */
export async function planStateImport(sourceRoot: string, destinationRoot: string, options: StateImportOptions = {}): Promise<StateImportPlan> {
  const { source, destination } = checkedRoots(sourceRoot, destinationRoot);
  emptyDestination(destination);
  const inspection = await inspect(source, destination, options);
  const files = inspection.entries.filter(entry => !entry.directory);
  return Object.freeze({ version: 1 as const, sourceRoot: source, destinationRoot: destination,
    profileCount: inspection.profileCount, fileCount: files.length, bytes: files.reduce((sum, entry) => sum + entry.bytes, 0), sourceFingerprint: inspection.fingerprint,
    excludedFiles: Object.freeze([...TRANSIENT].filter(path => existsSync(join(source, path)))), sameWindowsAccountRequired: true as const });
}

/** Copies the entire compatible root into a new directory. The source is never changed. */
export async function importState(plan: StateImportPlan, options: StateImportOptions = {}): Promise<StateImportResult> {
  if (plan.version !== 1 || typeof plan.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(plan.sourceFingerprint)) throw new Error("Create a fresh state import plan first");
  const { source, destination } = checkedRoots(plan.sourceRoot, plan.destinationRoot);
  emptyDestination(destination);
  const initial = await inspect(source, destination, options);
  if (initial.fingerprint !== plan.sourceFingerprint || initial.profileCount !== plan.profileCount) throw new Error("Source changed after the import preview; create a fresh plan");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  noLinkedAncestors(dirname(destination));
  const lock = join(dirname(destination), `.${basename(destination)}.gamebrowser-import.lock`);
  const descriptor = openSync(lock, "wx", 0o600);
  let staging: string | undefined, backupRoot: string | undefined;
  const rename = options.rename ?? renameSync;
  try {
    staging = mkdtempSync(join(dirname(destination), `.${basename(destination)}.import-`));
    for (const entry of initial.entries) {
      const from = join(source, entry.path), target = join(staging, entry.path);
      if (!beneath(staging, target)) throw new Error("Staged import entry escapes its directory");
      const info = lstatSync(from);
      if (info.isSymbolicLink() || (entry.directory ? !info.isDirectory() : !info.isFile() || info.nlink > 1)) throw new Error("Source changed during import; create a fresh plan");
      if (entry.directory) mkdirSync(target, { mode: 0o700 });
      else { copyFileSync(from, target, constants.COPYFILE_EXCL); if (digestFile(target) !== entry.hash) throw new Error("Source changed while its files were copied; create a fresh plan"); }
    }
    const staged = await inspect(staging, destination, options);
    if (staged.fingerprint !== plan.sourceFingerprint || staged.profileCount !== plan.profileCount) throw new Error("Staged state did not match the import preview");
    const final = await inspect(source, destination, options);
    if (final.fingerprint !== plan.sourceFingerprint) throw new Error("Source changed during import; close the old application and create a fresh plan");
    emptyDestination(destination);
    const receiptName = `${RECEIPT_PREFIX}${randomUUID()}.json`;
    writeFileSync(join(staging, receiptName), JSON.stringify({ version: 1, importedAt: new Date().toISOString(), sourceRoot: source, sourceFingerprint: plan.sourceFingerprint, profileCount: plan.profileCount, excludedFiles: plan.excludedFiles }) + "\n", { flag: "wx", mode: 0o600 });
    if (existsSync(destination)) {
      backupRoot = `${destination}.pre-import-${randomUUID()}`;
      rename(destination, backupRoot);
    }
    try { rename(staging, destination); staging = undefined; }
    catch (error) {
      if (backupRoot && !existsSync(destination)) {
        try { rename(backupRoot, destination); backupRoot = undefined; }
        catch { throw new Error(`Import commit failed; original empty destination backup is retained at ${backupRoot}`); }
      }
      throw error;
    }
    return { status: "imported", profileCount: plan.profileCount, destinationRoot: destination, ...(backupRoot ? { backupRoot } : {}), receipt: join(destination, receiptName) };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    closeSync(descriptor); rmSync(lock, { force: true });
  }
}

/** UI-only discovery. A detected source is not a promise that an offline copy is safe. */
export async function getStateImportStatus(destinationRoot: string, options: StateImportDiscoveryOptions = {}) {
  const currentRoot = resolve(destinationRoot);
  const sources = detectStateImportCandidates(currentRoot, options).map(candidate => {
    const id = createHash("sha256").update(candidate.root).digest("hex").slice(0, 24);
    try { return { id, kind: candidate.kind, label: candidate.label, path: candidate.root, profileCount: databaseProfiles(candidate.root).length, status: "detected" as const }; }
    catch (error) { return { id, kind: candidate.kind, label: candidate.label, path: candidate.root, profileCount: 0, status: "blocked" as const, reason: error instanceof Error ? error.message : "Source could not be read safely" }; }
  });
  let imported = false;
  try { imported = readdirSync(currentRoot).some(name => name.startsWith(RECEIPT_PREFIX) && name.endsWith(".json")); } catch {}
  return { currentRoot, legacyFound: sources.some(source => source.kind === "stakemode"), imported, sources, requiresNewEmptyRoot: true as const,
    command: "bun GameBrowser-cli.ts import-state --source PATH --state-root NEW_EMPTY_ROOT --confirm-copy" };
}
