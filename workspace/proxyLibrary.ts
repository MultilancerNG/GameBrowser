/** Private local proxy credentials; public views contain routing metadata only. */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProxySpec } from "../types.ts";
import { assertSafeProfileId } from "../profile-id.ts";
import type { ProcessManager } from "./processManager.ts";
import { effectiveProfileProxy } from "./networkPolicy.ts";
import { parseWorkspaceProxy } from "./profileStore.ts";

export const MAX_SAVED_PROXIES = 256;
export const MAX_PROXY_IMPORT_BYTES = 1024 * 1024;
const MAX_STORAGE_BYTES = 2 * 1024 * 1024;
const ID = /^proxy_[a-f0-9]{32}$/;

export class ProxyLibraryError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503 = 400) { super(message); this.name = "ProxyLibraryError"; }
}
export interface SavedProxyView {
  id: string; alias: string; group: string; type: ProxySpec["type"]; host: string; port: string;
  authenticated: boolean; createdAt: number; updatedAt: number;
}
interface SavedProxy { id: string; alias: string; group: string; proxy: ProxySpec; createdAt: number; updatedAt: number; }
export type ProxyAssignmentManager = Pick<ProcessManager, "getProfile" | "canEditProfile" | "updateNetwork">;
export interface ProxyAssignmentResult { profileId: string; success: boolean; error?: string; }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProxyLibraryError("Proxy request must be an object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ProxyLibraryError("Proxy request contains an unsupported field");
}
function label(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.trim().length > 80 || (!allowEmpty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProxyLibraryError(`${name} must contain ${allowEmpty ? "0" : "1"} to 80 printable characters`);
  }
  return value.trim();
}
function endpoint(value: unknown): ProxySpec {
  try {
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
    } else {
      const raw = object(value); fields(raw, ["type", "host", "port", "user", "pass"]);
      if (Object.values(raw).some(item => typeof item !== "string" || Buffer.byteLength(item) > 2048 || /[\u0000-\u001f\u007f]/.test(item))) throw new Error();
    }
    const proxy = parseWorkspaceProxy(value as string | ProxySpec);
    if (!proxy || proxy.host.length > 253 || Buffer.byteLength(proxy.user) > 1024 || Buffer.byteLength(proxy.pass) > 2048
      || /[\u0000-\u001f\u007f]/.test(proxy.user + proxy.pass)) throw new Error();
    return effectiveProfileProxy({ proxy }, "proxy")!;
  } catch {
    throw new ProxyLibraryError("Invalid proxy endpoint; use HTTP, HTTPS, or SOCKS5. Authenticated HTTPS is unsupported");
  }
}
function view(entry: SavedProxy): SavedProxyView {
  return { id: entry.id, alias: entry.alias, group: entry.group, type: entry.proxy.type, host: entry.proxy.host,
    port: entry.proxy.port, authenticated: !!entry.proxy.user, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
}

export class ProxyLibrary {
  private readonly root: string;
  private readonly directory: string;
  private readonly file: string;
  private entries = new Map<string, SavedProxy>();
  constructor(stateRoot: string) {
    this.root = resolve(stateRoot); this.directory = join(this.root, "workspace"); this.file = join(this.directory, "proxies.json");
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) throw new Error();
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.assertStorage();
      const info = lstatSync(this.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORAGE_BYTES) throw new Error();
      const document = object(JSON.parse(readFileSync(this.file, "utf8")));
      if (document.version !== 1 || !Array.isArray(document.proxies) || document.proxies.length > MAX_SAVED_PROXIES) throw new Error();
      for (const value of document.proxies) {
        const raw = object(value);
        if (typeof raw.id !== "string" || !ID.test(raw.id) || this.entries.has(raw.id)
          || !Number.isSafeInteger(raw.createdAt) || Number(raw.createdAt) < 0
          || !Number.isSafeInteger(raw.updatedAt) || Number(raw.updatedAt) < Number(raw.createdAt)) throw new Error();
        const entry: SavedProxy = { id: raw.id, alias: label(raw.alias, "Proxy alias"), group: label(raw.group, "Proxy group", true),
          proxy: endpoint(raw.proxy), createdAt: Number(raw.createdAt), updatedAt: Number(raw.updatedAt) };
        this.assertUnique(entry.alias); this.entries.set(entry.id, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ProxyLibraryError("Local proxy library is unavailable or invalid; repair it before editing saved proxies", 503);
    }
  }
  list(): SavedProxyView[] { return [...this.entries.values()].map(view); }
  get(id: string): SavedProxyView { return view(this.require(id)); }
  create(value: unknown): SavedProxyView {
    const raw = object(value); fields(raw, ["alias", "group", "proxy"]);
    if (this.entries.size >= MAX_SAVED_PROXIES) throw new ProxyLibraryError("Use at most 256 saved proxies");
    const alias = label(raw.alias, "Proxy alias"); this.assertUnique(alias);
    const now = Date.now(), entry: SavedProxy = { id: `proxy_${randomUUID().replaceAll("-", "")}`, alias,
      group: label(raw.group ?? "", "Proxy group", true), proxy: endpoint(raw.proxy), createdAt: now, updatedAt: now };
    const next = new Map(this.entries); next.set(entry.id, entry); this.persist(next); return view(entry);
  }
  update(id: string, value: unknown): SavedProxyView {
    const current = this.require(id), raw = object(value); fields(raw, ["alias", "group", "proxy"]);
    if (!Object.keys(raw).length) throw new ProxyLibraryError("Proxy update must contain alias, group, or proxy");
    const alias = Object.hasOwn(raw, "alias") ? label(raw.alias, "Proxy alias") : current.alias; this.assertUnique(alias, id);
    const entry: SavedProxy = { ...current, alias, group: Object.hasOwn(raw, "group") ? label(raw.group, "Proxy group", true) : current.group,
      proxy: Object.hasOwn(raw, "proxy") ? endpoint(raw.proxy) : current.proxy, updatedAt: Math.max(Date.now(), current.updatedAt) };
    const next = new Map(this.entries); next.set(id, entry); this.persist(next); return view(entry);
  }
  delete(id: string): void {
    this.require(id); const next = new Map(this.entries); next.delete(id); this.persist(next);
    // Assignment copies endpoint/authentication into a profile. Registry removal
    // deliberately has no side effects on those independent profile settings.
  }
  importText(text: unknown, group: unknown = ""): SavedProxyView[] {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_PROXY_IMPORT_BYTES) throw new ProxyLibraryError("Proxy import must be text of at most 1 MB");
    const cleanGroup = label(group, "Proxy group", true);
    const lines = text.split(/\r\n|\r|\n/).map((value, index) => ({ value: value.trim(), line: index + 1 })).filter(item => item.value);
    if (!lines.length || lines.length > MAX_SAVED_PROXIES || this.entries.size + lines.length > MAX_SAVED_PROXIES) throw new ProxyLibraryError("Import 1 to 256 proxies within the saved proxy limit");
    const next = new Map(this.entries), imported: SavedProxy[] = []; let suffix = 1;
    for (const line of lines) {
      let proxy: ProxySpec;
      try { proxy = endpoint(line.value); } catch { throw new ProxyLibraryError(`Proxy import line ${line.line} is invalid; nothing was imported`); }
      while ([...next.values()].some(entry => entry.alias.toLowerCase() === `Proxy ${suffix}`.toLowerCase())) suffix++;
      const now = Date.now(), entry: SavedProxy = { id: `proxy_${randomUUID().replaceAll("-", "")}`, alias: `Proxy ${suffix++}`,
        group: cleanGroup, proxy, createdAt: now, updatedAt: now };
      next.set(entry.id, entry); imported.push(entry);
    }
    this.persist(next); return imported.map(view);
  }
  assign(id: string, profileIds: unknown, manager: ProxyAssignmentManager): ProxyAssignmentResult[] {
    const entry = this.require(id);
    if (!Array.isArray(profileIds) || !profileIds.length || profileIds.length > 256
      || profileIds.some(profileId => typeof profileId !== "string") || new Set(profileIds).size !== profileIds.length) throw new ProxyLibraryError("Choose 1 to 256 distinct profile IDs");
    for (const profileId of profileIds) {
      try { assertSafeProfileId(profileId); } catch { throw new ProxyLibraryError("Profile selection contains an invalid ID"); }
      if (!manager.getProfile(profileId)) throw new ProxyLibraryError("A selected profile was not found", 404);
      if (!manager.canEditProfile(profileId)) throw new ProxyLibraryError("Stop all selected profiles and finish lifecycle operations before assigning a proxy", 409);
    }
    const proxy = endpoint(entry.proxy);
    return profileIds.map((profileId: string) => {
      try { manager.updateNetwork(profileId, { networkMode: "proxy", proxy: { ...proxy } }); return { profileId, success: true }; }
      catch { return { profileId, success: false, error: "Proxy assignment could not finish; check that this profile remains stopped and local storage is available" }; }
    });
  }
  private require(id: string): SavedProxy {
    if (typeof id !== "string" || !ID.test(id)) throw new ProxyLibraryError("Saved proxy ID is invalid");
    const entry = this.entries.get(id); if (!entry) throw new ProxyLibraryError("Saved proxy was not found", 404); return entry;
  }
  private assertUnique(alias: string, except?: string): void {
    if ([...this.entries.values()].some(entry => entry.id !== except && entry.alias.toLowerCase() === alias.toLowerCase())) throw new ProxyLibraryError("A saved proxy with this alias already exists", 409);
  }
  private assertStorage(): void {
    for (const directory of [this.root, this.directory]) {
      const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    }
    try { const info = lstatSync(this.file); if (!info.isFile() || info.isSymbolicLink()) throw new Error(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private persist(entries: Map<string, SavedProxy>): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      this.assertStorage();
      const content = JSON.stringify({ version: 1, proxies: [...entries.values()] });
      if (Buffer.byteLength(content) > MAX_STORAGE_BYTES) throw new Error();
      writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file); this.entries = entries;
    } catch { throw new ProxyLibraryError("Local proxy library could not be saved; no saved proxy changes were applied", 503); }
    finally { rmSync(temporary, { force: true }); }
  }
}
