import type { Launcher } from "../launcher.ts";
import type { ProfileStore } from "../store.ts";
import type { Profile } from "../types.ts";
import type { StakeModeWorkspace } from "../workspace/server.ts";
import { approvedOrigin, boundedJson, isLoopback, trustedLocalRequest } from "../workspace/protocol.ts";
import { isSafeProfileId } from "../profile-id.ts";
import { parseProfileResourcePolicy, resolveProfileResources, resourceMemorySnapshot } from "../profile-resources.ts";
import { importBuffers, ProfileImportError } from "../inbox.ts";
import { parseStrictResolution, parseStrictTimezone, serializeAdsTxt, serializeCsv, serializeXlsxRows, type ProfileExport } from "../parse.ts";
import { writeXlsx } from "../xlsx.ts";
import { normalizeProfileLocale } from "../profile-locale.ts";
import { setFirefoxScreen, syncFirefoxTimezone } from "../firefox-config.ts";
import { buildNewProfile } from "../create.ts";
import type { CloudBrowserCloseResult, CloudBrowserOpenResult, CloudBrowserProfile } from "../cloud-browser.ts";
import { runtimeDownloads } from "../runtime-download.ts";
import { AgentControlHub, AGENT_CONTROL_PATH, AGENT_CONTROL_PROTOCOL, AGENT_CONTROL_MAX_MESSAGE_BYTES, validAgentAuthorization, type AgentControlSession } from "../agent-control.ts";
import { LifecycleAdmissionController } from "../lifecycle-admission.ts";
import { CloudApiError } from "../cloud-client.ts";
import { StandaloneCloud, type StandaloneCloudOptions } from "./cloud.ts";
import { getStateImportStatus } from "./migration.ts";
import { normalizeWorkspacePolicy, normalizeWorkspaceUrl } from "../workspace/profileStore.ts";
import { effectiveProfileProxy, normalizeNetworkMode } from "../workspace/networkPolicy.ts";
import { createCloudProfileRoutes, type StandaloneCloudProfileContext } from "./cloud-profiles.ts";

export interface StandaloneServiceOptions extends StandaloneCloudOptions {
  store: ProfileStore;
  launcher: Launcher;
  workspace?: StakeModeWorkspace;
  admission?: LifecycleAdmissionController;
  nonce?: string;
  log?: (message: string) => void;
  cloudProfiles?: {
    list(): Promise<{ profiles: CloudBrowserProfile[]; healthSources: [] }>;
    create(profile: Profile, preferences?: { origin?: string; networkMode?: unknown; ramMb?: number; heapMb?: number; explicitHeap?: boolean }): Promise<{ id: string }>;
    open(id: string): Promise<CloudBrowserOpenResult>;
    close(id: string): Promise<CloudBrowserCloseResult>;
    retryPending(): Promise<void>;
  };
  takeCreatedQueueKey?: () => string | undefined;
  cloudAppFetch?: (request: Request, remoteAddress: string) => Promise<Response | undefined>;
  cloudAppContext?: () => StandaloneCloudProfileContext | undefined;
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (message: string, status = 400) => json({ ok: false, error: message }, status);

function idsFrom(value: unknown, maximum = 10_000): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some(id => typeof id !== "string" || !isSafeProfileId(id)) || new Set(value).size !== value.length) throw new Error("Choose unique valid profile IDs");
  return value;
}

function editView(profile: Profile) {
  return { id: profile.id, name: profile.name, group: profile.group, engine: profile.engine ?? "chromium",
    ...(profile.chromiumRuntime ? { chromiumRuntime: profile.chromiumRuntime } : {}),
    ua: profile.ua, userAgent: profile.ua, timezone: profile.timezone, locale: profile.locale ?? "",
    screenWidth: profile.screenWidth, screenHeight: profile.screenHeight, resolution: `${profile.screenWidth}x${profile.screenHeight}` };
}

/** Own app routes. Mount app paths exclusively through StakeModeWorkspace.appFetch. */
export function createStandaloneServices(options: StandaloneServiceOptions) {
  const { store, launcher } = options;
  const cloud = new StandaloneCloud(options);
  const admission = options.admission ?? new LifecycleAdmissionController();
  const hub = options.nonce ? new AgentControlHub({ launcher, store, admission, log: options.log }) : undefined;
  const sessions = new Set<AgentControlSession>();
  let stopping = false;
  const cloudRoutes = options.cloudAppContext ? createCloudProfileRoutes(options.cloudAppContext) : undefined;

  const agent = {
    path: AGENT_CONTROL_PATH,
    protocol: AGENT_CONTROL_PROTOCOL,
    maxMessageBytes: AGENT_CONTROL_MAX_MESSAGE_BYTES,
    authorize: (request: Request) => !stopping && !!hub && !!options.nonce && cloud.localMcpEnabled() && validAgentAuthorization(request.headers.get("authorization"), options.nonce),
    connect: () => {
      if (stopping || !hub || !cloud.localMcpEnabled()) throw new Error("Local MCP is unavailable");
      const session = hub.connect();
      sessions.add(session);
      return session;
    },
    disconnect: async (session: AgentControlSession) => { try { await session.disconnect(); } finally { sessions.delete(session); } },
  };

  const changed = () => { options.workspace?.refreshProfiles(); };
  const stopped = (id: string) => options.workspace ? options.workspace.manager.canEditProfile(id) : !store.getLaunch(id) && !launcher.profileDeletionBlocked?.(id);

  async function resources(request: Request, id: string): Promise<Response> {
    if (!store.getProfile(id)) return error("Profile not found", 404);
    if (!["GET", "POST"].includes(request.method)) return error("Method not allowed", 405);
    if (request.method === "POST") {
      const policy = parseProfileResourcePolicy(await boundedJson(request));
      const previous = store.getProfileResourcePolicy(id);
      if (policy.alwaysShowBookmarks === undefined && previous.alwaysShowBookmarks !== undefined) policy.alwaysShowBookmarks = previous.alwaysShowBookmarks;
      store.setProfileResourcePolicy(id, policy);
    }
    const policy = store.getProfileResourcePolicy(id);
    const system = resourceMemorySnapshot(store.listLaunches().filter(launch => launch.profileId !== id).length);
    return json({ ok: true, policy, allocation: resolveProfileResources(policy, system), system, appliesNextLaunch: true });
  }

  async function trash(request: Request, action: string): Promise<Response> {
    if (request.method === "GET" && !action) return json({ ok: true, profiles: store.listTrashed().map(profile => ({ ...profile, canRestore: true, canPurge: true })) });
    if (request.method !== "POST" || !["restore", "purge", "move"].includes(action)) return error("Unknown Trash operation", 404);
    const ids = idsFrom((await boundedJson(request)).ids);
    const results = [];
    for (const id of ids) {
      await launcher.cacheCleanupSettled?.(id);
      if (launcher.profileDeletionBlocked?.(id) || store.getLaunch(id) || (action === "move" && !stopped(id))) { results.push({ id, status: "failed", code: "profile_open" }); continue; }
      try {
        if (action === "move") {
          if (!store.trashProfile(id)) { results.push({ id, status: "failed", code: "profile_not_found" }); continue; }
        } else if (!store.isTrashed(id)) { results.push({ id, status: "failed", code: "not_in_trash" }); continue; }
        else if (action === "restore") store.restoreProfile(id);
        else {
          if (!launcher.removeUserDataDir(id)) throw new Error("cleanup refused");
          store.deleteProfile(id);
          await options.workspace?.forgetProfile(id);
        }
        results.push({ id, status: action === "move" ? "trashed" : action === "restore" ? "restored" : "purged" });
      } catch { results.push({ id, status: "failed", code: "operation_failed" }); }
    }
    changed();
    return json({ ok: true, results });
  }

  async function importProfiles(request: Request): Promise<Response> {
    const form = await request.formData();
    const uploads: Array<{ name: string; bytes: Uint8Array }> = [];
    let total = 0;
    for (const [, value] of form) if (value instanceof File) {
      total += value.size;
      if (total > 32 * 1024 * 1024 || uploads.length >= 32) throw new Error("Upload at most 32 files totaling 32 MB");
      uploads.push({ name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) });
    }
    if (!uploads.length) throw new Error("Select a TXT, CSV, JSON, or XLSX export");
    const groupId = form.get("groupId");
    const selectedGroup = typeof groupId === "string" && groupId ? options.workspace?.library.listGroups().find(group => group.id === groupId) : undefined;
    if (typeof groupId === "string" && groupId && !selectedGroup) throw new Error("Selected group is unavailable");
    const group = selectedGroup?.name ?? form.get("group"), platform = form.get("platform");
    const overrides = { ...(typeof group === "string" && group.trim() ? { group: group.trim() } : {}),
      ...(typeof platform === "string" && platform.trim() ? { platform: platform.trim() } : {}) };
    let importedIds: string[] = [];
    const result = await importBuffers(store, uploads, options.log, overrides, profiles => {
      if (stopping || request.signal.aborted) throw new Error("Import cancelled");
      if (store.count() + profiles.filter(profile => !store.getProfile(profile.id)).length > 256) throw new Error("Workspace allows at most 256 profiles");
      if (profiles.some(profile => store.getProfile(profile.id) && !stopped(profile.id))) throw new Error("Stop affected browsers before importing their profiles");
      importedIds = profiles.map(profile => profile.id);
    });
    launcher.prefetchFirefoxFontPacks?.(store.listProfiles());
    if (selectedGroup && options.workspace) {
      // The full importer owns browser identity; workspace organization lives in its own library.
      for (const id of importedIds) options.workspace.library.set(id, { groupId: selectedGroup.id });
    }
    changed();
    return json({ ok: true, ...result });
  }

  async function exportProfiles(request: Request): Promise<Response> {
    const body = await boundedJson(request);
    const ids = idsFrom(body.ids, 256);
    const format = body.format;
    if (!["txt", "csv", "xlsx", "json"].includes(String(format))) throw new Error("Choose TXT, CSV, JSON, or XLSX");
    const profiles: ProfileExport[] = [];
    for (const id of ids) {
      if (request.signal.aborted || stopping) throw new Error("Export cancelled");
      if (!store.getProfile(id)) return error("A selected profile is unavailable", 404);
      const live = format !== "csv" && await launcher.captureLocalSession(id);
      const profile = store.getProfile(id);
      if (!profile) return error("A selected profile is unavailable", 404);
      const sessionBundle = format === "csv" ? undefined : store.getSessionBundle(id) ?? undefined;
      profiles.push({ ...profile, sessionBundle, sessionSource: live ? "live" : sessionBundle ? "saved" : "stored-cookies" });
    }
    const table = serializeXlsxRows(profiles);
    let bytes: Uint8Array;
    let contentType: string;
    if (format === "xlsx") { bytes = await writeXlsx(table.headers, table.rows); contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
    else {
      const text = format === "txt" ? serializeAdsTxt(profiles) : format === "csv" ? serializeCsv(profiles)
        : `${JSON.stringify(table.rows.map(row => Object.fromEntries(table.headers.map((header, index) => [header, row[index] ?? ""]))), null, 2)}\n`;
      bytes = new TextEncoder().encode(text);
      contentType = format === "json" ? "application/json" : format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8";
    }
    return new Response(bytes as BodyInit, { headers: { "content-type": contentType,
      "content-disposition": `attachment; filename=gamebrowser-export.${format}`, "cache-control": "no-store" } });
  }

  async function identity(request: Request, id: string): Promise<Response> {
    let profile = store.getProfile(id);
    if (!profile) return error("Profile not found", 404);
    if (request.method === "POST") {
      if (!stopped(id)) return error("Stop this browser before editing its identity", 409);
      const body = await boundedJson(request), set = body.set;
      if (!set || typeof set !== "object" || Array.isArray(set)) throw new Error("Profile edits are required");
      const fields = set as Record<string, unknown>;
      if (Object.keys(fields).some(key => !["name", "ua", "userAgent", "timezone", "locale", "resolution"].includes(key))) throw new Error("Unsupported identity field");
      const next = { ...profile };
      if ("name" in fields) {
        if (typeof fields.name !== "string" || !fields.name.trim() || fields.name.length > 120 || /[\u0000-\u001f\u007f]/.test(fields.name)) throw new Error("Name must contain 1 to 120 printable characters");
        next.name = fields.name.trim();
      }
      if ("ua" in fields || "userAgent" in fields) {
        const ua = fields.ua ?? fields.userAgent;
        if (typeof ua !== "string" || !ua.trim() || ua.length > 2048 || /[\r\n\0]/.test(ua)) throw new Error("Invalid user agent");
        next.ua = ua.trim();
        if (next.engine === "firefox" && next.firefox) next.firefox = { ...next.firefox,
          config: { ...next.firefox.config, "navigator.userAgent": next.ua, "headers.User-Agent": next.ua } };
      }
      if ("timezone" in fields) { next.timezone = parseStrictTimezone(fields.timezone); next.timezoneManual = true; syncFirefoxTimezone(next); }
      if ("locale" in fields) {
        const locale = normalizeProfileLocale(fields.locale);
        if (!locale) throw new Error("A valid browser locale is required");
        next.locale = locale;
      }
      if ("resolution" in fields) {
        const screen = parseStrictResolution(fields.resolution);
        if (screen.width > 4096 || screen.height > 4096 || screen.width * screen.height > 8_800_000) throw new Error("Screen is outside Live workspace limits");
        if (next.engine === "firefox") setFirefoxScreen(next, screen.width, screen.height);
        else { next.screenWidth = screen.width; next.screenHeight = screen.height; }
      }
      // Recheck after all validation, immediately before the synchronous store write.
      if (!stopped(id)) return error("Browser state changed; stop it before editing", 409);
      store.upsertProfile(next); profile = store.getProfile(id)!; changed();
    } else if (request.method !== "GET") return error("Method not allowed", 405);
    return json({ ok: true, profile: editView(profile) });
  }

  async function fetch(request: Request, remoteAddress: string, scope: "local" | "cloud" = "local"): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/ui/api/")) {
      // Native health checks use these read-only compatibility routes without a dashboard session.
      if (!isLoopback(remoteAddress) || request.headers.has("origin") && request.headers.get("origin") !== url.origin) return error("Local access required", 403);
      if (request.method !== "GET") return undefined;
      if (url.pathname === "/ui/api/runtime-downloads") return json({ downloads: runtimeDownloads() });
      const match = /^\/ui\/api\/profiles\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
      if (match) return identity(request, match[1]!);
      return undefined;
    }
    if (!url.pathname.startsWith("/workspace/api/app/")) return undefined;
    if (!trustedLocalRequest(request, remoteAddress) || !/^Bearer \S+$/.test(request.headers.get("authorization") ?? "")) return error("Authenticated local workspace access required", 403);
    if (stopping) return error("GameBrowser is stopping", 503);
    const path = url.pathname.slice("/workspace/api/app/".length);
    try {
      if (path === "settings" && request.method === "GET") return json({ ok: true, mode: scope, cloud: cloud.state(), localMcp: { available: !!options.nonce, enabled: !!options.nonce && cloud.localMcpEnabled(), protocol: AGENT_CONTROL_PROTOCOL, path: AGENT_CONTROL_PATH } });
      if (path === "migration" && request.method === "GET") return json({ ok: true, ...await getStateImportStatus(options.root) });
      if (path === "local-mcp" && request.method === "POST") {
        const body = await boundedJson(request);
        if (typeof body.enabled !== "boolean") throw new Error("MCP enabled must be true or false");
        cloud.setLocalMcp(body.enabled);
        if (!body.enabled) await Promise.all([...sessions].map(session => agent.disconnect(session)));
        return json({ ok: true, enabled: !!options.nonce && cloud.localMcpEnabled() });
      }
      if (path === "cloud/configure" && request.method === "POST") { cloud.configure(await boundedJson(request)); return json({ ok: true, cloud: cloud.state() }); }
      if (path === "cloud/signin" && request.method === "POST") {
        const body = await boundedJson(request);
        if (typeof body.email !== "string" || !body.email.trim() || typeof body.password !== "string" || !body.password) throw new Error("Email and password are required");
        if (body.queueKey !== undefined && (typeof body.queueKey !== "string" || !body.queueKey || body.queueKey.length > 8192)) throw new Error("Invalid queue encryption key");
        const state = await cloud.signIn(body.email.trim(), body.password, body.queueKey as string | undefined);
        const queueKey = options.takeCreatedQueueKey?.();
        const deviceCredential = cloud.context()?.connection.deviceCredential();
        return json({ ok: true, cloud: state, ...(queueKey ? { queueKey } : {}), ...(deviceCredential ? { deviceCredential } : {}) });
      }
      if (path === "cloud/restore" && request.method === "POST") {
        const body = await boundedJson(request);
        if (typeof body.refreshToken !== "string" || !body.refreshToken || body.refreshToken.length > 65_536) throw new Error("Saved sign-in is unavailable");
        if (body.queueKey !== undefined && (typeof body.queueKey !== "string" || !body.queueKey || body.queueKey.length > 8192)) throw new Error("Invalid queue encryption key");
        if (body.deviceCredential !== undefined && (typeof body.deviceCredential !== "string" || !body.deviceCredential || body.deviceCredential.length > 65_536)) throw new Error("Invalid saved device credential");
        const state = await cloud.restore(body.refreshToken, body.queueKey as string | undefined, body.deviceCredential as string | undefined);
        const queueKey = options.takeCreatedQueueKey?.();
        const deviceCredential = cloud.context()?.connection.deviceCredential();
        return json({ ok: true, cloud: state, ...(queueKey ? { queueKey } : {}), ...(deviceCredential ? { deviceCredential } : {}) });
      }
      if (path === "cloud/signout" && request.method === "POST") { await cloud.signOut(); return json({ ok: true, cloud: cloud.state() }); }
      if (path === "team" && request.method === "GET") return json(await cloud.team());
      if (path === "cloud/groups" && request.method === "GET") return json(await cloud.groups());
      if (path === "team/invite" && request.method === "POST") {
        const body = await boundedJson(request);
        if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || !["admin", "member"].includes(String(body.role))) throw new Error("A valid email and member role are required");
        return json(await cloud.invite(body.email, body.role as "admin" | "member"));
      }
      if (path === "team/share" && request.method === "POST") {
        const body = await boundedJson(request);
        if (!["group", "profile"].includes(String(body.scope)) || typeof body.id !== "string" || !body.id || typeof body.accountId !== "string" || !body.accountId || !["view", "edit"].includes(String(body.permission))) throw new Error("Choose a group or profile, member, and permission");
        return json(await cloud.share(body.scope as "group" | "profile", body.id, body.accountId, body.permission as "view" | "edit"));
      }
      if (path === "cloud/profiles" && options.cloudProfiles) {
        if (request.method === "GET") return json({ ok: true, ...await options.cloudProfiles.list() });
        if (request.method === "POST") {
          const input = await boundedJson(request);
          const profile = buildNewProfile(input, () => false);
          if (profile.screenWidth > 4096 || profile.screenHeight > 4096 || profile.screenWidth * profile.screenHeight > 8_800_000) throw new Error("Screen is outside Live workspace limits");
          const origin = input.origin ? approvedOrigin(input.origin) : undefined;
          const networkMode = input.networkMode === undefined ? undefined : normalizeNetworkMode(input.networkMode);
          if (networkMode) effectiveProfileProxy(profile, networkMode);
          const policy = normalizeWorkspacePolicy({ ...(input.ramMb === undefined ? {} : { ramMb: input.ramMb as number }),
            ...(input.heapMb === undefined ? {} : { heapMb: input.heapMb as number }),
            ...(input.explicitHeap === undefined ? {} : { explicitHeap: input.explicitHeap as boolean }), urls: origin ? [origin] : [] });
          return json({ ok: true, ...await options.cloudProfiles.create(profile, { origin, networkMode, ramMb: policy.ramMb,
            ...(input.heapMb === undefined ? {} : { heapMb: policy.heapMb }), explicitHeap: policy.explicitHeap }) });
        }
      }
      const cloudProfile = /^cloud\/profiles\/([a-zA-Z0-9_-]{1,128})\/(open|close)$/.exec(path);
      if (cloudProfile && request.method === "POST" && options.cloudProfiles) return json({ ok: true,
        ...await (cloudProfile[2] === "open" ? options.cloudProfiles.open(cloudProfile[1]!) : options.cloudProfiles.close(cloudProfile[1]!)) });
      if (path === "cloud/retry-pending" && request.method === "POST" && options.cloudProfiles) { await options.cloudProfiles.retryPending(); return json({ ok: true }); }
      if (scope === "cloud") return await cloudRoutes?.(request, remoteAddress) ?? await options.cloudAppFetch?.(request, remoteAddress) ?? error("Use the Cloud workspace profile controls for this operation", 409);
      if (path === "profile-order" && ["GET", "POST"].includes(request.method)) {
        if (request.method === "POST") {
          const value = (await boundedJson(request)).ids;
          const ids = Array.isArray(value) && value.length === 0 ? [] : idsFrom(value);
          if (ids.some(id => !store.getProfile(id))) throw new Error("Profile order contains an unavailable profile");
          store.setProfileOrder("local", ids);
        }
        return json({ ok: true, ids: store.getProfileOrder("local") });
      }
      if (path === "profiles/import" && request.method === "POST") return await importProfiles(request);
      if (path === "profiles/export" && request.method === "POST") return await exportProfiles(request);
      if (path === "profiles/trash") return await trash(request, "move");
      if (path === "trash" || path.startsWith("trash/")) return await trash(request, path.slice(6));
      const profile = /^profiles\/([a-zA-Z0-9_-]{1,128})\/(resources|identity)$/.exec(path);
      if (profile) return profile[2] === "resources" ? await resources(request, profile[1]!) : await identity(request, profile[1]!);
      return error("App route not found", 404);
    } catch (failure) {
      return error(failure instanceof Error ? failure.message.slice(0, 240) : "Request failed",
        failure instanceof CloudApiError ? failure.status : failure instanceof ProfileImportError ? failure.status : 400);
    }
  }

  return { fetch, agent, cloud, admission, close: async () => {
    stopping = true;
    await Promise.all([...sessions].map(session => agent.disconnect(session)));
    await cloud.close();
  } };
}
