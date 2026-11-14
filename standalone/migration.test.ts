import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectStateImportCandidates, getStateImportStatus, importState, planStateImport, type StateImportOptions } from "./migration.ts";

const temporaryRoots: string[] = [];
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stopped: StateImportOptions = { scanProcesses: async () => ({ records: [], incomplete: false }), validateDpapi: async () => {} };
const chromeId = "A" + "b".repeat(127);
function write(root: string, path: string, content: string | Buffer): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-import-test-")); temporaryRoots.push(root);
  const source = join(root, "StakeMode"), destination = join(root, "GameBrowser"); mkdirSync(source);
  const database = new Database(join(source, "profiles.sqlite"));
  database.exec("CREATE TABLE profiles(id TEXT PRIMARY KEY,name TEXT,fingerprint_seed INTEGER,engine TEXT,seeded INTEGER,future_blob BLOB); CREATE TABLE launches(profile_id TEXT,pid INTEGER); CREATE TABLE future_table(value TEXT)");
  database.query("INSERT INTO profiles VALUES(?,?,?,?,?,?)").run(chromeId, "Original Admin", 424242, "chromium", 1, Buffer.from([0, 255, 17]));
  database.query("INSERT INTO profiles VALUES(?,?,?,?,?,?)").run("FireFox", "Original follower", 777777, "firefox", 1, Buffer.from([4, 5, 6]));
  database.exec("INSERT INTO future_table VALUES('preserve unknown schema too')"); database.close();
  write(source, `profiles/${chromeId}/Local State`, JSON.stringify({ os_crypt: { encrypted_key: Buffer.from("DPAPI-fixture-key").toString("base64") } }));
  write(source, `profiles/${chromeId}/Default/Cookies`, Buffer.from([1, 4, 7, 0, 255]));
  write(source, `profiles/${chromeId}/Default/Bookmarks`, '{"roots":{"bookmark_bar":{"children":[{"url":"https://example.com"}]}}}');
  write(source, `profiles/${chromeId}/Default/Local Storage/leveldb/000004.ldb`, Buffer.from([8, 7, 6]));
  write(source, "profiles/FireFox/sessionstore-backups/recovery.jsonlz4", Buffer.from([100, 101, 102]));
  write(source, "profiles/FireFox/prefs.js", 'user_pref("browser.startup.page", 3);');
  for (const directory of ["workspace", "live-workspace/local/workspace"]) {
    for (const name of ["settings.json", "library.json", "proxies.json", "workflows.json", "extensions/registry.json", "extensions/library/addon/source/manifest.json"]) {
      write(source, `${directory}/${name}`, JSON.stringify({ original: directory, path: name, privateFixture: true }));
    }
  }
  write(source, "config.json", '{"version":1,"mode":"local"}');
  write(source, ".operator-id", "original-device-id\n");
  write(source, "agent-runtime.json", '{"transientGeneration":"not-user-data"}');
  return { root, source, destination };
}
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string, prefix: string) => {
    for (const name of readdirSync(path).sort()) {
      const suffix = prefix ? `${prefix}/${name}` : name, file = join(path, name);
      if (statSync(file).isDirectory()) { result[`${suffix}/`] = "directory"; visit(file, suffix); }
      else result[suffix] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  };
  visit(root, ""); return result;
}

test("offline full-root import preserves profile identities, browser bytes and both original and beta82 workspace layouts", async () => {
  const { source, destination } = fixture(), before = tree(source);
  const plan = await planStateImport(source, destination, stopped);
  expect(plan.profileCount).toBe(2); expect(plan.fileCount).toBeGreaterThan(15); expect(plan.bytes).toBeGreaterThan(0);
  expect(plan.excludedFiles).toEqual(["agent-runtime.json"]); expect(Object.isFrozen(plan)).toBe(true); expect(existsSync(destination)).toBe(false);
  expect(tree(source)).toEqual(before);
  const result = await importState(plan, stopped);
  expect(result.status).toBe("imported"); expect(result.profileCount).toBe(2); expect(tree(source)).toEqual(before);
  const copied = tree(destination), expected = { ...before }; delete expected["agent-runtime.json"];
  delete copied[result.receipt.split(/[\\/]/).at(-1)!]; expect(copied).toEqual(expected);
  const db = new Database(join(destination, "profiles.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT name,fingerprint_seed,future_blob FROM profiles WHERE id=?").get(chromeId)).toEqual({ name: "Original Admin", fingerprint_seed: 424242, future_blob: new Uint8Array([0, 255, 17]) });
    expect(db.query("SELECT value FROM future_table").get()).toEqual({ value: "preserve unknown schema too" });
  } finally { db.close(); }
  expect((await getStateImportStatus(destination)).imported).toBe(true);
  await expect(importState(plan, stopped)).rejects.toThrow("already contains");
});

test("destination contents, nested roots and source links cannot be overwritten or followed", async () => {
  const { source, destination, root } = fixture();
  mkdirSync(destination); write(destination, "keep-me.txt", "original destination");
  await expect(planStateImport(source, destination, stopped)).rejects.toThrow("already contains");
  expect(readFileSync(join(destination, "keep-me.txt"), "utf8")).toBe("original destination");
  await expect(planStateImport(source, join(source, "nested"), stopped)).rejects.toThrow("without nesting");
  await expect(planStateImport(source, root, stopped)).rejects.toThrow("without nesting");
  const external = join(root, "outside"); mkdirSync(external); write(external, "private.txt", "never follow");
  symlinkSync(external, join(source, "linked"), process.platform === "win32" ? "junction" : "dir");
  await expect(planStateImport(source, join(root, "clean"), stopped)).rejects.toThrow("symbolic link");
  rmSync(join(source, "linked"));
  const linkedSource = join(root, "alias"); symlinkSync(source, linkedSource, process.platform === "win32" ? "junction" : "dir");
  await expect(planStateImport(linkedSource, join(root, "clean"), stopped)).rejects.toThrow("junctions");
  linkSync(join(source, "config.json"), join(source, "hard-linked-config"));
  await expect(planStateImport(source, join(root, "clean"), stopped)).rejects.toThrow("hard link");
});

test("incomplete and unknown ownership scans and active Chromium, Firefox and app processes fail closed", async () => {
  const { source, destination } = fixture();
  for (const snapshot of [null, { incomplete: true, records: [] },
    { incomplete: false, records: [{ pid: 99901, processName: "firefox", executablePath: null }] },
    { incomplete: false, records: [{ pid: 99901, processName: "chrome", executablePath: "/opt/chrome", argv: ["chrome", "--user-data-dir", join(source, "profiles", chromeId)] }] },
    { incomplete: false, records: [{ pid: 99901, processName: "firefox", executablePath: "/opt/firefox", commandLine: `firefox -profile "${join(source, "profiles", "FireFox")}"` }] },
    { incomplete: false, records: [{ pid: 99901, processName: "bun", executablePath: "/opt/bun", argv: ["bun", "GameBrowser-cli.ts", "start"] }] },
    { incomplete: false, records: [{ pid: 99901, processName: "bun", executablePath: "/opt/bun", argv: ["bun", "StakeMode-cli.ts"] }] },
    { incomplete: false, records: [{ pid: 99901, processName: "node", executablePath: null }] },
    { incomplete: false, records: [{ pid: 99901, processName: "GameBrowser.exe", executablePath: "C:/Apps/GameBrowser.exe", argv: [] }] },
    { incomplete: false, records: [{ pid: 99901, processName: "firefox", executablePath: "/opt/firefox", argv: ["firefox", "-profile", "relative/unknown"] }] },
  ]) await expect(planStateImport(source, destination, { ...stopped, scanProcesses: async () => snapshot })).rejects.toThrow();
  const unknownOwner = { incomplete: false, records: [{ pid: 99901, processName: "unidentified", executablePath: null, argv: ["browser", `--user-data-dir=${source}/profiles/${chromeId}`] }] };
  await expect(planStateImport(source, destination, { ...stopped, scanProcesses: async () => unknownOwner })).rejects.toThrow("still uses");
  expect(existsSync(destination)).toBe(false);
});

test("source launch records and unsafe profile IDs reject metadata-only or ambiguous copies", async () => {
  const { source, destination } = fixture();
  const db = new Database(join(source, "profiles.sqlite")); db.exec("INSERT INTO launches VALUES('FireFox',1234)"); db.close();
  await expect(planStateImport(source, destination, stopped)).rejects.toThrow("launch records");
  const again = new Database(join(source, "profiles.sqlite")); again.exec("DELETE FROM launches; UPDATE profiles SET id='CON' WHERE id='FireFox'"); again.close();
  await expect(planStateImport(source, destination, stopped)).rejects.toThrow("unsafe");
  expect(existsSync(destination)).toBe(false);
});

test("missing initialized browser state and unrecognized profile folders are refused", async () => {
  const { source, destination } = fixture();
  rmSync(join(source, "profiles", "FireFox"), { recursive: true });
  await expect(planStateImport(source, destination, stopped)).rejects.toThrow("metadata-only");
  mkdirSync(join(source, "profiles", "Unknown"));
  await expect(planStateImport(source, destination, stopped)).rejects.toThrow("unrecognized");
});

test("Windows encrypted browser secrets require the Windows account proof", async () => {
  const { source, destination } = fixture();
  let checked: string[] = [];
  await planStateImport(source, destination, { ...stopped, validateDpapi: async paths => { checked = paths; } });
  expect(checked).toContain(join(source, "profiles", chromeId, "Local State"));
  if (process.platform !== "win32") {
    await expect(planStateImport(source, destination, { scanProcesses: stopped.scanProcesses })).rejects.toThrow("same Windows machine and account");
  }
  expect(existsSync(destination)).toBe(false);
});

test("a changed preview, changed process proof or failed secret verification never commits", async () => {
  const { source, destination } = fixture();
  const plan = await planStateImport(source, destination, stopped);
  write(source, "workspace/new-setting.json", "changed");
  await expect(importState(plan, stopped)).rejects.toThrow("Source changed");
  rmSync(join(source, "workspace", "new-setting.json"));
  let scans = 0;
  await expect(importState(plan, { ...stopped, scanProcesses: async () => (++scans < 3 ? { incomplete: false, records: [] } : null) })).rejects.toThrow("ownership");
  await expect(importState(plan, { ...stopped, validateDpapi: async () => { throw new Error("same machine and Windows account required"); } })).rejects.toThrow("Windows account");
  expect(existsSync(destination)).toBe(false);
});

test("empty destination is backed up and a failed commit rolls it back without touching source", async () => {
  const { source, destination, root } = fixture(); mkdirSync(destination);
  const before = tree(source), plan = await planStateImport(source, destination, stopped);
  await expect(importState(plan, { ...stopped, rename: (from, to) => { if (from.includes(".import-")) throw new Error("commit fixture failure"); renameSync(from, to); } })).rejects.toThrow("commit fixture");
  expect(readdirSync(destination)).toEqual([]); expect(tree(source)).toEqual(before);
  expect(readdirSync(root).some(name => name.endsWith(".gamebrowser-import.lock") || name.includes(".import-"))).toBe(false);
  const result = await importState(plan, stopped);
  expect(result.backupRoot).toBeDefined(); expect(readdirSync(result.backupRoot!)).toEqual([]);
});

test("discovery includes original standalone/native roots and beta82 native root while excluding the running destination", async () => {
  const { source, root } = fixture();
  const local = join(root, "Local"), roaming = join(root, "Roaming");
  const roots = [join(local, "StakeMode"), join(roaming, "com.solomongs.stakemode"), join(roaming, "ng.solomon.gamebrowser")];
  for (const path of roots) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, "profiles.sqlite"), readFileSync(join(source, "profiles.sqlite"))); }
  const options = { env: { LOCALAPPDATA: local, APPDATA: roaming }, home: root, platform: "win32" as const };
  expect(detectStateImportCandidates(roots[2]!, options).map(candidate => candidate.root)).toEqual(roots.slice(0, 2));
  const status = await getStateImportStatus(roots[2]!, options);
  expect(status.legacyFound).toBe(true); expect(status.sources).toHaveLength(2); expect(status.sources.every(candidate => candidate.profileCount === 2)).toBe(true);
  expect(status.requiresNewEmptyRoot).toBe(true); expect(status.command).toContain("--confirm-copy");
});
