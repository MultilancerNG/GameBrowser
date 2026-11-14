import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingSyncQueue, PendingSyncRuntime } from "../pending-sync.ts";
import { encodePortableProfile } from "../portable-profile.ts";
import { buildNewProfile } from "../create.ts";
import { initializeBoundPendingQueue } from "./queue-service-binding.ts";

const roots: string[] = [], runtimes: PendingSyncRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const firstService = "https://first.example.test", otherService = "https://other.example.test";
function setup(native = true) {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-queue-service-")); roots.push(root);
  const path = join(root, "pending-sync.sqlite"), keyPath = native ? undefined : join(root, "pending-sync.key");
  const runtime = new PendingSyncRuntime(path, keyPath); runtimes.push(runtime);
  return { root, path, runtime };
}
function bind(fixture: ReturnType<typeof setup>, baseUrl = firstService, queueKey?: string) { return initializeBoundPendingQueue({ root: fixture.root, runtime: fixture.runtime, baseUrl, queueKey }); }
function open(queue: PendingSyncQueue, accountId = "another-account") { queue.recordOpen({ accountId, profileId: "retained", registrationId: "private-registration", expectedVersion: 4 }); }
function close(queue: PendingSyncQueue) {
  const profile = { ...buildNewProfile({ name: "Private capture", engine: "chromium", screen: "1280x720" }, () => false), id: "retained" };
  return queue.enqueue({ accountId: "another-account", profileId: profile.id, registrationId: "private-registration", expectedVersion: 4, payload: encodePortableProfile(profile) });
}

test("an empty queue binds to a canonical service and retains native key delivery without writing its key", () => {
  const f = setup(), result = bind(f, "https://FIRST.example.test:443/");
  expect(JSON.parse(readFileSync(join(f.root, "pending-sync-service.json"), "utf8"))).toEqual({ version: 1, baseUrl: firstService });
  expect(Buffer.from(result.createdKey!, "base64")).toHaveLength(32); expect(existsSync(join(f.root, "pending-sync.key"))).toBe(false);
  if (process.platform !== "win32") expect(statSync(join(f.root, "pending-sync-service.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(f.root).some(name => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
  open(result.queue); f.runtime.close();
  expect(bind(f, firstService, result.createdKey).queue.getOpen("retained", "another-account")?.registrationId).toBe("private-registration");
});

test.each(["open", "ready-close"])("a bound service cannot change while any account retains an encrypted %s", kind => {
  const f = setup(), first = bind(f);
  const pending = kind === "open" ? (open(first.queue), undefined) : close(first.queue);
  const before = readFileSync(join(f.root, "pending-sync-service.json"));
  f.runtime.close();
  expect(() => bind(f, otherService, first.createdKey)).toThrow("original configured service");
  expect(f.runtime.queue()).toBeUndefined(); expect(readFileSync(join(f.root, "pending-sync-service.json"))).toEqual(before);
  const recovered = bind(f, firstService, first.createdKey).queue;
  if (pending) expect(recovered.get(pending, "another-account")?.registrationId).toBe("private-registration");
  else expect(recovered.getOpen("retained", "another-account")?.registrationId).toBe("private-registration");
});

test("an empty queue may rebind after the previous service has no opens or closes", () => {
  const f = setup(false); bind(f); f.runtime.close(); bind(f, otherService);
  expect(JSON.parse(readFileSync(join(f.root, "pending-sync-service.json"), "utf8")).baseUrl).toBe(otherService);
});

test("unbound legacy encrypted state only binds to a matching valid original config cloudUrl", () => {
  const f = setup(), original = f.runtime.initialize(); open(original.queue); f.runtime.close();
  writeFileSync(join(f.root, "gamebrowser-settings.json"), JSON.stringify({ version: 1, cloud: { baseUrl: firstService } }));
  expect(() => bind(f, firstService, original.createdKey)).toThrow("unknown Cloud service");
  writeFileSync(join(f.root, "config.json"), JSON.stringify({ version: 1, mode: "cloud", cloudUrl: otherService, localAnalytics: false }));
  expect(() => bind(f, firstService, original.createdKey)).toThrow("original configured service");
  writeFileSync(join(f.root, "config.json"), JSON.stringify({ version: 1, mode: "cloud", cloudUrl: firstService, localAnalytics: false }));
  expect(bind(f, firstService, original.createdKey).queue.getOpen("retained", "another-account")).not.toBeNull();
});

test("a malformed or linked binding is refused without replacing it or losing captures", () => {
  const f = setup(false), target = join(f.root, "outside-record.json");
  writeFileSync(join(f.root, "pending-sync-service.json"), "malformed original record");
  expect(() => bind(f)).toThrow("could not be verified");
  expect(readFileSync(join(f.root, "pending-sync-service.json"), "utf8")).toBe("malformed original record");
  rmSync(join(f.root, "pending-sync-service.json"));
  writeFileSync(target, JSON.stringify({ version: 1, baseUrl: firstService }));
  if (process.platform === "win32") {
    const linkedDirectory = join(f.root, "linked-record"); mkdirSync(linkedDirectory);
    symlinkSync(linkedDirectory, join(f.root, "pending-sync-service.json"), "junction");
  } else symlinkSync(target, join(f.root, "pending-sync-service.json"));
  expect(() => bind(f)).toThrow("could not be verified");
  expect(JSON.parse(readFileSync(target, "utf8")).baseUrl).toBe(firstService);
});

test("newly appearing encrypted state prevents rebind before a coordinator can receive the queue", () => {
  const f = setup(false), initialize = f.runtime.initialize.bind(f.runtime);
  const hook = spyOn(f.runtime, "initialize").mockImplementation(key => { const result = initialize(key); open(result.queue); return result; });
  try { expect(() => bind(f)).toThrow("encrypted queue was preserved"); }
  finally { hook.mockRestore(); }
  expect(f.runtime.queue()).toBeUndefined(); expect(existsSync(join(f.root, "pending-sync-service.json"))).toBe(false);
  const key = Buffer.from(readFileSync(join(f.root, "pending-sync.key"), "utf8").trim(), "base64"), recovered = new PendingSyncQueue(f.path, key);
  try { expect(recovered.getOpen("retained", "another-account")).not.toBeNull(); } finally { recovered.close(); }
});

test("unsafe URLs and an unfinished binding lock fail before a queue is initialized", () => {
  const f = setup();
  for (const baseUrl of ["http://remote.example.test", "https://user:secret@example.test", "https://example.test/?token=private", "https://example.test/#private"]) expect(() => bind(f, baseUrl)).toThrow();
  writeFileSync(join(f.root, ".pending-sync-service.lock"), "retained recovery lock");
  expect(() => bind(f)).toThrow("lock needs recovery");
  expect(f.runtime.queue()).toBeUndefined(); expect(existsSync(f.path)).toBe(false);
});

test.each(["-wal", "-shm", "-journal"])("an orphan database %s is preserved rather than treated as an empty service queue", suffix => {
  const f = setup(), sidecar = `${f.path}${suffix}`, before = Buffer.from("retained incomplete database fixture");
  writeFileSync(sidecar, before);
  expect(() => bind(f)).toThrow();
  expect(existsSync(f.path)).toBe(false); expect(readFileSync(sidecar)).toEqual(before);
  expect(existsSync(join(f.root, "pending-sync-service.json"))).toBe(false);
});
