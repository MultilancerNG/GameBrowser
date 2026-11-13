import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_PROTOCOL,
  DesktopCredentialBridge,
  ManagedDesktopRuntime,
  agentControlNonce,
  desktopHealthMetadata,
  desktopReadyRecord,
  isDesktopShutdownCommand,
} from "./desktop-runtime.ts";

const NONCE = "ab".repeat(32);

function admission(inFlight = 0, queued = 0): any {
  return { stats: () => ({ inFlight, queued }) };
}

test("desktop health metadata requires a nonce, version, and root", () => {
  expect(desktopHealthMetadata({}, undefined)).toBeNull();
  expect(desktopHealthMetadata({
    ALIASMODE_DESKTOP_NONCE: NONCE,
    ALIASMODE_DESKTOP_VERSION: "0.1.0-beta.1",
  }, "C:\\Users\\me\\AppData\\Roaming\\com.aliasmode.desktop")).toEqual({
    instance: NONCE,
    version: "0.1.0-beta.1",
    root: "C:\\Users\\me\\AppData\\Roaming\\com.aliasmode.desktop",
  });
  expect(() => desktopHealthMetadata({
    ALIASMODE_DESKTOP_NONCE: "not-a-nonce",
    ALIASMODE_DESKTOP_VERSION: "0.1.0-beta.1",
  }, "root")).toThrow("64 lowercase hexadecimal");
});

test("agent control uses a separate validated desktop nonce", () => {
  expect(agentControlNonce({})).toBeNull();
  expect(agentControlNonce({ ALIASMODE_AGENT_NONCE: NONCE })).toBe(NONCE);
  expect(() => agentControlNonce({ ALIASMODE_AGENT_NONCE: "invalid" }))
    .toThrow("ALIASMODE_AGENT_NONCE");
});

test("desktop readiness is emitted only for a valid owned port and pid", () => {
  expect(desktopReadyRecord(NONCE, 49_152, 42)).toEqual({
    protocol: DESKTOP_PROTOCOL,
    event: "ready",
    nonce: NONCE,
    pid: 42,
    port: 49_152,
  });
  expect(() => desktopReadyRecord(NONCE, 0, 42)).toThrow("port is invalid");
  expect(() => desktopReadyRecord(NONCE, 49_152, 0)).toThrow("pid is invalid");
});

test("desktop control accepts only the fixed nonce-bound shutdown command", () => {
  const valid = JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "shutdown", nonce: NONCE });
  expect(isDesktopShutdownCommand(valid, NONCE)).toBe(true);
  expect(isDesktopShutdownCommand(JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "shutdown", nonce: "cd".repeat(32) }), NONCE)).toBe(false);
  expect(isDesktopShutdownCommand(JSON.stringify({ protocol: DESKTOP_PROTOCOL, command: "run", nonce: NONCE }), NONCE)).toBe(false);
  expect(isDesktopShutdownCommand("not json", NONCE)).toBe(false);
});

test("desktop control gracefully shuts down when the parent stdin pipe closes", () => {
  const source = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  expect(source).toContain('process.stdin.once("end", shutdown);');
  expect(source).toContain('process.stdin.once("close", shutdown);');
});

test("desktop Cloud automation API receives the shared Cloud browser lifecycle", () => {
  const source = readFileSync(join(import.meta.dir, "cli.ts"), "utf8");
  const cloudStart = source.indexOf('if (configuredMode.mode === "cloud")');
  const automationStart = source.indexOf("serveDesktopAutomationApi({", cloudStart);
  const automationEnd = source.indexOf("})", automationStart);
  const automationSetup = source.slice(automationStart, automationEnd);
  expect(automationSetup).toContain("cloudBrowser,");
});

test("desktop credential bridge waits for a nonce-bound parent acknowledgement", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const stored = bridge.persistRefreshToken("rotated-refresh");
  const request = JSON.parse(output[0]!) as { request: number };
  expect(bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: "cd".repeat(32),
    request: request.request,
    ok: true,
  }))).toBe(false);
  expect(bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: request.request,
    ok: true,
  }))).toBe(true);
  await stored;
});

test("desktop credential bridge surfaces Credential Manager rejection", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const stored = bridge.persistRefreshToken("rotated-refresh");
  const request = JSON.parse(output[0]!) as { request: number };
  bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: request.request,
    ok: false,
  }));
  await expect(stored).rejects.toThrow("Credential Manager rejected");
});

test("desktop credential bridge clears refresh and device credentials", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const cleared = bridge.clearCloudSessionCredentials();
  const refresh = JSON.parse(output[0]!) as { request: number; event: string; key: string };
  expect(refresh).toMatchObject({ event: "credential-delete", key: "refresh_token" });
  bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: refresh.request,
    ok: true,
  }));
  await Promise.resolve();
  const device = JSON.parse(output[1]!) as { request: number; event: string; key: string };
  expect(device).toMatchObject({ event: "credential-delete", key: "device_credential" });
  bridge.handleLine(JSON.stringify({
    protocol: DESKTOP_PROTOCOL,
    event: "credential-result",
    nonce: NONCE,
    request: device.request,
    ok: true,
  }));
  await cleared;
  expect(output.map((line) => JSON.parse(line).key)).toEqual(["refresh_token", "device_credential"]);
  expect(output.join("\n")).not.toContain("queue_encryption_key");
});

test("desktop credential bridge attempts both Cloud credential deletes after one rejection", async () => {
  const output: string[] = [];
  const bridge = new DesktopCredentialBridge(NONCE, (line) => { output.push(line); });
  const cleared = bridge.clearCloudSessionCredentials();
  expect(output).toHaveLength(2);
  const requests = output.map((line) => JSON.parse(line) as { request: number; key: string });
  for (const request of requests) {
    bridge.handleLine(JSON.stringify({
      protocol: DESKTOP_PROTOCOL,
      event: "credential-result",
      nonce: NONCE,
      request: request.request,
      ok: request.key === "device_credential",
    }));
  }
  await expect(cleared).rejects.toThrow("could not clear Cloud credentials");
  expect(requests.map((request) => request.key)).toEqual(["refresh_token", "device_credential"]);
  expect(output.join("\n")).not.toContain("queue_encryption_key");
});

test("desktop shutdown coalesces and closes both listeners before authoritative local launches", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("dashboard"); } },
    automationServer: { stop: async () => { events.push("automation"); } },
    admission: admission(),
    store: {
      listLaunches: () => [{ profileId: "one" }, { profileId: "two" }],
      close: () => { events.push("store"); },
    },
    launcher: { stop: async (id) => { events.push(`stop:${id}`); return true; } },
    stopInbox: () => { events.push("inbox"); },
  });

  const first = runtime.shutdown();
  const second = runtime.shutdown();
  expect(first).toBe(second);
  await first;
  expect(events.slice(0, 2).sort()).toEqual(["automation", "dashboard"]);
  expect(events.slice(2)).toEqual(["inbox", "stop:one", "stop:two", "store"]);
});

test("desktop shutdown stops script workers before browser capture and store close", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("server"); }, stopScripts: async () => { events.push("scripts"); } },
    admission: admission(),
    store: { listLaunches: () => [{ profileId: "one" }], close: () => { events.push("store"); } },
    launcher: { stop: async () => { events.push("browser"); return true; } },
  });
  await runtime.shutdown();
  expect(events).toEqual(["server", "scripts", "browser", "store"]);
});

test("desktop shutdown closes a real owned WebSocket and drains HTTP plus admission before final listener cleanup", async () => {
  let peer: import("bun").ServerWebSocket<unknown> | undefined;
  let requestEntered!: () => void, releaseRequest!: () => void, scriptsStopped!: () => void;
  const entered = new Promise<void>(resolve => { requestEntered = resolve; });
  const responseReady = new Promise<void>(resolve => { releaseRequest = resolve; });
  const scriptsDone = new Promise<void>(resolve => { scriptsStopped = resolve; });
  const events: string[] = [], stops: Array<boolean | undefined> = [];
  const activity = { inFlight: 0, queued: 0 };
  const listener = Bun.serve<Record<string, never>>({ hostname: "127.0.0.1", port: 0, development: false,
    async fetch(request, server) {
      if (new URL(request.url).pathname === "/socket") {
        if (server.upgrade(request, { data: {} })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      requestEntered(); await responseReady; events.push("http-finished"); return new Response("saved");
    },
    websocket: { open(socket) { peer = socket; }, message() {} },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/socket`);
  let shutdown: Promise<void> | undefined;
  let response: Promise<Response> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const closed = new Promise<void>(resolve => socket.addEventListener("close", () => resolve(), { once: true }));
    response = fetch(`http://127.0.0.1:${listener.port}/save`); await entered;
    const runtime = new ManagedDesktopRuntime({
      server: {
        get pendingRequests() { return listener.pendingRequests; },
        get pendingWebSockets() { return listener.pendingWebSockets; },
        stop(force) { stops.push(force); events.push(force ? "listener-finished" : "listener-requested"); return listener.stop(force); },
        async stopScripts() { peer!.close(1001, "Desktop stopping"); peer!.terminate(); await closed; events.push("scripts"); scriptsStopped(); },
      },
      admission: { stats: () => activity } as any,
      store: { listLaunches: () => [{ profileId: "owned" }], close: () => { events.push("store"); } },
      launcher: { stop: async () => { events.push("browser"); return true; } },
      shutdownTimeoutMs: 2000,
    });
    shutdown = runtime.shutdown(); await scriptsDone;
    // HTTP alone must keep the listener in graceful mode, even without admission work.
    await Bun.sleep(30);
    expect(stops).toEqual([false]); expect(events).not.toContain("browser"); expect(events).not.toContain("store");
    activity.inFlight = 1;
    releaseRequest(); expect(await (await response).text()).toBe("saved");
    // The admitted lifecycle transition still owns its work after HTTP completes.
    await Bun.sleep(30); expect(stops).toEqual([false]); expect(events).not.toContain("browser");
    activity.inFlight = 0;
    await shutdown;
    expect(stops[0]).toBe(false);
    expect(events.indexOf("scripts")).toBeGreaterThan(events.indexOf("listener-requested"));
    expect(events.indexOf("browser")).toBeGreaterThan(events.indexOf("http-finished"));
    expect(events.at(-1)).toBe("store");
  } finally {
    activity.inFlight = 0; releaseRequest(); socket.close(); peer?.terminate();
    await Promise.allSettled([...(response ? [response] : []), ...(shutdown ? [shutdown] : [])]);
    await listener.stop(true);
  }
}, 10_000);

test("desktop shutdown never repairs a WebSocket drain without known zero HTTP work and an owned transport hook", async () => {
  for (const counters of [{ pendingRequests: undefined, stopScripts: async () => {} }, { pendingRequests: 0, stopScripts: undefined }]) {
    const stops: Array<boolean | undefined> = [];
    const runtime = new ManagedDesktopRuntime({
      server: { pendingWebSockets: 1, ...counters, stop: force => { stops.push(force); return new Promise<void>(() => {}); } },
      admission: admission(),
      store: { listLaunches: () => [], close: () => {} }, launcher: { stop: async () => true }, shutdownTimeoutMs: 20,
    });
    await expect(runtime.shutdown()).rejects.toThrow("desktop shutdown deadline expired");
    expect(stops).toEqual([false]);
  }
});

test("an initial listener failure remains a shutdown failure after owned transport cleanup", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { pendingRequests: 0, pendingWebSockets: 1,
      stop: async force => { events.push(`listener:${force}`); throw new Error("initial listener failure"); },
      stopScripts: async () => { events.push("scripts"); },
    },
    admission: admission(),
    store: { listLaunches: () => [], close: () => { events.push("store"); } }, launcher: { stop: async () => true },
  });
  await expect(runtime.shutdown()).rejects.toThrow("initial listener failure");
  expect(events).toEqual(["listener:false", "scripts", "store"]);
});

test("a previously accepted late WebSocket upgrade cannot strand shutdown after owned transport cleanup", async () => {
  let sockets = 0, http = 1;
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: {
      get pendingRequests() { return http; }, get pendingWebSockets() { return sockets; },
      stop(force) {
        events.push(`listener:${force}`);
        if (force) { expect(http).toBe(0); return Promise.resolve(); }
        expect(sockets).toBe(0); return new Promise<void>(() => {});
      },
      async stopScripts() {
        // An accepted upgrade finishes opening while owned sessions are being closed.
        sockets = 1; http = 0; events.push("owned-transports-closed");
      },
    },
    admission: admission(),
    store: { listLaunches: () => [{ profileId: "owned" }], close: () => { events.push("store"); } },
    launcher: { stop: async () => { events.push("browser"); return true; } }, shutdownTimeoutMs: 100,
  });
  await runtime.shutdown();
  expect(events).toEqual(["listener:false", "owned-transports-closed", "listener:true", "browser", "store"]);
});

test("desktop shutdown attempts both listener stops when one fails", async () => {
  const events: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("dashboard"); } },
    automationServer: { stop: async () => { events.push("automation"); throw new Error("automation stop failed"); } },
    admission: admission(),
    store: { listLaunches: () => [], close: () => { events.push("store"); } },
    launcher: { stop: async () => true },
  });

  await expect(runtime.shutdown()).rejects.toThrow("automation stop failed");
  expect(events.slice(0, 2).sort()).toEqual(["automation", "dashboard"]);
  expect(events.at(-1)).toBe("store");
});

test("desktop shutdown delegates remote capture and release to the coordinator drain", async () => {
  const events: string[] = [];
  let remainingMs = 0;
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => { events.push("server"); } },
    admission: admission(),
    store: { listLaunches: () => [], close: () => { events.push("store"); } },
    launcher: { stop: async () => { throw new Error("local stop must not run"); } },
    remoteShutdown: async (remaining) => { remainingMs = remaining; events.push("releaseAll"); },
  });
  await runtime.shutdown();
  expect(events).toEqual(["server", "releaseAll", "store"]);
  expect(remainingMs).toBeGreaterThan(0);
});

test("desktop shutdown attempts every local browser after one stop throws", async () => {
  const attempted: string[] = [];
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => {} },
    admission: admission(),
    store: {
      listLaunches: () => [{ profileId: "one" }, { profileId: "two" }],
      close: () => {},
    },
    launcher: {
      stop: async (id) => {
        attempted.push(id);
        if (id === "one") throw new Error("stop failed");
        return true;
      },
    },
  });
  await expect(runtime.shutdown()).rejects.toThrow("browser teardown was not confirmed");
  expect(attempted).toEqual(["one", "two"]);
});

test("desktop shutdown fails closed when browser teardown is unconfirmed", async () => {
  let storeClosed = false;
  const runtime = new ManagedDesktopRuntime({
    server: { stop: async () => {} },
    admission: admission(),
    store: { listLaunches: () => [{ profileId: "one" }], close: () => { storeClosed = true; } },
    launcher: { stop: async () => false },
  });
  await expect(runtime.shutdown()).rejects.toThrow("browser teardown was not confirmed");
  expect(storeClosed).toBe(true);
});

test("the Windows installer stops a leftover sidecar before overwriting it", () => {
  const hooks = readFileSync(
    join(import.meta.dir, "src-tauri", "windows", "installer-hooks.nsh"),
    "utf8",
  );
  expect(hooks).toContain("!macro NSIS_HOOK_PREINSTALL");
  // A graceful attempt first, then force: a locked sidecar aborts the install.
  expect(hooks).toContain(`nsExec::Exec 'taskkill /IM "aliasmode-sidecar.exe"'`);
  expect(hooks).toContain(`nsExec::Exec 'taskkill /F /T /IM "aliasmode-sidecar.exe"'`);
  // An AI client can hold the MCP helper launcher open as well. It goes first, and without its
  // process tree: the helper may have started the desktop app.
  const helperKill = hooks.indexOf(`nsExec::Exec 'taskkill /F /IM "aliasmode-mcp.exe"'`);
  expect(helperKill).toBeGreaterThan(0);
  expect(helperKill).toBeLessThan(hooks.indexOf(`taskkill /IM "aliasmode-sidecar.exe"`));
  expect(hooks).not.toContain(`/T /IM "aliasmode-mcp.exe"`);
  // An update removes the Python runtime that earlier versions bundled.
  expect(hooks).toContain(`RMDir /r "$INSTDIR\\playwright\\python"`);
});
