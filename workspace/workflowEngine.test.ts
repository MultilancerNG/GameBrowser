import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { builtinWorkflows, parseWorkflowDocument, validateWorkflowSteps, WORKFLOW_LIMITS, WorkspaceWorkflowEngine, type BrowserWorkflowStep, type WorkflowEngineOptions } from "./workflowEngine.ts";

function fixture(options: Partial<Omit<WorkflowEngineOptions, "stateRoot">> = {}) {
  const root = mkdtempSync(join(tmpdir(), "stakemode-workflow-test-"));
  const config: WorkflowEngineOptions = { stateRoot: root, canRunProfile: () => true, execute: async (_id, step) => step.kind === "extract" ? "Read result" : undefined, ...options };
  const engine = new WorkspaceWorkflowEngine(config);
  return { root, config, engine, file: join(root, "workspace", "workflows.json"), cleanup: () => { engine.stop(); rmSync(root, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() >= end) throw new Error("Expected workflow transition did not occur"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function deferred() { let resolve!: (value?: unknown) => void; const promise = new Promise<unknown>(done => { resolve = done; }); return { promise, resolve }; }
const extract = (field = "result") => ({ kind: "extract" as const, source: "title" as const, field });

describe("validated local read-only workflows", () => {
  test("portable JSON uses fresh IDs and rejects executable, credential and unknown fields", () => {
    const f = fixture();
    try {
      const source = { product: "StakeMode", version: 1, kind: "read-only-workflow", workflow: { name: "  Inspect  ", steps: [{ kind: "navigate", url: "https://example.com/public" }, { kind: "wait", ms: 0 }, { kind: "scroll", deltaX: 0, deltaY: 3000 }, { kind: "extract", source: "text", selector: "  main h1  ", field: "heading" }] } };
      const one = f.engine.importWorkflow(source), two = f.engine.importWorkflow(source);
      expect(one.id).not.toBe(two.id); expect(one.name).toBe("Inspect");
      expect(f.engine.exportWorkflow(one.id)).toEqual(parseWorkflowDocument(source));
      expect(f.engine.exportWorkflow(one.id).product).toBe("GameBrowser");
      expect(parseWorkflowDocument({ ...source, product: "GameBrowser" }).product).toBe("GameBrowser");
      expect(() => parseWorkflowDocument({ ...source, product: ["GameBrowser"] })).toThrow();
      expect(JSON.stringify(f.engine.exportWorkflow(one.id))).not.toContain(one.id);
      one.steps.length = 0; expect(f.engine.getWorkflow(one.id).steps).toHaveLength(4);
      for (const kind of ["click", "type", "login", "captcha", "payment", "bet", "javascript", "fetch", "mcp"]) expect(() => validateWorkflowSteps([{ kind }])).toThrow();
      for (const url of ["javascript:alert(1)", "file:///secret", "http://remote.example/", "https://user:pass@example.com/", "https://example.com/?token=secret", "https://example.com/#secret", "https://exa\nmple.com/"]) expect(() => validateWorkflowSteps([{ kind: "navigate", url }])).toThrow();
      expect(() => parseWorkflowDocument({ ...source, credentials: "secret" })).toThrow();
      expect(() => parseWorkflowDocument({ ...source, workflow: { ...source.workflow, id: "imported-id" } })).toThrow();
      expect(() => validateWorkflowSteps([{ ...extract(), value: "typed secret" }])).toThrow();
      expect(() => validateWorkflowSteps([extract(), extract()])).toThrow("unique");
      expect(() => validateWorkflowSteps(Array.from({ length: 65 }, () => ({ kind: "wait", ms: 0 })))).toThrow();
      expect(() => validateWorkflowSteps([{ kind: "wait", ms: 30001 }])).toThrow();
      expect(() => validateWorkflowSteps([{ kind: "scroll", deltaX: 0, deltaY: 3001 }])).toThrow();
      expect(() => validateWorkflowSteps([{ kind: "extract", source: "title", field: "title", selector: "h1" }])).toThrow();
      expect(() => validateWorkflowSteps([{ kind: "extract", source: "text", field: "text" }])).toThrow();
      expect(() => validateWorkflowSteps([{ kind: "extract", source: ["title"], field: "title" }])).toThrow();
      expect(() => f.engine.saveWorkflow({ id: [one.id], name: "Overwrite", steps: [extract()] })).toThrow();
      expect(() => f.engine.createSchedule({ workflowId: one.id, profileId: "profile_one", kind: ["interval"], intervalMs: 60000 })).toThrow();
      expect(() => f.engine.createSchedule({ workflowId: [one.id], profileId: "profile_one", kind: "interval", intervalMs: 60000 })).toThrow();
      expect(builtinWorkflows()[0]!.document.workflow.steps.map(step => step.kind)).toEqual(["extract", "extract"]);
    } finally { f.cleanup(); }
  });

  test("executes nodes deterministically and keeps extracted values out of persisted state/logs", async () => {
    const calls: BrowserWorkflowStep[] = [];
    const f = fixture({ execute: async (_id, step) => { calls.push(step); return step.kind !== "extract" ? undefined : step.source === "url" ? "https://user:secret@example.com/public?session=secret#secret" : step.source === "title" ? "=2+3" : "Visible text secret-local-output"; } });
    try {
      const definition = f.engine.saveWorkflow({ name: "Read page", steps: [{ kind: "navigate", url: "https://example.com/public" }, { kind: "wait", ms: 0 }, { kind: "scroll", deltaX: 0, deltaY: 100 }, extract("title"), { kind: "extract", source: "url", field: "url" }, { kind: "extract", source: "text", selector: "main", field: "text" }] });
      const job = f.engine.run(definition.id, "profile_one");
      await until(() => f.engine.getJob(job.id).status === "completed");
      expect(calls.map(step => step.kind)).toEqual(["navigate", "scroll", "extract", "extract", "extract"]);
      expect(f.engine.getJob(job.id).steps.map(step => step.status)).toEqual(Array(6).fill("completed"));
      expect(f.engine.getJob(job.id).stepIndex).toBe(6);
      expect(f.engine.getOutput(job.id).values).toEqual({ title: "=2+3", url: "https://example.com/public", text: "Visible text secret-local-output" });
      expect(f.engine.exportOutput(job.id, "csv")).toContain('"title","\'=2+3"');
      expect(f.engine.exportOutput(job.id, "json")).toContain("secret-local-output");
      const persisted = readFileSync(f.file, "utf8");
      for (const secret of ["session=secret", "secret-local-output", "user:secret", "=2+3"]) expect(persisted).not.toContain(secret);
      const reopened = new WorkspaceWorkflowEngine(f.config);
      expect(reopened.getJob(job.id).status).toBe("completed"); expect(reopened.getJob(job.id).outputsAvailable).toBe(false);
      expect(() => reopened.getOutput(job.id)).toThrow("app session"); reopened.stop();
    } finally { f.cleanup(); }
  });

  test("enforces two global leases and excludes overlapping jobs on the same profile", async () => {
    const gates = [deferred(), deferred(), deferred(), deferred()], calls: string[] = [];
    const f = fixture({ execute: async (id) => { const gate = gates[calls.length]!; calls.push(id); return gate.promise; } });
    try {
      const workflow = f.engine.saveWorkflow({ name: "Read", steps: [extract()] });
      const one = f.engine.run(workflow.id, "profile_one"), same = f.engine.run(workflow.id, "profile_one"), two = f.engine.run(workflow.id, "profile_two"), three = f.engine.run(workflow.id, "profile_three");
      expect(calls).toEqual(["profile_one", "profile_two"]);
      expect(f.engine.getJob(same.id).status).toBe("queued"); expect(f.engine.getJob(three.id).status).toBe("queued");
      gates[1]!.resolve("two"); await until(() => calls.length === 3); expect(calls[2]).toBe("profile_three");
      gates[0]!.resolve("one"); await until(() => calls.length === 4); expect(calls[3]).toBe("profile_one");
      gates[2]!.resolve("three"); gates[3]!.resolve("same");
      await until(() => [one, same, two, three].every(job => f.engine.getJob(job.id).status === "completed"));
    } finally { for (const gate of gates) gate.resolve(""); f.cleanup(); }
  });

  test("cancellation and timeout retain the profile lease until an in-flight callback settles", async () => {
    const gate = deferred(), calls: string[] = [];
    const f = fixture({ jobTimeoutMs: 30, execute: async id => { calls.push(id); return calls.length === 1 ? gate.promise : "next"; } });
    try {
      const workflow = f.engine.saveWorkflow({ name: "Read", steps: [extract()] });
      const timed = f.engine.run(workflow.id, "profile_one"), next = f.engine.run(workflow.id, "profile_one");
      await until(() => f.engine.getJob(timed.id).status === "timedout");
      expect(f.engine.getJob(next.id).status).toBe("queued"); expect(calls).toHaveLength(1);
      gate.resolve("discard this late result"); await until(() => f.engine.getJob(next.id).status === "completed");
      expect(() => f.engine.getOutput(timed.id)).toThrow(); expect(f.engine.getOutput(next.id).values.result).toBe("next");
      const waiting = f.engine.saveWorkflow({ name: "Wait", steps: [{ kind: "wait", ms: 30000 }, extract()] });
      const cancelled = f.engine.run(waiting.id, "profile_two"); f.engine.cancel(cancelled.id);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(f.engine.getJob(cancelled.id).status).toBe("cancelled"); expect(calls).toHaveLength(2);
    } finally { gate.resolve(""); f.cleanup(); }
  });

  test("a running job stops before its next node when manual control is lost", async () => {
    let manual = true; const calls: string[] = [], gate = deferred();
    const f = fixture({ canRunProfile: () => manual, execute: async (_id, step) => { calls.push(step.kind); if (step.kind === "navigate") { await gate.promise; manual = false; } return "read"; } });
    try {
      const workflow = f.engine.saveWorkflow({ name: "Read", steps: [{ kind: "navigate", url: "https://example.com/" }, extract()] });
      const job = f.engine.run(workflow.id, "profile_one");
      f.engine.saveWorkflow({ id: workflow.id, name: "Edited", steps: [{ kind: "scroll", deltaX: 0, deltaY: 1 }] });
      gate.resolve(); await until(() => f.engine.getJob(job.id).status === "failed");
      expect(calls).toEqual(["navigate"]); expect(f.engine.getJob(job.id).error).toBe("This profile must be running in manual control");
      expect(() => f.engine.run(workflow.id, "profile_two")).toThrow("manual control");
    } finally { gate.resolve(); f.cleanup(); }
  });

  test("cancelled native work cannot overlap its successor and queued cancellation never dispatches", async () => {
    const gate = deferred(), calls: string[] = [];
    const f = fixture({ execute: async id => { calls.push(id); return calls.length === 1 ? gate.promise : "next"; } });
    try {
      const workflow = f.engine.saveWorkflow({ name: "Read", steps: [extract()] });
      const active = f.engine.run(workflow.id, "profile_one"), cancelledQueued = f.engine.run(workflow.id, "profile_one"), next = f.engine.run(workflow.id, "profile_one");
      expect(() => f.engine.deleteWorkflow(workflow.id)).toThrow("Cancel active jobs");
      f.engine.cancel(cancelledQueued.id); f.engine.cancel(active.id);
      expect(f.engine.getJob(active.id).status).toBe("cancelled"); expect(f.engine.getJob(next.id).status).toBe("queued");
      expect(calls).toEqual(["profile_one"]);
      gate.resolve("discarded"); await until(() => f.engine.getJob(next.id).status === "completed");
      expect(calls).toEqual(["profile_one", "profile_one"]);
      expect(f.engine.getJob(cancelledQueued.id).status).toBe("cancelled"); expect(() => f.engine.getOutput(active.id)).toThrow();
      f.engine.deleteWorkflow(workflow.id); expect(f.engine.listWorkflows()).toEqual([]);
    } finally { gate.resolve(""); f.cleanup(); }
  });

  test("control loss during the final extraction discards its result", async () => {
    let manual = true;
    const f = fixture({ canRunProfile: () => manual, execute: async () => { manual = false; return "late private result"; } });
    try {
      const workflow = f.engine.saveWorkflow({ name: "Read", steps: [extract()] });
      const job = f.engine.run(workflow.id, "profile_one"); await until(() => f.engine.getJob(job.id).status === "failed");
      expect(f.engine.getJob(job.id).error).toBe("This profile must be running in manual control");
      expect(() => f.engine.getOutput(job.id)).toThrow(); expect(readFileSync(f.file, "utf8")).not.toContain("late private result");
    } finally { f.cleanup(); }
  });

  test("sanitizes executor errors, bounds output and never exposes partial results", async () => {
    let oversized = false;
    const f = fixture({ execute: async () => { if (oversized) return "x".repeat(WORKFLOW_LIMITS.textChars + 1); throw new Error("https://example.com/?password=secret raw account token"); } });
    try {
      const definition = f.engine.saveWorkflow({ name: "Read", steps: [{ kind: "extract", source: "text", selector: "main", field: "text" }] });
      const failed = f.engine.run(definition.id, "profile_one"); await until(() => f.engine.getJob(failed.id).status === "failed");
      expect(f.engine.getJob(failed.id).error).toBe("Workflow execution failed"); expect(readFileSync(f.file, "utf8")).not.toContain("password=secret");
      oversized = true; const tooLarge = f.engine.run(definition.id, "profile_one"); await until(() => f.engine.getJob(tooLarge.id).status === "failed");
      expect(f.engine.getJob(tooLarge.id).error).toBe("Workflow output exceeds its limit"); expect(() => f.engine.getOutput(tooLarge.id)).toThrow();
    } finally { f.cleanup(); }
  });

  test("one-off and interval schedules run only while app ticks and skip unavailable profiles", async () => {
    let now = 1000000, available = true; const calls: string[] = [];
    const f = fixture({ now: () => now, canRunProfile: () => available, execute: async id => { calls.push(id); return "read"; } });
    try {
      const workflow = f.engine.saveWorkflow({ name: "Read", steps: [extract()] });
      const once = f.engine.createSchedule({ workflowId: workflow.id, profileId: "profile_one", kind: "once", runAt: now + 1000 });
      const interval = f.engine.createSchedule({ workflowId: workflow.id, profileId: "profile_two", kind: "interval", intervalMs: 60000 });
      now += 1000; f.engine.tick(); await until(() => calls.length === 1);
      expect(f.engine.listSchedules().find(row => row.id === once.id)!.enabled).toBe(false);
      f.engine.tick(); expect(calls).toEqual(["profile_one"]);
      now += 59000; available = false; f.engine.tick();
      expect(calls).toEqual(["profile_one"]); expect(f.engine.listSchedules().find(row => row.id === interval.id)!.lastResult).toBe("skipped");
      expect(f.engine.storageWarning).toBeNull();
      available = true; now += 60000; f.engine.tick(); await until(() => calls.length === 2);
      expect(calls).toEqual(["profile_one", "profile_two"]);
      expect(() => f.engine.createSchedule({ workflowId: workflow.id, profileId: "profile_one", kind: "interval", intervalMs: 59999 })).toThrow();
      expect(() => f.engine.createSchedule({ workflowId: workflow.id, profileId: "../unsafe", kind: "once", runAt: now + 1 })).toThrow();
    } finally { f.cleanup(); }
  });

  test("restarts never catch up missed schedules or resume jobs, and supports changing schedule kind", async () => {
    let now = 1000000; const gate = deferred(), calls: string[] = [];
    const f = fixture({ now: () => now, execute: async id => { calls.push(id); return gate.promise; } });
    let reopened: WorkspaceWorkflowEngine | undefined;
    try {
      const workflow = f.engine.saveWorkflow({ name: "Read", steps: [extract()] });
      const once = f.engine.createSchedule({ workflowId: workflow.id, profileId: "profile_one", kind: "once", runAt: now + 1000 });
      const interval = f.engine.createSchedule({ workflowId: workflow.id, profileId: "profile_two", kind: "interval", intervalMs: 60000 });
      const job = f.engine.run(workflow.id, "profile_one"); now += 120000;
      reopened = new WorkspaceWorkflowEngine(f.config);
      expect(reopened.getJob(job.id).status).toBe("interrupted");
      expect(reopened.listSchedules().find(row => row.id === once.id)!.lastResult).toBe("missed_offline");
      expect(reopened.listSchedules().find(row => row.id === interval.id)!.nextRunAt).toBe(now + 60000);
      reopened.tick(); expect(calls).toEqual(["profile_one"]);
      const changed = reopened.updateSchedule(once.id, { kind: "interval", intervalMs: 60000, enabled: true });
      expect(changed.kind).toBe("interval"); expect(changed.runAt).toBeUndefined();
      const back = reopened.updateSchedule(once.id, { kind: "once", runAt: now + 5000 });
      expect(back.intervalMs).toBeUndefined();
    } finally { gate.resolve(""); reopened?.stop(); f.cleanup(); }
  });

  test("profile cleanup deletes related outputs/jobs/schedules and workflow deletion removes its schedules", async () => {
    const f = fixture();
    try {
      const workflow = f.engine.saveWorkflow({ name: "Read", steps: [extract()] });
      const job = f.engine.run(workflow.id, "profile_one"); await until(() => f.engine.getJob(job.id).status === "completed");
      f.engine.createSchedule({ workflowId: workflow.id, profileId: "profile_one", kind: "interval", intervalMs: 60000 });
      const other = f.engine.createSchedule({ workflowId: workflow.id, profileId: "profile_two", kind: "interval", intervalMs: 60000 });
      f.engine.removeProfile("profile_one");
      expect(() => f.engine.getOutput(job.id)).toThrow(); expect(f.engine.listJobs()).toEqual([]);
      expect(f.engine.listSchedules()).toEqual([other]);
      f.engine.deleteWorkflow(workflow.id); expect(f.engine.listSchedules()).toEqual([]);
      const reopened = new WorkspaceWorkflowEngine(f.config); expect(reopened.listWorkflows()).toEqual([]); expect(reopened.listJobs()).toEqual([]); reopened.stop();
    } finally { f.cleanup(); }
  });

  test("rejects corrupt persisted definitions and never executes them during construction", () => {
    const f = fixture();
    try {
      f.engine.saveWorkflow({ name: "Read", steps: [extract()] });
      const saved = JSON.parse(readFileSync(f.file, "utf8")); saved.workflows[0].steps = [{ kind: "click", selector: "#bet" }]; writeFileSync(f.file, JSON.stringify(saved));
      expect(() => new WorkspaceWorkflowEngine(f.config)).toThrow("invalid");
    } finally { f.cleanup(); }
  });

  test("failed history replacement preserves the previous completed job output", async () => {
    const f = fixture();
    try {
      const workflow = f.engine.saveWorkflow({ name: "Read", steps: [extract()] });
      const first = f.engine.run(workflow.id, "profile_one"); await until(() => f.engine.getJob(first.id).status === "completed");
      for (let offset = 1; offset < WORKFLOW_LIMITS.jobs; offset += 16) {
        const batch = Array.from({ length: Math.min(16, WORKFLOW_LIMITS.jobs - offset) }, () => f.engine.run(workflow.id, "profile_one"));
        await until(() => batch.every(job => f.engine.getJob(job.id).status === "completed"));
      }
      expect(f.engine.listJobs()).toHaveLength(WORKFLOW_LIMITS.jobs);
      const previous = f.engine.getOutput(first.id), backup = `${f.file}.original`;
      renameSync(f.file, backup); mkdirSync(f.file);
      try {
        expect(() => f.engine.run(workflow.id, "profile_one")).toThrow();
        expect(f.engine.getOutput(first.id)).toEqual(previous);
        expect(f.engine.listJobs()).toHaveLength(WORKFLOW_LIMITS.jobs);
      } finally { rmSync(f.file, { recursive: true, force: true }); renameSync(backup, f.file); }
    } finally { f.cleanup(); }
  });
});
