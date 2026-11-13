import { spawn } from "node:child_process";
import { expect, test } from "bun:test";
import { WindowsProcessScheduler } from "./windowsProcessScheduler.ts";

test("native collectors never overlap and queued ownership precedes background resource work", async () => {
  const scheduler = new WindowsProcessScheduler(), order: string[] = []; let active = 0, peak = 0, release!: () => void;
  const blocked = new Promise<void>(done => { release = done; });
  const operation = (name: string, wait?: Promise<void>) => async () => {
    active++; peak = Math.max(peak, active); order.push(name); if (wait) await wait; active--; return name;
  };
  const first = scheduler.schedule("resources", operation("active-resource", blocked));
  await Promise.resolve();
  const resource = scheduler.schedule("resources", operation("queued-resource"));
  const owner = scheduler.schedule("ownership", operation("ownership"));
  expect(order).toEqual(["active-resource"]); release();
  expect(await Promise.all([first, resource, owner])).toEqual(["active-resource", "queued-resource", "ownership"]);
  expect(order).toEqual(["active-resource", "ownership", "queued-resource"]); expect(peak).toBe(1);
});
test("expired queued inspections return unknown and never run later or interrupt an active helper", async () => {
  const scheduler = new WindowsProcessScheduler(); let release!: () => void, ran = false;
  const blocked = new Promise<void>(done => { release = done; });
  const active = scheduler.schedule("resources", async () => { await blocked; return "done"; });
  const queued = scheduler.schedule("ownership", async () => { ran = true; return "unsafe late work"; }, 5);
  expect(await queued).toBeNull(); expect(ran).toBe(false);
  release(); expect(await active).toBe("done");
  expect(await scheduler.schedule("ownership", async () => "fresh")).toBe("fresh"); expect(ran).toBe(false);
});
test("an inspection exception releases the lease without presenting an empty successful snapshot", async () => {
  const scheduler = new WindowsProcessScheduler();
  expect(await scheduler.schedule("ownership", async () => { throw new Error("unavailable"); })).toBeNull();
  expect(await scheduler.schedule("resources", async () => [123])).toEqual([123]);
  expect(() => scheduler.schedule("ownership", async () => [], 45000)).toThrow("queue timeout");
});
test("reporting a timeout does not release the helper lease before exact owned process exit", async () => {
  const scheduler = new WindowsProcessScheduler(); let exited!: () => void, ran = false;
  const exit = new Promise<void>(done => { exited = done; });
  expect(await scheduler.schedule("resources", async control => { control.ownHelper(() => {}, exit); return null; })).toBeNull();
  const pending = scheduler.schedule("ownership", async () => { ran = true; return "completed"; });
  await Promise.resolve(); expect(ran).toBe(false); exited(); expect(await pending).toBe("completed");
});
test("unconfirmed helper termination keeps the lease quarantined while new callers time out as unknown", async () => {
  const scheduler = new WindowsProcessScheduler(); let ran = false;
  expect(await scheduler.schedule("resources", async control => { control.ownHelper(() => {}, Promise.reject(new Error("exit unconfirmed"))); return null; })).toBeNull();
  expect(await scheduler.schedule("ownership", async () => { ran = true; return []; }, 5)).toBeNull(); expect(ran).toBe(false);
});

test("drain cancels exact owned work, rejects queued work, and reopens only after confirmed exit", async () => {
  const scheduler = new WindowsProcessScheduler(); let cancel = 0, release!: () => void, queuedRan = false;
  const exit = new Promise<void>(done => { release = done; });
  const active = scheduler.schedule("resources", async control => {
    control.ownHelper(() => { cancel++; }, exit); await exit; return "cancelled result";
  });
  await Promise.resolve();
  const queued = scheduler.schedule("ownership", async () => { queuedRan = true; return "late"; });
  const drain = scheduler.drain(100); let drained = false; void drain.then(() => { drained = true; });
  expect(await active).toBeNull(); expect(await queued).toBeNull(); expect(cancel).toBe(1);
  expect(await scheduler.schedule("ownership", async () => "paused")).toBeNull(); expect(drained).toBe(false);
  release(); expect(await drain).toBe(true); expect(queuedRan).toBe(false);
  expect(await scheduler.schedule("ownership", async () => "fresh")).toBe("fresh");
});
test("unconfirmed cancellation returns bounded failure without releasing the owned helper lease", async () => {
  const scheduler = new WindowsProcessScheduler(); let release!: () => void, ran = false;
  const exit = new Promise<void>(done => { release = done; });
  const active = scheduler.schedule("ownership", async control => { control.ownHelper(() => {}, exit); await exit; return []; });
  await Promise.resolve();
  expect(await scheduler.drain(5)).toBe(false); expect(await active).toBeNull();
  expect(await scheduler.schedule("resources", async () => { ran = true; return []; }, 5)).toBeNull(); expect(ran).toBe(false);
  release(); expect(await scheduler.drain(100)).toBe(true);
});
test("drain before the operation microtask prevents a late helper spawn", async () => {
  const scheduler = new WindowsProcessScheduler(); let ran = false;
  const pending = scheduler.schedule("ownership", async () => { ran = true; return []; });
  expect(await scheduler.drain()).toBe(true); expect(await pending).toBeNull(); expect(ran).toBe(false);
});
test("drain observes the actual owned child close before reporting helper cleanup", async () => {
  const scheduler = new WindowsProcessScheduler(); let opened!: () => void, closed = false, cancelled = 0;
  const started = new Promise<void>(done => { opened = done; });
  const result = scheduler.schedule("resources", async control => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject); child.once("close", () => { closed = true; resolve(); });
    });
    control.ownHelper(() => { cancelled++; child.kill(); }, exit);
    child.once("spawn", opened); await exit; return [];
  });
  await started; expect(await scheduler.drain()).toBe(true); expect(await result).toBeNull(); expect(closed).toBe(true); expect(cancelled).toBe(1);
});
