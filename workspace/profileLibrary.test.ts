import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookmarkUrl, MAX_TEMPLATE_BYTES, parseTemplateDocument, ProfileLibrary } from "./profileLibrary.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stakemode-library-test-"));
  const ids = new Set(["profile_one", "profile_two", "profile_three"]);
  const exists = (id: string) => ids.has(id);
  const library = new ProfileLibrary(root, exists);
  return { root, ids, exists, library, file: join(root, "workspace", "library.json"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function template(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Browser One", engine: "chromium", urls: ["https://example.com/dashboard"], ramMb: 2048, heapMb: 512,
    screenWidth: 1366, screenHeight: 768, networkMode: "direct", proxy: null,
    group: null, tags: [], notes: "", bookmarks: [], ...overrides };
}
function document(profiles: unknown[] = [template()]): Record<string, unknown> {
  return { product: "StakeMode", version: 1, kind: "configuration-templates", profiles };
}

describe("local profile organization", () => {
  test("persists normalized metadata and returns isolated copies", () => {
    const f = fixture();
    try {
      expect(f.library.get("profile_one")).toEqual({ groupId: null, tags: [], notes: "", bookmarks: [] });
      const group = f.library.createGroup("  Research  ");
      const result = f.library.set("profile_one", { groupId: group.id, tags: ["Work", " Work ", "Review"], notes: "First line\nSecond line",
        bookmarks: [{ title: "  Saved page  ", url: "https://example.com/path?q=deliberate#saved", password: "not metadata" }], unexpected: "dropped" });
      expect(result).toEqual({ groupId: group.id, tags: ["Work", "Review"], notes: "First line\nSecond line", bookmarks: [{ title: "Saved page", url: "https://example.com/path?q=deliberate#saved" }] });
      result.tags.push("caller mutation"); result.bookmarks[0]!.title = "caller mutation";
      const listed = f.library.listGroups(); listed[0]!.name = "caller mutation";
      expect(f.library.get("profile_one").tags).toEqual(["Work", "Review"]);
      expect(f.library.get("profile_one").bookmarks[0]!.title).toBe("Saved page");
      expect(f.library.listGroups()).toEqual([{ id: group.id, name: "Research" }]);
      const reopened = new ProfileLibrary(f.root, f.exists);
      expect(reopened.get("profile_one")).toEqual(f.library.get("profile_one"));
      expect(reopened.listGroups()).toEqual(f.library.listGroups());
      expect(readdirSync(join(f.root, "workspace"))).toEqual(["library.json"]);
    } finally { f.cleanup(); }
  });

  test("group rename and deletion preserve unrelated profiles and all other metadata", () => {
    const f = fixture();
    try {
      const work = f.library.createGroup("Work"), privateGroup = f.library.createGroup("Private");
      f.library.set("profile_one", { groupId: work.id, tags: ["one"], notes: "retain one", bookmarks: [{ title: "One", url: "https://one.example/" }] });
      f.library.set("profile_two", { groupId: work.id, tags: ["two"], notes: "retain two" });
      f.library.set("profile_three", { groupId: privateGroup.id, notes: "unrelated" });
      const before = ["profile_one", "profile_two", "profile_three"].map(id => f.library.get(id));
      expect(f.library.renameGroup(work.id, "Operations")).toEqual({ id: work.id, name: "Operations" });
      f.library.deleteGroup(work.id);
      expect(f.library.get("profile_one")).toEqual({ ...before[0]!, groupId: null });
      expect(f.library.get("profile_two")).toEqual({ ...before[1]!, groupId: null });
      expect(f.library.get("profile_three")).toEqual(before[2]!);
      const reopened = new ProfileLibrary(f.root, f.exists);
      expect(reopened.listGroups()).toEqual([privateGroup]);
      for (const id of f.ids) expect(reopened.get(id)).toEqual(f.library.get(id));
      f.ids.delete("profile_one"); reopened.removeProfile("profile_one");
      const saved = JSON.parse(readFileSync(f.file, "utf8"));
      expect(saved.profiles.map((row: any) => row.id).sort()).toEqual(["profile_three", "profile_two"]);
      expect(new ProfileLibrary(f.root, f.exists).get("profile_two")).toEqual({ ...before[1]!, groupId: null });
    } finally { f.cleanup(); }
  });

  test("failed atomic replacement does not commit group or assignment changes", () => {
    const f = fixture();
    try {
      const group = f.library.createGroup("Retain"); f.library.set("profile_one", { groupId: group.id, notes: "Retain metadata" });
      const original = readFileSync(f.file, "utf8"), backup = `${f.file}.original`;
      renameSync(f.file, backup); mkdirSync(f.file);
      try {
        expect(() => f.library.deleteGroup(group.id)).toThrow();
        expect(f.library.listGroups()).toEqual([group]);
        expect(f.library.get("profile_one").groupId).toBe(group.id);
        expect(readdirSync(join(f.root, "workspace")).some(name => name.endsWith(".tmp"))).toBe(false);
      } finally { rmSync(f.file, { recursive: true, force: true }); renameSync(backup, f.file); }
      expect(readFileSync(f.file, "utf8")).toBe(original);
      expect(new ProfileLibrary(f.root, f.exists).get("profile_one").notes).toBe("Retain metadata");
    } finally { f.cleanup(); }
  });

  test("rejects duplicate group names, unsafe identities and invalid metadata without partial writes", () => {
    const f = fixture();
    try {
      const group = f.library.createGroup("Work"), other = f.library.createGroup("Other");
      expect(f.library.groupForName("wOrK")).toBe(group.id);
      expect(() => f.library.createGroup(" work ")).toThrow("already exists");
      expect(() => f.library.renameGroup(other.id, "WORK")).toThrow("already exists");
      expect(() => f.library.createGroup("bad\nname")).toThrow();
      for (const id of ["../escape", "nested/profile", "CON", "a\\b", "missing"]) expect(() => f.library.set(id, { notes: "invalid" })).toThrow();
      const saved = readFileSync(f.file, "utf8");
      for (const value of [{ groupId: "../escape" }, { groupId: "unknown" }, { tags: Array(25).fill("tag") }, { notes: "x".repeat(4097) }, { bookmarks: Array(65).fill({ title: "Page", url: "https://example.com/" }) }]) expect(() => f.library.set("profile_one", value)).toThrow();
      expect(readFileSync(f.file, "utf8")).toBe(saved);
      expect(f.library.get("profile_one")).toEqual({ groupId: null, tags: [], notes: "", bookmarks: [] });
    } finally { f.cleanup(); }
  });

  test("reload fails closed for corrupt duplicate identities and unknown group references", () => {
    const f = fixture();
    try {
      for (const value of [
        { version: 1, groups: [{ id: "group_one", name: "Work" }, { id: "group_two", name: "work" }], profiles: [] },
        { version: 1, groups: [], profiles: [{ id: "profile_one", metadata: { groupId: "missing" } }] },
        { version: 1, groups: [], profiles: [{ id: "profile_one", metadata: {} }, { id: "profile_one", metadata: {} }] },
        { version: 1, groups: [], profiles: [{ id: "../escape", metadata: {} }] },
      ]) {
        writeFileSync(f.file, JSON.stringify(value));
        expect(() => new ProfileLibrary(f.root, f.exists)).toThrow("invalid");
      }
    } finally { f.cleanup(); }
  });
});

describe("portable configuration templates", () => {
  test("exports an exact configuration allowlist and never account, launch or fingerprint state", () => {
    const f = fixture();
    try {
      const group = f.library.createGroup("Operators");
      f.library.set("profile_one", { groupId: group.id, tags: ["review"], notes: "Local note", bookmarks: [{ title: "Documentation", url: "https://docs.example/" }] });
      const input: any = { ...template({ networkMode: "proxy", proxy: { type: "socks5", host: "proxy.example", port: "1080", user: "proxy-secret-user", pass: "proxy-secret-pass" } }), id: "profile_one",
        fingerprint: { secretSeed: "fingerprint-secret" }, cookies: [{ value: "session-cookie-secret" }], launch: { pid: 123, token: "launch-secret" }, account: { password: "account-secret", twoFactor: "otp-secret" }, extensions: ["extension-secret"], arbitrary: "arbitrary-secret" };
      const exported = f.library.export([input]);
      expect(exported as unknown).toEqual({ ...document([template({ networkMode: "proxy", proxy: { type: "socks5", host: "proxy.example", port: "1080" }, group: "Operators", tags: ["review"], notes: "Local note", bookmarks: [{ title: "Documentation", url: "https://docs.example/" }] })]), product: "GameBrowser" });
      const serialized = JSON.stringify(exported);
      for (const forbidden of ["profile_one", "proxy-secret", "fingerprint", "cookies", "launch", "account", "otp-secret", "extension-secret", "arbitrary-secret"]) expect(serialized).not.toContain(forbidden);
      expect(parseTemplateDocument(JSON.parse(serialized))).toEqual(exported);
      expect(input.proxy.user).toBe("proxy-secret-user");
    } finally { f.cleanup(); }
  });

  test("parser drops foreign identity/session fields and retains duplicate display names without IDs", () => {
    const first = template({ id: "old-profile-id", fingerprint: "old-fingerprint", cookies: ["old-cookie"], launch: { pid: 7 }, account: { password: "old-password" }, extensions: ["old-extension"] });
    const parsed = parseTemplateDocument({ ...document([first, template()]), token: "old-token", credentials: "old-credentials" });
    expect(parsed.product).toBe("GameBrowser");
    expect(parseTemplateDocument({ ...document(), product: "GameBrowser" }).product).toBe("GameBrowser");
    expect(() => parseTemplateDocument({ ...document(), product: ["GameBrowser"] })).toThrow();
    expect(parsed.profiles).toHaveLength(2);
    expect(parsed.profiles[0] as unknown).toEqual(template());
    expect(parsed.profiles[1]!.name).toBe(parsed.profiles[0]!.name);
    const serialized = JSON.stringify(parsed);
    for (const value of ["old-profile-id", "old-fingerprint", "old-cookie", "old-password", "old-extension", "old-token", "old-credentials"]) expect(serialized).not.toContain(value);
  });

  test("rejects credential-bearing proxy templates and invalid engine, resource and document boundaries", () => {
    for (const proxy of [{ type: "http", host: "proxy.example", port: "8080", user: "name", pass: "secret" }, "socks5://name:secret@proxy.example:1080", { type: "http", host: "", port: "", user: "name", pass: "secret" }]) {
      expect(() => parseTemplateDocument(document([template({ proxy })]))).toThrow();
    }
    for (const changes of [{ engine: "unknown" }, { networkMode: "vpn" }, { networkMode: "proxy", proxy: null }, { ramMb: 511 }, { heapMb: 4096 }, { screenWidth: 319 }, { screenHeight: 199 }, { screenWidth: 4097 }, { screenHeight: 4097 }, { name: "\nInjected" }, { tags: ["bad\ntag"] }, { urls: ["https://example.com/?session=secret"] }]) expect(() => parseTemplateDocument(document([template(changes)]))).toThrow();
    for (const value of [{ ...document(), product: "AliasMode" }, { ...document(), version: 2 }, document([]), document(Array.from({ length: 257 }, () => template())), { ...document(), junk: "x".repeat(MAX_TEMPLATE_BYTES) }]) expect(() => parseTemplateDocument(value)).toThrow();
  });

  test("bookmark URLs keep deliberate query/fragment saves and reject unsafe navigation or control injection", () => {
    expect(bookmarkUrl("https://example.com/saved?q=chosen#section")).toBe("https://example.com/saved?q=chosen#section");
    expect(bookmarkUrl("http://127.0.0.1:4321/fixture")).toBe("http://127.0.0.1:4321/fixture");
    for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///C:/secret", "chrome://settings", "//example.com/path", "http://remote.example/", "https://name:secret@example.com/", "https://exa\nmple.com/", "https://example.com/\u0000path"]) expect(() => bookmarkUrl(url)).toThrow();
  });
});
