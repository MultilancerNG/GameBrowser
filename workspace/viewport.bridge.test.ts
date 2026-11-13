import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { BrowserBridge } from "./browserBridge.ts";
import type { LiveFrame } from "./protocol.ts";

const desktop = { width: 1473, height: 913 };
function jpeg({ width, height }: { width: number; height: number }): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xda]);
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(condition()).toBe(true);
}
function fixture(engine: "chromium" | "firefox", initialCount = 1) {
  const events: string[] = [], frames: LiveFrame[] = [], pages: TestPage[] = [];
  let connected = true, connects = 0;
  class TestPage extends EventEmitter {
    size = { width: 390, height: 700 }; address: string; closed = false; gate = deferred();
    requested?: { width: number; height: number }; applied = false;
    constructor(address: string) { super(); this.address = address; }
    isClosed() { return this.closed; } url() { return this.address; } mainFrame() { return this; }
    title() { return Promise.resolve("Desktop fixture"); } bringToFront() { return Promise.resolve(); }
    async setViewportSize(size: { width: number; height: number }) {
      this.requested = size; events.push(`resize:${pages.indexOf(this)}`);
      await this.gate.promise; this.size = { ...size }; this.applied = true;
    }
    async screenshot() { events.push(`capture:${pages.indexOf(this)}`); if (!this.applied) throw new Error("Captured an unprepared viewport"); return jpeg(this.size); }
    async evaluate() { return { href: this.address, uri: this.address, contentType: "text/html", readyState: "complete" }; }
    async goto(url: string) { events.push(`navigate:${pages.indexOf(this)}`); if (!this.applied) throw new Error("Navigated an unprepared viewport"); this.address = url; this.emit("framenavigated", this); this.emit("domcontentloaded"); return { status: () => 200 }; }
    mouse = { click: async () => { events.push(`click:${pages.indexOf(this)}`); }, wheel: async () => { events.push("scroll"); } };
    keyboard = { press: async () => { events.push("key"); }, insertText: async () => { events.push("text"); } };
    async close() { this.closed = true; this.emit("close"); }
  }
  for (let i = 0; i < initialCount; i++) pages.push(new TestPage(`https://desktop.test/page-${i}`));
  const context: any = new EventEmitter();
  context.pages = () => pages.filter(page => !page.closed);
  context.newPage = async () => { const page = new TestPage("about:blank"); pages.push(page); context.emit("page", page); return page; };
  const browser: any = new EventEmitter();
  browser.contexts = () => [context]; browser.isConnected = () => connected;
  browser.close = async () => { connected = false; events.push("attachment-closed"); };
  const bridge = new BrowserBridge({ getLaunch: () => ({ engine, profileId: "p", pid: 1, ws: "ws://local", debugPort: 1, startedAt: 1 }),
    getConfig: () => ({ profileId: "p", role: "manual", token: "private", origins: ["https://desktop.test"], epoch: 1, relayUrl: "local" }),
    getViewport: () => desktop, canControl: () => true, connect: async () => { connects++; return browser; },
    onFrame: frame => frames.push(frame), onError: () => {}, beforeBrowserAction: () => {} });
  return { bridge, pages, frames, events, connects: () => connects, connected: () => connected };
}

for (const engine of ["chromium", "firefox"] as const) {
  test(`${engine} attachment prepares every saved desktop viewport before concurrent frames and manual input`, async () => {
    const { bridge, pages, frames, events, connects } = fixture(engine, 2);
    try {
      const attached = bridge.attach("p");
      await until(() => pages.every(page => !!page.requested));
      bridge.setVisible(["p"]);
      const capture = (bridge as any).frame("p"), control = bridge.control({ profileId: "p", kind: "click", x: 1400, y: 900 });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(frames).toHaveLength(0); expect(events.filter(event => /capture|click/.test(event))).toEqual([]);
      expect(pages.map(page => page.requested)).toEqual([desktop, desktop]);
      pages[0]!.gate.resolve(); await new Promise(resolve => setTimeout(resolve, 5));
      expect(frames).toHaveLength(0); expect(events).not.toContain("click:1");
      pages[1]!.gate.resolve(); await Promise.all([attached, capture, control]);
      expect(connects()).toBe(1); expect(frames).toHaveLength(1);
      expect({ width: frames[0]!.width, height: frames[0]!.height }).toEqual(desktop);
      expect(events).toContain("click:1");
      // Subscription/dashboard changes do not resize the isolated website.
      bridge.setVisible([]); bridge.setVisible(["p"]); await (bridge as any).frame("p");
      expect(pages.map(page => page.size)).toEqual([desktop, desktop]);
      expect(events.filter(event => event.startsWith("resize:"))).toHaveLength(2);
    } finally { await bridge.stop(); }
  });
  test(`${engine} new tabs and trusted extension pages await the same desktop viewport`, async () => {
    const { bridge, pages, frames, events } = fixture(engine);
    try {
      pages[0]!.gate.resolve(); await bridge.attach("p"); bridge.setVisible(["p"]);
      const opened = bridge.browserAction("p", { action: "new-tab", url: "https://desktop.test/new" });
      await until(() => pages.length === 2 && !!pages[1]!.requested);
      expect(events).not.toContain("navigate:1");
      await (bridge as any).frame("p"); expect(frames.at(-1)!.url).toBe("https://desktop.test/page-0");
      pages[1]!.gate.resolve(); const state = await opened;
      expect(state.error).toBeUndefined(); expect(state.tabs.find(tab => tab.id === state.activeTabId)!.url).toBe("https://desktop.test/new");
      expect(pages[1]!.size).toEqual(desktop);
      const origin = engine === "firefox" ? "moz-extension://12345678-1234-1234-1234-123456789abc" : `chrome-extension://${"a".repeat(32)}`;
      const addon = bridge.openExtensionPage("p", { origin, entrypoint: "popup.html" });
      await until(() => pages.length === 3 && !!pages[2]!.requested);
      expect(events).not.toContain("navigate:2"); pages[2]!.gate.resolve();
      expect((await addon).error).toBeUndefined(); expect(pages[2]!.size).toEqual(desktop);
      await (bridge as any).frame("p"); expect({ width: frames.at(-1)!.width, height: frames.at(-1)!.height }).toEqual(desktop);
    } finally { await bridge.stop(); }
  });
  test(`${engine} failed viewport setup detaches the attachment and rejects controls`, async () => {
    const { bridge, pages, events, connected } = fixture(engine);
    try {
      const attached = bridge.attach("p"); await until(() => !!pages[0]!.requested);
      pages[0]!.gate.reject(new Error("Native resize rejected"));
      await expect(attached).rejects.toThrow("desktop setup failed");
      expect(connected()).toBe(false);
      await expect(bridge.control({ profileId: "p", kind: "text", text: "operator input" })).rejects.toThrow("detached");
      expect(events.filter(event => /capture|click/.test(event))).toEqual([]);
    } finally { await bridge.stop(); }
  });
  test(`${engine} failed new-tab viewport setup closes only that tab and preserves the ready original`, async () => {
    const { bridge, pages, frames, connected } = fixture(engine);
    try {
      pages[0]!.gate.resolve(); const initial = await bridge.browserState("p");
      const opened = bridge.browserAction("p", { action: "new-tab", url: "https://desktop.test/new" });
      await until(() => pages.length === 2 && !!pages[1]!.requested);
      pages[1]!.gate.reject(new Error("Native resize rejected")); const result = await opened;
      expect(result.error).toBeDefined(); expect(result.activeTabId).toBe(initial.activeTabId);
      expect(pages[1]!.closed).toBe(true); expect(pages[0]!.closed).toBe(false); expect(connected()).toBe(true);
      bridge.setVisible(["p"]); await (bridge as any).frame("p"); expect(frames).toHaveLength(1);
      expect({ width: frames[0]!.width, height: frames[0]!.height }).toEqual(desktop);
    } finally { await bridge.stop(); }
  });
}

test("invalid legacy desktop geometry is rejected before attaching a browser", async () => {
  const { bridge, connects } = fixture("chromium");
  (bridge as any).options.getViewport = () => ({ width: 319, height: 700 });
  try { await expect(bridge.attach("p")).rejects.toThrow(); expect(connects()).toBe(0); }
  finally { await bridge.stop(); }
});

for (const input of [{ kind: "text", text: "private input" }, { kind: "key", key: "Enter" }, { kind: "scroll", deltaX: 0, deltaY: 25 }] as const) {
  test(`revoked control cannot deliver ${input.kind} after awaiting viewport preparation`, async () => {
    const { bridge, pages, events } = fixture("chromium");
    let authorized = true; (bridge as any).options.canControl = () => authorized;
    pages[0]!.gate.resolve(); await bridge.attach("p");
    const viewport = deferred(); const connection = (bridge as any).connections.get("p");
    const tab = [...connection.tabs.values()][0] as any; tab.viewportReady = viewport.promise;
    const pending = bridge.control({ profileId: "p", ...input }).then(() => null, error => error);
    await new Promise(resolve => setTimeout(resolve, 0)); authorized = false; viewport.resolve();
    try { expect((await pending)?.message).toContain("authorization"); expect(events.filter(event => ["text", "key", "scroll"].includes(event))).toEqual([]); }
    finally { await bridge.stop(); }
  });
}

test("portrait mobile viewport remains saved geometry in the live attachment", async () => {
  const { bridge, pages, frames } = fixture("chromium");
  (bridge as any).options.getViewport = () => ({ width: 390, height: 844 });
  try { pages[0]!.gate.resolve(); await bridge.attach("p"); bridge.setVisible(["p"]); await (bridge as any).frame("p");
    expect(pages[0]!.requested).toEqual({ width: 390, height: 844 }); expect({ width: frames[0]!.width, height: frames[0]!.height }).toEqual({ width: 390, height: 844 });
  } finally { await bridge.stop(); }
});
