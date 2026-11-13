/** Local organization and portable configuration templates; never account sessions. */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { assertSafeProfileId } from "../profile-id.ts";
import { normalizeWorkspacePolicy, normalizeWorkspaceUrl, parseWorkspaceProxy } from "./profileStore.ts";
import type { ProxySpec } from "../types.ts";
import { validateDesktopScreen } from "./displayPolicy.ts";

export const MAX_TEMPLATE_BYTES = 1024 * 1024;
const MAX_LIBRARY_BYTES = 8 * 1024 * 1024;
export interface ProfileGroup { id: string; name: string; }
export interface Bookmark { title: string; url: string; }
export interface ProfileMetadata { groupId: string | null; tags: string[]; notes: string; bookmarks: Bookmark[]; }
export interface ProfileTemplate {
  name: string; engine: "chromium" | "firefox"; urls: string[];
  ramMb: number; heapMb: number; screenWidth: number; screenHeight: number;
  networkMode: "direct" | "system" | "proxy"; proxy: Pick<ProxySpec, "type" | "host" | "port"> | null;
  group: string | null; tags: string[]; notes: string; bookmarks: Bookmark[];
}
export interface TemplateDocument { product: "GameBrowser"; version: 1; kind: "configuration-templates"; profiles: ProfileTemplate[]; }
const EMPTY: ProfileMetadata = { groupId: null, tags: [], notes: "", bookmarks: [] };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a configuration object");
  return value as Record<string, unknown>;
}
function label(value: unknown, what: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${what} must contain 1 to ${limit} printable characters`);
  return value.trim();
}
/** Bookmarks are deliberate user saves; automatic address state is never persisted. */
export function bookmarkUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Bookmark URL is invalid");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Bookmark URL is invalid"); }
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Bookmarks require HTTPS or loopback HTTP without credentials");
  return url.href;
}
function metadata(value: unknown, fallback: ProfileMetadata = EMPTY): ProfileMetadata {
  const raw = { ...fallback, ...object(value) };
  if (raw.groupId !== null) assertSafeProfileId(raw.groupId as string);
  if (!Array.isArray(raw.tags) || raw.tags.length > 24) throw new Error("Use at most 24 profile tags");
  const tags = [...new Set(raw.tags.map(tag => label(tag, "Tag", 40)))];
  if (typeof raw.notes !== "string" || raw.notes.length > 4096 || /\u0000/.test(raw.notes)) throw new Error("Profile notes must be at most 4096 characters");
  if (!Array.isArray(raw.bookmarks) || raw.bookmarks.length > 64) throw new Error("Use at most 64 bookmarks per profile");
  const bookmarks = raw.bookmarks.map(entry => { const item = object(entry); return { title: label(item.title, "Bookmark title", 120), url: bookmarkUrl(item.url) }; });
  return { groupId: raw.groupId as string | null, tags, notes: raw.notes, bookmarks };
}
export function parseTemplateDocument(value: unknown): TemplateDocument {
  const raw = object(value);
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_TEMPLATE_BYTES) throw new Error("Configuration import exceeds 1 MB; import fewer profiles at once");
  if ((raw.product !== "GameBrowser" && raw.product !== "StakeMode") || raw.version !== 1 || raw.kind !== "configuration-templates" || !Array.isArray(raw.profiles) || !raw.profiles.length || raw.profiles.length > 256) throw new Error("Use a GameBrowser configuration template containing 1 to 256 profiles");
  const profiles = raw.profiles.map((entry): ProfileTemplate => {
    const item = object(entry);
    if (item.engine !== "chromium" && item.engine !== "firefox") throw new Error("Template engine is invalid");
    const policy = normalizeWorkspacePolicy({ urls: item.urls as string[], ramMb: item.ramMb as number, heapMb: item.heapMb as number });
    if (!["direct", "system", "proxy"].includes(String(item.networkMode))) throw new Error("Template network mode is invalid");
    const rawProxy = item.proxy !== null && typeof item.proxy === "object" ? object(item.proxy) : undefined;
    if (rawProxy && ((rawProxy.user ?? "") !== "" || (rawProxy.pass ?? "") !== "")) throw new Error("Configuration templates must not contain proxy credentials");
    const parsedProxy = parseWorkspaceProxy(item.proxy as ProxySpec | null);
    if (parsedProxy?.user || parsedProxy?.pass) throw new Error("Configuration templates must not contain proxy credentials");
    if (item.networkMode === "proxy" && !parsedProxy) throw new Error("Proxy templates require a proxy endpoint");
    const meta = metadata({ tags: item.tags ?? [], notes: item.notes ?? "", bookmarks: item.bookmarks ?? [] });
    const screen = validateDesktopScreen({ width: item.screenWidth, height: item.screenHeight });
    return { name: label(item.name, "Profile name", 80), engine: item.engine, urls: policy.urls.map(normalizeWorkspaceUrl),
      ramMb: policy.ramMb, heapMb: policy.heapMb, screenWidth: screen.width, screenHeight: screen.height,
      networkMode: item.networkMode as ProfileTemplate["networkMode"], proxy: parsedProxy ? { type: parsedProxy.type, host: parsedProxy.host, port: parsedProxy.port } : null,
      group: item.group == null ? null : label(item.group, "Group name", 80), tags: meta.tags, notes: meta.notes, bookmarks: meta.bookmarks };
  });
  return { product: "GameBrowser", version: 1, kind: "configuration-templates", profiles };
}

export class ProfileLibrary {
  private readonly file: string;
  private groups = new Map<string, ProfileGroup>();
  private profiles = new Map<string, ProfileMetadata>();
  constructor(stateRoot: string, private exists: (id: string) => boolean) {
    const directory = join(resolve(stateRoot), "workspace");
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.file = join(directory, "library.json");
    let content: string;
    try { if (statSync(this.file).size > MAX_LIBRARY_BYTES) throw new Error(); content = readFileSync(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Local profile library is unavailable"); }
    try {
      const document = object(JSON.parse(content));
      if (document.version !== 1 || !Array.isArray(document.groups) || document.groups.length > 128 || !Array.isArray(document.profiles) || document.profiles.length > 256) throw new Error();
      for (const entry of document.groups) {
        const row = object(entry); assertSafeProfileId(row.id as string);
        if (this.groups.has(String(row.id))) throw new Error();
        const group = { id: String(row.id), name: label(row.name, "Group name", 80) };
        if ([...this.groups.values()].some(g => g.name.toLowerCase() === group.name.toLowerCase())) throw new Error();
        this.groups.set(group.id, group);
      }
      for (const entry of document.profiles) {
        const row = object(entry); assertSafeProfileId(row.id as string);
        const meta = metadata(row.metadata);
        if (meta.groupId && !this.groups.has(meta.groupId)) throw new Error();
        if (this.profiles.has(String(row.id))) throw new Error();
        if (this.exists(String(row.id))) this.profiles.set(String(row.id), meta);
      }
    } catch { throw new Error("Local profile library is invalid; repair it before editing profiles"); }
  }
  listGroups(): ProfileGroup[] { return structuredClone([...this.groups.values()]); }
  get(id: string): ProfileMetadata { this.require(id); return structuredClone(this.profiles.get(id) ?? EMPTY); }
  set(id: string, value: unknown): ProfileMetadata {
    this.require(id); const next = metadata(value, this.get(id));
    if (next.groupId && !this.groups.has(next.groupId)) throw new Error("Profile group was not found");
    const profiles = new Map(this.profiles); profiles.set(id, next); this.persist(this.groups, profiles); this.profiles = profiles;
    return structuredClone(next);
  }
  createGroup(name: unknown): ProfileGroup {
    const clean = label(name, "Group name", 80);
    if ([...this.groups.values()].some(group => group.name.toLowerCase() === clean.toLowerCase())) throw new Error("A group with this name already exists");
    if (this.groups.size >= 128) throw new Error("Use at most 128 profile groups");
    const group = { id: `group_${randomUUID().replaceAll("-", "")}`, name: clean };
    const groups = new Map(this.groups); groups.set(group.id, group); this.persist(groups, this.profiles); this.groups = groups; return { ...group };
  }
  renameGroup(id: string, name: unknown): ProfileGroup {
    assertSafeProfileId(id); if (!this.groups.has(id)) throw new Error("Profile group was not found");
    const clean = label(name, "Group name", 80);
    if ([...this.groups.values()].some(group => group.id !== id && group.name.toLowerCase() === clean.toLowerCase())) throw new Error("A group with this name already exists");
    const groups = new Map(this.groups), group = { id, name: clean }; groups.set(id, group); this.persist(groups, this.profiles); this.groups = groups; return { ...group };
  }
  deleteGroup(id: string): void {
    assertSafeProfileId(id); if (!this.groups.has(id)) throw new Error("Profile group was not found");
    const groups = new Map(this.groups), profiles = new Map(this.profiles); groups.delete(id);
    for (const [profileId, meta] of profiles) if (meta.groupId === id) profiles.set(profileId, { ...meta, groupId: null });
    this.persist(groups, profiles); this.groups = groups; this.profiles = profiles;
  }
  /** Internal deletion hook; the caller has already proved exclusive teardown. */
  removeProfile(id: string): void {
    assertSafeProfileId(id); const profiles = new Map(this.profiles); profiles.delete(id); this.persist(this.groups, profiles); this.profiles = profiles;
  }
  groupForName(name: string | null): string | null {
    return name === null ? null : [...this.groups.values()].find(g => g.name.toLowerCase() === name.toLowerCase())?.id ?? this.createGroup(name).id;
  }
  export(profiles: Array<{ id: string; name: string; engine: "chromium" | "firefox"; urls: string[]; ramMb: number; heapMb: number; screenWidth: number; screenHeight: number; networkMode: "direct" | "system" | "proxy"; proxy: { type: string; host: string; port: string } | null }>): TemplateDocument {
    const entries = profiles.map(profile => { const meta = this.get(profile.id); return { ...profile, id: undefined,
      proxy: profile.proxy ? { type: profile.proxy.type, host: profile.proxy.host, port: profile.proxy.port } : null,
      group: meta.groupId ? this.groups.get(meta.groupId)?.name ?? null : null, tags: meta.tags, notes: meta.notes, bookmarks: meta.bookmarks }; });
    // Parsing creates an exact export allowlist; fingerprints, credentials,
    // extensions, launch records and arbitrary caller fields cannot escape.
    return parseTemplateDocument({ product: "GameBrowser", version: 1, kind: "configuration-templates", profiles: entries });
  }
  private require(id: string): void { assertSafeProfileId(id); if (!this.exists(id)) throw new Error("Local profile was not found"); }
  private persist(groups: Map<string, ProfileGroup>, profiles: Map<string, ProfileMetadata>): void {
    const data = JSON.stringify({ version: 1, groups: [...groups.values()], profiles: [...profiles].map(([id, metadata]) => ({ id, metadata })) });
    if (Buffer.byteLength(data) > MAX_LIBRARY_BYTES) throw new Error("Local profile library exceeds 8 MB");
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, data, { flag: "wx", mode: 0o600 }); renameSync(temporary, this.file); }
    finally { rmSync(temporary, { force: true }); }
  }
}
