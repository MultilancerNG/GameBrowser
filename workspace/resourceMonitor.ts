/** Aggregate process-tree diagnostics with exact launch-generation ownership. */
import { spawn } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { cpus } from "node:os";
import { resolve } from "node:path";
import type { LaunchInfo } from "../types.ts";
import { windowsProcessScheduler, type ProcessScanControl } from "./windowsProcessScheduler.ts";
// @ts-expect-error Bun embeds this fixed PowerShell helper in the desktop sidecar.
import windowsScriptPath from "./helpers/resource-snapshot.ps1" with { type: "file" };

export interface ResourceProcess {
  pid: number;
  parentPid: number;
  startToken: string | null;
  createdAtMs?: number | null;
  executablePath: string;
  argv?: string[];
  commandLine?: string;
  /** CIM identity remains visible when native resource access is unavailable. */
  nativeVerified?: boolean;
  cpuSeconds: number | null;
  rssBytes: number | null;
}
export interface ResourceMetrics {
  profileId: string;
  generation: string;
  pid: number;
  verified: boolean;
  memoryMb: number | null;
  /** Percentage of this host's total logical-CPU capacity, sampled over time. */
  cpuPercent: number | null;
  processCount: number | null;
  sampledAt: number;
}
export type ResourceRowsFailureReason = "table-shape" | "row-count" | "row-shape" | "duplicate-pid" | "no-positive-pids";
export interface ResourceSnapshotDiagnostics {
  collector: "windows-cim";
  attemptedAt: number; durationMs: number; queueMs: number; timeoutMs: number;
  retryAt: number | null;
  outcome: "not-sampled" | "running" | "ok" | "timeout" | "queue-timeout" | "spawn-error" | "query-error" | "identity-error" | "exit-error" | "invalid-output" | "output-limit";
  scope: "complete" | "targeted"; requestedRootCount: number;
  recordCount: number; returnedRowCount: number | null; validationFailure: ResourceRowsFailureReason | null;
  unverifiedCount: number; candidateCount: number | null; probeCount: number | null; queryMs: number | null; nativeMs: number | null;
}
const WINDOWS_RESOURCE_TIMEOUT_MS = 12_000;
const FAILED_RESOURCE_BACKOFF_MS = 15_000;
let resourceDiagnostics: ResourceSnapshotDiagnostics = { collector: "windows-cim", attemptedAt: 0, durationMs: 0, queueMs: 0,
  timeoutMs: WINDOWS_RESOURCE_TIMEOUT_MS, retryAt: null, outcome: "not-sampled", scope: "complete", requestedRootCount: 0,
  recordCount: 0, returnedRowCount: null, validationFailure: null, unverifiedCount: 0, candidateCount: null, probeCount: null, queryMs: null, nativeMs: null };
/** Secret-free collector timings; no paths, arguments, or proxy credentials. */
export function readResourceSnapshotDiagnostics(): ResourceSnapshotDiagnostics { return { ...resourceDiagnostics }; }

function rootScope(roots?: readonly number[]): number[] | undefined {
  if (roots === undefined) return undefined;
  if (!Array.isArray(roots) || roots.length > 256 || roots.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)) throw new Error("Resource snapshot root IDs are invalid");
  return [...new Set(roots)].sort((a, b) => a - b);
}
/** Share only identical live scopes. In particular, targeted rows must never
 * satisfy a complete inspection used to confirm native process absence. */
export function createResourceSnapshotReader(
  collect: (roots?: readonly number[]) => Promise<ResourceProcess[] | null>,
  options: { backoffMs?: number; now?: () => number } = {},
): (roots?: readonly number[]) => Promise<ResourceProcess[] | null> {
  const inFlight = new Map<string, Promise<ResourceProcess[] | null>>(), failures = new Map<string, number>();
  const now = options.now ?? Date.now, backoff = Math.max(1, options.backoffMs ?? FAILED_RESOURCE_BACKOFF_MS);
  return roots => {
    const scope = rootScope(roots), key = scope === undefined ? "complete" : `roots:${scope.join(",")}`;
    const pending = inFlight.get(key); if (pending) return pending;
    if ((failures.get(key) ?? 0) > now()) return Promise.resolve(null);
    if (scope?.length === 0) return Promise.resolve([]);
    const task = Promise.resolve().then(() => collect(scope)).catch(() => null).then(rows => {
      if (rows === null) failures.set(key, now() + backoff); else failures.delete(key);
      for (const [oldKey, retryAt] of failures) if (retryAt <= now()) failures.delete(oldKey);
      if (failures.size > 256) failures.delete(failures.keys().next().value!);
      return rows;
    });
    inFlight.set(key, task);
    const clear = () => { if (inFlight.get(key) === task) inFlight.delete(key); }; task.then(clear, clear);
    return task;
  };
}
export function launchGeneration(launch: LaunchInfo): string {
  return `${launch.profileId}:${launch.debugPort}:${launch.startedAt}:${launch.pid}`;
}

/** CommandLineToArgvW-compatible tokenization, without evaluating the input. */
export function windowsArgv(raw: string): string[] {
  const argv: string[] = [];
  let value = "", quoted = false, active = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if ((ch === " " || ch === "\t") && !quoted) {
      if (active) { argv.push(value); value = ""; active = false; }
      continue;
    }
    active = true;
    if (ch === "\\") {
      let slashes = 1;
      while (raw[i + 1] === "\\") { slashes++; i++; }
      if (raw[i + 1] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        i++;
        if (slashes % 2) value += '"';
        else quoted = !quoted;
      } else value += "\\".repeat(slashes);
    } else if (ch === '"') quoted = !quoted;
    else value += ch;
  }
  if (active) argv.push(value);
  return argv;
}
function normalizedPath(path: string, windows: boolean): string {
  return windows ? path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase()
    : resolve(path.replace(/ \(deleted\)$/, ""));
}

export function ownedRoot(
  launch: LaunchInfo, records: readonly ResourceProcess[], windows = process.platform === "win32",
): ResourceProcess | null {
  if (launch.pid <= 0 || !launch.binaryPath || !launch.userDataDir) return null;
  const root = records.find((item) => item.pid === launch.pid);
  if (!root || !root.startToken || !root.executablePath
    || normalizedPath(root.executablePath, windows) !== normalizedPath(launch.binaryPath, windows)) return null;
  const args = root.argv ?? windowsArgv(root.commandLine ?? "");
  const sameArg = (candidate: string) => args.some((arg) => windows ? arg.toLowerCase() === candidate.toLowerCase() : arg === candidate);
  if (launch.engine === "firefox") {
    const index = args.indexOf("-profile");
    if (index < 0 || normalizedPath(args[index + 1] ?? "", windows) !== normalizedPath(launch.userDataDir, windows)) return null;
  } else if (!sameArg(`--remote-debugging-port=${launch.debugPort}`)
    || !sameArg(`--user-data-dir=${launch.userDataDir}`)) return null;
  if (launch.rootStartTime && root.startToken !== launch.rootStartTime) return null;
  // Initial Windows capture may follow a slow native launch. Bind to its saved
  // start window before pinning the exact creation token for all later samples.
  if (root.createdAtMs != null
    && (root.createdAtMs < launch.startedAt - 2_000 || root.createdAtMs > launch.startedAt + 180_000)) return null;
  return root;
}
export function ownedProcessTree(root: ResourceProcess, records: readonly ResourceProcess[]): ResourceProcess[] {
  const result = new Map<number, ResourceProcess>([[root.pid, root]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (result.has(record.pid) || !record.startToken) continue;
      const parent = result.get(record.parentPid);
      if (!parent) continue;
      if (record.createdAtMs != null && parent.createdAtMs != null && record.createdAtMs < parent.createdAtMs) continue;
      result.set(record.pid, record); changed = true;
    }
  }
  return [...result.values()];
}

async function windowsSnapshot(roots?: readonly number[]): Promise<ResourceProcess[] | null> {
  const queuedAt = Date.now(); let began = false;
  const result = await windowsProcessScheduler.schedule("resources", async (control) => {
    began = true; return windowsSnapshotUnscheduled(roots, Date.now() - queuedAt, control);
  }, 12_000);
  if (!began) resourceDiagnostics = { collector: "windows-cim", attemptedAt: queuedAt, durationMs: 0, queueMs: Date.now() - queuedAt,
    timeoutMs: WINDOWS_RESOURCE_TIMEOUT_MS, retryAt: Date.now() + FAILED_RESOURCE_BACKOFF_MS, outcome: "queue-timeout",
    scope: roots === undefined ? "complete" : "targeted", requestedRootCount: roots?.length ?? 0,
    recordCount: 0, returnedRowCount: null, validationFailure: null, unverifiedCount: 0, candidateCount: null, probeCount: null, queryMs: null, nativeMs: null };
  return result;
}
async function windowsSnapshotUnscheduled(roots: readonly number[] | undefined, queueMs: number, control: ProcessScanControl): Promise<ResourceProcess[] | null> {
  const started = Date.now();
  resourceDiagnostics = { collector: "windows-cim", attemptedAt: started, durationMs: 0, timeoutMs: WINDOWS_RESOURCE_TIMEOUT_MS,
    queueMs, retryAt: null, outcome: "running", scope: roots === undefined ? "complete" : "targeted", requestedRootCount: roots?.length ?? 0,
    recordCount: 0, returnedRowCount: null, validationFailure: null, unverifiedCount: 0, candidateCount: null, probeCount: null, queryMs: null, nativeMs: null };
  const script = await Bun.file(windowsScriptPath).text();
  if (control.signal.aborted) return null;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return await new Promise((complete) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    let confirmExit!: () => void;
    const exited = new Promise<void>(done => { confirmExit = done; });
    control.ownHelper(() => { child.kill(); }, exited);
    let output = "", done = false;
    const diagnostic = { ...resourceDiagnostics };
    const finish = (rows: ResourceProcess[] | null, outcome: ResourceSnapshotDiagnostics["outcome"]) => {
      if (done) return; done = true; clearTimeout(timer);
      resourceDiagnostics = { ...diagnostic, durationMs: Date.now() - started, outcome, recordCount: rows?.length ?? 0,
        retryAt: outcome === "ok" ? null : Date.now() + FAILED_RESOURCE_BACKOFF_MS,
        unverifiedCount: rows?.filter(row => row.nativeVerified === false).length ?? 0 }; complete(rows);
    };
    const timer = setTimeout(() => { child.kill(); finish(null, "timeout"); }, WINDOWS_RESOURCE_TIMEOUT_MS);
    child.once("error", () => finish(null, "spawn-error"));
    child.stdin.on("error", () => { child.kill(); finish(null, "spawn-error"); });
    child.stdin.end(JSON.stringify({ roots: roots ?? null }));
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString("utf8");
      if (Buffer.byteLength(output) > 8 * 1024 * 1024) { child.kill(); finish(null, "output-limit"); }
    });
    child.once("close", (code) => {
      confirmExit();
      if (code !== 0) return finish(null, code === 2 ? "query-error" : code === 4 ? "identity-error" : "exit-error");
      try {
        const raw = JSON.parse(output.replace(/^\uFEFF/, ""));
        if (!raw || !Number.isSafeInteger(raw.candidateCount) || raw.candidateCount < 1
          || !Number.isSafeInteger(raw.probeCount) || raw.probeCount < 0 || raw.probeCount > raw.candidateCount
          || !Number.isFinite(raw.queryMs) || raw.queryMs < 0 || !Number.isFinite(raw.nativeMs) || raw.nativeMs < 0) return finish(null, "invalid-output");
        diagnostic.candidateCount = raw.candidateCount; diagnostic.probeCount = raw.probeCount; diagnostic.queryMs = raw.queryMs; diagnostic.nativeMs = raw.nativeMs;
        diagnostic.returnedRowCount = Array.isArray(raw.rows) ? raw.rows.length : null;
        const rows = parseWindowsResourceRows(raw.rows, raw.candidateCount, roots, reason => { diagnostic.validationFailure = reason; });
        if (!rows) return finish(null, "identity-error");
        finish(rows, "ok");
      } catch { finish(null, "invalid-output"); }
    });
  });
}
/** Complete CIM tables must retain every observed positive PID, including
 * inaccessible processes. Malformed or truncated rows cannot prove absence. */
export function parseWindowsResourceRows(
  raw: unknown, candidateCount: number, roots?: readonly number[], onFailure?: (reason: ResourceRowsFailureReason) => void,
): ResourceProcess[] | null {
  const fail = (reason: ResourceRowsFailureReason): null => { onFailure?.(reason); return null; };
  if (!Array.isArray(raw) || raw.length > 32768 || !Number.isSafeInteger(candidateCount) || candidateCount < 1) return fail("table-shape");
  if (raw.length > candidateCount || (roots === undefined && raw.length !== candidateCount)) return fail("row-count");
  const rows: ResourceProcess[] = [], seen = new Set<number>();
  for (const value of raw) {
    // Windows' idle PID is not a terminable process; validate its metadata too.
    if (value?.pid === 0 && validRecord({ ...value, pid: 1 })) continue;
    if (!validRecord(value)) return fail("row-shape");
    if (seen.has(value.pid)) return fail("duplicate-pid");
    seen.add(value.pid); rows.push(value);
  }
  if (roots === undefined && !rows.length) return fail("no-positive-pids");
  // Inaccessible or exiting processes may retain arguments but lose their
  // executable path. Keep the observed PID; ownedRoot still refuses ownership,
  // and complete cleanup inspections still see occupancy rather than absence.
  return rows;
}
function validRecord(value: unknown): value is ResourceProcess {
  if (!value || typeof value !== "object") return false;
  const row = value as ResourceProcess;
  return Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.parentPid)
    && ((typeof row.startToken === "string" && !!row.startToken) || (row.nativeVerified === false && row.startToken === null))
    && typeof row.executablePath === "string" && typeof row.commandLine === "string"
    && (row.createdAtMs === undefined || (row.createdAtMs === null && row.nativeVerified === false) || (typeof row.createdAtMs === "number" && Number.isFinite(row.createdAtMs) && row.createdAtMs >= 0))
    && ((row.nativeVerified === false && row.cpuSeconds === null && row.rssBytes === null)
      || (row.nativeVerified !== false && typeof row.cpuSeconds === "number" && Number.isFinite(row.cpuSeconds) && row.cpuSeconds >= 0
        && typeof row.rssBytes === "number" && Number.isFinite(row.rssBytes) && row.rssBytes >= 0));
}

/** Parse /proc fields after the final ')' because process names contain spaces. */
export function linuxStat(raw: string, clockTicks = 100, pageSize = 4096): Pick<ResourceProcess, "parentPid" | "startToken" | "cpuSeconds" | "rssBytes"> | null {
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]), start = fields[19], cpu = (Number(fields[11]) + Number(fields[12])) / clockTicks;
  const rss = Number(fields[21]) * pageSize;
  if (!Number.isSafeInteger(ppid) || !start || !/^\d+$/.test(start) || !Number.isFinite(cpu) || cpu < 0 || !Number.isFinite(rss) || rss < 0) return null;
  return { parentPid: ppid, startToken: start, cpuSeconds: cpu, rssBytes: rss };
}
let linuxClockTicks = 100;
let linuxPageSize = 4096;
let linuxClockChecked = false;
async function checkLinuxClock(): Promise<void> {
  if (linuxClockChecked) return;
  linuxClockChecked = true;
  await new Promise<void>((done) => {
    const child = spawn("getconf", ["-a"], { stdio: ["ignore", "pipe", "ignore"] });
    let raw = "";
    const timer = setTimeout(() => { child.kill(); done(); }, 1_000);
    child.stdout.on("data", (bytes: Buffer) => { raw += bytes.toString(); });
    child.once("error", () => { clearTimeout(timer); done(); });
    child.once("close", () => {
      const ticks = Number(raw.match(/^CLK_TCK\s+(\d+)/m)?.[1]);
      const pageSize = Number(raw.match(/^PAGESIZE\s+(\d+)/m)?.[1]);
      if (Number.isFinite(ticks) && ticks > 0) linuxClockTicks = ticks;
      if (Number.isFinite(pageSize) && pageSize > 0) linuxPageSize = pageSize;
      clearTimeout(timer); done();
    });
  });
}
async function linuxSnapshot(): Promise<ResourceProcess[] | null> {
  try {
    await checkLinuxClock();
    const bootSeconds = Number((await readFile("/proc/stat", "utf8")).match(/^btime\s+(\d+)/m)?.[1]);
    if (!Number.isFinite(bootSeconds)) return null;
    const deadline = Date.now() + 8_000;
    const entries = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    if (entries.length > 32768) return null;
    const rows: ResourceProcess[] = [];
    // Bounded read batches avoid creating thousands of concurrent descriptors.
    for (let offset = 0; offset < entries.length; offset += 32) {
      if (Date.now() > deadline) return null;
      await Promise.all(entries.slice(offset, offset + 32).map(async (entry) => {
        try {
          const before = linuxStat(await readFile(`/proc/${entry}/stat`, "utf8"), linuxClockTicks, linuxPageSize);
          if (!before) return;
          const [cmd, executablePath] = await Promise.all([readFile(`/proc/${entry}/cmdline`), readlink(`/proc/${entry}/exe`)]);
          const after = linuxStat(await readFile(`/proc/${entry}/stat`, "utf8"), linuxClockTicks, linuxPageSize);
          if (!after || before.startToken !== after.startToken) return;
          rows.push({ pid: Number(entry), executablePath, argv: cmd.toString().split("\0").filter(Boolean),
            createdAtMs: bootSeconds * 1000 + Number(after.startToken) / linuxClockTicks * 1000, ...after });
        } catch { /* Exited or inaccessible process contributes no verified record. */ }
      }));
    }
    return rows;
  } catch { return null; }
}
async function collectResourceSnapshot(roots?: readonly number[]): Promise<ResourceProcess[] | null> {
  if (process.platform === "win32") {
    try { return await windowsSnapshot(roots); }
    catch { resourceDiagnostics = { ...resourceDiagnostics, outcome: "spawn-error", durationMs: Date.now() - resourceDiagnostics.attemptedAt }; return null; }
  }
  if (process.platform === "linux") return linuxSnapshot();
  // Platform without exact executable + creation-token sampling is unavailable,
  // never represented as a misleading zero or used for an arbitrary PID kill.
  return null;
}
export const readResourceSnapshot = createResourceSnapshotReader(collectResourceSnapshot);

export interface ResourceMonitorOptions {
  launches: () => LaunchInfo[];
  onMetrics: (metrics: ResourceMetrics[]) => void;
  readSnapshot?: (roots?: readonly number[]) => Promise<ResourceProcess[] | null>;
  intervalMs?: number;
  windows?: boolean;
  logicalCpus?: number;
  now?: () => number;
}
export class ResourceMonitor {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private busy: Promise<ResourceMetrics[]> | null = null;
  private roots = new Map<string, string>();
  private previous = new Map<string, { at: number; cpuSeconds: number }>();
  constructor(private readonly options: ResourceMonitorOptions) {}
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = async () => {
      await this.sample().catch(() => {});
      if (!this.stopped) this.timer = setTimeout(tick, Math.max(1_000, this.options.intervalMs ?? 2_500));
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref?.();
  }
  sample(): Promise<ResourceMetrics[]> {
    if (this.busy) return this.busy;
    this.busy = this.doSample().finally(() => { this.busy = null; });
    return this.busy;
  }
  private async doSample(): Promise<ResourceMetrics[]> {
    const launches = this.options.launches();
    const active = new Set(launches.map(launchGeneration));
    for (const key of this.roots.keys()) if (!active.has(key)) this.roots.delete(key);
    if (!launches.length) { this.previous.clear(); return []; }
    const snapshot = await (this.options.readSnapshot ?? readResourceSnapshot)(launches.filter(launch => launch.pid > 0).map(launch => launch.pid));
    const now = (this.options.now ?? Date.now)();
    const nextPrevious = new Map<string, { at: number; cpuSeconds: number }>();
    const metrics = launches.map((launch): ResourceMetrics => {
      const generation = launchGeneration(launch);
      const empty: ResourceMetrics = { profileId: launch.profileId, generation, pid: launch.pid, verified: false, memoryMb: null, cpuPercent: null, processCount: null, sampledAt: now };
      if (!snapshot) return empty;
      const root = ownedRoot(launch, snapshot, this.options.windows);
      if (!root || !root.startToken || (this.roots.has(generation) && this.roots.get(generation) !== root.startToken)) return empty;
      const tree = ownedProcessTree(root, snapshot);
      const ownedIds = new Set(tree.map(row => row.pid));
      if (snapshot.some(row => !row.startToken && ownedIds.has(row.parentPid))) return empty;
      const measured = tree.filter((row): row is ResourceProcess & { startToken: string; cpuSeconds: number; rssBytes: number } => row.nativeVerified !== false && !!row.startToken
        && typeof row.cpuSeconds === "number" && Number.isFinite(row.cpuSeconds) && row.cpuSeconds >= 0
        && typeof row.rssBytes === "number" && Number.isFinite(row.rssBytes) && row.rssBytes >= 0);
      // A partial process tree is not a measured total. Identity rows remain
      // available for cleanup proofs but never become fabricated zero counters.
      if (measured.length !== tree.length) return empty;
      this.roots.set(generation, root.startToken);
      let cpuPercent = 0, hasPrior = false;
      for (const row of measured) {
        const key = `${generation}:${row.pid}:${row.startToken}`;
        const prior = this.previous.get(key);
        nextPrevious.set(key, { at: now, cpuSeconds: row.cpuSeconds });
        if (prior && now > prior.at && row.cpuSeconds >= prior.cpuSeconds) {
          hasPrior = true;
          cpuPercent += (row.cpuSeconds - prior.cpuSeconds) / ((now - prior.at) / 1000) * 100;
        }
      }
      return { ...empty, verified: true, processCount: measured.length, memoryMb: measured.reduce((sum, row) => sum + row.rssBytes, 0) / 1024 / 1024,
        cpuPercent: hasPrior ? Math.min(100, Math.max(0, cpuPercent / Math.max(1, this.options.logicalCpus ?? cpus().length))) : null };
    });
    this.previous = nextPrevious;
    if (!this.stopped) this.options.onMetrics(metrics);
    return metrics;
  }
  dispose(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.roots.clear(); this.previous.clear(); }
}
