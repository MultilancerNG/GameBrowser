import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { chromium, firefox } from "playwright-core";
import { sensitiveTargetPattern, sensitivePathPattern, sensitiveControl } from "./browser-sync-policy.mjs";

// A connection must not change focus behaviour of the browsers it observes.
globalThis[Symbol.for("aliasmode.playwrightFocusEmulation")] = false;

// Standalone Node worker mirrors the central profile-id.ts grammar; a semantic
// cross-test keeps its128-character and Windows-device-name rules identical.
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESERVED_PROFILE_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const safeProfileId = (value) => typeof value === "string" && PROFILE_ID.test(value) && !RESERVED_PROFILE_ID.test(value);
const MAX_VALUE = 65_536;
const MAX_QUEUE = 128;
const ACTION_TIMEOUT = 5_000;
const MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);

export function validateSyncConfiguration(input) {
  const profile = (value) => {
    if (!value || !safeProfileId(value.id) || !["chromium", "firefox"].includes(value.engine)
      || typeof value.endpoint !== "string" || value.endpoint.length > 2_048) throw new Error("invalid sync configuration");
    const url = new URL(value.endpoint);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password) throw new Error("invalid sync endpoint");
    return { id: value.id, engine: value.engine, endpoint: value.endpoint };
  };
  if (input?.type !== "start" || !Array.isArray(input.followers)
    || input.followers.length < 1 || input.followers.length > 20) throw new Error("invalid sync configuration");
  if (input.alignOnStart !== undefined && typeof input.alignOnStart !== "boolean") throw new Error("invalid sync alignment option");
  const admin = profile(input.admin);
  if (admin.engine !== "chromium") throw new Error("Chromium Admin required");
  const followers = input.followers.map(profile);
  if (new Set([admin.id, ...followers.map((item) => item.id)]).size !== followers.length + 1) throw new Error("duplicate sync profiles");
  if (new Set([admin.endpoint, ...followers.map((item) => item.endpoint)]).size !== followers.length + 1) throw new Error("duplicate sync endpoints");
  let policy;
  if (input.policy !== undefined) {
    const value = input.policy;
    if (!value || !Array.isArray(value.origins) || value.origins.length > 32 || !["fast", "paced"].includes(value.pacing)
      || value.sensitiveControls !== "manual" || (value.pausedProfileIds !== undefined && (!Array.isArray(value.pausedProfileIds) || value.pausedProfileIds.length > 256 || value.pausedProfileIds.some((id) => !safeProfileId(id))))) throw new Error("invalid sync policy");
    const origins = [...new Set(value.origins.map((origin) => {
      if (typeof origin !== "string" || origin.length > 2048) throw new Error("invalid sync origin");
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("invalid sync origin");
      return origin;
    }))];
    policy = { origins, pacing: value.pacing, sensitiveControls: "manual", pausedProfileIds: [...new Set(value.pausedProfileIds ?? [])] };
  }
  return { type: "start", admin, followers, ...(input.alignOnStart === undefined ? {} : { alignOnStart: input.alignOnStart }), ...(policy ? { policy } : {}) };
}

export function normalizeMirrorAction(value) {
  if (!value || typeof value !== "object") throw new Error("invalid mirror action");
  const selector = typeof value.selector === "string" && value.selector.length <= 4_096 ? value.selector : "";
  const fraction = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  if (value.type === "click" && fraction(value.x) && fraction(value.y) && [0, 1, 2].includes(value.button)) {
    if (!Array.isArray(value.modifiers) || value.modifiers.some((modifier) => !MODIFIERS.has(modifier))) throw new Error("invalid click modifiers");
    if ((value.elementX !== undefined || value.elementY !== undefined) && (!fraction(value.elementX) || !fraction(value.elementY))) throw new Error("invalid click position");
    return { type: "click", selector, x: value.x, y: value.y, button: value.button, modifiers: value.modifiers,
      ...(value.elementX === undefined ? {} : { elementX: value.elementX, elementY: value.elementY }) };
  }
  if (value.type === "input" && selector && typeof value.value === "string" && value.value.length <= MAX_VALUE) {
    return { type: "input", selector, value: value.value, ...(value.keyHandled === true ? { keyHandled: true } : {}) };
  }
  if (value.type === "check" && selector && typeof value.checked === "boolean") return { type: "check", selector, checked: value.checked };
  if (value.type === "select" && selector && Array.isArray(value.values) && value.values.length <= 100
    && value.values.every((item) => typeof item === "string" && item.length <= 1_024)) return { type: "select", selector, values: value.values };
  if (value.type === "key" && typeof value.key === "string"
    && /^(?:(?:Control|Meta|Alt|Shift)\+)*(?:Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Delete|Backspace|[A-Za-z0-9])$/.test(value.key)) {
    return { type: "key", selector, key: value.key };
  }
  if (value.type === "scroll" && fraction(value.x) && fraction(value.y)) return { type: "scroll", selector, x: value.x, y: value.y };
  throw new Error("invalid mirror action");
}

/** The bounded queue fails visibly instead of dropping clicks or typed input. */
export class FollowerQueue {
  constructor(apply, failed, limit = MAX_QUEUE, disconnected = null) {
    this.apply = apply; this.reportFailure = failed; this.limit = limit; this.disconnected = disconnected;
    this.pending = []; this.running = false; this.failed = false; this.stopped = false;
  }
  enqueue(action) {
    if (this.stopped || this.failed) return false;
    if (this.pending.length >= this.limit) { this.fail("queue-overflow"); return false; }
    this.pending.push(action);
    if (!this.running) void this.drain();
    return true;
  }
  fail(reason = "action-failed") {
    if (this.failed || this.stopped) return;
    this.failed = true; this.pending.length = 0; this.reportFailure(reason);
  }
  stop() { this.stopped = true; this.pending.length = 0; }
  async drain() {
    this.running = true;
    try {
      while (!this.stopped && !this.failed && this.pending.length) {
        const action = this.pending.shift();
        try { await this.apply(action); } catch (error) {
          // Let the browser-disconnected notification settle before treating a
          // failed operation as uncertain replay. A closed browser can reconnect.
          if (this.disconnected) await new Promise((resolve) => setTimeout(resolve, 0));
          this.fail(this.disconnected?.() ? "follower-disconnected" : error?.reason === "policy-blocked" ? "policy-blocked" : "action-failed");
        }
      }
    } finally { this.running = false; }
  }
}

/** Executes only in a random Chromium isolated world, never the site's JS world. */
export function installTrustedCapture(bindingName, cleanupName, policy = null, sensitive = null) {
  if (globalThis[cleanupName]) globalThis[cleanupName]();
  const listeners = [];
  let scrollTimer;
  let latestScroll;
  let lastEnterActivation = 0;
  let lastEnterTarget;
  const webPage = () => location.protocol === "http:" || location.protocol === "https:";
  const pauseForPolicy = () => {
    try { globalThis[bindingName](JSON.stringify({ type: "policy-pause", sourceUrl: location.href })); } catch { /* detached observer */ }
  };
  const send = (action) => {
    if (!webPage() || policy?.paused) return;
    if (policy && document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="hcaptcha.com"],iframe[src*="recaptcha"],.cf-turnstile,.h-captcha,.g-recaptcha,[data-sitekey],input[autocomplete="one-time-code"],input[type="password"]')) { pauseForPolicy(); return; }
    if (policy && (!policy.origins.includes(location.origin) || new RegExp(policy.sensitivePathSource, "i").test(location.pathname))) { pauseForPolicy(); return; }
    try { globalThis[bindingName](JSON.stringify({ ...action, sourceUrl: location.href })); } catch { /* detached observer */ }
  };
  const permittedTarget = (element) => {
    if (policy?.paused) return false;
    if (policy && sensitive?.(element, policy.sensitiveTargetSource)) { pauseForPolicy(); return false; }
    return true;
  };
  const selectorFor = (element) => {
    if (!(element instanceof Element)) return "";
    const parts = [];
    let node = element;
    for (let depth = 0; node && depth < 12; depth++) {
      const root = node.getRootNode();
      let part = node.localName;
      if (node.id) part = `#${CSS.escape(node.id)}`;
      else {
        const testId = node.getAttribute("data-testid");
        const name = node.getAttribute("name");
        if (testId) part += `[data-testid=${JSON.stringify(testId)}]`;
        else if (name) part += `[name=${JSON.stringify(name)}]`;
        else if (node.parentElement) {
          const siblings = [...node.parentElement.children].filter((item) => item.localName === node.localName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      try { if (root.querySelectorAll(parts.join(" > ")).length === 1 && root instanceof Document) return parts.join(" > "); } catch { return ""; }
      node = node.parentElement;
      if (!node && root instanceof ShadowRoot) { node = root.host; parts.unshift(":scope"); }
    }
    return parts.join(" > ").replaceAll(" > :scope > ", " ");
  };
  const target = (event) => event.composedPath().find((item) => item instanceof Element);
  const modifiers = (event) => [event.altKey && "Alt", event.ctrlKey && "Control", event.metaKey && "Meta", event.shiftKey && "Shift"].filter(Boolean);
  const listen = (type, callback, options = true) => {
    document.addEventListener(type, callback, options); listeners.push([type, callback, options]);
  };
  listen("click", (event) => {
    if (!event.isTrusted || event.button > 2) return;
    // Enter activation creates a second, trusted click with detail 0. Its
    // follower key press already creates that click, so never send it twice.
    if (event.detail === 0 && Date.now() - lastEnterActivation < 750) { lastEnterActivation = 0; return; }
    const element = target(event);
    if (!element || element.matches('input[type="checkbox"],input[type="radio"],select,option')) return;
    if (!permittedTarget(element)) return;
    const rect = element.getBoundingClientRect();
    const scaleX = rect.width / (element.offsetWidth || rect.width || 1);
    const scaleY = rect.height / (element.offsetHeight || rect.height || 1);
    const width = (element.clientWidth || rect.width) * scaleX;
    const height = (element.clientHeight || rect.height) * scaleY;
    const position = event.detail > 0 && width > 0 && height > 0 ? {
      elementX: Math.max(0, Math.min(1, (event.clientX - rect.left - (element.clientLeft || 0) * scaleX) / width)),
      elementY: Math.max(0, Math.min(1, (event.clientY - rect.top - (element.clientTop || 0) * scaleY) / height)),
    } : {};
    send({ type: "click", selector: selectorFor(element), x: Math.max(0, Math.min(1, event.clientX / innerWidth)), y: Math.max(0, Math.min(1, event.clientY / innerHeight)), button: event.button, modifiers: modifiers(event), ...position });
  });
  listen("input", (event) => {
    if (!event.isTrusted) return;
    const element = target(event);
    if (!element || element.matches('input[type="checkbox"],input[type="radio"],select,input[type="file"]')) return;
    if (!permittedTarget(element)) return;
    const value = element.isContentEditable ? element.textContent : element.value;
    if (typeof value !== "string") return;
    if (policy && value.length > 512) { pauseForPolicy(); return; }
    if (value.length > 65_536) { send({ type: "capture-error" }); return; }
    send({ type: "input", selector: selectorFor(element), value, keyHandled: element === lastEnterTarget && Date.now() - lastEnterActivation < 750 });
  });
  listen("change", (event) => {
    if (!event.isTrusted) return;
    const element = target(event);
    if (!permittedTarget(element)) return;
    if (element instanceof HTMLSelectElement) send({ type: "select", selector: selectorFor(element), values: [...element.selectedOptions].map((option) => option.value) });
    else if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) send({ type: "check", selector: selectorFor(element), checked: element.checked });
  });
  listen("keydown", (event) => {
    if (!event.isTrusted || event.isComposing) return;
    lastEnterActivation = 0;
    lastEnterTarget = undefined;
    const element = target(event);
    if (!permittedTarget(element)) return;
    const editable = element?.isContentEditable || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    // Select navigation is represented by its resulting change event. Sending
    // both the key and selectOption would run the follower's change handler twice.
    if (element instanceof HTMLSelectElement && !["Tab", "Escape"].includes(event.key)) return;
    const named = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
    if (!named.includes(event.key) && !(!editable && ["Delete", "Backspace"].includes(event.key))
      && !((event.ctrlKey || event.metaKey) && /^[a-z0-9]$/i.test(event.key) && !/[cvx]/i.test(event.key))) return;
    if (event.key === "Enter") { lastEnterActivation = Date.now(); lastEnterTarget = element; }
    send({ type: "key", selector: selectorFor(element), key: [...modifiers(event), event.key].join("+") });
  });
  listen("scroll", (event) => {
    if (!event.isTrusted) return;
    const element = event.target instanceof Element ? event.target : document.scrollingElement;
    if (!element) return;
    const root = element === document.scrollingElement;
    latestScroll = {
      type: "scroll", selector: root ? "" : selectorFor(element),
      x: Math.max(0, Math.min(1, element.scrollLeft / Math.max(1, element.scrollWidth - element.clientWidth))),
      y: Math.max(0, Math.min(1, element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight))),
    };
    if (!scrollTimer) scrollTimer = setTimeout(() => { scrollTimer = undefined; send(latestScroll); }, 50);
  }, { capture: true, passive: true });
  globalThis[cleanupName] = () => {
    for (const [type, callback, options] of listeners) document.removeEventListener(type, callback, options);
    clearTimeout(scrollTimer);
    delete globalThis[cleanupName];
  };
}

function isWebUrl(value) {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

async function disconnect(browser) {
  // For connect()/connectOverCDP() this disconnects our client, not the owned process.
  let timer;
  try { await Promise.race([browser.close().catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 2_000); })]); }
  finally { clearTimeout(timer); }
}

async function frameAt(page, path) {
  let frame = page.mainFrame();
  for (const index of path) {
    frame = frame.childFrames()[index];
    if (!frame) throw new Error("matching follower frame is unavailable");
  }
  return frame;
}

export async function applyMirrorAction(context, pages, action, policy) {
  let page = pages.get(action.pageId);
  if (!page || page.isClosed()) {
    page = context.pages()[action.pageId] ?? await context.newPage();
    pages.set(action.pageId, page);
  }
  if (action.type === "navigate") {
    if (policy && isWebUrl(action.url) && (!policy.origins.includes(new URL(action.url).origin) || sensitivePathPattern.test(new URL(action.url).pathname))) {
      const error = new Error("Synchronization requires independent manual control"); error.reason = "policy-blocked"; throw error;
    }
    if (action.fragmentOnly) {
      if (!isWebUrl(action.url) || !isWebUrl(page.url())) throw new Error("follower workflow does not match the Admin");
      const source = new URL(action.url);
      const follower = new URL(page.url());
      if (source.origin !== follower.origin || source.pathname !== follower.pathname) throw new Error("follower workflow does not match the Admin");
      follower.hash = source.hash;
      if (page.url() !== follower.href) await page.goto(follower.href, { timeout: ACTION_TIMEOUT, waitUntil: "domcontentloaded" });
      return;
    }
    if (action.initial && isWebUrl(action.url) && isWebUrl(page.url())) {
      const source = new URL(action.url);
      const follower = new URL(page.url());
      // Starting observation is not a new navigation command. A follower
      // already on the same workflow keeps its own account query/fragment.
      if (source.origin === follower.origin && source.pathname === follower.pathname) return;
    }
    if (isWebUrl(action.url) && page.url() !== action.url) await page.goto(action.url, { timeout: ACTION_TIMEOUT, waitUntil: "domcontentloaded" });
    return;
  }
  const frame = await frameAt(page, action.framePath ?? []);
  if (!isWebUrl(action.sourceUrl)) throw new Error("Admin page is not ready for website actions");
  const sourceUrl = new URL(action.sourceUrl);
  const matchingWorkflow = (url) => url.origin === sourceUrl.origin && url.pathname === sourceUrl.pathname;
  // Each profile keeps its own session/query tokens. A slower follower may
  // still be committing the navigation caused by its previous mirrored click.
  // Wait for that browser to reach the matching workflow; never send it the
  // Admin's account-specific URL just to make the guard pass.
  if (!isWebUrl(frame.url()) || !matchingWorkflow(new URL(frame.url()))) {
    try { await frame.waitForURL(matchingWorkflow, { timeout: ACTION_TIMEOUT, waitUntil: "domcontentloaded" }); }
    catch { throw new Error("follower workflow does not match the Admin"); }
  }
  if (!isWebUrl(frame.url()) || !matchingWorkflow(new URL(frame.url()))) throw new Error("follower workflow does not match the Admin");
  const locator = action.selector ? frame.locator(action.selector).first() : null;
  if (policy) {
    const originAllowed = policy.origins.includes(sourceUrl.origin) && !sensitivePathPattern.test(sourceUrl.pathname);
    const pageSensitive = await frame.locator("html").evaluate(sensitiveControl, null);
    const targetSensitive = locator && await locator.count() ? await locator.evaluate(sensitiveControl, sensitiveTargetPattern.source) : action.type !== "scroll";
    if (!originAllowed || pageSensitive || targetSensitive || (action.type === "input" && action.value.length > 512)) { const error = new Error("Synchronization requires independent manual control"); error.reason = "policy-blocked"; throw error; }
  }
  switch (action.type) {
    case "click": {
      const button = ["left", "middle", "right"][action.button];
      if (locator && await locator.count()) {
        let position;
        if (action.elementX !== undefined) {
          await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT });
          const size = await locator.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { width: element.clientWidth || rect.width, height: element.clientHeight || rect.height };
          });
          if (size.width <= 0 || size.height <= 0) throw new Error("matching follower target is unavailable");
          position = { x: Math.min(size.width - 0.5, action.elementX * size.width), y: Math.min(size.height - 0.5, action.elementY * size.height) };
        }
        await locator.click({ button, modifiers: action.modifiers, position, timeout: ACTION_TIMEOUT, noWaitAfter: false });
      } else {
        const box = frame === page.mainFrame()
          ? { x: 0, y: 0, ...await frame.evaluate(() => ({ width: innerWidth, height: innerHeight })) }
          : await (await frame.frameElement()).boundingBox();
        if (!box) throw new Error("matching follower target is unavailable");
        for (const modifier of action.modifiers) await page.keyboard.down(modifier);
        try { await page.mouse.click(box.x + action.x * box.width, box.y + action.y * box.height, { button }); }
        finally { for (const modifier of [...action.modifiers].reverse()) await page.keyboard.up(modifier); }
      }
      break;
    }
    case "input": {
      // Enter in a textarea/contenteditable produces both a key event and an
      // input event. The replayed key already made the same input change.
      const alreadyApplied = action.keyHandled && await locator.evaluate((element) => element.isContentEditable ? element.textContent : element.value) === action.value;
      if (!alreadyApplied) await locator.fill(action.value, { timeout: ACTION_TIMEOUT });
      break;
    }
    case "check": await locator.setChecked(action.checked, { timeout: ACTION_TIMEOUT }); break;
    case "select": await locator.selectOption(action.values, { timeout: ACTION_TIMEOUT }); break;
    case "key":
      if (locator && await locator.count()) await locator.press(action.key, { timeout: ACTION_TIMEOUT, noWaitAfter: false });
      else await page.keyboard.press(action.key);
      break;
    case "scroll":
      await frame.evaluate(({ selector, x, y }) => {
        const element = selector ? document.querySelector(selector) : document.scrollingElement;
        if (!element) throw new Error("scroll target is unavailable");
        element.scrollTo(x * Math.max(0, element.scrollWidth - element.clientWidth), y * Math.max(0, element.scrollHeight - element.clientHeight));
      }, action);
      break;
    default: throw new Error("unsupported mirror action");
  }
}

export async function createMirrorSession(rawConfiguration, options = {}) {
  const configuration = validateSyncConfiguration(rawConfiguration);
  const emit = options.emit ?? (() => {});
  const connect = options.connect ?? (async (profile) => profile.engine === "firefox"
    ? firefox.connect(profile.endpoint, { timeout: 30_000 })
    : chromium.connectOverCDP(profile.endpoint, { timeout: 30_000 }));
  const browsers = [];
  const captures = new Map();
  const claimedPages = new WeakSet();
  const queues = [];
  let stopped = false;
  let failed = false;
  let failureReason;
  let closePromise;
  const close = () => closePromise ??= (async () => {
    stopped = true;
    for (const queue of queues) queue.stop();
    await Promise.allSettled([...captures.values()].map((capture) => capture.close()));
    await Promise.allSettled(browsers.map(disconnect));
  })();
  const fail = (reason = "observer-unavailable") => {
    if (stopped || failed) return;
    const safeReason = ["admin-disconnected", "policy-blocked"].includes(reason) ? reason : "observer-unavailable";
    failureReason = safeReason;
    failed = true; emit({ type: "failure", reason: safeReason, message: safeReason === "policy-blocked" ? "Synchronization paused for independent manual control on this page" : "Browser mirroring stopped because the Admin observer became unavailable" });
    void close();
  };
  try {
    const connected = await Promise.allSettled([configuration.admin, ...configuration.followers].map(async (profile) => {
      const browser = await connect(profile); browsers.push(browser); return browser;
    }));
    if (connected.some((result) => result.status === "rejected")) throw new Error("browser connection unavailable");
    const browserFor = connected.map((result) => result.value);
    const admin = browserFor[0];
    const context = admin.contexts()[0];
    if (!context) throw new Error("Admin context unavailable");
    for (let index = 0; index < configuration.followers.length; index++) {
      const follower = configuration.followers[index];
      const browser = browserFor[index + 1];
      const context = browser.contexts()[0];
      if (!context) throw new Error("follower context unavailable");
      const pages = new Map();
      const queue = new FollowerQueue(async (action) => {
        if (configuration.policy?.pacing === "paced") await new Promise((resolve) => setTimeout(resolve, 450 + Math.floor(Math.random() * 1301)));
        if (!stopped) await applyMirrorAction(context, pages, action, configuration.policy);
      }, (reason) => emit({ type: "follower-error", profileId: follower.id, reason }), MAX_QUEUE, () => !browser.isConnected());
      queues.push(queue);
      browser.on("disconnected", () => queue.fail("follower-disconnected"));
    }
    const broadcast = (action) => {
      if (stopped || configuration.policy?.pausedProfileIds.includes(configuration.admin.id)) return;
      if (configuration.policy) {
        const value = action.type === "navigate" ? action.url : action.sourceUrl;
        const url = isWebUrl(value) ? new URL(value) : null;
        if (!url || !configuration.policy.origins.includes(url.origin) || sensitivePathPattern.test(url.pathname)) {
          if (!action.initial) fail("policy-blocked");
          return;
        }
      }
      queues.forEach((queue, index) => { if (!configuration.policy?.pausedProfileIds.includes(configuration.followers[index].id)) queue.enqueue(action); });
    };
    let nextPageId = 0;
    const attachPage = async (page, initial = false) => {
      if (stopped || claimedPages.has(page)) return;
      claimedPages.add(page);
      const pageId = nextPageId++;
      const token = randomUUID().replaceAll("-", "");
      const worldName = `gamebrowser_sync_${token}`;
      const bindingName = `__gamebrowser_sync_${token}`;
      const cleanupName = `${bindingName}_cleanup`;
      const capturePolicy = configuration.policy ? { origins: configuration.policy.origins, paused: configuration.policy.pausedProfileIds.includes(configuration.admin.id), sensitiveTargetSource: sensitiveTargetPattern.source, sensitivePathSource: sensitivePathPattern.source } : null;
      const source = `(${installTrustedCapture.toString()})(${JSON.stringify(bindingName)},${JSON.stringify(cleanupName)},${JSON.stringify(capturePolicy)},${sensitiveControl.toString()})`;
      const session = await context.newCDPSession(page);
      const contexts = new Map();
      const framePaths = new Map();
      let scriptId;
      let rootFrameId;
      let lastDocumentUrl = page.url();
      const rendererUrls = new Set();
      const rendererLoaders = new Set();
      const documentRequests = new Map();
      let refreshPromise;
      const refreshFrames = () => refreshPromise ??= session.send("Page.getFrameTree").then(({ frameTree }) => {
        framePaths.clear();
        rootFrameId = frameTree.frame.id;
        const visit = (tree, path) => { framePaths.set(tree.frame.id, path); (tree.childFrames ?? []).forEach((child, index) => visit(child, [...path, index])); };
        visit(frameTree, []);
      }).finally(() => { refreshPromise = undefined; });
      const onContext = ({ context }) => {
        if (context.name === worldName && context.auxData?.frameId) contexts.set(context.id, context.auxData.frameId);
      };
      const onBinding = ({ name, payload, executionContextId }) => {
        if (stopped || name !== bindingName || !contexts.has(executionContextId)) return;
        if (typeof payload !== "string" || payload.length > 150_000) { fail(); return; }
        try {
          const captured = JSON.parse(payload);
          if (captured.type === "policy-pause" && configuration.policy) { fail("policy-blocked"); return; }
          const action = normalizeMirrorAction(captured);
          if (!isWebUrl(captured.sourceUrl)) { fail(); return; }
          const framePath = framePaths.get(contexts.get(executionContextId));
          if (!framePath) { fail(); return; }
          broadcast({ ...action, pageId, framePath, sourceUrl: captured.sourceUrl });
        } catch { fail(); }
      };
      const onNavigationRequested = ({ frameId, url, disposition }) => {
        if (frameId !== rootFrameId || disposition !== "currentTab") return;
        rendererUrls.add(url);
        const loaderId = documentRequests.get(url);
        if (loaderId) {
          rendererLoaders.add(loaderId);
          if (rendererLoaders.size > 32) rendererLoaders.delete(rendererLoaders.values().next().value);
        }
        if (rendererUrls.size > 32) rendererUrls.delete(rendererUrls.values().next().value);
      };
      const onDocumentRequest = ({ frameId, type, request, loaderId }) => {
        if (frameId !== rootFrameId || type !== "Document") return;
        documentRequests.set(request.url, loaderId);
        if (documentRequests.size > 32) documentRequests.delete(documentRequests.keys().next().value);
        if (rendererUrls.has(request.url) || request.method === "POST") {
          rendererLoaders.add(loaderId);
          if (rendererLoaders.size > 32) rendererLoaders.delete(rendererLoaders.values().next().value);
        }
      };
      const onNavigationCommitted = ({ frame }) => {
        if (stopped || frame.parentId) return;
        // Renderer navigation comes from the click/key already replayed on each
        // follower. Track its loader through redirects rather than copying an
        // Admin account's redirected URL (or submitting the same form twice).
        const replayedByAction = rendererLoaders.has(frame.loaderId);
        rendererLoaders.delete(frame.loaderId);
        rendererUrls.clear();
        documentRequests.clear();
        // Chromium reports a committed document's fragment separately.
        const destination = isWebUrl(frame.url) ? new URL(frame.url) : null;
        if (destination && typeof frame.urlFragment === "string") destination.hash = frame.urlFragment;
        lastDocumentUrl = destination?.href ?? frame.url;
        if (!replayedByAction && destination) broadcast({ type: "navigate", pageId, url: destination.href });
      };
      const onNavigationScheduled = (event) => onNavigationRequested({ ...event, disposition: "currentTab" });
      const onSameDocumentNavigation = ({ frameId, url, navigationType }) => {
        if (stopped || frameId !== rootFrameId) return;
        const previous = lastDocumentUrl;
        lastDocumentUrl = url;
        const replayedByAction = rendererUrls.delete(url);
        // Hash links and renderer routers already ran independently through
        // the mirrored click/key, keeping each account's own query tokens.
        if (replayedByAction || navigationType === "historyApi" || !isWebUrl(url)) return;
        const source = new URL(url);
        const before = isWebUrl(previous) ? new URL(previous) : null;
        const fragmentOnly = !!before && before.origin === source.origin && before.pathname === source.pathname && before.search === source.search;
        broadcast({ type: "navigate", pageId, url, ...(fragmentOnly ? { fragmentOnly: true } : {}) });
      };
      const onFrameChange = () => {
        if (!stopped) void refreshFrames().catch(() => {
          if (!page.isClosed() && admin.isConnected()) fail();
        });
      };
      const onDestroyed = ({ executionContextId }) => contexts.delete(executionContextId);
      const capture = {
        async close() {
          session.off("Page.frameRequestedNavigation", onNavigationRequested);
          session.off("Page.frameScheduledNavigation", onNavigationScheduled);
          session.off("Network.requestWillBeSent", onDocumentRequest);
          session.off("Page.frameNavigated", onNavigationCommitted);
          session.off("Page.navigatedWithinDocument", onSameDocumentNavigation);
          session.off("Runtime.bindingCalled", onBinding);
          session.off("Runtime.executionContextCreated", onContext);
          session.off("Runtime.executionContextDestroyed", onDestroyed);
          session.off("Page.frameAttached", onFrameChange);
          session.off("Page.frameDetached", onFrameChange);
          session.off("Page.frameNavigated", onFrameChange);
          if (scriptId) await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }).catch(() => {});
          await Promise.allSettled([...contexts.keys()].map((contextId) => session.send("Runtime.evaluate", { expression: `globalThis[${JSON.stringify(cleanupName)}]?.()`, contextId })));
          await session.send("Runtime.removeBinding", { name: bindingName }).catch(() => {});
          await session.detach().catch(() => {});
        },
      };
      captures.set(page, capture);
      session.on("Runtime.executionContextCreated", onContext);
      session.on("Runtime.executionContextDestroyed", onDestroyed);
      session.on("Runtime.bindingCalled", onBinding);
      session.on("Page.frameAttached", onFrameChange);
      session.on("Page.frameDetached", onFrameChange);
      session.on("Page.frameNavigated", onFrameChange);
      session.on("Page.frameRequestedNavigation", onNavigationRequested);
      session.on("Page.frameScheduledNavigation", onNavigationScheduled);
      session.on("Network.requestWillBeSent", onDocumentRequest);
      session.on("Page.frameNavigated", onNavigationCommitted);
      session.on("Page.navigatedWithinDocument", onSameDocumentNavigation);
      await session.send("Page.enable");
      await session.send("Network.enable");
      await session.send("Runtime.enable");
      await session.send("Runtime.addBinding", { name: bindingName, executionContextName: worldName });
      ({ identifier: scriptId } = await session.send("Page.addScriptToEvaluateOnNewDocument", { source, worldName }));
      await refreshFrames();
      for (const [frameId] of framePaths) {
        const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId, worldName });
        contexts.set(executionContextId, frameId);
        await session.send("Runtime.evaluate", { expression: source, contextId: executionContextId });
      }
      if ((!initial || configuration.alignOnStart !== false) && isWebUrl(page.url())) broadcast({ type: "navigate", pageId, url: page.url(), ...(initial ? { initial: true } : {}) });
      page.once("close", () => { captures.delete(page); void capture.close(); });
    };
    const onPage = (page) => { void attachPage(page).catch(() => { if (!page.isClosed()) fail(admin.isConnected() ? "observer-unavailable" : "admin-disconnected"); }); };
    context.on("page", onPage);
    const onAdminDisconnected = () => fail("admin-disconnected");
    admin.on("disconnected", onAdminDisconnected);
    await Promise.all(context.pages().map((page) => attachPage(page, true)));
    if (stopped || queues.some((queue) => queue.failed)) throw new Error("observer stopped");
    emit({ type: "ready" });
    return { close: async () => { context.off("page", onPage); admin.off("disconnected", onAdminDisconnected); await close(); } };
  } catch {
    await close();
    const error = new Error("Browser mirroring could not connect to all selected browsers");
    error.reason = failureReason ?? "connection-unavailable";
    throw error;
  }
}

/** @param {import("node:stream").Readable} [input] @param {import("node:stream").Writable} [output] */
export async function runWorker(input = process.stdin, output = process.stdout) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let session;
  let starting;
  let stopped = false;
  const emit = (event) => output.write(`${JSON.stringify(event)}\n`);
  const stop = async () => {
    stopped = true;
    if (starting) await starting.catch(() => {});
    await session?.close();
  };
  try {
    for await (const line of lines) {
      if (line.length > 65_536) throw new Error("invalid worker command");
      const command = JSON.parse(line);
      if (command.type === "stop") break;
      if (starting || command.type !== "start") throw new Error("invalid worker command");
      validateSyncConfiguration(command);
      starting = createMirrorSession(command, { emit: (event) => { if (!stopped) emit(event); } }).then(async (value) => {
        session = value;
        if (stopped) await session.close();
      });
      // Keep reading stop/EOF while the browsers connect.
      starting.catch((error) => { if (!stopped) { emit({ type: "failure", reason: error?.reason === "policy-blocked" ? "policy-blocked" : "connection-unavailable", message: "Browser mirroring could not connect to all selected browsers" }); lines.close(); } });
    }
  } catch {
    if (!stopped) emit({ type: "failure", reason: "invalid-command", message: "Browser mirroring received an invalid command" });
  } finally {
    await stop();
    lines.close();
    input.pause?.();
    input.unref?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runWorker();
}
