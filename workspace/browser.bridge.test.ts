import { expect, test } from "bun:test";
import { BrowserBridge } from "./browserBridge.ts";
import { isSafeProfileId } from "../profile-id.ts";
import { jpegDimensions, safeManualControl, relayEndpoint, type LiveFrame } from "./protocol.ts";
function jpegFixture(width = 1366, height = 768, marker = 0xc0): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, marker, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xda]);
}
function bridgeFixture(manual = true) {
  const events: string[] = [];
  const frames: LiveFrame[] = [];
  let pageClosed = false, connected = true, screenshotInFlight = 0, maxInFlight = 0;
  const page: any = {
    isClosed: () => pageClosed,
    url: () => "https://site.test/workspace?session=secret",
    evaluate: async () => ({ width: 5, height: 5 }),
    screenshot: async () => { screenshotInFlight++; maxInFlight = Math.max(maxInFlight, screenshotInFlight); await new Promise(resolve => setTimeout(resolve, 700)); screenshotInFlight--; return jpegFixture(); },
    goto: async (url: string) => { events.push(`navigate:${url}`); }, bringToFront: async () => {},
    mouse: { click: async (x: number, y: number) => { events.push(`click:${x}:${y}`); }, wheel: async () => { events.push("scroll"); } },
    keyboard: { press: async () => { events.push("key"); }, insertText: async () => { events.push("text"); } },
  };
  const browser: any = { isConnected: () => connected, contexts: () => [{ pages: () => [page] }], on: () => {},
    _connection: { close: () => { connected = false; events.push("disconnect"); } }, close: async () => { connected = false; events.push("attachment-disconnect"); } };
  const bridge = new BrowserBridge({ getLaunch: () => ({ profileId: "p", pid: 123, debugPort: 4000, ws: "ws://127.0.0.1:4000", startedAt: 1 }),
    getConfig: () => ({ profileId: "p", token: "private", role: "manual", origins: ["https://site.test"], relayUrl: "ws://127.0.0.1:8080/relay", epoch: 1 }),
    canControl: () => manual, connect: async () => browser,
    onFrame: frame => frames.push(frame), onError: () => {} });
  return { bridge, events, frames, maxInFlight: () => maxInFlight };
}
test("live view captures only subscribed profiles and bounds in-flight capture", async () => {
  const { bridge, frames, maxInFlight, events } = bridgeFixture();
  bridge.start(); bridge.setVisible(["p"]);
  await new Promise(resolve => setTimeout(resolve, 1350));
  expect(frames).toHaveLength(1);
  expect(frames[0]!.jpeg).toBe(jpegFixture().toString("base64"));
  expect(frames[0]!.url).toBe("https://site.test/workspace");
  expect({ width: frames[0]!.width, height: frames[0]!.height }).toEqual({ width: 1366, height: 768 });
  expect(maxInFlight()).toBe(1);
  bridge.setVisible([]); const count = frames.length;
  await new Promise(resolve => setTimeout(resolve, 600));
  expect(frames).toHaveLength(count);
  await bridge.stop();
  expect(events).toContain("attachment-disconnect");
  expect(events).not.toContain("disconnect");
});
test("manual tile controls cannot operate a synchronized follower", async () => {
  const { bridge, events } = bridgeFixture(false);
  await expect(bridge.control({ profileId: "p", kind: "click", x: 10, y: 10 })).rejects.toThrow();
  expect(events).toEqual([]);
  await bridge.stop();
});
test("manual controls stay on their profile while browsing arbitrary HTTPS sites", async () => {
  const { bridge, events } = bridgeFixture();
  await bridge.control({ profileId: "p", kind: "click", x: 10, y: 20 });
  expect(events).toContain("click:10:20");
  await expect(bridge.control({ profileId: "p", kind: "click", x: 2000, y: 20 })).rejects.toThrow();
  await bridge.navigate("p", "https://other.test/page?session=secret#fragment");
  expect(events).toContain("navigate:https://other.test/page?session=secret#fragment");
  await expect(bridge.navigate("p", "javascript:alert(1)")).rejects.toThrow();
  await bridge.navigate("p", "https://site.test/page");
  expect(events).toContain("navigate:https://site.test/page");
  await bridge.stop();
});
test("Firefox delivers synchronization to exactly one selected tab and ignores other tab bindings", async () => {
  const packets: Array<{ page: string; packet: any }> = [], forwarded: any[] = [];
  let binding: ((source: any, packet: unknown, nonce?: string) => Promise<void>) | undefined;
  let captureNonce = "";
  let transport: any;
  const makePage = (name: string) => {
    const frame = {};
    return { name, isClosed: () => false, url: () => "https://site.test/workspace", mainFrame: () => frame, on: () => {},
      evaluate: async (_code: any, packet?: any) => { if (packet) packets.push({ page: name, packet }); } };
  };
  const first = makePage("first"), selected = makePage("selected");
  const context: any = { pages: () => [first, selected], on: () => {},
    exposeBinding: async (_name: string, callback: any) => { binding = callback; }, addInitScript: async ({ content }: any) => { captureNonce = /const privateCaptureNonce = "([a-zA-Z0-9_-]+)"/.exec(content)![1]!; } };
  const browser: any = { contexts: () => [context], isConnected: () => true, on: () => {}, close: async () => {}, _connection: { close: () => {} } };
  const bridge = new BrowserBridge({ getLaunch: () => ({ engine: "firefox", profileId: "p", pid: 1, debugPort: 4, ws: "firefox-owner", startedAt: 1 }),
    getConfig: () => ({ profileId: "p", token: "private", role: "follower", origins: ["https://site.test"], relayUrl: "ws://127.0.0.1:8080/relay", epoch: 1 }),
    canControl: () => true, connect: async () => browser, onFrame: () => {}, onError: () => {},
    onFirefoxConnect: (_id, _token, value) => { transport = value; value.send({ type: "CONFIG", role: "follower", origins: ["https://site.test"], epoch: 1 }); return true; },
    onFirefoxPacket: (_id, _transport, packet) => { forwarded.push(packet); } });
  await bridge.attach("p");
  packets.length = 0; forwarded.length = 0;
  transport.send({ type: "ACTION", id: "action0001", epoch: 1 });
  expect(packets.filter(p => p.packet.type === "ACTION").map(p => p.page)).toEqual(["selected"]);
  await binding!({ page: first, frame: first.mainFrame() }, { type: "ACTION" }, captureNonce);
  expect(forwarded).toHaveLength(0);
  await binding!({ page: selected, frame: selected.mainFrame() }, { type: "ACK", id: "action0001", status: "applied" });
  expect(forwarded).toHaveLength(0);
  await binding!({ page: selected, frame: selected.mainFrame() }, { type: "ACK", id: "action0001", status: "applied" }, "é".repeat(43));
  expect(forwarded).toHaveLength(0);
  await binding!({ page: selected, frame: selected.mainFrame() }, { type: "ACK", id: "action0001", status: "applied" }, captureNonce);
  expect(forwarded.map(p => p.type)).toEqual(["PAGE", "ACK"]);
  await bridge.stop();
});
test("detaching one Chromium CDP attachment preserves the shared driver and unrelated profile", async () => {
  let driverConnected = true;
  const attached = new Map([["target", true], ["unrelated", true]]);
  const controls: string[] = [], opened: string[] = [];
  const sharedDriver = { close: () => { driverConnected = false; } };
  const browsers = new Map([...attached.keys()].map(id => {
    const page: any = { isClosed: () => !attached.get(id), url: () => "https://site.test/workspace",
      evaluate: async () => ({ width: 1, height: 1 }),
      screenshot: async () => jpegFixture(),
      mouse: { click: async () => { if (!driverConnected || !attached.get(id)) throw new Error("Target closed"); controls.push(id); } } };
    return [id, { isConnected: () => driverConnected && attached.get(id), contexts: () => [{ pages: () => [page] }], on: () => {},
      _connection: sharedDriver, close: async () => { attached.set(id, false); } }];
  }));
  const bridge = new BrowserBridge({ getLaunch: id => ({ profileId: id, pid: id === "target" ? 1 : 2, ws: `ws://127.0.0.1/${id}`, debugPort: 5, startedAt: 1 }),
    getConfig: id => ({ profileId: id, token: "private", role: "manual", origins: ["https://site.test"], relayUrl: "ws://127.0.0.1:8080/relay", epoch: 1 }),
    canControl: () => true, connect: async launch => { opened.push(launch.profileId); return browsers.get(launch.profileId) as any; }, onFrame: () => {}, onError: () => {} });
  await bridge.attach("target"); await bridge.attach("unrelated");
  await bridge.detach("target");
  expect(driverConnected).toBe(true);
  expect(attached.get("target")).toBe(false); expect(attached.get("unrelated")).toBe(true);
  await bridge.control({ profileId: "unrelated", kind: "click", x: 10, y: 10 });
  expect(controls).toEqual(["unrelated"]);
  await expect(bridge.control({ profileId: "target", kind: "click", x: 10, y: 10 })).rejects.toThrow();
  expect(opened.filter(id => id === "target")).toHaveLength(1);
  await bridge.stop(); expect(driverConnected).toBe(true);
});
test("native page closure during Firefox detach is nonfatal", async () => {
  let closed = false;
  const page: any = { isClosed: () => closed, url: () => "https://site.test/workspace", on: () => {}, evaluate: async () => {} };
  const context: any = { pages: () => { if (closed) throw new Error("Target page, context or browser has been closed"); return [page]; },
    on: () => {}, exposeBinding: async () => {}, addInitScript: async () => {} };
  const browser: any = { contexts: () => [context], isConnected: () => !closed, on: () => {},
    close: async () => { if (closed) throw new Error("Target page, context or browser has been closed"); closed = true; } };
  const bridge = new BrowserBridge({ getLaunch: () => ({ engine: "firefox", profileId: "p", pid: 1, debugPort: 4, ws: "firefox-owner", startedAt: 1 }),
    getConfig: () => ({ profileId: "p", token: "private", role: "manual", origins: ["https://site.test"], relayUrl: "ws://127.0.0.1:8080/relay", epoch: 1 }),
    canControl: () => true, connect: async () => browser, onFrame: () => {}, onError: () => {},
    onFirefoxConnect: () => true, onFirefoxPacket: () => {} });
  await bridge.attach("p"); closed = true;
  await expect(bridge.detach("p")).resolves.toBeUndefined();
  await bridge.stop();
});

test("JPEG SOF geometry supports native baseline/progressive frames and ignores metadata segments", () => {
  expect(jpegDimensions(jpegFixture(1366, 768))).toEqual({ width: 1366, height: 768 });
  expect(jpegDimensions(jpegFixture(1536, 864, 0xc2))).toEqual({ width: 1536, height: 864 });
  expect(jpegDimensions(jpegFixture(390, 844))).toEqual({ width: 390, height: 844 });
  expect(jpegDimensions(jpegFixture(1366, 2732))).toEqual({ width: 1366, height: 2732 });
  expect(jpegDimensions(jpegFixture(4096, 2160))).toEqual({ width: 4096, height: 2160 });
});
test("JPEG geometry rejects corrupt, truncated, missing, and oversized image headers", () => {
  for (const bytes of [Buffer.from("not jpeg"), Buffer.from([0xff, 0xd8, 0xff, 0xda]), jpegFixture().subarray(0, 15),
    jpegFixture(0, 768), jpegFixture(4097, 768), jpegFixture(1366, 4097), Buffer.alloc(4 * 1024 * 1024 + 1)]) expect(() => jpegDimensions(bytes)).toThrow();
  const badLength = jpegFixture(); badLength[11] = 0;
  expect(() => jpegDimensions(badLength)).toThrow();
});
test("frame sequences survive attachment reconnects and remain independent per profile", async () => {
  const frames: LiveFrame[] = [];
  const connections: string[] = [];
  const bridge = new BrowserBridge({
    getLaunch: id => ({ profileId: id, pid: id === "reconnected" ? 1 : 2, debugPort: 4000, ws: `ws://127.0.0.1/${id}`, startedAt: 1 }),
    getConfig: id => ({ profileId: id, token: "private", role: "manual", origins: ["https://site.test"], relayUrl: "ws://127.0.0.1:8080/relay", epoch: 1 }),
    canControl: () => true,
    connect: async launch => {
      connections.push(launch.profileId);
      let connected = true;
      const page: any = { isClosed: () => !connected, url: () => `https://site.test/${launch.profileId}`, screenshot: async () => jpegFixture() };
      return { contexts: () => [{ pages: () => [page] }], isConnected: () => connected, on: () => {}, close: async () => { connected = false; } } as any;
    },
    onFrame: frame => frames.push(frame), onError: () => {},
  });
  bridge.setVisible(["reconnected", "unrelated"]);
  await (bridge as any).frame("reconnected");
  await (bridge as any).frame("reconnected");
  await (bridge as any).frame("unrelated");
  expect(frames.filter(frame => frame.profileId === "reconnected").map(frame => frame.sequence)).toEqual([1, 2]);
  expect(frames.find(frame => frame.profileId === "unrelated")!.sequence).toBe(1);
  await bridge.detach("reconnected");
  await bridge.attach("reconnected");
  await (bridge as any).frame("reconnected");
  await (bridge as any).frame("unrelated");
  expect(frames.filter(frame => frame.profileId === "reconnected").map(frame => frame.sequence)).toEqual([1, 2, 3]);
  expect(frames.filter(frame => frame.profileId === "unrelated").map(frame => frame.sequence)).toEqual([1, 2]);
  expect(connections.filter(id => id === "reconnected")).toHaveLength(2);
  await bridge.stop();
});

test("manual controls share128-character profile IDs and reject Windows device names", () => {
  for (const profileId of ["a", "A_9", "id-" + "x".repeat(125), "x".repeat(129), "CON", "nul", "COM1", "lpt9", "COM10", "_first", "-first", "a.b", "a/b", "", "é"]) {
    if (isSafeProfileId(profileId)) expect(safeManualControl({ profileId, kind: "text", text: "input" }).profileId).toBe(profileId);
    else expect(() => safeManualControl({ profileId, kind: "text", text: "input" })).toThrow();
  }
  expect(relayEndpoint("ws://127.0.0.1:54321/workspace/relay")).toBe("ws://127.0.0.1:54321/workspace/relay");
  for (const url of ["ws://remote.test:54321/workspace/relay", "ws://127.0.0.1:54321/workspace/relay?token=secret", "ws://127.0.0.1:54321/wrong", "ws://user@127.0.0.1:54321/relay"]) expect(() => relayEndpoint(url)).toThrow();
});

test("worker-mode Firefox native follower control does not install legacy page-world synchronization", async () => {
  const events: string[] = [];
  const page: any = { isClosed: () => false, url: () => "https://site.test/workspace", on: () => {},
    keyboard: { insertText: async () => events.push("native-text") } };
  const context: any = { pages: () => [page], on: () => {}, exposeBinding: async () => events.push("legacy-binding"), addInitScript: async () => events.push("legacy-capture") };
  const browser: any = { contexts: () => [context], isConnected: () => true, on: () => {}, close: async () => {} };
  const bridge = new BrowserBridge({ controller: "worker", getLaunch: () => ({ engine: "firefox", profileId: "p", pid: 1, debugPort: 4, ws: "firefox-owner", startedAt: 1 }),
    getConfig: () => ({ profileId: "p", token: "private", role: "follower", origins: ["https://site.test"], relayUrl: "ws://127.0.0.1:50443/workspace/relay", controller: "worker", epoch: 1 }),
    canControl: () => true, connect: async () => browser, onFrame: () => {}, onError: () => {},
    onFirefoxConnect: () => { events.push("legacy-connection"); return true; } });
  try { await bridge.attach("p"); await bridge.control({ profileId: "p", kind: "text", text: "manual follower input" }); expect(events).toEqual(["native-text"]); } finally { await bridge.stop(); }
});

test("owned launch certification precedes endpoint attachment and guards cached native control reuse", async () => {
  const { bridge, events } = bridgeFixture();
  let permitted = true, certificates = 0;
  (bridge as any).options.authorizeLaunch = async () => { certificates++; return permitted; };
  try {
    await bridge.attach("p"); expect(certificates).toBe(1); permitted = false;
    await expect(bridge.control({ profileId: "p", kind: "text", text: "blocked" })).rejects.toThrow("certified");
    expect(certificates).toBe(2); expect(events).not.toContain("text");
  } finally { await bridge.stop(); }
});
for (const outcome of ["denied", "replaced", "scope-lost"] as const) test(`delayed launch certification rejects ${outcome} before native endpoint attachment`, async () => {
  const { bridge, events } = bridgeFixture();
  let finish!: (value: boolean) => void, entered!: () => void, connects = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const options = (bridge as any).options, originalLaunch = options.getLaunch, originalConnect = options.connect;
  options.authorizeLaunch = () => { entered(); return new Promise<boolean>(resolve => { finish = resolve; }); };
  options.connect = async (launch: unknown) => { connects++; return originalConnect(launch); };
  const attached = bridge.attach("p").then(() => null, error => error);
  try {
    await waiting; expect(connects).toBe(0);
    if (outcome === "replaced") options.getLaunch = () => ({ ...originalLaunch(), startedAt: 2 });
    if (outcome === "scope-lost") options.getLaunch = () => null;
    finish(outcome !== "denied"); expect(await attached).toBeInstanceOf(Error); expect(connects).toBe(0); expect(events).toEqual([]);
  } finally { await bridge.stop(); }
});

test("read-only followers can inspect owned browser state and frames while native mutation stays blocked", async () => {
  const { bridge, events, frames } = bridgeFixture(false);
  try {
    expect((await bridge.browserState("p")).tabs).toHaveLength(1);
    bridge.setVisible(["p"]); await (bridge as any).frame("p"); expect(frames).toHaveLength(1);
    await expect(bridge.browserAction("p", { action: "reload" })).rejects.toThrow();
    await expect(bridge.control({ profileId: "p", kind: "text", text: "blocked" })).rejects.toThrow();
    expect(events).not.toContain("text");
    (bridge as any).options.getLaunch = () => null;
    await expect(bridge.browserState("p")).rejects.toThrow();
    await (bridge as any).frame("p"); expect(frames).toHaveLength(1);
  } finally { await bridge.stop(); }
});

test("scope revocation during a read-only follower screenshot discards the frame", async () => {
  const { bridge, frames } = bridgeFixture(false);
  let complete!: () => void, entered!: () => void;
  const captured = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { complete = resolve; });
  try {
    await bridge.attach("p"); const connection = (bridge as any).connections.get("p");
    connection.page ??= connection.context.pages()[0];
    connection.page.screenshot = async () => { entered(); await released; return jpegFixture(); };
    bridge.setVisible(["p"]); const frame = (bridge as any).frame("p");
    await captured; (bridge as any).options.getLaunch = () => null; complete(); await frame;
    expect(frames).toEqual([]);
  } finally { await bridge.stop(); }
});
