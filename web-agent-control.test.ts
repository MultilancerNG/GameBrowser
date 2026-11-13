import { expect, test } from "bun:test";
import WebSocket from "ws";
import {
  AGENT_CONTROL_PATH,
  AGENT_CONTROL_PROTOCOL,
} from "./agent-control.ts";
import { LifecycleAdmissionController } from "./lifecycle-admission.ts";
import { ProfileStore } from "./store.ts";
import { serveDashboard } from "./web.ts";

function openSocket(url: string, nonce: string): Promise<WebSocket> {
  const socket = new WebSocket(url, AGENT_CONTROL_PROTOCOL, {
    headers: { Authorization: `Bearer ${nonce}` },
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("agent WebSocket requires its separate nonce and serves protocol requests", async () => {
  const nonce = "a".repeat(64);
  const store = new ProfileStore(":memory:");
  const launcher = {
    reconcileOrphans: async () => {},
  };
  const server = serveDashboard({
    launcher: launcher as any,
    store,
    port: 0,
    agentNonce: nonce,
    lifecycleAdmission: new LifecycleAdmissionController(),
    log: () => {},
  });
  const endpoint = `http://127.0.0.1:${server.port}${AGENT_CONTROL_PATH}`;

  try {
    const missing = await fetch(endpoint, {
      headers: { "sec-websocket-protocol": AGENT_CONTROL_PROTOCOL },
    });
    expect(missing.status).toBe(401);

    const socket = await openSocket(endpoint.replace("http:", "ws:"), nonce);
    const response = new Promise<any>((resolve) => {
      socket.once("message", (data: Buffer) => resolve(JSON.parse(data.toString("utf8"))));
    });
    socket.send(JSON.stringify({
      protocol: AGENT_CONTROL_PROTOCOL,
      id: 9,
      method: "profiles.list",
      params: {},
    }));
    expect(await response).toEqual({
      protocol: AGENT_CONTROL_PROTOCOL,
      id: 9,
      ok: true,
      result: { profiles: [] },
    });
    socket.close();
  } finally {
    await server.stop(true);
    store.close();
  }
});

test("dashboard shutdown closes retained agent sockets and rejects new HTTP work and upgrades", async () => {
  const nonce = "b".repeat(64), store = new ProfileStore(":memory:");
  const server = serveDashboard({ launcher: { reconcileOrphans: async () => {} } as any,
    store, port: 0, agentNonce: nonce, log: () => {} });
  let socket: WebSocket | undefined;
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    socket = await openSocket(`${origin}${AGENT_CONTROL_PATH}`.replace("http:", "ws:"), nonce);
    const first = server.stopScripts();
    expect(server.stopScripts()).toBe(first);
    await first;
    await until(() => socket!.readyState === WebSocket.CLOSED);

    const roster = await fetch(`${origin}/ui/api/profiles`);
    expect(roster.status).toBe(503);
    expect(await roster.json()).toEqual({ ok: false, error: "GameBrowser is shutting down" });
    const upgrade = await fetch(`${origin}${AGENT_CONTROL_PATH}`, {
      headers: { authorization: `Bearer ${nonce}`, "sec-websocket-protocol": AGENT_CONTROL_PROTOCOL },
    });
    expect(upgrade.status).toBe(503);
    expect(upgrade.headers.get("cache-control")).toBe("no-store");
  } finally {
    socket?.close(); await server.stopScripts();
    // Bun 1.2 can retain stale WebSocket drain bookkeeping after a close.
    // These are only this test's connections, with no outstanding HTTP work.
    void server.stop(false); await server.stop(true); store.close();
  }
});

test("dashboard shutdown waits for an admitted agent open and its exact cleanup without dispatching queued work", async () => {
  const nonce = "c".repeat(64), store = new ProfileStore(":memory:");
  let allowOpen!: () => void, allowStop!: () => void;
  const opening = new Promise<void>(resolve => { allowOpen = resolve; });
  const stopping = new Promise<void>(resolve => { allowStop = resolve; });
  const started: string[] = [], stopped: string[] = [];
  const launcher = {
    reconcileOrphans: async () => {}, certifiedActive: async () => false,
    start: async (id: string) => {
      started.push(id); await opening;
      store.recordLaunch({ profileId: id, pid: 11, debugPort: 9222, ws: "ws://owned-test", startedAt: 1 });
      return { ws: "ws://owned-test", port: 9222 };
    },
    stop: async (id: string) => { stopped.push(id); await stopping; store.clearLaunch(id); return true; },
  };
  const server = serveDashboard({ launcher: launcher as any, store, port: 0, agentNonce: nonce, log: () => {} });
  let socket: WebSocket | undefined, cleanup: Promise<void> | undefined;
  try {
    socket = await openSocket(`ws://127.0.0.1:${server.port}${AGENT_CONTROL_PATH}`, nonce);
    const request = (id: number, profileId: string) => JSON.stringify({ protocol: AGENT_CONTROL_PROTOCOL, id, method: "browser.open", params: { profileId } });
    socket.send(request(1, "first")); socket.send(request(2, "queued"));
    await until(() => started.length === 1);
    let settled = false;
    cleanup = server.stopScripts().then(() => { settled = true; });
    await Bun.sleep(10); expect(settled).toBe(false);
    allowOpen(); await until(() => stopped.length === 1);
    expect(settled).toBe(false); expect(started).toEqual(["first"]);
    allowStop(); await cleanup;
    expect(stopped).toEqual(["first"]); expect(store.listLaunches()).toEqual([]);
    expect(started).toEqual(["first"]);
  } finally {
    allowOpen(); allowStop(); socket?.close(); await (cleanup ?? server.stopScripts());
    void server.stop(false); await server.stop(true); store.close();
  }
});
