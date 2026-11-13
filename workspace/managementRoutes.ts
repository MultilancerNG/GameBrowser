/** Authenticated by the workspace before entry; extra local management surfaces. */
import type { ProcessManager } from "./processManager.ts";
import type { BrowserBridge } from "./browserBridge.ts";
import type { SyncRelay } from "./syncRelay.ts";
import { ExtensionManager, type ExtensionAssignment } from "./extensionManager.ts";
import { MAX_TEMPLATE_BYTES, parseTemplateDocument, ProfileLibrary } from "./profileLibrary.ts";
import { boundedJson, type SyncRole } from "./protocol.ts";
import { isSafeProfileId } from "../profile-id.ts";

interface ManagementOptions {
  manager: ProcessManager; bridge: BrowserBridge; relay: SyncRelay;
  extensions: ExtensionManager; library: ProfileLibrary;
  snapshot(): object; changed(): void;
  openExtensionPage(profileId: string, extensionId: string, kind: "popup" | "options"): Promise<object>;
  /** Integrated workspaces use the sole mirroring worker for explicit changes. */
  onRoleChange?(profileId: string, role: SyncRole): Promise<void>;
  onPauseChange?(profileId: string, enabled: boolean): Promise<void>;
}
export class ManagementRoutes {
  constructor(private options: ManagementOptions) {}
  async handle(request: Request, url: URL): Promise<Response | undefined> {
    const path = url.pathname.slice("/workspace/api/".length);
    if (!(path === "extensions" || path.startsWith("extensions/") || path === "library" || path.startsWith("library/") || path === "batch" || /^profiles\/[a-zA-Z0-9_-]{1,128}\/(?:extensions|rename|copy|screen)(?:\/|$)/.test(path))) return undefined;
    try {
      const requestedProfile = /^(?:library\/)?profiles\/([^/]+)(?:\/|$)/.exec(path)?.[1];
      if (requestedProfile && !isSafeProfileId(requestedProfile)) return json({ error: "Profile ID is invalid" }, 400);
      const screen = /^profiles\/([a-zA-Z0-9_-]{1,128})\/screen$/.exec(path);
      if (screen) {
        const id = screen[1]!;
        if (!this.options.manager.getProfile(id)) return json({ error: "Local profile was not found" }, 404);
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const body = await boundedJson(request);
        if (!this.options.manager.canEditProfile(id)) return json({ error: "Stop this profile before changing its desktop screen" }, 409);
        const profile = this.options.manager.updateScreen(id, body);
        this.options.changed(); return json({ profile, snapshot: this.options.snapshot() });
      }
      if (path === "extensions" && request.method === "GET") return json({ extensions: this.options.extensions.list() });
      if (path === "extensions/import" && request.method === "POST") {
        const body = await boundedJson(request);
        const extension = await this.options.extensions.importLocal(body as any);
        return json({ extension, extensions: this.options.extensions.list() });
      }
      const extensionDelete = /^extensions\/([a-f0-9-]{36})$/.exec(path);
      if (extensionDelete && request.method === "DELETE") { this.options.extensions.delete(extensionDelete[1]!); return json({ extensions: this.options.extensions.list() }); }
      const assignment = /^profiles\/([a-zA-Z0-9_-]{1,128})\/extensions(?:\/([a-f0-9-]{36}))?$/.exec(path);
      const extensionOpen = /^profiles\/([a-zA-Z0-9_-]{1,128})\/extensions\/([a-f0-9-]{36})\/open$/.exec(path);
      if (extensionOpen && request.method === "POST") {
        if (!this.options.manager.getProfile(extensionOpen[1]!)) return json({ error: "Profile was not found" }, 404);
        const body = await boundedJson(request);
        if (body.kind !== "popup" && body.kind !== "options") throw new Error("Choose the imported add-on popup or options page");
        return json({ browser: await this.options.openExtensionPage(extensionOpen[1]!, extensionOpen[2]!, body.kind), snapshot: this.options.snapshot() });
      }
      if (assignment) {
        const id = assignment[1]!;
        if (!this.options.manager.getProfile(id)) return json({ error: "Local profile was not found" }, 404);
        if (request.method === "GET" && !assignment[2]) return json({ assignments: this.options.extensions.listAssignments(id), extensions: this.options.extensions.list() });
        if (!this.options.manager.canEditProfile(id)) return json({ error: "Stop this profile before changing its add-ons" }, 409);
        let result: ExtensionAssignment | undefined;
        if (request.method === "POST" && !assignment[2]) result = this.options.extensions.assign(id, await boundedJson(request) as any);
        else if (request.method === "DELETE" && assignment[2]) this.options.extensions.unassign(id, assignment[2]);
        else return json({ error: "Method not allowed" }, 405);
        this.options.changed();
        return json({ assignment: result, assignments: this.options.extensions.listAssignments(id), extensions: this.options.extensions.list(), snapshot: this.options.snapshot() });
      }
      if (path === "library" && request.method === "GET") return json({ groups: this.options.library.listGroups(), profiles: this.options.manager.list().map(p => {
        const meta = this.options.library.get(p.id); return { profileId: p.id, groupId: meta.groupId, tags: meta.tags, notes: meta.notes, bookmarkCount: meta.bookmarks.length };
      }) });
      const metadata = /^library\/profiles\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
      if (metadata) {
        if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
        if (!this.options.manager.getProfile(metadata[1]!)) throw new Error("Profile was not found");
        const result = request.method === "GET" ? this.options.library.get(metadata[1]!) : this.options.library.set(metadata[1]!, await boundedJson(request));
        if (request.method === "POST") this.options.changed();
        return json({ metadata: result, groups: this.options.library.listGroups(), ...(request.method === "POST" ? { snapshot: this.options.snapshot() } : {}) });
      }
      if (path === "library/groups" && request.method === "POST") {
        const body = await boundedJson(request);
        const group = typeof body.id === "string" ? this.options.library.renameGroup(body.id, body.name) : this.options.library.createGroup(body.name);
        this.options.changed(); return json({ group, groups: this.options.library.listGroups(), snapshot: this.options.snapshot() });
      }
      const groupDelete = /^library\/groups\/([a-zA-Z0-9_-]{1,64})$/.exec(path);
      if (groupDelete && request.method === "DELETE") {
        this.options.library.deleteGroup(groupDelete[1]!); this.options.changed(); return json({ groups: this.options.library.listGroups(), snapshot: this.options.snapshot() });
      }
      if (path === "library/export" && request.method === "GET") {
        const selected = url.searchParams.get("ids");
        const ids = selected ? selected.split(",") : this.options.manager.list().map(p => p.id);
        if (!ids.length || ids.length > 256 || new Set(ids).size !== ids.length) throw new Error("Select 1 to 256 different profiles to export");
        const profiles = ids.map(id => { const profile = this.options.manager.getProfile(id); if (!profile) throw new Error("Export profile was not found"); return profile; });
        return json({ document: this.options.library.export(profiles) });
      }
      if (path === "library/import" && request.method === "POST") return await this.importTemplates(await boundedJson(request, MAX_TEMPLATE_BYTES));
      const profileAction = /^profiles\/([a-zA-Z0-9_-]{1,128})\/(rename|copy)$/.exec(path);
      if (profileAction && request.method === "POST") {
        const id = profileAction[1]!, body = await boundedJson(request);
        const source = this.options.library.get(id);
        const profile = profileAction[2] === "rename" ? this.options.manager.renameProfile(id, body.name as string) : await this.options.manager.copyProfile(id, body.name as string | undefined);
        if (profileAction[2] === "copy") this.options.library.set(profile.id, source);
        this.options.changed(); return json({ profile, snapshot: this.options.snapshot() });
      }
      if (path === "batch" && request.method === "POST") return await this.batch(await boundedJson(request));
      return json({ error: "Method or management route not allowed" }, 405);
    } catch (error) { return json({ error: publicError(error) }, 400); }
  }
  private async importTemplates(body: Record<string, unknown>): Promise<Response> {
    const document = parseTemplateDocument(body.document);
    if (this.options.manager.list().length + document.profiles.length > 256) throw new Error("Import would exceed the 256-profile workspace limit");
    const existingGroups = this.options.library.listGroups();
    const names = new Set(existingGroups.map(group => group.name.toLowerCase()));
    for (const row of document.profiles) if (row.group) names.add(row.group.toLowerCase());
    if (names.size > 128) throw new Error("Import would exceed the 128-group limit");
    const created: string[] = [], createdGroups = new Set<string>();
    try {
      for (const row of document.profiles) {
        const [profile] = await this.options.manager.bulkCreate({ count: 1, prefix: row.name, engine: row.engine, urls: row.urls,
          ramMb: row.ramMb, heapMb: row.heapMb, networkMode: row.networkMode,
          proxies: [row.proxy ? { ...row.proxy, user: "", pass: "" } : null], resolutions: [{ width: row.screenWidth, height: row.screenHeight }] });
        if (!profile) throw new Error("Profile creation did not return an isolated profile");
        created.push(profile.id); this.options.manager.renameProfile(profile.id, row.name);
        const existing = row.group ? this.options.library.listGroups().find(group => group.name.toLowerCase() === row.group!.toLowerCase()) : undefined;
        const groupId = row.group ? existing?.id ?? this.options.library.createGroup(row.group).id : null;
        if (groupId && !existing) createdGroups.add(groupId);
        this.options.library.set(profile.id, { groupId, tags: row.tags, notes: row.notes, bookmarks: row.bookmarks });
      }
    } catch (error) {
      const remaining: string[] = [];
      for (const id of [...created].reverse()) { try { await this.options.manager.deleteProfile(id); } catch { remaining.push(id); } }
      for (const group of this.options.library.listGroups()) if (createdGroups.has(group.id) && !this.options.manager.list().some(p => this.options.library.get(p.id).groupId === group.id)) this.options.library.deleteGroup(group.id);
      if (remaining.length) return json({ error: "Import failed and some new profiles could not be rolled back; review these local profile IDs", remainingProfileIds: remaining, snapshot: this.options.snapshot() }, 409);
      throw error;
    }
    this.options.changed(); return json({ profiles: created.map(id => this.options.manager.getProfile(id)), groups: this.options.library.listGroups(), snapshot: this.options.snapshot() });
  }
  private async batch(body: Record<string, unknown>): Promise<Response> {
    if (!Array.isArray(body.profileIds) || !body.profileIds.length || body.profileIds.length > 32 || body.profileIds.some(id => typeof id !== "string") || new Set(body.profileIds).size !== body.profileIds.length) throw new Error("Select 1 to 32 different profiles for a batch operation");
    const ids = body.profileIds as string[];
    for (const id of ids) if (!this.options.manager.getProfile(id)) throw new Error("A selected local profile was not found");
    if (!["start", "stop", "manual", "pause", "network", "metadata", "copy", "delete"].includes(String(body.action))) throw new Error("Batch action is invalid");
    if (["manual", "pause"].includes(String(body.action)) && typeof body.enabled !== "boolean") throw new Error("Batch toggle value must be boolean");
    if (body.action === "delete") {
      if (body.confirmation !== `DELETE ${ids.length} PROFILES`) throw new Error("Type the displayed profile-count confirmation before deleting local data");
      if (ids.some(id => !this.options.manager.canEditProfile(id))) return json({ error: "Stop every selected profile before deleting local data" }, 409);
    }
    const run = async (id: string) => {
      try {
        if (body.action === "start") { await this.options.manager.start(id); await this.options.bridge.attach(id); }
        else if (body.action === "stop") { await this.options.bridge.detach(id); if (!await this.options.manager.stop(id)) throw new Error("Browser shutdown could not be confirmed"); }
        else if (body.action === "manual") {
          const role = body.enabled ? "manual" : "follower";
          if (this.options.onRoleChange) await this.options.onRoleChange(id, role);
          else { if (body.enabled === false) this.options.manager.setManual(id, false); this.options.relay.setRole(id, role); }
        }
        else if (body.action === "pause") {
          if (this.options.onPauseChange) await this.options.onPauseChange(id, body.enabled as boolean);
          else this.options.relay.setPaused(id, body.enabled as boolean);
        }
        else if (body.action === "network") this.options.manager.updateNetwork(id, { networkMode: body.networkMode as any, ...(Object.hasOwn(body, "proxy") ? { proxy: body.proxy as any } : {}) });
        else if (body.action === "metadata") this.options.library.set(id, body.metadata);
        else if (body.action === "copy") { const copied = await this.options.manager.copyProfile(id); this.options.library.set(copied.id, this.options.library.get(id)); return { profileId: id, ok: true, createdProfileId: copied.id }; }
        else if (body.action === "delete") await this.options.manager.deleteProfile(id);
        return { profileId: id, ok: true };
      } catch (error) { return { profileId: id, ok: false, error: publicError(error) }; }
    };
    // Launch concurrency stays bounded by ProcessManager's four-slot owner queue.
    const results = body.action === "start" ? await Promise.all(ids.map(run)) : [];
    if (body.action !== "start") for (const id of ids) results.push(await run(id));
    this.options.changed(); return json({ results, snapshot: this.options.snapshot() });
  }
}
function publicError(error: unknown): string { return error instanceof Error && error.message.length <= 200 ? error.message : "Local management request failed"; }
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }
