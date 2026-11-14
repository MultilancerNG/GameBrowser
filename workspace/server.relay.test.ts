import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { StakeModeWorkspace } from "./server.ts";

function fixture(options: { launched?: boolean; control?: (packet: any) => Promise<void>; sync?: any; syncController?: "relay"; appFetch?: (request: Request) => Response | undefined } = {}) {
  let active = options.launched ?? false, deleted = false;
  const events: string[] = [];
  let bridgeOptions: any;
  const stateRoot = mkdtempSync(join(tmpdir(), "stakemode-relay-"));
  const profile: any = { id: "profile1", name: "Profile 1", engine: "chromium", proxy: null, screenWidth: 1366, screenHeight: 768,
    ramMb: 2048, heapMb: 512, headless: true, urls: ["https://stake.com/casino/games/limbo"], manual: true, state: "stopped",
    pid: null, cpuPercent: null, memoryMb: null, processCount: null, metricsVerified: false, overBudget: false,
    resourcePolicy: "monitored", budgetAction: "pause-sync" };
  const manager: any = { list: () => deleted ? [] : [{ ...profile }, ...((options.sync || options.syncController) ? [{ ...profile, id: "admin", name: "Admin" }] : [])], getProfile: (id: string) => !deleted && (id === profile.id || (options.sync || options.syncController) && id === "admin") ? { ...profile, id } : null,
    getLaunch: () => active ? { profileId: "profile1", pid: 100, ws: "private-internal-owner", startedAt: 1, debugPort: 5000, firefoxOwner: { token: "never-public" } } : null, onChange: () => () => {}, setManual: (_id: string, manual: boolean) => { profile.manual = manual; return profile; },
    canEditProfile: () => !active && !deleted, deleteProfile: async () => { deleted = true; events.push("delete"); return { deleted: true, profileId: profile.id }; },
    updateNetwork: (_id: string, value: any) => { Object.assign(profile, { networkMode: value.networkMode, networkSummary: value.networkMode }); return { ...profile }; },
    dispose: () => {}, bulkCreate: async () => [], start: async () => profile, stop: async () => { active = false; return true; }, forceKill: async () => { active = false; return true; } };
  const bridge: any = { start: () => {}, attach: async () => {}, detach: () => {}, stop: async () => {}, setVisible: () => {}, setActivePage: () => {}, control: options.control ?? (async () => {}), navigate: async () => {}, forgetProfile: async () => { events.push("forget"); },
    browserState: async () => ({ profileId: profile.id, activeTabId: "tab_abcdefghijklmnop", tabs: [{ id: "tab_abcdefghijklmnop", title: "Page", url: "https://ordinary.test/?private=query#fragment", loading: false }], loading: false, canGoBack: null, canGoForward: null }),
    browserAction: async (id: string, command: any) => { bridgeOptions.beforeBrowserAction(id); events.push(`browser:${command.action}`); return bridge.browserState(); },
    cookies: async (_id: string, origin: string) => ({ profileId: profile.id, origin, cookies: [{ name: "session", value: "cookie-secret" }] }),
    changeCookies: async (id: string, value: any) => { bridgeOptions.beforeBrowserAction(id); return { profileId: id, origin: value.origin, changed: 1 }; } };
  const workspace = new StakeModeWorkspace({ stateRoot, sync: options.sync, syncController: options.syncController, appFetch: options.appFetch, launcher: {} as any, store: { getProfile: (id: string) => manager.getProfile(id) } as any, manager, bridgeFactory: config => { bridgeOptions = config; return bridge; },
    assets: { "/workspace/dashboard.html": { body: "<!doctype html><title>StakeMode</title>", contentType: "text/html" } },
    extraFetch: req => new URL(req.url).pathname === "/ui/api/health" ? Response.json({ ready: true, desktop: true }) : undefined });
  const request = (path: string, token?: string, body?: unknown) => new Request(`http://127.0.0.1:${workspace.port ?? 8080}/workspace/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: `127.0.0.1:${workspace.port ?? 8080}`, "x-stakemode-workspace": "1", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { workspace, request, stateRoot, profile, manager, bridge, events, getBridgeOptions: () => bridgeOptions, setActive: (value: boolean) => { active = value; } };
}
test("HTTP bootstrap is same-origin, owner-local, and separates public snapshot from raw launch data", async () => {
  const { workspace, request, stateRoot } = fixture();
  try {
    expect((await workspace.handleRequest(request("snapshot"), "127.0.0.1")).status).toBe(401);
    expect((await workspace.handleRequest(request("bootstrap"), "192.168.1.5")).status).toBe(403);
    const malicious = request("bootstrap"); malicious.headers.set("origin", "https://attacker.test");
    expect((await workspace.handleRequest(malicious, "127.0.0.1")).status).toBe(403);
    const bootstrap = await (await workspace.handleRequest(request("bootstrap"), "127.0.0.1")).json();
    expect(bootstrap.token).toHaveLength(43);
    expect(bootstrap.snapshot.profiles[0].id).toBe("profile1");
    expect(JSON.stringify(bootstrap.snapshot)).not.toContain("firefoxOwner");
    expect(JSON.stringify(bootstrap.snapshot)).not.toContain("token");
    expect((await workspace.handleRequest(request("role", bootstrap.token, { profileId: "profile1", role: "admin" }), "127.0.0.1")).status).toBe(200);
    expect((workspace.snapshot() as any).profiles[0].role).toBe("admin");
    expect((await workspace.handleRequest(request("navigate", bootstrap.token, { profileId: "profile1", url: "https://other.test" }), "127.0.0.1")).status).toBe(409);
    const health = await workspace.handleRequest(new Request("http://127.0.0.1:8080/ui/api/health"), "127.0.0.1");
    expect((await health.json()).desktop).toBe(true);
  } finally { await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});
test("loopback HTTP prevents idle socket reuse and covers assets and health", async () => {
  const { workspace, request, stateRoot } = fixture();
  try {
    await workspace.start();
    // Use actual Node rather than Bun's HTTP compatibility client for the wire check.
    const probe = await new Promise<any>((resolveProbe, rejectProbe) => {
      const child = spawn("node", ["-e", `
        const http = require('node:http');
        const agent = new http.Agent({keepAlive:true,maxSockets:1});
        const sockets = new Set(), responses = [];
        const timer = setTimeout(() => {agent.destroy();process.exit(2)},3000);
        function run() {
          const req = http.get('http://127.0.0.1:${workspace.port}/workspace/api/bootstrap',
            {agent,headers:{'X-StakeMode-Workspace':'1'}},res => {
              sockets.add(res.socket);res.resume();
              res.on('end',() => {
                responses.push({status:res.statusCode,connection:res.headers.connection});
                if(responses.length<2)run();
                else {clearTimeout(timer);agent.destroy();process.stdout.write(JSON.stringify({responses,sockets:sockets.size}))}
              });
            });
          req.on('error',() => {agent.destroy();process.exit(3)});
        }
        run();
      `], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout!.on("data", chunk => { output += chunk.toString(); });
      child.once("error", rejectProbe);
      child.once("exit", code => {
        if (code !== 0) return rejectProbe(new Error(`Node HTTP socket probe exited ${code}`));
        try { resolveProbe(JSON.parse(output)); } catch { rejectProbe(new Error("Node HTTP probe response was invalid")); }
      });
    });
    expect(probe.sockets).toBe(2);
    expect(probe.responses).toEqual([{ status: 200, connection: "close" }, { status: 200, connection: "close" }]);
    expect((await workspace.handleRequest(request("snapshot"), "127.0.0.1")).headers.get("connection")).toBe("close");
    for (const path of ["/workspace/", "/ui/api/health"]) {
      const response = await workspace.handleRequest(new Request(`http://127.0.0.1:8080${path}`), "127.0.0.1");
      expect(response.status).toBe(200);
      expect(response.headers.get("connection")).toBe("close");
      expect((await response.text()).length).toBeGreaterThan(0);
    }
  } finally { await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});
test("loopback WebSocket uses first-message scoped authentication and rejects hostile page origins", async () => {
  const { workspace, request, stateRoot } = fixture();
  let dashboard: WebSocket | undefined, profile: WebSocket | undefined;
  try {
    const bootstrap = await (await workspace.handleRequest(request("bootstrap"), "127.0.0.1")).json();
    expect(await workspace.start()).toBeGreaterThan(0);
    const rejected = await fetch(`http://127.0.0.1:${workspace.port}/workspace/relay`, { headers: { origin: "https://attacker.test", upgrade: "websocket" } });
    expect(rejected.status).toBe(403);
    dashboard = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`, { origin: `http://127.0.0.1:${workspace.port}` });
    await opened(dashboard);
    const first = message(dashboard); dashboard.send(JSON.stringify({ type: "HELLO", client: "dashboard", token: bootstrap.token }));
    expect((await first).type).toBe("SNAPSHOT");
    profile = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`);
    await opened(profile);
    const configured = message(profile); profile.send(JSON.stringify({ type: "HELLO", profileId: "profile1", token: workspace.relay.tokenFor("profile1") }));
    const config = await configured;
    expect(config.type).toBe("CONFIG");
    expect(config.token).toBeUndefined();
    expect(config.origins).toEqual(["https://stake.com"]);
    const unicode = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`); await opened(unicode);
    const unicodeClosed = new Promise<number>(resolve => unicode.on("close", code => resolve(code)));
    unicode.send(JSON.stringify({ type: "HELLO", profileId: "profile1", token: "é".repeat(43) }));
    expect(await unicodeClosed).toBe(4001);
    const malformed = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`); await opened(malformed);
    const malformedClosed = new Promise<number>(resolve => malformed.on("close", code => resolve(code)));
    malformed.send("{broken JSON");
    expect(await malformedClosed).toBe(4002);
    const bad = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`); await opened(bad);
    const closed = new Promise<number>(resolve => bad.on("close", code => resolve(code)));
    bad.send(JSON.stringify({ type: "HELLO", profileId: "profile1", token: bootstrap.token }));
    expect(await closed).toBe(4001);
  } finally { dashboard?.close(); profile?.close(); await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});
function opened(socket: WebSocket): Promise<void> { return new Promise((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); }); }
function message(socket: WebSocket, label = "message"): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Expected WebSocket ${label}`)), 2000);
    socket.once("message", value => { clearTimeout(timer); resolve(JSON.parse(value.toString())); });
  });
}

test("explicit tile controls preserve click-before-text ordering", async () => {
  const order: string[] = [];
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const { workspace, request, stateRoot } = fixture({ launched: true, control: async input => {
    order.push(`${input.kind}-start`);
    await new Promise(resolve => setTimeout(resolve, 25));
    order.push(`${input.kind}-end`);
    if (input.kind === "text") complete();
  } });
  let dashboard: WebSocket | undefined;
  try {
    const bootstrap = await (await workspace.handleRequest(request("bootstrap"), "127.0.0.1")).json();
    await workspace.start();
    dashboard = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`, { origin: `http://127.0.0.1:${workspace.port}` });
    await opened(dashboard);
    const hello = message(dashboard); dashboard.send(JSON.stringify({ type: "HELLO", client: "dashboard", token: bootstrap.token })); await hello;
    dashboard.send(JSON.stringify({ type: "SUBSCRIBE", profileIds: ["profile1"] }));
    dashboard.send(JSON.stringify({ type: "FOCUS", profileId: "profile1" }));
    dashboard.send(JSON.stringify({ type: "CONTROL", profileId: "profile1", kind: "click", x: 10, y: 20 }));
    dashboard.send(JSON.stringify({ type: "CONTROL", profileId: "profile1", kind: "text", text: "hello" }));
    await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error("Manual input did not finish")), 2000))]);
    expect(order).toEqual(["click-start", "click-end", "text-start", "text-end"]);
  } finally { dashboard?.close(); await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});
test("closing and reconnecting the dashboard retains explicit worker roles without replaying extension actions", async () => {
  const sync = { status: () => ({ adminId: "admin", followerIds: ["profile1"], active: true }), stop: async () => ({}) };
  const { workspace, request, stateRoot } = fixture({ launched: true, sync });
  let dashboard: WebSocket | undefined, follower: WebSocket | undefined, reconnected: WebSocket | undefined;
  const received: any[] = [];
  try {
    workspace.relay.register("admin", "https://stake.com");
    const bootstrap = await (await workspace.handleRequest(request("bootstrap"), "127.0.0.1")).json();
    await workspace.start();
    dashboard = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`, { origin: `http://127.0.0.1:${workspace.port}` }); await opened(dashboard);
    const hello = message(dashboard); dashboard.send(JSON.stringify({ type: "HELLO", client: "dashboard", token: bootstrap.token })); await hello;
    const adminConfig = workspace.relay.register("admin", "https://stake.com");
    const adminTransport = { send: () => {}, close: () => {} };
    workspace.relay.authenticate("admin", adminConfig.token, adminTransport);
    workspace.relay.setRole("admin", "admin"); workspace.relay.setRole("profile1", "follower");
    follower = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`); await opened(follower);
    const configured = message(follower); follower.send(JSON.stringify({ type: "HELLO", profileId: "profile1", token: workspace.relay.tokenFor("profile1") })); await configured;
    follower.on("message", value => received.push(JSON.parse(value.toString())));
    follower.send(JSON.stringify({ type: "PAGE", url: "https://stake.com/casino/games/limbo" }));
    workspace.relay.receive("admin", adminTransport, { type: "PAGE", url: "https://stake.com/casino/games/limbo" });
    for (let attempt = 0; attempt < 200 && workspace.relay.statuses().find(p => p.profileId === 'profile1')?.origin !== 'https://stake.com'; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(workspace.relay.statuses().find(p => p.profileId === 'profile1')?.origin).toBe('https://stake.com');
    const action = (seq: number) => ({ type: "ACTION", id: `scroll000${seq}`, seq, epoch: workspace.relay.epoch, action: "scroll", origin: "https://stake.com", url: "https://stake.com/casino/games/limbo", x: 0, y: seq * 20 });
    workspace.relay.receive("admin", adminTransport, action(1)); workspace.relay.receive("admin", adminTransport, action(2));
    expect(workspace.relay.statuses().find(p => p.profileId === "profile1")!.queued).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 50));
    const actionsBeforeDisconnect = received.filter(p => p.type === "ACTION").length;
    const closed = new Promise<void>(resolve => dashboard!.once("close", () => resolve())); dashboard.close(); await closed;
    await new Promise(resolve => setTimeout(resolve, 15));
    const status = workspace.relay.statuses().find(p => p.profileId === "profile1")!;
    expect(status.role).toBe("follower"); expect(status.queued).toBe(0);
    follower.send(JSON.stringify({ type: "ACK", epoch: workspace.relay.configFor("profile1")!.epoch, id: "scroll0001", status: "applied" }));
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(received.filter(p => p.type === "ACTION")).toHaveLength(actionsBeforeDisconnect);
    reconnected = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`, { origin: `http://127.0.0.1:${workspace.port}` }); await opened(reconnected);
    const resumed = message(reconnected); reconnected.send(JSON.stringify({ type: "HELLO", client: "dashboard", token: bootstrap.token }));
    expect((await resumed).snapshot.profiles[0].role).toBe("follower");
  } finally { dashboard?.close(); follower?.close(); reconnected?.close(); await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});

test("explicit role selectors can configure Admin first and add followers without requiring an incomplete worker group", async () => {
  let state: any = { active: false, adminId: null, followerIds: [], saved: false };
  let starts = 0;
  const sync = { status: () => state, async stop() { state = { ...state, active: false, adminId: null, followerIds: [] }; return state; },
    async start(adminId: string, followerIds: string[]) { starts++; state = { ...state, active: true, adminId, followerIds }; return state; } };
  const { workspace, request, stateRoot } = fixture({ launched: true, sync });
  try {
    const boot = await (await workspace.handleRequest(request("bootstrap"), "127.0.0.1")).json();
    expect((await workspace.handleRequest(request("role", boot.token, { profileId: "profile1", role: "admin" }), "127.0.0.1")).status).toBe(200);
    expect(starts).toBe(0);
    expect((workspace.snapshot() as any).profiles.find((profile: any) => profile.id === "profile1").role).toBe("admin");
    expect((await workspace.handleRequest(request("role", boot.token, { profileId: "admin", role: "follower" }), "127.0.0.1")).status).toBe(200);
    expect(starts).toBe(1); expect(state).toMatchObject({ adminId: "profile1", followerIds: ["admin"] });
    // Address/tab selection and a snapshot refresh do not change this assignment.
    workspace.snapshot(); expect(starts).toBe(1);
  } finally { await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});

test("followers remain viewable but native input and navigation require explicit manual takeover", async () => {
  let state: any = { active: true, adminId: "admin", followerIds: ["profile1"], saved: false };
  const sync = { status: () => state, async stop() { state = { ...state, active: false, adminId: null, followerIds: [] }; return state; } };
  let controls = 0, controlled!: () => void;
  const completed = new Promise<void>(resolve => { controlled = resolve; });
  const { workspace, request, stateRoot, getBridgeOptions } = fixture({ launched: true, sync, control: async () => { controls++; controlled(); } });
  let dashboard: WebSocket | undefined;
  const received: any[] = [];
  try {
    const boot = await (await workspace.handleRequest(request("bootstrap"), "127.0.0.1")).json();
    expect((await workspace.handleRequest(request("profiles/profile1/browser", boot.token), "127.0.0.1")).status).toBe(200);
    expect((await workspace.handleRequest(request("profiles/profile1/browser", boot.token, { action: "navigate", url: "https://example.test" }), "127.0.0.1")).status).toBe(403);
    expect(getBridgeOptions().canControl("profile1")).toBe(false);
    await workspace.start();
    dashboard = new WebSocket(`ws://127.0.0.1:${workspace.port}/workspace/relay`); await opened(dashboard);
    // Bun 1.2's ws shim needs a persistent listener when successive once listeners are installed.
    dashboard.on("message", value => received.push(JSON.parse(value.toString())));
    const hello = message(dashboard, "follower hello"); dashboard.send(JSON.stringify({ type: "HELLO", client: "dashboard", token: boot.token })); await hello;
    dashboard.send(JSON.stringify({ type: "SUBSCRIBE", profileIds: ["profile1"] }));
    dashboard.send(JSON.stringify({ type: "FOCUS", profileId: "profile1" }));
    const denied = message(dashboard, "follower input denial");
    dashboard.send(JSON.stringify({ type: "CONTROL", profileId: "profile1", kind: "text", text: "must not type" }));
    expect((await denied).type).toBe("CONTROL_ERROR"); expect(controls).toBe(0);
    const frame = message(dashboard, "follower frame");
    getBridgeOptions().onFrame({ type: "FRAME", profileId: "profile1", jpeg: "frame", width: 1366, height: 768, sequence: 1, at: Date.now(), url: "https://example.test" });
    expect((await frame).type).toBe("FRAME");
    expect((await workspace.handleRequest(request("role", boot.token, { profileId: "profile1", role: "manual" }), "127.0.0.1")).status).toBe(200);
    expect(getBridgeOptions().canControl("profile1")).toBe(true);
    dashboard.send(JSON.stringify({ type: "CONTROL", profileId: "profile1", kind: "text", text: "explicit manual input" }));
    await completed; expect(controls).toBe(1);
    expect(received.map(packet => packet.type)).toContain("CONTROL_ERROR");
    expect(received.map(packet => packet.type)).toContain("FRAME");
  } finally { dashboard?.close(); await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});

test("browser HTTP controls enforce local authorization, force manual before navigation and keep full URLs off snapshots", async () => {
  const { workspace, request, stateRoot, events, profile, getBridgeOptions } = fixture({ launched: true });
  try {
    const token = (await (await workspace.handleRequest(request("bootstrap"), "127.0.0.1")).json()).token;
    const route = "profiles/profile1/browser";
    expect((await workspace.handleRequest(request(route), "127.0.0.1")).status).toBe(401);
    const state = await (await workspace.handleRequest(request(route, token), "127.0.0.1")).json();
    expect(state.browser.tabs[0].url).toContain("?private=query#fragment");
    expect(JSON.stringify(workspace.snapshot())).not.toContain("private=query");
    workspace.relay.setRole("profile1", "admin"); profile.manual = false;
    const before = workspace.relay.configFor("profile1")!.epoch;
    const response = await workspace.handleRequest(request(route, token, { action: "navigate", url: "https://ordinary.test/path?q=secret#result" }), "127.0.0.1");
    expect(response.status).toBe(200); expect(events).toContain("browser:navigate");
    expect(workspace.relay.configFor("profile1")!.role).toBe("manual"); expect(workspace.relay.configFor("profile1")!.epoch).toBeGreaterThan(before);
    expect(profile.manual).toBe(true); expect(workspace.relay.origins).not.toContain("https://ordinary.test");
    workspace.relay.setRole("profile1", "follower"); profile.manual = false;
    expect((await workspace.handleRequest(request(route, token), "127.0.0.1")).status).toBe(200);
    expect((await workspace.handleRequest(request(route, token, { action: "reload" }), "127.0.0.1")).status).toBe(403);
    workspace.relay.setRole("profile1", "admin"); getBridgeOptions().onNavigation("profile1", "https://unapproved.test/page");
    expect(workspace.relay.configFor("profile1")!.role).toBe("manual");
    expect((await workspace.handleRequest(request(route, token, { action: "navigate", url: "javascript:alert(1)" }), "127.0.0.1")).status).toBe(400);
  } finally { await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});
test("deletion requires typed confirmation and stopped ownership, then revokes tokens and generated credentials", async () => {
  const { workspace, request, stateRoot, setActive, events } = fixture({ launched: true });
  try {
    const token = (await (await workspace.handleRequest(request("bootstrap"), "127.0.0.1")).json()).token;
    const oldToken = workspace.relay.tokenFor("profile1")!;
    const remove = (confirmation: string) => { const base = request("profiles/profile1", token, { confirmation }); return new Request(base, { method: "DELETE" }); };
    expect((await workspace.handleRequest(remove("wrong"), "127.0.0.1")).status).toBe(400);
    expect((await workspace.handleRequest(remove("profile1"), "127.0.0.1")).status).toBe(409);
    expect((await workspace.handleRequest(request("profiles/profile1/network", token, { networkMode: "system" }), "127.0.0.1")).status).toBe(409);
    setActive(false);
    const generated = join(stateRoot, "sync-extensions", "profile1"); mkdirSync(generated, { recursive: true }); writeFileSync(join(generated, "config.json"), "private");
    const network = await workspace.handleRequest(request("profiles/profile1/network", token, { networkMode: "system" }), "127.0.0.1");
    expect(network.status).toBe(200); expect((await network.json()).profile.networkMode).toBe("system");
    const deleted = await workspace.handleRequest(remove("profile1"), "127.0.0.1"); expect(deleted.status).toBe(200);
    expect(events).toEqual(["delete", "forget"]); expect(existsSync(generated)).toBe(false);
    expect(workspace.relay.authenticate("profile1", oldToken, { send: () => {}, close: () => {} })).toBe(false);
    expect((await workspace.handleRequest(request("profiles/profile1/browser", token), "127.0.0.1")).status).toBe(404);
    expect((workspace.snapshot() as any).profiles).toHaveLength(0);
  } finally { await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});
test("manual startup is independent of sync origins and empty scopes produce no website permissions", async () => {
  const { workspace, profile, stateRoot } = fixture();
  try {
    profile.urls = ["https://ordinary.test/path"];
    workspace.relay.unregister("profile1");
    await (workspace as any).prepareProfile("profile1", profile);
    expect(workspace.relay.configFor("profile1")!.origins).toEqual([]);
    const manifest = await Bun.file(join(stateRoot, "sync-extensions", "profile1", "manifest.json")).json();
    expect(manifest.host_permissions).toEqual([]); expect(manifest.content_scripts).toEqual([]);
    expect(workspace.relay.origins).not.toContain("https://ordinary.test");
  } finally { await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});
test("cookies use direct authenticated HTTP responses and mutations switch the selected profile to manual", async () => {
  const { workspace, request, stateRoot, profile } = fixture({ launched: true });
  try {
    const token = (await (await workspace.handleRequest(request("bootstrap"), "127.0.0.1")).json()).token;
    const exported = await workspace.handleRequest(request("profiles/profile1/cookies?origin=https%3A%2F%2Fordinary.test", token), "127.0.0.1");
    expect(exported.status).toBe(200); expect((await exported.json()).cookies[0].value).toBe("cookie-secret");
    expect(JSON.stringify(workspace.snapshot())).not.toContain("cookie-secret");
    workspace.relay.setRole("profile1", "admin"); profile.manual = false;
    const changed = await workspace.handleRequest(request("profiles/profile1/cookies", token, { action: "clear", origin: "https://ordinary.test" }), "127.0.0.1");
    expect(changed.status).toBe(200); expect(workspace.relay.configFor("profile1")!.role).toBe("manual");
  } finally { await workspace.stop(); rmSync(stateRoot, { recursive: true, force: true }); }
});

test("independent relay controller owns saved following without the host worker or trusted endpoint restrictions", async () => {
  const f = fixture({ launched: true, syncController: "relay" });
  try {
    const bootstrap = await (await f.workspace.handleRequest(f.request("bootstrap"), "127.0.0.1")).json();
    expect(f.getBridgeOptions().controller).toBe("extension");
    const started = await (await f.workspace.handleRequest(f.request("sync", bootstrap.token, { adminId: "admin", followerIds: ["profile1"], saveSession: true }), "127.0.0.1")).json();
    expect(started).toMatchObject({ adminId: "admin", followerIds: ["profile1"], active: false, waiting: true, saved: true });
    expect(started.snapshot.profiles.find((row: any) => row.id === "profile1")).toMatchObject({ role: "follower", syncMechanism: "Manifest V3 extension / authenticated page binding", connected: false });
    expect(started.snapshot.policy.credentialsMirrored).toBe(false);
    const adminConfig = f.workspace.relay.configFor("admin")!;
    const followerConfig = f.workspace.relay.configFor("profile1")!;
    const transport = () => ({ send() {}, close() {} });
    f.workspace.relay.authenticate("admin", adminConfig.token, transport());
    f.workspace.relay.authenticate("profile1", followerConfig.token, transport());
    expect((f.workspace.snapshot() as any).syncSession.active).toBe(true);
    f.workspace.relay.disconnect("profile1");
    expect((f.workspace.snapshot() as any).profiles.find((row: any) => row.id === "profile1").role).toBe("follower");
    await f.workspace.quiesce();
    expect((await import("./sessionController.ts")).RelaySessionController).toBeDefined();
    expect(f.manager.getLaunch("profile1")).not.toBeNull();
    const saved = JSON.parse(readFileSync(join(f.stateRoot, "workspace", "following-session.json"), "utf8"));
    expect(saved).toMatchObject({ adminId: "admin", followerIds: ["profile1"] });
  } finally { await f.workspace.stop({ stopSync: false }); rmSync(f.stateRoot, { recursive: true, force: true }); }
});

test("standalone application routes run only after local origin and dashboard token authentication", async () => {
  let calls = 0;
  const f = fixture({ appFetch: request => new URL(request.url).pathname === "/workspace/api/app/probe" ? (calls++, Response.json({ ok: true })) : undefined });
  try {
    expect((await f.workspace.handleRequest(f.request("app/probe"), "127.0.0.1")).status).toBe(401);
    expect(calls).toBe(0);
    const bootstrap = await (await f.workspace.handleRequest(f.request("bootstrap"), "127.0.0.1")).json();
    const crossOrigin = f.request("app/probe", bootstrap.token, {}); crossOrigin.headers.set("origin", "https://foreign.test");
    expect((await f.workspace.handleRequest(crossOrigin, "127.0.0.1")).status).toBe(403);
    expect(calls).toBe(0);
    expect((await f.workspace.handleRequest(f.request("app/probe", bootstrap.token, {}), "127.0.0.1")).status).toBe(200);
    expect(calls).toBe(1);
  } finally { await f.workspace.stop(); rmSync(f.stateRoot, { recursive: true, force: true }); }
});

test("Cloud prelaunch preparation requires the exact cached identity and cannot prepare another profile", async () => {
  const f = fixture({ launched: true, syncController: "relay" });
  try {
    await f.workspace.prepareLaunch("profile1", f.profile);
    await expect(f.workspace.prepareLaunch("profile1", { ...f.profile, name: "Changed identity" })).rejects.toThrow("identity or access changed");
    await expect(f.workspace.prepareLaunch("admin", f.profile)).rejects.toThrow("identity or access changed");
    await expect(f.workspace.prepareLaunch("missing", { ...f.profile, id: "missing" })).rejects.toThrow("identity or access changed");
  } finally { await f.workspace.stop(); rmSync(f.stateRoot, { recursive: true, force: true }); }
});
