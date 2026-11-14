import { CloudApiError, CloudClient } from "../cloud-client.ts";
import type { CloudBrowserLifecycle } from "../cloud-browser.ts";
import type { ProfileStore } from "../store.ts";
import type { StakeModeWorkspace } from "../workspace/server.ts";
import { boundedJson, trustedLocalRequest } from "../workspace/protocol.ts";
import { isSafeProfileId } from "../profile-id.ts";
import { parseProfileResourcePolicy, resourceMemorySnapshot, resolveProfileResources } from "../profile-resources.ts";
import { decodePortableProfile, encodePortableProfile } from "../portable-profile.ts";
import { prepareImportBuffers } from "../inbox.ts";
import { serializeAdsTxt, serializeCsv, serializeXlsxRows, parseStrictTimezone, parseStrictResolution, type ProfileExport } from "../parse.ts";
import { normalizeProfileLocale } from "../profile-locale.ts";
import { completeProfileFingerprint, setFirefoxScreen, syncFirefoxTimezone } from "../firefox-config.ts";
import { writeXlsx } from "../xlsx.ts";
import type { StandaloneCloudContext } from "./cloud.ts";

export interface StandaloneCloudProfileContext {
  context: StandaloneCloudContext;
  store: ProfileStore;
  workspace: StakeModeWorkspace;
  coordinator: CloudBrowserLifecycle;
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const fail = (message: string, status = 400) => json({ ok: false, error: message }, status);
function idsFrom(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 10_000 || value.some(id => typeof id !== "string" || !isSafeProfileId(id)) || new Set(value).size !== value.length) throw new Error("Choose unique valid profile IDs");
  return value;
}

/** Cloud management has its own store and fresh server permissions on every request. */
export function createCloudProfileRoutes(getContext: () => StandaloneCloudProfileContext | undefined) {
  return async (request: Request, remoteAddress: string): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname.replace(/^\/workspace\/api\/app\//, "");
    if (!(path === "profile-order" || path.startsWith("profiles/") || path === "trash" || path.startsWith("trash/"))) return undefined;
    if (!trustedLocalRequest(request, remoteAddress) || !/^Bearer \S+$/.test(request.headers.get("authorization") ?? "")) return fail("Authenticated local workspace access required", 403);
    const active = getContext();
    if (!active) return fail("Cloud sign-in is required", 401);
    const { context, store, workspace, coordinator } = active;
    const accountId = context.connection.accountId();
    const current = () => { const next = getContext(); return !request.signal.aborted && context.current() && next?.context === context && next.store === store && context.connection.accountId() === accountId; };
    const assertCurrent = () => { if (!current()) throw new CloudApiError("Cloud account changed; reload the workspace", "authentication_required", 401); };
    // A new client avoids using a roster cached before a role or account change.
    const client = new CloudClient({ baseUrl: context.configuration.baseUrl,
      accessToken: async () => current() ? context.auth.accessTokenOrRefresh() : undefined,
      deviceCredential: () => current() ? context.connection.deviceCredential() : undefined, fetchFn: context.fetchFn });
    try {
      const status = await client.status();
      assertCurrent();
      if (!accountId || status.account.id !== accountId) return fail("Cloud account changed; reload the workspace", 401);
      const roster = await client.listProfiles();
      assertCurrent();
      const visible = roster.profiles.filter(profile => profile.trashedAt === null);
      const authorize = (id: string, edit = false, trashed = false) => {
        const profile = roster.profiles.find(profile => profile.id === id && (trashed ? profile.trashedAt !== null : profile.trashedAt === null));
        if (!profile) throw new CloudApiError("Profile is unavailable", "profile_not_found", 404);
        if (edit && profile.permission !== "edit") throw new CloudApiError("Edit access is required", "folder_access_denied", 403);
        return profile;
      };
      const profileRoute = /^profiles\/([a-zA-Z0-9_-]{1,128})\/(resources|identity)$/.exec(path);
      if (profileRoute) {
        const id = profileRoute[1]!;
        authorize(id, request.method === "POST" || profileRoute[2] === "resources");
        if (!["GET", "POST"].includes(request.method)) return fail("Method not allowed", 405);
        if (profileRoute[2] === "resources") {
          if (request.method === "POST") {
            const policy = parseProfileResourcePolicy(await boundedJson(request)); assertCurrent();
            const previous = store.getProfileResourcePolicy(id);
            if (policy.alwaysShowBookmarks === undefined && previous.alwaysShowBookmarks !== undefined) policy.alwaysShowBookmarks = previous.alwaysShowBookmarks;
            store.setProfileResourcePolicy(id, policy); workspace.refreshProfiles();
          }
          const policy = store.getProfileResourcePolicy(id), system = resourceMemorySnapshot(store.listLaunches().filter(launch => launch.profileId !== id).length);
          return json({ ok: true, policy, allocation: resolveProfileResources(policy, system), system, appliesNextLaunch: true });
        }
        const authoritative = await client.getProfile(id); assertCurrent();
        const decoded = decodePortableProfile(authoritative.payload), profile = decoded.profile;
        let version = authoritative.profile.version;
        if (profile.id !== id) throw new Error("Cloud returned a mismatched profile payload");
        if (request.method === "POST") {
          if (authoritative.profile.permission !== "edit") return fail("Edit access is required", 403);
          if (store.getLaunch(id) || authoritative.profile.activeOpens.length) return fail("Stop this browser on all devices before editing its identity", 409);
          const { set, expectedVersion } = await boundedJson(request); assertCurrent();
          if (expectedVersion !== undefined && expectedVersion !== authoritative.profile.version) return fail("Cloud profile changed; reload it before saving", 409);
          if (!set || typeof set !== "object" || Array.isArray(set)) throw new Error("Profile edits are required");
          const fields = set as Record<string, unknown>;
          if (Object.keys(fields).some(key => !["name", "locale", "timezone", "ua", "userAgent", "resolution"].includes(key))) throw new Error("Unsupported identity field");
          if ("name" in fields) {
            if (typeof fields.name !== "string" || !fields.name.trim() || fields.name.length > 120 || /[\u0000-\u001f\u007f]/.test(fields.name)) throw new Error("Invalid profile name");
            profile.name = fields.name.trim();
          }
          if ("timezone" in fields) { profile.timezone = parseStrictTimezone(fields.timezone); profile.timezoneManual = !!profile.timezone; syncFirefoxTimezone(profile); }
          if ("locale" in fields) { const locale = normalizeProfileLocale(fields.locale); if (!locale) throw new Error("A valid browser locale is required"); profile.locale = locale; }
          if ("ua" in fields || "userAgent" in fields) {
            const ua = fields.ua ?? fields.userAgent;
            if (typeof ua !== "string" || !ua.trim() || ua.length > 2048 || /[\r\n\0]/.test(ua)) throw new Error("Invalid user agent");
            profile.ua = ua.trim();
            if (profile.engine === "firefox" && profile.firefox) profile.firefox = { ...profile.firefox, config: { ...profile.firefox.config, "navigator.userAgent": profile.ua, "headers.User-Agent": profile.ua } };
          }
          if ("resolution" in fields) {
            const screen = parseStrictResolution(fields.resolution);
            if (screen.width > 4096 || screen.height > 4096 || screen.width * screen.height > 8_800_000) throw new Error("Screen is outside Live workspace limits");
            if (profile.engine === "firefox") setFirefoxScreen(profile, screen.width, screen.height);
            else { profile.screenWidth = screen.width; profile.screenHeight = screen.height; }
          }
          assertCurrent();
          const updated = await client.updateProfile(id, { expectedVersion: authoritative.profile.version, payload: encodePortableProfile(completeProfileFingerprint(profile), decoded.sessionBundle) });
          version = updated.profile.version;
          assertCurrent();
          workspace.refreshProfiles();
        }
        return json({ ok: true, profile: { id, name: profile.name, ua: profile.ua, userAgent: profile.ua, timezone: profile.timezone, locale: profile.locale ?? "",
          engine: profile.engine ?? "chromium", chromiumRuntime: profile.chromiumRuntime, screenWidth: profile.screenWidth, screenHeight: profile.screenHeight, expectedVersion: version } });
      }
      if (path === "profile-order" && ["GET", "POST"].includes(request.method)) {
        if (request.method === "POST") {
          const value = (await boundedJson(request)).ids, ids = Array.isArray(value) && value.length === 0 ? [] : idsFrom(value);
          for (const id of ids) authorize(id);
          assertCurrent(); store.setProfileOrder(`cloud:${accountId}`, ids);
        }
        return json({ ok: true, ids: store.getProfileOrder(`cloud:${accountId}`).filter(id => visible.some(profile => profile.id === id)) });
      }
      if ((path === "trash" || path.startsWith("trash/") || path === "profiles/trash")) {
        if (path === "trash" && request.method === "GET") return json({ ok: true, profiles: roster.profiles.filter(profile => profile.trashedAt !== null).map(profile => ({
          id: profile.id, name: profile.name, group: profile.group, trashedAt: profile.trashedAt, version: profile.version, canRestore: profile.permission === "edit", canPurge: status.workspace.role === "owner" })) });
        if (request.method !== "POST" || !["trash/restore", "trash/purge", "profiles/trash"].includes(path)) return fail("Unknown Trash operation", 404);
        const ids = idsFrom((await boundedJson(request)).ids), results = [];
        for (const id of ids) {
          try {
            assertCurrent(); const profile = authorize(id, true, path !== "profiles/trash");
            if (store.getLaunch(id) || profile.activeOpens.length) throw new CloudApiError("Profile is open", "profile_open", 409);
            if (path === "trash/purge") {
              if (status.workspace.role !== "owner") throw new CloudApiError("Only the owner can permanently delete profiles", "owner_only", 403);
              await client.purgeProfile(id, profile.version);
            } else if (path === "trash/restore") await client.restoreProfile(id, { expectedVersion: profile.version });
            else await client.trashProfile(id, { expectedVersion: profile.version });
            results.push({ id, status: path === "trash/purge" ? "purged" : path === "trash/restore" ? "restored" : "trashed" });
          } catch (failure) { results.push({ id, status: "failed", code: failure instanceof CloudApiError ? failure.code : "operation_failed" }); }
        }
        assertCurrent(); await coordinator.listRoster(); workspace.refreshProfiles();
        return json({ ok: true, results });
      }
      if (path === "profiles/export" && request.method === "POST") {
        const body = await boundedJson(request), ids = idsFrom(body.ids), format = body.format;
        if (!["txt", "csv", "xlsx", "json"].includes(String(format))) throw new Error("Choose TXT, CSV, JSON, or XLSX");
        const profiles: ProfileExport[] = [];
        for (const id of ids) {
          authorize(id, true); assertCurrent();
          const result = await client.getProfile(id); assertCurrent();
          if (result.profile.permission !== "edit") return fail("Edit access is required to export profiles", 403);
          const decoded = decodePortableProfile(result.payload);
          if (decoded.profile.id !== id) throw new Error("Cloud returned a mismatched profile payload");
          profiles.push({ ...decoded.profile, sessionBundle: decoded.sessionBundle, sessionSource: "cloud" });
        }
        const table = serializeXlsxRows(profiles);
        const bytes = format === "xlsx" ? await writeXlsx(table.headers, table.rows) : new TextEncoder().encode(format === "txt" ? serializeAdsTxt(profiles) : format === "csv" ? serializeCsv(profiles)
          : JSON.stringify(table.rows.map(row => Object.fromEntries(table.headers.map((header, index) => [header, row[index] ?? ""]))), null, 2));
        assertCurrent();
        return new Response(bytes as BodyInit, { headers: { "cache-control": "no-store", "content-disposition": `attachment; filename=gamebrowser-export.${format}`,
          "content-type": format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : format === "json" ? "application/json" : format === "csv" ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8" } });
      }
      if (path === "profiles/import" && request.method === "POST") {
        const form = await request.formData(), uploads = [];
        let total = 0;
        for (const [, value] of form) if (value instanceof File) { total += value.size; if (total > 32 * 1024 * 1024 || uploads.length >= 32) throw new Error("Upload at most 32 files totaling 32 MB"); uploads.push({ name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) }); }
        if (!uploads.length) throw new Error("Select a profile export");
        const groupId = form.get("groupId"), group = typeof groupId === "string" && groupId ? workspace.library.listGroups().find(group => group.id === groupId)?.name : form.get("group");
        if (typeof group !== "string" || !group.trim()) throw new Error("Choose a Cloud destination group");
        const folders = await client.listFolders(); assertCurrent();
        if (!folders.folders.some(folder => folder.name === group && folder.archivedAt === null && folder.permission === "edit")) return fail("Edit access to the destination group is required", 403);
        const prepared = await prepareImportBuffers(uploads, () => {}, { group }); assertCurrent();
        await coordinator.importProfiles(group, prepared.imports.map(({ profile, sessionBundle }) => ({ ...profile, sessionBundle }))); assertCurrent();
        await coordinator.listRoster(); workspace.refreshProfiles();
        return json({ ok: true, ...prepared.result });
      }
      return undefined;
    } catch (failure) { return fail(failure instanceof Error ? failure.message.slice(0, 240) : "Cloud operation failed", failure instanceof CloudApiError ? failure.status : 400); }
  };
}
