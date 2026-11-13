import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "../store.ts";
import { ProcessManager } from "./processManager.ts";
import { StakeModeWorkspace } from "./server.ts";
import { windowsProcessScheduler } from "./windowsProcessScheduler.ts";

function fixture(warmProcessService: () => Promise<boolean>, opening?: () => Promise<void>) {
  const stateRoot = mkdtempSync(join(tmpdir(), "stakemode-shutdown-"));
  const store = new ProfileStore(join(stateRoot, "profiles.sqlite"));
  let launched = 0, stopped = 0, monitorStopped = false;
  const launcher = {
    async start(id: string) {
      launched++; await opening?.();
      store.recordLaunch({ profileId: id, engine: "chromium", pid: 1234, debugPort: 9222, ws: "ws://127.0.0.1:9222/private",
        startedAt: Date.now(), headless: true, binaryPath: "C:\\StakeMode\\chrome.exe", userDataDir: `C:\\StakeMode\\Profiles\\${id}` });
      return { ws: "ws://127.0.0.1:9222/private", port: 9222 };
    },
    async stop(id: string) { stopped++; store.clearLaunch(id); return true; },
  };
  const manager = new ProcessManager({ launcher, store, stateRoot, warmProcessService,
    monitorFactory: () => ({ start() {}, dispose() { monitorStopped = true; } }) });
  const workspace = new StakeModeWorkspace({ stateRoot, launcher: launcher as any, store, manager,
    bridgeFactory: () => ({ stop: async () => {}, detach() {}, setVisible() {} }) as any });
  return { manager, workspace, store, get launched() { return launched; }, get stopped() { return stopped; }, get monitorStopped() { return monitorStopped; },
    cleanup() { manager.dispose(); store.close(); rmSync(stateRoot, { recursive: true, force: true }); } };
}

test("workspace close during native warmup cancels its owned helper and prevents a late browser launch", async () => {
  let began!: () => void, exited!: () => void, cancelled = 0, helperClosed = false;
  const started = new Promise<void>(done => { began = done; });
  const exit = new Promise<void>(done => { exited = () => { helperClosed = true; done(); }; });
  const f = fixture(async () => await windowsProcessScheduler.schedule("ownership", async control => {
    control.ownHelper(() => { cancelled++; exited(); }, exit); began(); await exit; return true;
  }) === true);
  try {
    const [profile] = await f.manager.bulkCreate({ count: 1 });
    const opening = f.manager.start(profile!.id).catch(() => null); await started;
    await f.workspace.stop(); expect(await opening).toBeNull();
    expect(f.monitorStopped).toBe(true); expect(cancelled).toBe(1); expect(helperClosed).toBe(true);
    expect(f.launched).toBe(0); expect(f.store.listLaunches()).toEqual([]);
    expect(() => f.manager.start(profile!.id)).toThrow("closed");
    expect(await windowsProcessScheduler.schedule("ownership", async () => "new workspace")).toBe("new workspace");
  } finally { f.cleanup(); }
});

test("workspace close includes native starts that have not yet written their launch generation", async () => {
  let release!: () => void, began!: () => void;
  const started = new Promise<void>(done => { began = done; });
  const waiting = new Promise<void>(done => { release = done; });
  const f = fixture(async () => true, async () => { began(); await waiting; });
  try {
    const [profile] = await f.manager.bulkCreate({ count: 1 });
    const opening = f.manager.start(profile!.id); await started;
    expect(f.store.listLaunches()).toEqual([]);
    const closing = f.workspace.stop(); let closed = false; void closing.then(() => { closed = true; });
    await Bun.sleep(0); expect(closed).toBe(false); expect(f.monitorStopped).toBe(true);
    expect(() => f.manager.start(profile!.id)).toThrow("stopping");
    release(); await opening; await closing;
    expect(f.launched).toBe(1); expect(f.stopped).toBe(1); expect(f.store.listLaunches()).toEqual([]);
  } finally { release(); f.cleanup(); }
});

test("zero-profile workspace close never warms the process service", async () => {
  let warmed = 0;
  const f = fixture(async () => { warmed++; return true; });
  try { await f.workspace.stop(); expect(warmed).toBe(0); expect(f.launched).toBe(0); expect(f.monitorStopped).toBe(true); }
  finally { f.cleanup(); }
});
