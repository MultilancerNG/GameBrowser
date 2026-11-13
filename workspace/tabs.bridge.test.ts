import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { BrowserBridge } from "./browserBridge.ts";
import { browserCommand, browsingUrl, MAX_BROWSER_TABS, siteCookies, type ProfileBrowserState } from "./protocol.ts";

function tabsFixture(engine: "chromium" | "firefox" = "chromium") {
  const events: string[] = [], states: ProfileBrowserState[] = [];
  let allowed = true, connected = true, role: "manual" | "admin" | "follower" = "manual";
  class TestPage extends EventEmitter {
    closed = false; address: string; failed = false; titleValue = "Fixture"; history: string[]; index = 0;
    constructor(address: string) { super(); this.address = address; this.history = [address]; }
    isClosed() { return this.closed; } url() { return this.address; } title() { return Promise.resolve(this.titleValue); }
    mainFrame() { return this; }
    bringToFront() { events.push(`front:${this.address}`); return Promise.resolve(); }
    async goto(url: string): Promise<any> {
      events.push(`navigate:${url}`);
      if (this.failed) { this.failed = false; const error = new Error(`Timeout opening ${url}`); error.name = "TimeoutError"; throw error; }
      this.history = [...this.history.slice(0, this.index + 1), url]; this.index++; this.address = url;
      this.emit("framenavigated", this); this.emit("domcontentloaded"); return { status: () => 200 };
    }
    async goBack() { events.push("back"); if (this.index > 0) this.address = this.history[--this.index]!; this.emit("framenavigated", this); this.emit("load"); }
    async goForward() { events.push("forward"); if (this.index + 1 < this.history.length) this.address = this.history[++this.index]!; this.emit("framenavigated", this); this.emit("load"); }
    async reload() { events.push("reload"); this.emit("load"); }
    async evaluate(_fn?: any, _arg?: any): Promise<any> {
      if (String(_fn).includes("document.documentURI")) return { href: this.address, uri: this.address, contentType: "text/html", readyState: "complete" };
      events.push("stop");
    }
    mouse = { wheel: async (x: number, y: number) => { events.push(`scroll:${x}:${y}`); }, click: async () => { events.push("click"); } };
    keyboard = { press: async () => { events.push("key"); }, insertText: async () => { events.push("text"); } };
    async close() { events.push(`close:${this.address}:remaining=${pages.filter(page => !page.closed).length}`); this.closed = true; this.emit("close"); }
  }
  const pages = [new TestPage("https://approved.test/start?token=first#secret")];
  const context: any = new EventEmitter();
  context.pages = () => pages.filter(page => !page.closed);
  context.newPage = async () => { const page = new TestPage("about:blank"); pages.push(page); context.emit("page", page); return page; };
  if (engine === "chromium") context.newCDPSession = async (page: TestPage) => ({ send: async (method: string) => {
    if (method === "Page.stopLoading") { events.push("stop"); return {}; }
    return { currentIndex: page.index, entries: page.history.map(url => ({ url })) };
  }, detach: async () => {} });
  const cookieJar: any[] = [];
  context.cookies = async (origins: string[]) => cookieJar.filter(cookie => { const host = new URL(origins[0]!).hostname; return host === cookie.domain.replace(/^\./, "") || host.endsWith(cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`); });
  context.addCookies = async (cookies: any[]) => { events.push("cookies:import"); cookieJar.push(...cookies); };
  context.clearCookies = async ({ domain }: any) => { events.push(`cookies:clear:${domain}`); for (let i = cookieJar.length - 1; i >= 0; i--) if (cookieJar[i].domain === domain) cookieJar.splice(i, 1); };
  const browser: any = new EventEmitter();
  browser.contexts = () => [context]; browser.isConnected = () => connected; browser.close = async () => { connected = false; };
  const bridge = new BrowserBridge({ getLaunch: () => ({ engine, profileId: "p", pid: 1, ws: "ws://localhost/native", debugPort: 1, startedAt: 1 }),
    getConfig: () => ({ profileId: "p", token: "private", role, origins: ["https://approved.test"], relayUrl: "ws://127.0.0.1:8080/relay", epoch: 1 }),
    canControl: () => allowed, connect: async () => browser, onFrame: () => {}, onError: () => {},
    beforeBrowserAction: () => { role = "manual"; events.push("manual"); }, onBrowserState: state => states.push(state), onNavigation: () => {} });
  return { bridge, events, states, pages, cookieJar, setAllowed: (value: boolean) => { allowed = value; }, setRole: (value: typeof role) => { role = value; } };
}
for (const engine of ["chromium", "firefox"] as const) test(`${engine} manual browsing supports native history and opaque query-distinct tabs`, async () => {
  const { bridge, pages, events, states } = tabsFixture(engine);
  try {
    const initial = await bridge.browserState("p");
    expect(initial.tabs[0]!.url).toContain("?token=first#secret");
    const original = initial.activeTabId!;
    const navigated = await bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/search?q=secret#result" });
    expect(navigated.tabs[0]!.url).toBe("https://ordinary.test/search?q=secret#result");
    expect(events.indexOf("manual")).toBeLessThan(events.indexOf("navigate:https://ordinary.test/search?q=secret#result"));
    await bridge.browserAction("p", { action: "back" }); expect(pages[0]!.url()).toContain("approved.test/start");
    await bridge.browserAction("p", { action: "forward" }); expect(pages[0]!.url()).toContain("ordinary.test/search");
    await bridge.browserAction("p", { action: "reload" }); await bridge.browserAction("p", { action: "stop" });
    expect(events).toContain("reload"); expect(events).toContain("stop");
    const second = await bridge.browserAction("p", { action: "new-tab", url: "https://ordinary.test/search?q=second" });
    expect(second.tabs).toHaveLength(2); expect(second.activeTabId).not.toBe(original);
    expect(new Set(second.tabs.map(tab => tab.id)).size).toBe(2);
    await bridge.browserAction("p", { action: "select-tab", tabId: original });
    expect((await bridge.browserState("p")).activeTabId).toBe(original);
    bridge.setActivePage("p", "https://ordinary.test/search"); // A redacted URL cannot override an opaque selection.
    expect((await bridge.browserState("p")).activeTabId).toBe(original);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(states.length).toBeGreaterThan(0);
    expect(JSON.stringify(states)).not.toContain("?q="); expect(JSON.stringify(states)).not.toContain("?token="); expect(JSON.stringify(states)).not.toContain("#secret");
    expect(states.at(-1)!.redacted).toBe(true);
  } finally { await bridge.stop(); }
});
for (const engine of ["chromium", "firefox"] as const) test(`${engine} delayed approved PAGE reports cannot steal explicit manual tab selection or input`, async () => {
  const { bridge, pages, states, events, setRole } = tabsFixture(engine);
  const captures: unknown[] = [], frames: any[] = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 0, 5, 0x56, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xda]);
  try {
    const initial = await bridge.browserState("p"), original = initial.activeTabId!;
    await bridge.browserAction("p", { action: "navigate", url: "https://approved.test/second?operator=private#fragment" });
    const opened = await bridge.browserAction("p", { action: "new-tab", url: "https://approved.test/start" }), newer = opened.activeTabId!;
    const first = pages[0]!, second = pages[1]!;
    first.bringToFront = async () => { bridge.setActivePage("p", second.url()); };
    for (const page of [first, second]) {
      (page as any).screenshot = async () => { captures.push(page); return jpeg; };
      page.mouse.click = async () => { events.push(page === first ? "original-click" : "newer-click"); };
      page.keyboard.insertText = async () => { events.push(page === first ? "original-text" : "newer-text"); };
    }
    // The production pre-action hook changes admin to manual before bringing
    // the selected native tab forward, where a stale MV3 PAGE can race it.
    setRole("admin");
    const selected = await bridge.browserAction("p", { action: "select-tab", tabId: original });
    expect(selected.activeTabId).toBe(original); expect(selected.tabs).toHaveLength(2);
    bridge.setActivePage("p", second.url());
    expect((await bridge.browserState("p")).activeTabId).toBe(original);
    (bridge as any).options.onFrame = (frame: unknown) => frames.push(frame);
    bridge.setVisible(["p"]); await (bridge as any).frame("p");
    await bridge.control({ profileId: "p", kind: "click", x: 10, y: 20 });
    await bridge.control({ profileId: "p", kind: "text", text: "direct operator input" });
    expect(captures).toEqual([first]); expect(frames[0]!.url).toBe("https://approved.test/second");
    expect(events).toContain("original-click"); expect(events).toContain("original-text");
    expect(events).not.toContain("newer-click"); expect(events).not.toContain("newer-text");
    await new Promise(resolve => setTimeout(resolve, 100)); expect(states.at(-1)!.activeTabId).toBe(original);
    // Native active-tab reports still select approved pages during explicitly
    // enabled synchronization, rather than disabling that separate mechanism.
    for (const role of ["admin", "follower"] as const) {
      setRole(role); bridge.setActivePage("p", second.url());
      expect((await bridge.browserState("p")).activeTabId).toBe(newer);
      setRole("manual"); await bridge.browserAction("p", { action: "select-tab", tabId: original });
    }
  } finally { await bridge.stop(); }
});
test("closing the final tab creates its replacement first and never closes the browser", async () => {
  const { bridge, events } = tabsFixture();
  try {
    const state = await bridge.browserState("p");
    const next = await bridge.browserAction("p", { action: "close-tab", tabId: state.activeTabId! });
    expect(next.tabs).toHaveLength(1); expect(next.tabs[0]!.url).toBe("about:blank");
    expect(next.activeTabId).not.toBe(state.activeTabId);
    expect(events.find(event => event.startsWith("close:"))).toEndWith("remaining=2");
    expect((await bridge.browserState("p")).tabs).toHaveLength(1);
  } finally { await bridge.stop(); }
});
test("tab bounds survive concurrent creation and navigation timeouts leave usable tabs", async () => {
  const { bridge, pages } = tabsFixture();
  try {
    await bridge.attach("p"); pages[0]!.failed = true;
    const failed = await bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/?sensitive=query" });
    expect(failed.error).toContain("timed out"); expect(failed.error).not.toContain("sensitive");
    const recovered = await bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/recovered" });
    expect(recovered.error).toBeUndefined(); expect(recovered.tabs[0]!.url).toBe("https://ordinary.test/recovered");
    await Promise.all(Array.from({ length: 30 }, () => bridge.browserAction("p", { action: "new-tab" })));
    expect((await bridge.browserState("p")).tabs).toHaveLength(MAX_BROWSER_TABS);
  } finally { await bridge.stop(); }
});
test("read-only followers can inspect tabs while native controls and dangerous addresses remain blocked", async () => {
  const { bridge, setAllowed, events } = tabsFixture();
  try {
    setAllowed(false);
    expect((await bridge.browserState("p")).tabs).toHaveLength(1);
    await expect(bridge.browserAction("p", { action: "new-tab" })).rejects.toThrow(); expect(events).toEqual([]);
    setAllowed(true);
    for (const url of ["javascript:alert(1)", "file:///private", "data:text/html,hello", "about:config", "http://ordinary.test/", "https://user:password@ordinary.test/"])
      expect(() => browserCommand({ action: "navigate", url })).toThrow();
    expect(browsingUrl("https://ordinary.test/path?full=address#fragment")).toBe("https://ordinary.test/path?full=address#fragment");
    expect(browserCommand({ action: "new-tab" }).url).toBe("about:blank");
  } finally { await bridge.stop(); }
});
const cookie = { name: "session", value: "private-value", domain: "ordinary.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const };
test("site cookie import/export/clear is explicit, private, bounded and isolated by origin", async () => {
  const { bridge, cookieJar, events, setAllowed, states } = tabsFixture();
  try {
    cookieJar.push({ ...cookie, domain: "unrelated.test" });
    await bridge.changeCookies("p", { action: "import", origin: "https://ordinary.test", cookies: [cookie] });
    expect(events.indexOf("manual")).toBeLessThan(events.indexOf("cookies:import"));
    expect((await bridge.cookies("p", "https://ordinary.test")).cookies).toEqual([cookie]);
    await expect(bridge.changeCookies("p", { action: "import", origin: "https://ordinary.test", cookies: [{ ...cookie, domain: "unrelated.test" }] })).rejects.toThrow();
    await bridge.changeCookies("p", { action: "clear", origin: "https://ordinary.test" });
    expect(cookieJar).toHaveLength(1); expect(cookieJar[0].domain).toBe("unrelated.test");
    await new Promise(resolve => setTimeout(resolve, 100)); expect(JSON.stringify(states)).not.toContain("private-value");
    setAllowed(false); await expect(bridge.cookies("p", "https://ordinary.test")).rejects.toThrow();
  } finally { await bridge.stop(); }
});
test("cookie validation rejects unrelated domains, unverified parent scopes, malformed flags and oversized imports", () => {
  for (const invalid of [{ ...cookie, domain: ".test" }, { ...cookie, domain: "ordinary.test.evil.test" }, { ...cookie, domain: "evil.test" },
    { ...cookie, name: "bad;name" }, { ...cookie, value: "line\nbreak" }, { ...cookie, path: "bad" }, { ...cookie, sameSite: "None", secure: false },
    { ...cookie, expires: Infinity }, { ...cookie, httpOnly: "true" }, { ...cookie, value: "x".repeat(5000) }])
    expect(() => siteCookies([invalid], "https://ordinary.test")).toThrow();
  expect(() => siteCookies([{ ...cookie, domain: ".ordinary.test" }], "https://sub.ordinary.test")).toThrow();
  expect(siteCookies([{ ...cookie, domain: ".ordinary.test" }], "https://sub.ordinary.test", [".ordinary.test"])).toHaveLength(1);
  expect(() => siteCookies(Array.from({ length: 257 }, () => cookie), "https://ordinary.test")).toThrow();
});

test("navigation invalidates in-flight pixels and pointer bounds even when the selected Page object is unchanged", async () => {
  const frames: unknown[] = [], clicks: string[] = [];
  const shots: Array<(data: Buffer) => void> = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 0, 5, 0x56, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xda]);
  const page: any = new EventEmitter(); let address = "https://ordinary.test/path?step=1";
  page.url = () => address; page.isClosed = () => false; page.mainFrame = () => page; page.title = async () => "Fixture";
  page.bringToFront = async () => {}; page.screenshot = () => new Promise<Buffer>(resolve => shots.push(resolve));
  page.goto = async (url: string) => { address = url; page.emit("framenavigated", page); page.emit("load"); };
  page.mouse = { click: async () => clicks.push("click") };
  const context: any = { pages: () => [page], on: () => {} };
  const browser: any = { contexts: () => [context], isConnected: () => true, on: () => {}, close: async () => {} };
  const bridge = new BrowserBridge({ getLaunch: () => ({ profileId: "p", pid: 1, ws: "local", debugPort: 1, startedAt: 1 }),
    getConfig: () => ({ profileId: "p", role: "manual", origins: [], epoch: 1, token: "private", relayUrl: "local" }),
    canControl: () => true, connect: async () => browser, onFrame: frame => frames.push(frame), onError: () => {} });
  const waitForShot = async () => { for (let i = 0; i < 30 && !shots.length; i++) await new Promise(resolve => setTimeout(resolve, 1)); expect(shots.length).toBe(1); };
  try {
    await bridge.attach("p"); bridge.setVisible(["p"]);
    const capture = (bridge as any).frame("p"); await waitForShot();
    await bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/path?step=2" });
    shots.shift()!(jpeg); await capture; expect(frames).toHaveLength(0);
    const control = bridge.control({ profileId: "p", kind: "click", x: 10, y: 10 }).then(() => null, error => error); await waitForShot();
    await bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/path?step=3" });
    shots.shift()!(jpeg); const error = await control; expect(error).toBeInstanceOf(Error); expect(error.message).toContain("Browser page changed");
    expect(clicks).toHaveLength(0);
  } finally { await bridge.stop(); }
});

for (const engine of ["chromium", "firefox"] as const) test(`${engine} trusted extension entry points use verified native origins and remain directly interactive`, async () => {
  const { bridge, events } = tabsFixture(engine);
  const origin = engine === "chromium" ? `chrome-extension://${"a".repeat(32)}` : "moz-extension://12345678-1234-1234-1234-123456789abc";
  try {
    const opened = await bridge.openExtensionPage("p", { origin, entrypoint: "ui/popup.html" });
    expect(opened.error).toBeUndefined(); expect(opened.tabs.find(tab => tab.id === opened.activeTabId)!.url).toBe(`${origin}/ui/popup.html`);
    expect(events.indexOf("manual")).toBeLessThan(events.indexOf(`navigate:${origin}/ui/popup.html`));
    await bridge.control({ profileId: "p", kind: "text", text: "operator input" }); expect(events).toContain("text");
    await expect(bridge.browserAction("p", { action: "navigate", url: `${origin}/ui/popup.html` })).rejects.toThrow();
    for (const entrypoint of ["../secret", "%2e%2e/secret", "ui/%2fsecret", "https://ordinary.test", "/absolute", "ui/popup.html?secret=1"])
      await expect(bridge.openExtensionPage("p", { origin, entrypoint })).rejects.toThrow();
    await expect(bridge.openExtensionPage("p", { origin: "https://ordinary.test", entrypoint: "popup.html" })).rejects.toThrow();
  } finally { await bridge.stop(); }
});
test("unverified extension responses never grant privileged-page input", async () => {
  const { bridge, pages } = tabsFixture();
  try {
    await bridge.attach("p");
    const connection = (bridge as any).connections.get("p");
    const original = connection.context.newPage;
    connection.context.newPage = async () => { const page = await original(); const goto = page.goto.bind(page); page.goto = async (url: string) => { await goto(url); return { status: () => 404 }; }; return page; };
    const state = await bridge.openExtensionPage("p", { origin: `chrome-extension://${"b".repeat(32)}`, entrypoint: "missing.html" });
    expect(state.error).toContain("could not be verified"); expect(state.tabs.at(-1)!.url).toBe("");
    await expect(bridge.control({ profileId: "p", kind: "text", text: "blocked" })).rejects.toThrow();
    expect(pages.filter(page => !page.closed)).toHaveLength(2);
  } finally { await bridge.stop(); }
});
test("Firefox extension channels without HTTP responses require the exact committed native HTML document", async () => {
  const origin = "moz-extension://12345678-1234-1234-1234-123456789abc";
  for (const errorDocument of [false, true]) {
    const { bridge } = tabsFixture("firefox");
    try {
      await bridge.attach("p");
      const connection = (bridge as any).connections.get("p"), original = connection.context.newPage;
      connection.context.newPage = async () => {
        const page = await original(), goto = page.goto.bind(page);
        page.goto = async (url: string) => { await goto(url); return null; };
        if (errorDocument) page.evaluate = async () => ({ href: page.address, uri: "about:neterror", contentType: "text/html", readyState: "complete" });
        return page;
      };
      const state = await bridge.openExtensionPage("p", { origin, entrypoint: "popup.html" });
      if (errorDocument) {
        expect(state.error).toContain("could not be verified"); expect(state.tabs.at(-1)!.url).toBe("");
        await expect(bridge.control({ profileId: "p", kind: "text", text: "blocked" })).rejects.toThrow();
      } else { expect(state.error).toBeUndefined(); expect(state.tabs.at(-1)!.url).toBe(`${origin}/popup.html`); }
    } finally { await bridge.stop(); }
  }
});
test("read-only workflow execution supports bounded navigation, scrolling and redacted URL extraction with cancellation", async () => {
  const { bridge, pages, events, setAllowed } = tabsFixture();
  try {
    const signal = new AbortController();
    expect(await bridge.executeWorkflowStep("p", { kind: "extract", source: "url", field: "location" }, signal.signal)).toBe("https://approved.test/start");
    await bridge.executeWorkflowStep("p", { kind: "navigate", url: "https://ordinary.test/public" }, signal.signal);
    await bridge.executeWorkflowStep("p", { kind: "scroll", deltaX: 0, deltaY: 200 }, signal.signal);
    expect(events).toContain("scroll:0:200");
    expect(await bridge.executeWorkflowStep("p", { kind: "extract", source: "title", field: "title" }, signal.signal)).toBe("Fixture");
    await expect(bridge.executeWorkflowStep("p", { kind: "navigate", url: "https://ordinary.test/?token=private" }, signal.signal)).rejects.toThrow();
    await expect(bridge.executeWorkflowStep("p", { kind: "scroll", deltaX: 0, deltaY: 3001 }, signal.signal)).rejects.toThrow();
    setAllowed(false); await expect(bridge.executeWorkflowStep("p", { kind: "extract", source: "title", field: "title" }, signal.signal)).rejects.toThrow();
    setAllowed(true); signal.abort();
    const before = events.length; await expect(bridge.executeWorkflowStep("p", { kind: "navigate", url: "https://ordinary.test/new" }, signal.signal)).rejects.toThrow("cancelled"); expect(events).toHaveLength(before);
    expect(events).not.toContain("click"); expect(events).not.toContain("text");
    expect(pages[0]!.url()).toBe("https://ordinary.test/public");
  } finally { await bridge.stop(); }
});
test("workflow text extraction reads only visible public DOM text and rejects controls, sensitive attributes and page changes", async () => {
  const { bridge, pages } = tabsFixture();
  const priorDocument = globalThis.document, priorStyle = globalThis.getComputedStyle;
  const node: any = { parentElement: null, id: "public-result", textContent: "Public fixture result", closest: () => null, querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null, hasAttribute: () => false };
  Object.defineProperty(node, "value", { get: () => { throw new Error("Control values must never be read"); } });
  try {
    await bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/public" });
    (globalThis as any).document = { querySelectorAll: () => [node] }; (globalThis as any).getComputedStyle = () => ({ display: "block", visibility: "visible" });
    pages[0]!.evaluate = async (fn: any, arg?: any) => fn(arg);
    const step = { kind: "extract" as const, source: "text" as const, selector: "#public-result", field: "result" }, signal = new AbortController();
    expect(await bridge.executeWorkflowStep("p", step, signal.signal)).toBe("Public fixture result");
    node.closest = () => node; await expect(bridge.executeWorkflowStep("p", step, signal.signal)).rejects.toThrow("public text"); node.closest = () => null;
    node.getAttribute = (name: string) => name === "data-testid" ? "password-value" : null; await expect(bridge.executeWorkflowStep("p", step, signal.signal)).rejects.toThrow("public text"); node.getAttribute = () => null;
    node.textContent = "Opaque abc123 Public fixture result";
    node.querySelectorAll = () => [{ cssHidden: true }];
    (globalThis as any).getComputedStyle = (element: any) => ({ display: element.cssHidden ? "none" : "block", visibility: "visible" });
    await expect(bridge.executeWorkflowStep("p", step, signal.signal)).rejects.toThrow("public text");
    node.querySelectorAll = () => [];
    node.textContent = "x".repeat(65537); await expect(bridge.executeWorkflowStep("p", step, signal.signal)).rejects.toThrow("public text"); node.textContent = "Public fixture result";
    await bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/login" });
    await expect(bridge.executeWorkflowStep("p", step, signal.signal)).rejects.toThrow("sensitive pages");
  } finally { (globalThis as any).document = priorDocument; (globalThis as any).getComputedStyle = priorStyle; await bridge.stop(); }
});

test("Stop interrupts an in-flight native navigation without queuing or leaving a spurious failure", async () => {
  const { bridge, pages } = tabsFixture();
  try {
    await bridge.attach("p");
    let abortNavigation!: (error: Error) => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    pages[0]!.goto = async () => { entered(); return await new Promise<never>((_resolve, reject) => { abortNavigation = reject; }); };
    const context = (bridge as any).connections.get("p").context;
    const nativeSession = context.newCDPSession;
    context.newCDPSession = async (page: unknown) => {
      const session = await nativeSession(page), send = session.send;
      session.send = async (method: string) => { if (method === "Page.stopLoading") abortNavigation(new Error("Navigation was aborted")); return send(method); };
      return session;
    };
    const navigation = bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/stalled" });
    await waiting;
    const stopped = await bridge.browserAction("p", { action: "stop" });
    expect(stopped.loading).toBe(false); expect(stopped.error).toBeUndefined();
    const completed = await navigation; expect(completed.error).toBeUndefined();
  } finally { await bridge.stop(); }
});

test("opaque selection navigates only one of two identical-URL native tabs", async () => {
  const { bridge, pages } = tabsFixture();
  try {
    const initial = await bridge.browserState("p");
    const firstId = initial.tabs[0]!.id;
    const duplicate = await bridge.browserAction("p", { action: "new-tab", url: initial.tabs[0]!.url });
    expect(duplicate.tabs).toHaveLength(2); expect(duplicate.tabs[0]!.url).toBe(duplicate.tabs[1]!.url);
    await bridge.browserAction("p", { action: "select-tab", tabId: firstId });
    const url = "https://ordinary.test/second?operator-fixture-query=preview2#local-fragment";
    const state = await bridge.browserAction("p", { action: "navigate", url });
    expect(state.error).toBeUndefined(); expect(state.activeTabId).toBe(firstId);
    expect(state.tabs.find(tab => tab.id === firstId)!.url).toBe(url);
    expect(pages[0]!.url()).toBe(url); expect(pages[1]!.url()).toBe(initial.tabs[0]!.url);
  } finally { await bridge.stop(); }
});

for (const engine of ["chromium", "firefox"] as const) test(`${engine} Stop releases an API navigation even when native goto never settles`, async () => {
  const { bridge, pages, events } = tabsFixture(engine);
  try {
    await bridge.attach("p");
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    pages[0]!.goto = async () => { entered(); return new Promise<never>(() => {}); };
    const navigation = bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/stalled" });
    await waiting;
    const at = Date.now(), stopped = await bridge.browserAction("p", { action: "stop" });
    const result = await Promise.race([navigation, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Stop retained the old lifecycle wait")), 300))]);
    expect(Date.now() - at).toBeLessThan(300); expect(stopped.loading).toBe(false); expect(result.loading).toBe(false); expect(result.error).toBeUndefined();
    expect(events).toContain("stop"); expect((bridge as any).connections.get("p").navigations.size).toBe(0);
  } finally { await bridge.stop(); }
});
test("superseding navigation ignores late native rejection and preserves the newer pending load", async () => {
  const { bridge, pages } = tabsFixture();
  try {
    await bridge.attach("p");
    let entered!: () => void, failOld!: (error: Error) => void, finishNew!: () => void;
    let waiting = new Promise<void>(resolve => { entered = resolve; });
    const oldGoto = pages[0]!.goto.bind(pages[0]);
    pages[0]!.goto = async () => { entered(); return new Promise<never>((_resolve, reject) => { failOld = reject; }); };
    const first = bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/old" }); await waiting;
    waiting = new Promise<void>(resolve => { entered = resolve; });
    pages[0]!.goto = async url => { entered(); await new Promise<void>(resolve => { finishNew = resolve; }); return oldGoto(url); };
    const second = bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/new" }); await waiting;
    const cancelled = await first; expect(cancelled.loading).toBe(true); expect(cancelled.error).toBeUndefined();
    failOld(new Error("Late old native failure contains no actionable result")); await Promise.resolve(); await Promise.resolve();
    const during = await bridge.browserState("p"); expect(during.loading).toBe(true); expect(during.error).toBeUndefined();
    finishNew(); const completed = await second; expect(completed.tabs[0]!.url).toBe("https://ordinary.test/new"); expect(completed.loading).toBe(false); expect(completed.error).toBeUndefined();
  } finally { await bridge.stop(); }
});
test("detach cancels a never-settling native navigation without retaining application waiters", async () => {
  const { bridge, pages } = tabsFixture();
  try {
    await bridge.attach("p"); const connection = (bridge as any).connections.get("p");
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    pages[0]!.goto = async () => { entered(); return new Promise<never>(() => {}); };
    const navigation = bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/stalled" }).then(() => null, error => error);
    await waiting; await bridge.detach("p");
    const error = await Promise.race([navigation, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Detach retained a navigation waiter")), 300))]);
    expect(error).toBeInstanceOf(Error); expect(error.name).toBe("NavigationCancelled"); expect(connection.navigations.size).toBe(0);
  } finally { await bridge.stop(); }
});

function actionGate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
for (const action of ["back", "forward", "reload", "select-tab"] as const) {
  test(`revocation while viewport is pending blocks native ${action}`, async () => {
    const { bridge, events, setAllowed } = tabsFixture();
    try {
      const state = await bridge.browserState("p"), connection = (bridge as any).connections.get("p");
      const gate = actionGate(), tab = [...connection.tabs.values()][0] as any; tab.viewportReady = gate.promise; events.length = 0;
      const pending = bridge.browserAction("p", { action, ...(action === "select-tab" ? { tabId: state.activeTabId! } : {}) }).then(() => null, error => error);
      await new Promise(resolve => setTimeout(resolve, 0)); setAllowed(false); gate.resolve();
      expect(await pending).toBeInstanceOf(Error); expect(events.filter(event => /^(?:front:|back|forward|reload)/.test(event))).toEqual([]);
    } finally { await bridge.stop(); }
  });
}
test("revocation during native bringToFront blocks the following navigation", async () => {
  const { bridge, events, pages, setAllowed } = tabsFixture();
  try {
    await bridge.attach("p"); const gate = actionGate(), entered = actionGate();
    pages[0]!.bringToFront = async () => { entered.resolve(); await gate.promise; };
    const pending = bridge.browserAction("p", { action: "navigate", url: "https://ordinary.test/forbidden" }).then(() => null, error => error);
    await entered.promise; setAllowed(false); gate.resolve();
    expect(await pending).toBeInstanceOf(Error); expect(events).not.toContain("navigate:https://ordinary.test/forbidden");
  } finally { await bridge.stop(); }
});
test("revocation during new extension tab preparation prevents extension navigation", async () => {
  const { bridge, events, pages, setAllowed } = tabsFixture();
  try {
    await bridge.attach("p"); const connection = (bridge as any).connections.get("p"), gate = actionGate(), entered = actionGate();
    connection.viewport = { width: 390, height: 844 };
    const prototype = Object.getPrototypeOf(pages[0]); prototype.setViewportSize = async () => { entered.resolve(); await gate.promise; };
    const pending = bridge.openExtensionPage("p", { origin: "chrome-extension://" + "a".repeat(32), entrypoint: "popup.html" }).then(() => null, error => error);
    await entered.promise; setAllowed(false); gate.resolve();
    expect(await pending).toBeInstanceOf(Error); expect(events.some(event => event.startsWith("navigate:chrome-extension:"))).toBe(false);
    expect(events.some(event => event === "front:about:blank")).toBe(false);
  } finally { await bridge.stop(); }
});
test("revocation between cookie domains prevents remaining clears and export return", async () => {
  const { bridge, cookieJar, events, setAllowed } = tabsFixture();
  try {
    await bridge.attach("p"); const connection = (bridge as any).connections.get("p");
    cookieJar.push({ ...cookie }, { ...cookie, domain: ".ordinary.test" });
    const first = actionGate(), entered = actionGate(), original = connection.context.clearCookies;
    connection.context.clearCookies = async (value: any) => { await original(value); entered.resolve(); await first.promise; };
    const pending = bridge.changeCookies("p", { action: "clear", origin: "https://ordinary.test" }).then(() => null, error => error);
    await entered.promise; setAllowed(false); first.resolve(); expect(await pending).toBeInstanceOf(Error);
    expect(events.filter(event => event.startsWith("cookies:clear:"))).toEqual(["cookies:clear:ordinary.test"]);
    setAllowed(true); const exportGate = actionGate(), reading = actionGate(); connection.context.cookies = async () => { reading.resolve(); await exportGate.promise; return [cookie]; };
    const exported = bridge.cookies("p", "https://ordinary.test").then(() => null, error => error);
    await reading.promise; setAllowed(false); exportGate.resolve(); expect(await exported).toBeInstanceOf(Error);
  } finally { await bridge.stop(); }
});
