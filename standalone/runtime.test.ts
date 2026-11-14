import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gameBrowserStateRoot, gameBrowserWorkspaceRoot, startGameBrowser } from "./runtime.ts";
import { gameBrowserStartOptions } from "../GameBrowser-cli.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { AGENT_CONTROL_PATH, AGENT_CONTROL_PROTOCOL } from "../agent-control.ts";
import NodeWebSocket from "ws";
import { ProfileStore } from "../store.ts";
import { ProfileLibrary } from "../workspace/profileLibrary.ts";
import { buildNewProfile } from "../create.ts";
import { encodePortableProfile } from "../portable-profile.ts";
import { Launcher } from "../launcher.ts";

const roots: string[] = [];
const runtimes: Array<Awaited<ReturnType<typeof startGameBrowser>>> = [];
function temporary() { const root = mkdtempSync(join(tmpdir(), "gamebrowser-standalone-")); roots.push(root); return root; }
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("independent GameBrowser runtime", () => {
  test("keeps explicit and native data roots separate from original StakeMode", () => {
    expect(gameBrowserStateRoot({ stateRoot: "/workspace/explicit", desktopRoot: "/workspace/native", env: { GAMEBROWSER_STATE_ROOT: "/workspace/env" } })).toBe(resolve("/workspace/explicit"));
    expect(gameBrowserStateRoot({ desktopRoot: "/workspace/native", env: { GAMEBROWSER_STATE_ROOT: "/workspace/env" } })).toBe(resolve("/workspace/env"));
    expect(gameBrowserStateRoot({ desktopRoot: "/workspace/native", env: { STAKEMODE_STATE_ROOT: "/workspace/original" } })).toBe(resolve("/workspace/native"));
    expect(gameBrowserStateRoot({ env: { STAKEMODE_STATE_ROOT: "/workspace/original" } })).toBe(resolve("/workspace/original"));
    expect(gameBrowserStateRoot({ env: { LOCALAPPDATA: "/workspace/local" } })).toBe(resolve("/workspace/local/GameBrowser"));
  });

  test("reuses beta 82 scoped metadata and fails visibly on an ambiguous second workspace", () => {
    const root = temporary(), nested = join(root, "live-workspace", "local");
    mkdirSync(join(nested, "workspace"), { recursive: true });
    writeFileSync(join(nested, "workspace", "library.json"), "original scoped metadata");
    expect(gameBrowserWorkspaceRoot(root)).toBe(nested);
    mkdirSync(join(root, "workspace"));
    writeFileSync(join(root, "workspace", "settings.json"), "original standalone metadata");
    expect(() => gameBrowserWorkspaceRoot(root)).toThrow("--workspace-state-root");
    expect(gameBrowserWorkspaceRoot(root, nested)).toBe(nested);
    expect(readFileSync(join(nested, "workspace", "library.json"), "utf8")).toBe("original scoped metadata");
    expect(readFileSync(join(root, "workspace", "settings.json"), "utf8")).toBe("original standalone metadata");
  });

  test("accepts native engine pins and only an explicit ephemeral port", () => {
    const options = gameBrowserStartOptions(["start", "--desktop-root", "native-root", "--state-root", "native-root", "--port", "0", "--firefox-binary", "firefox.exe", "--firefox-sha256", "a".repeat(64)]);
    expect(options.port).toBe(0);
    expect(options.firefoxBinaryPath).toBe("firefox.exe");
    expect(options.firefoxBinarySha256).toBe("a".repeat(64));
    expect(gameBrowserStartOptions(["start"]).port).toBeUndefined();
    expect(() => gameBrowserStartOptions(["start", "--port", "1.5"])).toThrow("integer");
    expect(() => gameBrowserStartOptions(["start", "--state-root"])).toThrow("requires a value");
  });

  test("opens the beta 82 store and scoped library in place without losing organization", async () => {
    const root = temporary(), nested = join(root, "live-workspace", "local");
    const store = new ProfileStore(join(root, "profiles.sqlite"));
    const profile = buildNewProfile({ name: "Retained profile", engine: "chromium" }, () => false);
    store.upsertProfile(profile);
    const library = new ProfileLibrary(nested, id => id === profile.id);
    const group = library.createGroup("Retained team");
    const metadata = library.set(profile.id, { groupId: group.id, notes: "Keep this workspace", tags: ["reviewed"], bookmarks: [{ title: "Saved page", url: "https://example.com/" }] });
    store.close();
    const runtime = await startGameBrowser({ stateRoot: root, port: 0 }); runtimes.push(runtime);
    expect(runtime.workspaceStateRoot).toBe(nested);
    expect(runtime.store.getProfile(profile.id)).toMatchObject(profile);
    expect(runtime.workspace.library.listGroups()).toEqual([group]);
    expect(runtime.workspace.library.get(profile.id)).toEqual(metadata);
  }, 30000);

  test("refuses a busy listener and keeps the existing service alive", async () => {
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("existing service") });
    try {
      await expect(startGameBrowser({ stateRoot: temporary(), port: occupied.port })).rejects.toThrow("no other service was adopted");
      expect(await fetch(`http://127.0.0.1:${occupied.port}`).then(response => response.text())).toBe("existing service");
    } finally { await occupied.stop(true); }
  }, 30000);

  test("serves its own workspace, SDK bootstrap and native health without an account", async () => {
    const root = temporary();
    const runtime = await startGameBrowser({ stateRoot: root, port: 0 }); runtimes.push(runtime);
    const base = new URL(runtime.url).origin;
    const health = await fetch(`${base}/ui/api/health`).then(response => response.json());
    expect(health).toMatchObject({ ok: true, root, version: ALIASMODE_VERSION, product: "GameBrowser", standalone: true, readiness: "local" });
    const html = await fetch(base).then(response => response.text());
    expect(html).toContain("GameBrowser");
    expect(html).toContain("Live workspace");
    expect(await fetch(`${base}/ui/api/app-mode`).then(response => response.json())).toMatchObject({ mode: "local", localAnalytics: false });
    expect(await fetch(`${base}/ui/api/profiles`).then(response => response.json())).toEqual({ profiles: [] });
    expect(await fetch(`${base}/ui/api/runtime-downloads`).then(response => response.json())).toEqual({ downloads: [] });
    expect((await fetch(`${base}/ui/api/profiles`, { headers: { host: "unrelated.example" } })).status).toBe(403);
    expect((await fetch(`${base}/workspace/cloud/dashboard.html`)).status).toBe(401);
    const headers = { "X-StakeMode-Workspace": "1", origin: base };
    const bootstrapResponse = await fetch(`${base}/workspace/api/bootstrap`, { headers });
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = await bootstrapResponse.json();
    expect(bootstrap.token).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(bootstrap.snapshot.capabilities).toMatchObject({ mode: "local", identityManagement: true });
    expect(bootstrap.snapshot.syncSession.saved).toBe(false);
    // API names and authorization remain compatible with the original SDK.
    const created = await fetch(`${base}/workspace/api/bulk`, { method: "POST", headers: { ...headers, authorization: `Bearer ${bootstrap.token}`, "content-type": "application/json" }, body: JSON.stringify({ count: 1, engine: "firefox", prefix: "Independent", resolutions: ["1280x720"] }) });
    expect(created.status).toBe(200);
    const profile = (await created.json()).profiles[0];
    expect(profile.engine).toBe("firefox");
    const roster = await fetch(`${base}/ui/api/profiles`).then(response => response.json());
    expect(roster.profiles).toEqual([expect.objectContaining({ id: profile.id, name: "Independent 1", engine: "firefox", running: false })]);
    const denied = await fetch(`${base}/workspace/api/app/settings`, { method: "POST", headers: { "content-type": "application/json", origin: "https://unrelated.example" }, body: "{}" });
    expect(denied.status).toBe(403);
    await runtime.close();
    expect(() => runtime.store.listProfiles()).toThrow();
  }, 30000);

  test("drains an authenticated dashboard WebSocket and makes close idempotent", async () => {
    const runtime = await startGameBrowser({ stateRoot: temporary(), port: 0 }); runtimes.push(runtime);
    const base = new URL(runtime.url).origin;
    const bootstrap = await fetch(`${base}/workspace/api/bootstrap`, { headers: { "X-StakeMode-Workspace": "1", origin: base } }).then(response => response.json());
    const socket = new WebSocket(bootstrap.relayUrl);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => { socket.send(JSON.stringify({ type: "HELLO", client: "dashboard", token: bootstrap.token })); }; socket.onmessage = () => resolve(); socket.onerror = reject; });
    const closed = new Promise<void>(resolve => { socket.onclose = () => resolve(); });
    const first = runtime.close(), second = runtime.close();
    expect(first).toBe(second);
    await Promise.all([first, closed]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  }, 30000);

  test("keeps the installed MCP protocol behind its private credential and drains its session", async () => {
    const nonce = "a".repeat(64);
    const runtime = await startGameBrowser({ stateRoot: temporary(), port: 0, env: { ...process.env, ALIASMODE_AGENT_NONCE: nonce } }); runtimes.push(runtime);
    const base = new URL(runtime.url).origin;
    const denied = await fetch(`${base}${AGENT_CONTROL_PATH}`, { headers: { "sec-websocket-protocol": AGENT_CONTROL_PROTOCOL } });
    expect(denied.status).toBe(401);
    const socket = new NodeWebSocket(`${base.replace("http:", "ws:")}${AGENT_CONTROL_PATH}`, AGENT_CONTROL_PROTOCOL, { headers: { authorization: `Bearer ${nonce}` } });
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
    const result = new Promise<any>((resolve, reject) => { socket.onmessage = event => resolve(JSON.parse(String(event.data))); socket.onerror = reject; });
    socket.send(JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id: 1, method: "profiles.list" }));
    expect(await result).toMatchObject({ id: 1, ok: true, result: { profiles: [] } });
    const closed = new Promise<void>(resolve => { socket.onclose = () => resolve(); });
    await Promise.all([runtime.close(), closed]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  }, 30000);

  test("keeps optional Cloud workspace stores, roles and dashboard tokens separate from Local", async () => {
    const root = temporary();
    const cloudIdentity = { ...buildNewProfile({ engine: "chromium", name: "Cloud browser" }, () => false), id: "cloud-only" };
    const summary = { id: "cloud-only", name: "Cloud browser", group: "Cloud team", platform: "", tags: [], permission: "edit", version: 1, trashedAt: null, activeOpens: [] };
    const status = { ok: true, account: { id: "cloud-owner", email: "owner@example.test", emailVerified: true },
      workspace: { id: "cloud-workspace", ownerAccountId: "cloud-owner", name: "Cloud team", role: "owner" },
      device: { id: "cloud-device", label: "GameBrowser", platform: "linux", appVersion: "test", createdAt: 1, lastSeenAt: 1, revokedAt: null, current: true },
      legal: { current: { terms: "1", privacy: "1", acceptableUse: "1" }, accepted: null } };
    const calls: string[] = [];
    const runtime = await startGameBrowser({ stateRoot: root, port: 0, cloudFetch: async (url, init) => {
      const path = new URL(url).pathname; calls.push(path);
      if (path === "/auth/v1/token") return Response.json({ access_token: "mock-access", refresh_token: "mock-refresh", expires_in: 3600, user: { id: "cloud-owner", email: "owner@example.test", email_confirmed_at: "verified" } });
      if (path === "/auth/v1/logout") return Response.json({});
      if (path === "/v1/account/bootstrap") return Response.json({ ...status, deviceCredential: "mock-device-credential" });
      if (path === "/v1/status") return Response.json(status);
      if (path === "/v1/profiles") return Response.json({ ok: true, profiles: [summary] });
      if (path === "/v1/profiles/cloud-only") return Response.json({ ok: true, profile: summary, payload: encodePortableProfile(cloudIdentity), payloadDigest: "mock-payload-digest" });
      if (path === "/v1/profiles/cloud-only/open") return Response.json({ ok: true, registrationId: "mock-first-open", baseVersion: 1, payload: encodePortableProfile(cloudIdentity), activeOpens: [] });
      if (path.endsWith("/heartbeat")) return Response.json({ ok: true, revoked: false, activeOpens: [] });
      if (path.endsWith("/abandon")) return Response.json({ ok: true, status: "abandoned" });
      throw new Error(`Unexpected simulated service route: ${path} (${init?.method ?? "GET"})`);
    } }); runtimes.push(runtime);
    const base = new URL(runtime.url).origin;
    const sdkHeaders = { "X-StakeMode-Workspace": "1", origin: base };
    const local = await fetch(`${base}/workspace/api/bootstrap`, { headers: sdkHeaders }).then(response => response.json());
    const localHeaders = { ...sdkHeaders, authorization: `Bearer ${local.token}`, "content-type": "application/json" };
    const configure = await fetch(`${base}/workspace/api/app/cloud/configure`, { method: "POST", headers: localHeaders, body: JSON.stringify({ baseUrl: "https://mock-cloud.example.test", authUrl: "https://mock-auth.example.test" }) });
    expect(configure.status).toBe(200);
    const signIn = await fetch(`${base}/workspace/api/app/cloud/signin`, { method: "POST", headers: localHeaders, body: JSON.stringify({ email: "owner@example.test", password: "mock-password" }) });
    expect(await signIn.json()).toMatchObject({ ok: true, cloud: { authenticated: true } });
    // Local Settings can open the first Cloud browser before a Cloud page or bootstrap is visited.
    // Stop at the native boundary and inspect the actual generated extension configuration.
    const start = spyOn(Launcher.prototype, "start").mockImplementation(async () => { throw new Error("Fixture stopped before actual native spawn"); });
    try {
      await fetch(`${base}/workspace/api/app/cloud/profiles/cloud-only/open`, { method: "POST", headers: localHeaders, body: "{}" });
      expect(start).toHaveBeenCalledTimes(1);
      const scope = readdirSync(join(root, "live-workspace")).find(name => name.startsWith("cloud-"));
      const generated = JSON.parse(readFileSync(join(root, "live-workspace", scope!, "sync-extensions", "cloud-only", "config.json"), "utf8"));
      expect(generated.relayUrl).toBe(`ws://127.0.0.1:${runtime.port}/workspace/cloud/relay`);
    } finally { start.mockRestore(); }
    const cloudResponse = await fetch(`${base}/workspace/cloud/api/bootstrap`, { headers: sdkHeaders });
    expect(cloudResponse.status).toBe(200);
    const cloud = await cloudResponse.json();
    expect(cloud.token).not.toBe(local.token);
    expect(cloud.relayUrl).toBe(`ws://127.0.0.1:${runtime.port}/workspace/cloud/relay`);
    expect(cloud.snapshot.capabilities.mode).toBe("cloud");
    expect(cloud.snapshot.profiles).toMatchObject([{ id: "cloud-only", name: "Cloud browser", state: "error", pid: null }]);
    expect(runtime.store.listProfiles()).toEqual([]);
    expect(runtime.workspace.manager.list()).toEqual([]);
    expect((await fetch(`${base}/workspace/cloud/api/snapshot`, { headers: localHeaders })).status).toBe(401);
    const cloudHeaders = { ...sdkHeaders, authorization: `Bearer ${cloud.token}`, "content-type": "application/json" };
    expect((await fetch(`${base}/workspace/api/snapshot`, { headers: cloudHeaders })).status).toBe(401);
    const cloudSocket = new WebSocket(cloud.relayUrl);
    const received = new Promise<any>((resolve, reject) => { cloudSocket.onopen = () => cloudSocket.send(JSON.stringify({ type: "HELLO", client: "dashboard", token: cloud.token })); cloudSocket.onmessage = event => resolve(JSON.parse(String(event.data))); cloudSocket.onerror = reject; });
    expect((await received).snapshot.capabilities.mode).toBe("cloud");
    const signedOut = await fetch(`${base}/workspace/api/app/cloud/signout`, { method: "POST", headers: localHeaders, body: "{}" });
    expect(signedOut.status).toBe(200);
    expect((await fetch(`${base}/workspace/cloud/api/bootstrap`, { headers: sdkHeaders })).status).toBe(401);
    expect((await fetch(`${base}/workspace/api/snapshot`, { headers: localHeaders })).status).toBe(200);
    expect(calls).toContain("/v1/profiles");
    cloudSocket.close();
  }, 30000);

  test("native readiness and shutdown use the private matching instance nonce", async () => {
    const root = temporary(), nonce = "e".repeat(64);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "GameBrowser-cli.ts"), "start", "--state-root", root, "--desktop-root", root, "--port", "0"], {
      cwd: join(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ALIASMODE_DESKTOP_NONCE: nonce, ALIASMODE_DESKTOP_VERSION: ALIASMODE_VERSION },
    });
    let output = "";
    const reader = child.stdout.getReader();
    try {
      while (!output.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("Sidecar exited before readiness");
        output += new TextDecoder().decode(value);
        if (output.length > 65536) throw new Error("Readiness output exceeded its limit");
      }
      const ready = JSON.parse(output.split("\n")[0]!);
      expect(ready).toMatchObject({ event: "ready", protocol: "aliasmode-desktop-v1", nonce, pid: child.pid });
      const health = await fetch(`http://127.0.0.1:${ready.port}/ui/api/health`).then(response => response.json());
      expect(health).toMatchObject({ root, instance: nonce, version: ALIASMODE_VERSION, standalone: true });
      child.stdin.write(`${JSON.stringify({ protocol: ready.protocol, command: "shutdown", nonce: "f".repeat(64) })}\n`);
      expect((await fetch(`http://127.0.0.1:${ready.port}/ui/api/health`)).status).toBe(200);
      child.stdin.write(`${JSON.stringify({ protocol: ready.protocol, command: "shutdown", nonce })}\n`);
      while (true) { const { value, done } = await reader.read(); if (done) break; output += new TextDecoder().decode(value); }
      expect(await child.exited).toBe(0);
      expect(output.trim().split("\n").map(line => JSON.parse(line))).toContainEqual({ protocol: ready.protocol, event: "shutdown-complete", nonce });
    } finally {
      child.kill();
      await child.exited;
      reader.releaseLock();
    }
  }, 30000);
});
