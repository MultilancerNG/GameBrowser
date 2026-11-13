import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createResourceSnapshotReader, linuxStat, ownedProcessTree, ownedRoot, parseWindowsResourceRows, readResourceSnapshot, ResourceMonitor, windowsArgv, type ResourceProcess } from "./resourceMonitor.ts";
import type { LaunchInfo } from "../types.ts";

const launch: LaunchInfo = { profileId: "profile_one", pid: 110, debugPort: 9222, startedAt: 1700000000000, ws: "ws://127.0.0.1:9222",
  binaryPath: "C:\\StakeMode\\chrome.exe", userDataDir: "C:\\StakeMode\\Profile One", headless: true };
function root(overrides: Partial<ResourceProcess> = {}): ResourceProcess {
  return { pid: 110, parentPid: 1, startToken: "500", createdAtMs: launch.startedAt + 200, executablePath: launch.binaryPath!,
    commandLine: '"C:\\StakeMode\\chrome.exe" --remote-debugging-port=9222 "--user-data-dir=C:\\StakeMode\\Profile One"', cpuSeconds: 3, rssBytes: 100 * 1024 * 1024, ...overrides };
}
test("exact Windows argument parsing respects quoted paths and escaped literals", () => {
  expect(windowsArgv(root().commandLine!)).toEqual(["C:\\StakeMode\\chrome.exe", "--remote-debugging-port=9222", "--user-data-dir=C:\\StakeMode\\Profile One"]);
  expect(windowsArgv('tool.exe "" "value\\\"with quote"')).toEqual(["tool.exe", "", 'value"with quote']);
  expect(ownedRoot(launch, [root()], true)?.pid).toBe(110);
  expect(ownedRoot(launch, [root({ commandLine: root().commandLine!.replace("9222", "92220") })], true)).toBeNull();
  expect(ownedRoot(launch, [root({ executablePath: "C:\\Other\\chrome.exe" })], true)).toBeNull();
  expect(ownedRoot(launch, [root({ createdAtMs: launch.startedAt - 10000 })], true)).toBeNull();
});
test("process-tree metrics sum descendants without sibling or recycled-parent contamination", () => {
  const records = [root(), root({ pid: 111, parentPid: 110, createdAtMs: launch.startedAt + 300, startToken: "501", rssBytes: 50 * 1024 * 1024 }),
    root({ pid: 112, parentPid: 111, createdAtMs: launch.startedAt + 400, startToken: "502", rssBytes: 20 * 1024 * 1024 }),
    root({ pid: 113, parentPid: 110, createdAtMs: launch.startedAt - 1000, startToken: "200" }), root({ pid: 120, parentPid: 1, startToken: "503" })];
  expect(ownedProcessTree(records[0]!, records).map((record) => record.pid)).toEqual([110, 111, 112]);
});
test("CPU uses cumulative deltas and creation-token reuse fails closed", async () => {
  let now = launch.startedAt + 1000, row = root(), generation = { ...launch };
  const monitor = new ResourceMonitor({ launches: () => [generation], onMetrics() {}, readSnapshot: async () => [row], windows: true, logicalCpus: 4, now: () => now });
  expect((await monitor.sample())[0]).toMatchObject({ verified: true, memoryMb: 100, cpuPercent: null, processCount: 1 });
  now += 2000; row = root({ cpuSeconds: 7 });
  expect((await monitor.sample())[0]?.cpuPercent).toBe(50);
  now += 2000; row = root({ startToken: "reused", cpuSeconds: 1 });
  expect((await monitor.sample())[0]).toMatchObject({ verified: false, memoryMb: null, cpuPercent: null });
  generation = { ...launch, startedAt: launch.startedAt + 1000 }; row = root({ createdAtMs: generation.startedAt, startToken: "new_generation" });
  expect((await monitor.sample())[0]?.verified).toBe(true);
  monitor.dispose();
});
test("inconclusive native sampling does not invent zero metrics", async () => {
  const monitor = new ResourceMonitor({ launches: () => [launch], onMetrics() {}, readSnapshot: async () => null });
  expect((await monitor.sample())[0]).toMatchObject({ verified: false, memoryMb: null, cpuPercent: null, processCount: null });
  monitor.dispose();
});
test("complete Windows resource tables reject empty, truncated, duplicate or malformed positive identities", () => {
  const inaccessible = root({ pid: 220, parentPid: 0, startToken: null, createdAtMs: null,
    executablePath: "", commandLine: "", nativeVerified: false, cpuSeconds: null, rssBytes: null });
  const idle = { ...inaccessible, pid: 0 };
  expect(parseWindowsResourceRows([], 0)).toBeNull();
  expect(parseWindowsResourceRows([idle], 1)).toBeNull();
  expect(parseWindowsResourceRows([root()], 2)).toBeNull();
  expect(parseWindowsResourceRows([root(), root()], 2)).toBeNull();
  expect(parseWindowsResourceRows([root(), { ...inaccessible, parentPid: "broken" }], 2)).toBeNull();
  expect(parseWindowsResourceRows([idle, root(), inaccessible], 3)).toEqual([root(), inaccessible]);
  expect(parseWindowsResourceRows([root()], 30, [110])).toEqual([root()]);
  expect(parseWindowsResourceRows([], 30, [110])).toEqual([]);
  expect(parseWindowsResourceRows([root({ executablePath: "" })], 1)).toEqual([root({ executablePath: "" })]);
});
test("resource reads coalesce exact target sets without hiding unrelated roots from a complete inspection", async () => {
  let release!: () => void; const pending = new Promise<void>(done => { release = done; });
  const calls: Array<readonly number[] | undefined> = [];
  const read = createResourceSnapshotReader(async roots => {
    calls.push(roots); await pending;
    return roots === undefined ? [root(), root({ pid: 220, startToken: "other" })] : roots.map(pid => root({ pid }));
  });
  const first = read([110, 110]), duplicate = read([110]), unrelated = read([220]), complete = read();
  expect(first).toBe(duplicate); expect(first).not.toBe(unrelated); expect(first).not.toBe(complete);
  await Promise.resolve(); expect(calls).toEqual([[110], [220], undefined]); release();
  expect((await first)?.map(row => row.pid)).toEqual([110]);
  expect((await unrelated)?.map(row => row.pid)).toEqual([220]);
  expect((await complete)?.map(row => row.pid)).toEqual([110, 220]);
  await read(); expect(calls).toHaveLength(4);
  expect(() => read([0])).toThrow();
});
test("failed resource scopes back off independently and successful absence is never cached", async () => {
  let now = 1000, reads = 0;
  const read = createResourceSnapshotReader(async roots => { reads++; return roots ? null : []; }, { backoffMs: 15000, now: () => now });
  expect(await read([110])).toBeNull(); expect(await read([110])).toBeNull(); expect(reads).toBe(1);
  expect(await read()).toEqual([]); expect(await read()).toEqual([]); expect(reads).toBe(3);
  now += 15000; expect(await read([110])).toBeNull(); expect(reads).toBe(4);
});
test("unavailable native counters retain observed root identity and invalidate a partial process-tree total", async () => {
  let rows = [root({ nativeVerified: false, cpuSeconds: null, rssBytes: null })];
  expect(ownedRoot(launch, rows, true)?.pid).toBe(launch.pid);
  const scopes: Array<readonly number[] | undefined> = [];
  const monitor = new ResourceMonitor({ launches: () => [launch], onMetrics() {}, windows: true,
    readSnapshot: async roots => { scopes.push(roots); return rows; } });
  expect((await monitor.sample())[0]).toMatchObject({ verified: false, memoryMb: null, cpuPercent: null, processCount: null });
  rows = [root(), root({ pid: 111, parentPid: 110, createdAtMs: launch.startedAt + 300, startToken: "child", nativeVerified: false, cpuSeconds: null, rssBytes: null })];
  expect((await monitor.sample())[0]).toMatchObject({ verified: false, memoryMb: null, cpuPercent: null, processCount: null });
  rows = [root(), root({ pid: 111, parentPid: 110, createdAtMs: null, startToken: null, nativeVerified: false, cpuSeconds: null, rssBytes: null })];
  expect((await monitor.sample())[0]).toMatchObject({ verified: false, memoryMb: null, cpuPercent: null, processCount: null });
  rows = [root()]; expect((await monitor.sample())[0]).toMatchObject({ verified: true, memoryMb: 100 });
  expect(scopes).toEqual([[110], [110], [110], [110]]); monitor.dispose();
});
test("Linux stat parser handles spaces and parentheses in process name", () => {
  const fields = Array<string>(24).fill("0");
  fields[0] = "S"; fields[1] = "1"; fields[11] = "200"; fields[12] = "100"; fields[19] = "500"; fields[21] = "128";
  expect(linuxStat(`110 (browser (renderer)) ${fields.join(" ")}`)).toEqual({ parentPid: 1, startToken: "500", cpuSeconds: 3, rssBytes: 524288 });
  expect(linuxStat("malformed")).toBeNull();
});

const nativeLinuxNamespace = process.platform !== "linux"
  || readFileSync("/proc/self/stat", "utf8").startsWith(`${process.pid} `);
test.skipIf(!["linux", "win32"].includes(process.platform) || !nativeLinuxNamespace)("native resource sampler measures an owned process without disclosing its command line", async () => {
  const binary = Bun.which("node");
  if (!binary) throw new Error("native Node runtime missing");
  const executable = realpathSync(binary);
  const directory = process.platform === "win32" ? "C:\\StakeMode\\NativeTest" : "/tmp/stakemode-native-test";
  const startedAt = Date.now();
  const child = spawn(executable, ["-e", "setInterval(() => {}, 1000)", "--", "--remote-debugging-port=19222", `--user-data-dir=${directory}`], { stdio: "ignore" });
  try {
    await new Promise<void>((ready, reject) => { child.once("spawn", ready); child.once("error", reject); });
    await Bun.sleep(200);
    const nativeLaunch: LaunchInfo = { profileId: "native_test", pid: child.pid!, debugPort: 19222, startedAt,
      ws: "ws://127.0.0.1:19222", binaryPath: executable, userDataDir: directory, headless: true };
    const monitor = new ResourceMonitor({ launches: () => [nativeLaunch], onMetrics() {}, readSnapshot: readResourceSnapshot });
    const [metrics] = await monitor.sample();
    monitor.dispose();
    expect(metrics?.verified).toBe(true);
    expect(metrics?.memoryMb).toBeGreaterThan(0);
    expect(metrics?.processCount).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(metrics)).not.toContain("remote-debugging");
  } finally { child.kill(); }
}, 20_000);

test("complete snapshots retain inaccessible browser PIDs without granting ownership or hiding healthy roots", async () => {
  const other = root({ pid: 220, parentPid: 1, executablePath: "", nativeVerified: false, cpuSeconds: null, rssBytes: null });
  const rows = parseWindowsResourceRows([root(), other], 2)!;
  expect(rows.map(row => row.pid)).toEqual([110, 220]);
  expect(ownedRoot(launch, rows, true)?.pid).toBe(110);
  const otherLaunch = { ...launch, profileId: "profile_other", pid: 220 };
  expect(ownedRoot(otherLaunch, rows, true)).toBeNull();
  // Final complete-table cleanup uses positive PID presence; a missing path
  // must never turn the observed browser into an absence proof.
  expect(rows.some(row => row.pid === otherLaunch.pid)).toBe(true);
  const monitor = new ResourceMonitor({ launches: () => [launch, otherLaunch], onMetrics() {}, windows: true, readSnapshot: async () => rows });
  const metrics = await monitor.sample(); monitor.dispose();
  expect(metrics[0]).toMatchObject({ verified: true, memoryMb: 100, processCount: 1 });
  expect(metrics[1]).toMatchObject({ verified: false, memoryMb: null, cpuPercent: null, processCount: null });
  const missingOwnPath = parseWindowsResourceRows([root({ executablePath: "" })], 1)!;
  expect(missingOwnPath.map(row => row.pid)).toEqual([launch.pid]);
  expect(ownedRoot(launch, missingOwnPath, true)).toBeNull();
});
test("resource validation reasons distinguish malformed, truncated and duplicate tables without exposing row data", () => {
  const reasons: string[] = [], failure = (reason: string) => { reasons.push(reason); };
  expect(parseWindowsResourceRows(null, 1, undefined, failure)).toBeNull();
  expect(parseWindowsResourceRows([root()], 2, undefined, failure)).toBeNull();
  expect(parseWindowsResourceRows([root({ parentPid: "malformed" as any })], 1, undefined, failure)).toBeNull();
  expect(parseWindowsResourceRows([root(), root()], 2, undefined, failure)).toBeNull();
  expect(parseWindowsResourceRows([root({ pid: 0 })], 1, undefined, failure)).toBeNull();
  expect(reasons).toEqual(["table-shape", "row-count", "row-shape", "duplicate-pid", "no-positive-pids"]);
  const before = reasons.length;
  expect(parseWindowsResourceRows([root({ executablePath: "" })], 1, undefined, failure)?.[0]?.pid).toBe(launch.pid);
  expect(reasons).toHaveLength(before);
  expect(JSON.stringify(reasons)).not.toContain("StakeMode"); expect(JSON.stringify(reasons)).not.toContain("user-data-dir");
});
