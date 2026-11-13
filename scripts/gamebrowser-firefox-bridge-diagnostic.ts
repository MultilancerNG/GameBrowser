/** Bounded, real-engine Windows diagnostic; this does not replace the installed release gate. */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildNewProfile } from "../create.ts";
import { callFirefoxOwner, closeFirefoxOwner, reserveFirefoxOwner, startFirefoxOwner } from "../firefox-runtime.ts";
import { Launcher } from "../launcher.ts";
import { resolvePlaywrightRuntime } from "../playwright-runtime.ts";
import { ProfileStore } from "../store.ts";
import { withDesktopScreen } from "../workspace/displayPolicy.ts";
import { jpegDimensions } from "../workspace/protocol.ts";

type Geometry = Record<string, number | null>;
type Failure = { name: string; code?: string; message: string; stack?: string };
const geometryKeys = ["screen.width", "screen.height", "screen.availWidth", "screen.availHeight", "window.innerWidth", "window.innerHeight", "window.outerWidth", "window.outerHeight"];
const reportPath = resolve(process.argv[2] ?? "artifacts/firefox-bridge-diagnostic.json");
const report: { version: number; platform: string; cases: Array<Record<string, unknown>>; failure?: Failure } = { version: 1, platform: process.platform, cases: [] };
let activeStage = "environment";

function failure(error: unknown): Failure {
  const value = error instanceof Error ? error : new Error("Diagnostic operation failed");
  // Fresh test data only; still remove private local endpoints and random protocol credentials.
  const scrub = (text: string) => text.replace(/(?:https?|wss?):\/\/[^\s<>"')\]]+/gi, "[local endpoint redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  const code = (value as Error & { code?: unknown }).code;
  return { name: value.name.slice(0, 80), ...(typeof code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? { code } : {}),
    message: scrub(value.message).slice(0, 3000), ...(value.stack ? { stack: scrub(value.stack).slice(0, 6000) } : {}) };
}
async function bounded<T>(operation: Promise<T>, ms: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { const error = new Error(`${stage} exceeded its ${ms} ms diagnostic bound`); error.name = "DiagnosticTimeout"; reject(error); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
function configGeometry(config: Record<string, unknown>): Geometry {
  return Object.fromEntries(geometryKeys.map(key => [key, typeof config[key] === "number" ? config[key] as number : null]));
}
function publicNumbers(value: unknown): Geometry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry === null || typeof entry === "number" && Number.isFinite(entry))) as Geometry;
}
function publishSummary(row: Record<string, unknown>, cleanupConfirmed: boolean): void {
  const name = (row.failure as Failure | undefined)?.name;
  const summary = { diagnostic: "firefox-bridge", case: row.kind, savedScreen: publicNumbers(row.savedScreen),
    success: row.success === true, stage: row.failedStage ?? "complete",
    code: name && ["Error", "TimeoutError", "DiagnosticTimeout", "TargetClosedError"].includes(name) ? name : name ? "OperationError" : "ok",
    runtimeGeometry: publicNumbers(row.runtimeGeometry), beforeGeometry: publicNumbers(row.beforeGeometry),
    requestedViewport: publicNumbers(row.requestedViewport), afterGeometry: publicNumbers(row.afterGeometry),
    jpeg: publicNumbers(row.jpeg), ownedCleanupConfirmed: cleanupConfirmed };
  const safe = JSON.stringify(summary);
  console.log(safe);
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::notice title=Firefox bridge viewport diagnostic::${safe.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function runCase(kind: "saved-screen" | "effective-content", screen: { width: number; height: number }, binary: string, sha256: string): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-firefox-bridge-"));
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const row: Record<string, unknown> = { kind, savedScreen: screen, stages: [], nativeExecutableVerified: true, productionIdentityGates: true };
  report.cases.push(row);
  const stages = row.stages as string[];
  let runtimeConfig: Record<string, unknown> = {};
  let browser: any;
  let profileId: string | undefined;
  let viewportPending: Promise<void> | undefined;
  let cleanupConfirmed = false;
  const launcher = new Launcher({
    store, dataRoot: join(root, "profiles"), firefoxBinaryPath: binary, expectedFirefoxBinarySha256: sha256,
    headless: true, log: () => {}, cdpReadyTimeoutMs: 25_000, teardownTimeoutMs: 5000,
    firefoxRuntime: { reserve: reserveFirefoxOwner, call: callFirefoxOwner, close: closeFirefoxOwner,
      start: (input, hooks) => { runtimeConfig = input.config; return startFirefoxOwner(input, hooks); } },
  });
  let fixture: ReturnType<typeof Bun.serve> | undefined;
  try {
    activeStage = "profile";
    const generated = buildNewProfile({ name: "Firefox bridge diagnostic", engine: "firefox", platformOs: "windows", screen: `${screen.width}x${screen.height}` }, () => false);
    const profile = withDesktopScreen(generated, screen);
    profileId = profile.id;
    store.upsertProfile(profile);
    row.savedGeometry = configGeometry(profile.firefox!.config);
    fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>Firefox bridge diagnostic</title><style>body{margin:0;background:#173226;color:#fff}button{width:100%;height:180px}</style><button>Owned viewport fixture</button>", { headers: { "content-type": "text/html; charset=utf-8" } }) });

    activeStage = "owner-start";
    await bounded(launcher.start(profileId, [], { headless: true, autoNavigate: false, restoreLastSession: false, restoreLocalSession: false }), 60_000, activeStage);
    stages.push(activeStage);
    row.runtimeGeometry = configGeometry(runtimeConfig);
    const launch = store.getLaunch(profileId);
    if (!launch?.firefoxOwner) throw new Error("Owned Firefox did not publish its private owner");
    activeStage = "owner-endpoint";
    const endpoint = await callFirefoxOwner<{ endpoint: string }>(launch.firefoxOwner, "playwright-endpoint", {}, { timeoutMs: 15_000 });
    stages.push(activeStage);
    const runtime = resolvePlaywrightRuntime();
    const playwright = await import(pathToFileURL(join(runtime.root, "node_modules", "playwright-core", "index.mjs")).href);
    activeStage = "bun-firefox-attach";
    browser = await bounded(playwright.firefox.connect(endpoint.endpoint, { timeout: 15000 }), 18_000, activeStage);
    stages.push(activeStage);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Owned Firefox has no persistent context");
    const page = context.pages()[0] ?? await bounded(context.newPage(), 10_000, "first-page");
    activeStage = "first-page-navigation";
    await bounded(page.goto(`http://127.0.0.1:${fixture.port}/`, { waitUntil: "domcontentloaded", timeout: 15000 }), 18_000, activeStage);
    stages.push(activeStage);
    activeStage = "before-viewport-geometry";
    row.beforeGeometry = await bounded(page.evaluate(() => ({ screenWidth: globalThis.screen.width, screenHeight: globalThis.screen.height,
      availWidth: globalThis.screen.availWidth, availHeight: globalThis.screen.availHeight, innerWidth, innerHeight, outerWidth, outerHeight,
      devicePixelRatio, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight })), 8000, activeStage);
    stages.push(activeStage);
    const width = kind === "saved-screen" ? screen.width : runtimeConfig["window.innerWidth"];
    const height = kind === "saved-screen" ? screen.height : runtimeConfig["window.innerHeight"];
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Number(width) < 1 || Number(height) < 1 || Number(width) > 4096 || Number(height) > 4096) throw new Error("Effective diagnostic viewport is outside its bounded dimensions");
    row.requestedViewport = { width, height };
    activeStage = "set-viewport";
    const started = Date.now();
    const viewportOperation = page.setViewportSize({ width: Number(width), height: Number(height) }) as Promise<void>;
    viewportPending = viewportOperation;
    viewportOperation.catch(error => { row.viewportUnderlyingError = failure(error); });
    try { await bounded(viewportOperation, 5000, activeStage); }
    finally { row.viewportElapsedMs = Date.now() - started; }
    stages.push(activeStage);
    activeStage = "after-viewport-geometry";
    row.afterGeometry = await bounded(page.evaluate(() => ({ innerWidth, innerHeight, outerWidth, outerHeight,
      devicePixelRatio, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight })), 8000, activeStage);
    stages.push(activeStage);
    activeStage = "jpeg-capture";
    const bytes = await bounded(page.screenshot({ type: "jpeg", quality: 55, fullPage: false, scale: "css", timeout: 8000 }) as Promise<Buffer>, 10_000, activeStage);
    row.jpeg = { ...jpegDimensions(bytes), bytes: bytes.length };
    stages.push(activeStage);
    row.success = true;
  } catch (error) {
    row.success = false; row.failedStage = activeStage; row.failure = failure(error);
  } finally {
    if (browser) await bounded(browser.close(), 4000, "attachment-close").catch(error => { row.attachmentCleanupError = failure(error); });
    if (profileId) {
      const current = store.getLaunch(profileId);
      cleanupConfirmed = await bounded(launcher.stop(profileId, current ? { startedAt: current.startedAt, debugPort: current.debugPort } : undefined), 15_000, "owned-stop").catch(error => { row.cleanupError = failure(error); return false; });
    } else cleanupConfirmed = true;
    fixture?.stop(true);
    row.ownedCleanupConfirmed = cleanupConfirmed;
    // Let the failed viewport operation report its native/transport rejection after exact close.
    if (viewportPending) await bounded(viewportPending.catch(() => {}), 1000, "viewport-retirement").catch(() => {});
    store.close();
    if (cleanupConfirmed) rmSync(root, { recursive: true, force: true });
    else row.retainedQuarantine = true;
  }
  publishSummary(row, cleanupConfirmed);
  return row;
}

try {
  if (process.platform !== "win32") throw new Error("This diagnostic requires the real Windows engine and Windows owner lifecycle");
  const binary = process.env.ALIASMODE_FIREFOX_BINARY_PATH;
  const expected = process.env.ALIASMODE_FIREFOX_BINARY_SHA256;
  if (!binary || !expected || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error("The approved native executable and pinned SHA-256 must be supplied");
  if (await hashFile(binary) !== expected.toLowerCase()) throw new Error("The native executable does not match its approved pin");
  await runCase("saved-screen", { width: 1280, height: 720 }, binary, expected.toLowerCase());
  await runCase("effective-content", { width: 1280, height: 720 }, binary, expected.toLowerCase());
  await runCase("effective-content", { width: 320, height: 200 }, binary, expected.toLowerCase());
  await runCase("effective-content", { width: 390, height: 844 }, binary, expected.toLowerCase());
  if (report.cases.some(row => row.kind === "effective-content" && row.success !== true || row.ownedCleanupConfirmed !== true)) process.exitCode = 1;
} catch (error) {
  report.failure = failure(error); process.exitCode = 1;
  const safe = JSON.stringify({ diagnostic: "firefox-bridge", stage: activeStage, code: report.failure.name === "Error" ? "Error" : "OperationError" });
  console.log(safe);
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::error title=Firefox bridge diagnostic prerequisite::${safe.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
} finally {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
