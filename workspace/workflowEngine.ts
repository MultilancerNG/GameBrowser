/** Local read-only workflows. No credential entry, clicks, wagering, AI or remote jobs. */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertSafeProfileId } from "../profile-id.ts";
import { normalizeWorkspaceUrl } from "./profileStore.ts";
import { publicPageUrl } from "./protocol.ts";

export const WORKFLOW_LIMITS = Object.freeze({ workflows: 128, schedules: 64, jobs: 256, queued: 64, steps: 64,
  concurrency: 2, jobMs: 180000, waitMs: 30000, textChars: 16384, outputBytes: 256 * 1024, documentBytes: 256 * 1024, storageBytes: 8 * 1024 * 1024 });
export type WorkflowStep = { kind: "navigate"; url: string } | { kind: "wait"; ms: number }
  | { kind: "scroll"; deltaX: number; deltaY: number }
  | { kind: "extract"; source: "text" | "title" | "url"; selector?: string; field: string };
export type BrowserWorkflowStep = Exclude<WorkflowStep, { kind: "wait" }>;
export interface WorkflowDefinition { id: string; name: string; steps: WorkflowStep[]; createdAt: number; updatedAt: number; }
export interface WorkflowDocument { product: "GameBrowser"; version: 1; kind: "read-only-workflow"; workflow: { name: string; steps: WorkflowStep[] }; }
export type WorkflowJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timedout" | "interrupted";
export interface WorkflowStepStatus { index: number; kind: WorkflowStep["kind"]; status: "running" | "completed" | "failed"; startedAt: number; finishedAt?: number; }
export interface WorkflowJob {
  id: string; workflowId: string; profileId: string; status: WorkflowJobStatus; trigger: "manual" | "schedule";
  stepIndex: number; stepCount: number; createdAt: number; startedAt?: number; finishedAt?: number;
  steps: WorkflowStepStatus[]; error?: string; outputsAvailable: boolean;
}
export interface WorkflowSchedule {
  id: string; workflowId: string; profileId: string; kind: "once" | "interval"; enabled: boolean;
  runAt?: number; intervalMs?: number; nextRunAt: number; createdAt: number;
  lastRunAt?: number; lastJobId?: string; lastResult?: "queued" | "skipped" | "missed_offline";
}
export interface WorkflowOutput { jobId: string; workflowId: string; profileId: string; values: Record<string, string>; }
export interface WorkflowEngineOptions {
  stateRoot: string;
  execute(profileId: string, step: BrowserWorkflowStep, signal: AbortSignal): Promise<unknown>;
  canRunProfile(profileId: string): boolean;
  onChange?(): void;
  now?(): number;
  /** Shorter limits support embedding/tests; callers cannot exceed three minutes. */
  jobTimeoutMs?: number;
}
const idPattern = /^wf_[a-f0-9]{32}$/;
const jobPattern = /^job_[a-f0-9]{32}$/;
const schedulePattern = /^schedule_[a-f0-9]{32}$/;
const safeErrors = new Set(["This profile must be running in manual control", "Workflow execution failed", "Workflow exceeded its time limit", "Workflow cancelled", "Application stopped", "Application stopped before completion", "Workflow output exceeds its limit"]);
const fresh = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const clone = <T>(value: T): T => structuredClone(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow configuration must be an object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Workflow configuration contains an unsupported field");
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Workflow name must contain 1 to 100 printable characters");
  return value.trim();
}
function integer(value: unknown, min: number, max: number, message: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(message);
  return Number(value);
}
function timestamp(value: unknown): number { return integer(value, 0, 8640000000000000, "Workflow time is invalid"); }
export function validateWorkflowSteps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value) || !value.length || value.length > WORKFLOW_LIMITS.steps) throw new Error("Use 1 to 64 read-only workflow steps");
  const outputFields = new Set<string>();
  return value.map(entry => {
    const step = object(entry);
    if (step.kind === "navigate") {
      fields(step, ["kind", "url"]);
      if (typeof step.url !== "string" || /[\u0000-\u001f\u007f]/.test(step.url)) throw new Error("Workflow website address is invalid");
      return { kind: "navigate", url: normalizeWorkspaceUrl(step.url) };
    }
    if (step.kind === "wait") { fields(step, ["kind", "ms"]); return { kind: "wait", ms: integer(step.ms, 0, WORKFLOW_LIMITS.waitMs, "Wait must be from 0 to 30000 milliseconds") }; }
    if (step.kind === "scroll") {
      fields(step, ["kind", "deltaX", "deltaY"]);
      return { kind: "scroll", deltaX: integer(step.deltaX, -3000, 3000, "Scroll distance exceeds its limit"), deltaY: integer(step.deltaY, -3000, 3000, "Scroll distance exceeds its limit") };
    }
    if (step.kind === "extract") {
      fields(step, ["kind", "source", "selector", "field"]);
      if (typeof step.source !== "string" || !["text", "title", "url"].includes(step.source) || typeof step.field !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(step.field) || outputFields.has(step.field)) throw new Error("Choose a unique output field and a supported extraction source");
      outputFields.add(step.field);
      if (step.source === "text") {
        if (typeof step.selector !== "string" || !step.selector.trim() || step.selector.length > 512 || /[\u0000-\u001f\u007f]/.test(step.selector)) throw new Error("Text extraction requires a bounded CSS selector");
        return { kind: "extract", source: "text", selector: step.selector.trim(), field: step.field };
      }
      if (step.selector !== undefined) throw new Error("Title and URL extraction do not accept a selector");
      return { kind: "extract", source: step.source as "title" | "url", field: step.field };
    }
    throw new Error("Only navigation, wait, scroll and read-only extraction steps are supported");
  });
}
export function parseWorkflowDocument(value: unknown): WorkflowDocument {
  const input = object(value);
  if (Buffer.byteLength(JSON.stringify(input)) > WORKFLOW_LIMITS.documentBytes) throw new Error("Workflow document exceeds 256 KiB");
  fields(input, ["product", "version", "kind", "workflow"]);
  if ((input.product !== "GameBrowser" && input.product !== "StakeMode") || input.version !== 1 || input.kind !== "read-only-workflow") throw new Error("Use a GameBrowser read-only workflow document");
  const workflow = object(input.workflow); fields(workflow, ["name", "steps"]);
  return { product: "GameBrowser", version: 1, kind: "read-only-workflow", workflow: { name: name(workflow.name), steps: validateWorkflowSteps(workflow.steps) } };
}
/** A real local template, imported through exactly the same validation as user JSON. */
export function builtinWorkflows(): Array<{ key: string; description: string; document: WorkflowDocument }> {
  return [{ key: "inspect-current-page", description: "Read the selected manual page title and its address without a query or fragment.", document: parseWorkflowDocument({ product: "GameBrowser", version: 1, kind: "read-only-workflow", workflow: { name: "Inspect current page", steps: [{ kind: "extract", source: "title", field: "title" }, { kind: "extract", source: "url", field: "url" }] } }) }];
}

export class WorkspaceWorkflowEngine {
  private readonly file: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private workflows = new Map<string, WorkflowDefinition>();
  private schedules = new Map<string, WorkflowSchedule>();
  private jobs = new Map<string, WorkflowJob>();
  private definitions = new Map<string, WorkflowDefinition>();
  private outputs = new Map<string, Record<string, string>>();
  private controllers = new Map<string, AbortController>();
  private pending: string[] = [];
  private active = new Set<string>();
  private activeProfiles = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private storageFailed = false;
  constructor(private options: WorkflowEngineOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = integer(options.jobTimeoutMs ?? WORKFLOW_LIMITS.jobMs, 10, WORKFLOW_LIMITS.jobMs, "Workflow time limit must be from 10 to 180000 milliseconds");
    const directory = join(resolve(options.stateRoot), "workspace"); mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Workflow storage must not be a symbolic link");
    this.file = join(directory, "workflows.json");
    let content: string;
    try { const info = lstatSync(this.file); if (!info.isFile() || info.isSymbolicLink() || info.size > WORKFLOW_LIMITS.storageBytes) throw new Error(); content = readFileSync(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Workflow storage is unavailable"); }
    try {
      const saved = object(JSON.parse(content));
      if (saved.version !== 1 || !Array.isArray(saved.workflows) || saved.workflows.length > WORKFLOW_LIMITS.workflows || !Array.isArray(saved.schedules) || saved.schedules.length > WORKFLOW_LIMITS.schedules || !Array.isArray(saved.jobs) || saved.jobs.length > WORKFLOW_LIMITS.jobs) throw new Error();
      for (const value of saved.workflows) {
        const row = object(value); if (typeof row.id !== "string" || !idPattern.test(row.id) || this.workflows.has(row.id)) throw new Error();
        this.workflows.set(row.id, { id: row.id, name: name(row.name), steps: validateWorkflowSteps(row.steps), createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt) });
      }
      for (const value of saved.schedules) {
        const row = object(value); if (typeof row.id !== "string" || !schedulePattern.test(row.id) || this.schedules.has(row.id)) throw new Error();
        const schedule = this.normalizeSchedule(row, true);
        if (schedule.enabled && schedule.kind === "interval") schedule.nextRunAt = this.now() + schedule.intervalMs!;
        else if (schedule.enabled && schedule.nextRunAt <= this.now()) { schedule.enabled = false; schedule.lastResult = "missed_offline"; }
        this.schedules.set(schedule.id, schedule);
      }
      for (const value of saved.jobs) {
        const row = object(value); assertSafeProfileId(row.profileId);
        if (typeof row.id !== "string" || !jobPattern.test(row.id) || this.jobs.has(row.id) || typeof row.workflowId !== "string" || !idPattern.test(row.workflowId) || typeof row.status !== "string" || !["queued", "running", "completed", "failed", "cancelled", "timedout", "interrupted"].includes(row.status) || typeof row.trigger !== "string" || !["manual", "schedule"].includes(row.trigger)) throw new Error();
        const interrupted = row.status === "queued" || row.status === "running";
        const steps = this.restoreStepStatus(row.steps);
        const restored: WorkflowJob = { id: row.id, workflowId: row.workflowId, profileId: row.profileId as string, status: interrupted ? "interrupted" : row.status as WorkflowJobStatus, trigger: row.trigger as WorkflowJob["trigger"], stepIndex: integer(row.stepIndex, 0, 64, "Invalid progress"), stepCount: integer(row.stepCount, 1, 64, "Invalid step count"), createdAt: timestamp(row.createdAt), steps, outputsAvailable: false };
        if (row.startedAt !== undefined) restored.startedAt = timestamp(row.startedAt);
        if (interrupted) { restored.finishedAt = this.now(); restored.error = "Application stopped before completion"; }
        else { if (row.finishedAt !== undefined) restored.finishedAt = timestamp(row.finishedAt); if (row.error !== undefined) { if (typeof row.error !== "string" || !safeErrors.has(row.error)) throw new Error(); restored.error = row.error; } }
        this.jobs.set(restored.id, restored);
      }
    } catch { throw new Error("Workflow storage is invalid; repair it before running local workflows"); }
    this.persist();
  }
  get storageWarning(): string | null { return this.storageFailed ? "Workflow status could not be saved; check local storage" : null; }
  listWorkflows(): WorkflowDefinition[] { return clone([...this.workflows.values()]); }
  getWorkflow(id: string): WorkflowDefinition { return clone(this.requireWorkflow(id)); }
  saveWorkflow(value: unknown): WorkflowDefinition {
    const row = object(value); fields(row, ["id", "name", "steps"]);
    if (row.id !== undefined && typeof row.id !== "string") throw new Error("Workflow identifier is invalid");
    const previous = row.id === undefined ? undefined : this.requireWorkflow(row.id as string);
    if (!previous && this.workflows.size >= WORKFLOW_LIMITS.workflows) throw new Error("Local workflow library is full");
    const now = this.now(), workflow: WorkflowDefinition = { id: previous?.id ?? fresh("wf"), name: name(row.name), steps: validateWorkflowSteps(row.steps), createdAt: previous?.createdAt ?? now, updatedAt: now };
    const next = new Map(this.workflows); next.set(workflow.id, workflow); this.persist(next); this.workflows = next; this.changed(); return clone(workflow);
  }
  importWorkflow(value: unknown): WorkflowDefinition { return this.saveWorkflow(parseWorkflowDocument(value).workflow); }
  exportWorkflow(id: string): WorkflowDocument { const workflow = this.requireWorkflow(id); return parseWorkflowDocument({ product: "GameBrowser", version: 1, kind: "read-only-workflow", workflow: { name: workflow.name, steps: workflow.steps } }); }
  deleteWorkflow(id: string): void {
    this.requireWorkflow(id);
    if ([...this.jobs.values()].some(job => job.workflowId === id && ["queued", "running"].includes(job.status))) throw new Error("Cancel active jobs before deleting this workflow");
    const workflows = new Map(this.workflows), schedules = new Map(this.schedules); workflows.delete(id);
    for (const [key, schedule] of schedules) if (schedule.workflowId === id) schedules.delete(key);
    this.persist(workflows, schedules); this.workflows = workflows; this.schedules = schedules; this.changed();
  }
  listJobs(): WorkflowJob[] { return clone([...this.jobs.values()].reverse()); }
  getJob(id: string): WorkflowJob { const job = this.jobs.get(id); if (!job) throw new Error("Workflow job was not found"); return clone(job); }
  run(workflowId: string, profileId: string, trigger: WorkflowJob["trigger"] = "manual"): WorkflowJob {
    if (this.closed) throw new Error("Local workflows are stopped");
    assertSafeProfileId(profileId); const workflow = this.requireWorkflow(workflowId);
    if (!["manual", "schedule"].includes(trigger)) throw new Error("Workflow trigger is invalid");
    if (!this.options.canRunProfile(profileId)) throw new Error("This profile must be running in manual control");
    if (this.pending.length >= WORKFLOW_LIMITS.queued) throw new Error("Local workflow queue is full");
    const job: WorkflowJob = { id: fresh("job"), workflowId, profileId, trigger, status: "queued", stepIndex: 0, stepCount: workflow.steps.length, createdAt: this.now(), steps: [], outputsAvailable: false };
    const jobs = new Map(this.jobs), retired: string[] = [];
    while (jobs.size >= WORKFLOW_LIMITS.jobs) {
      const removable = [...jobs.values()].find(candidate => !["queued", "running"].includes(candidate.status) && !this.active.has(candidate.id));
      if (!removable) throw new Error("Local workflow history is full");
      jobs.delete(removable.id); retired.push(removable.id);
    }
    jobs.set(job.id, job); this.persist(this.workflows, this.schedules, jobs); this.jobs = jobs;
    for (const id of retired) this.outputs.delete(id);
    this.definitions.set(job.id, clone(workflow)); this.controllers.set(job.id, new AbortController()); this.pending.push(job.id);
    this.changed(); this.pump(); return this.getJob(job.id);
  }
  cancel(id: string): WorkflowJob {
    const job = this.getJob(id);
    if (!["queued", "running"].includes(job.status)) return job;
    this.controllers.get(id)?.abort(); this.pending = this.pending.filter(key => key !== id);
    this.updateJob(id, { status: "cancelled", finishedAt: this.now(), error: "Workflow cancelled", outputsAvailable: false }); this.outputs.delete(id);
    if (!this.active.has(id)) { this.controllers.delete(id); this.definitions.delete(id); }
    this.pump(); return this.getJob(id);
  }
  getOutput(id: string): WorkflowOutput {
    const job = this.getJob(id), values = this.outputs.get(id);
    if (job.status !== "completed" || !values) throw new Error("Completed workflow output is not available in this app session");
    return { jobId: id, workflowId: job.workflowId, profileId: job.profileId, values: clone(values) };
  }
  exportOutput(id: string, format: "json" | "csv"): string {
    const output = this.getOutput(id);
    if (format === "json") return JSON.stringify(output, null, 2);
    if (format !== "csv") throw new Error("Choose JSON or CSV output");
    const cell = (value: string) => `"${(/^[\s]*[=+\-@]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
    return ["field,value", ...Object.entries(output.values).map(([key, value]) => `${cell(key)},${cell(value)}`)].join("\r\n");
  }
  listSchedules(): WorkflowSchedule[] { return clone([...this.schedules.values()]); }
  createSchedule(value: unknown): WorkflowSchedule {
    if (this.schedules.size >= WORKFLOW_LIMITS.schedules) throw new Error("Use at most 64 local workflow schedules");
    const row = object(value); fields(row, ["workflowId", "profileId", "kind", "enabled", "runAt", "intervalMs"]);
    const schedule = this.normalizeSchedule({ ...row, id: fresh("schedule"), enabled: row.enabled ?? true, createdAt: this.now() });
    const schedules = new Map(this.schedules); schedules.set(schedule.id, schedule); this.persist(this.workflows, schedules); this.schedules = schedules; this.changed(); return clone(schedule);
  }
  updateSchedule(id: string, value: unknown): WorkflowSchedule {
    const previous = this.schedules.get(id); if (!previous) throw new Error("Workflow schedule was not found");
    const row = object(value); fields(row, ["workflowId", "profileId", "kind", "enabled", "runAt", "intervalMs"]);
    const merged: Record<string, unknown> = { ...previous, ...row, nextRunAt: undefined };
    if (row.kind !== undefined && row.kind !== previous.kind) {
      if (row.kind === "once") delete merged.intervalMs;
      else if (row.kind === "interval") delete merged.runAt;
    }
    const schedule = this.normalizeSchedule(merged);
    const schedules = new Map(this.schedules); schedules.set(id, schedule); this.persist(this.workflows, schedules); this.schedules = schedules; this.changed(); return clone(schedule);
  }
  deleteSchedule(id: string): void {
    if (!this.schedules.has(id)) throw new Error("Workflow schedule was not found");
    const schedules = new Map(this.schedules); schedules.delete(id); this.persist(this.workflows, schedules); this.schedules = schedules; this.changed();
  }
  start(): void { if (this.timer) return; this.closed = false; this.tick(); this.timer = setInterval(() => this.tick(), 1000); this.timer.unref?.(); }
  /** Schedules only advance while this method/app timer runs. No offline catch-up. */
  tick(): void {
    if (this.closed) return;
    const now = this.now();
    for (const schedule of [...this.schedules.values()]) {
      if (!schedule.enabled || schedule.nextRunAt > now) continue;
      const next: WorkflowSchedule = { ...schedule, enabled: schedule.kind === "interval", nextRunAt: schedule.kind === "interval" ? now + schedule.intervalMs! : schedule.nextRunAt, lastRunAt: now, lastResult: "skipped" };
      const schedules = new Map(this.schedules); schedules.set(schedule.id, next);
      try {
        // Save the consumed occurrence before dispatch so a restart cannot replay it.
        this.persist(this.workflows, schedules); this.schedules = schedules;
        const job = this.run(schedule.workflowId, schedule.profileId, "schedule");
        next.lastJobId = job.id; next.lastResult = "queued";
        this.schedules.set(schedule.id, next); this.persist();
      } catch { /* Unavailable/manual-disabled profiles skip this occurrence. */ }
      this.changed();
    }
  }
  /** Internal teardown hook: the owner must first stop the browser profile. */
  removeProfile(profileId: string): void {
    assertSafeProfileId(profileId);
    const schedules = new Map(this.schedules), jobs = new Map(this.jobs);
    for (const [id, row] of schedules) if (row.profileId === profileId) schedules.delete(id);
    const removed: string[] = [];
    for (const [id, row] of jobs) if (row.profileId === profileId) { jobs.delete(id); removed.push(id); }
    this.persist(this.workflows, schedules, jobs); this.schedules = schedules; this.jobs = jobs;
    this.pending = this.pending.filter(id => !removed.includes(id));
    for (const id of removed) { this.controllers.get(id)?.abort(); this.outputs.delete(id); if (!this.active.has(id)) { this.controllers.delete(id); this.definitions.delete(id); } }
    this.changed();
  }
  stop(): void {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const job of this.jobs.values()) if (["queued", "running"].includes(job.status)) {
      this.controllers.get(job.id)?.abort(); this.outputs.delete(job.id);
      this.updateJob(job.id, { status: "interrupted", finishedAt: this.now(), error: "Application stopped", outputsAvailable: false });
      if (!this.active.has(job.id)) { this.controllers.delete(job.id); this.definitions.delete(job.id); }
    }
    this.pending = [];
  }
  private pump(): void {
    if (this.closed) return;
    while (this.active.size < WORKFLOW_LIMITS.concurrency) {
      const index = this.pending.findIndex(id => { const job = this.jobs.get(id); return !!job && !this.activeProfiles.has(job.profileId); });
      if (index < 0) break;
      const [id] = this.pending.splice(index, 1), job = this.jobs.get(id!); if (!job) continue;
      this.active.add(job.id); this.activeProfiles.add(job.profileId);
      void this.executeJob(job.id).finally(() => { this.active.delete(job.id); this.activeProfiles.delete(job.profileId); this.controllers.delete(job.id); this.definitions.delete(job.id); this.pump(); });
    }
  }
  private async executeJob(id: string): Promise<void> {
    const job = this.jobs.get(id), definition = this.definitions.get(id), controller = this.controllers.get(id);
    if (!job || !definition || !controller) return;
    const timer = setTimeout(() => {
      if (this.jobs.get(id)?.status !== "running") return;
      controller.abort(); this.outputs.delete(id);
      this.updateJob(id, { status: "timedout", finishedAt: this.now(), error: "Workflow exceeded its time limit", outputsAvailable: false });
    }, this.timeoutMs); timer.unref?.();
    try {
      this.updateJob(id, { status: "running", startedAt: this.now() });
      const values: Record<string, string> = {};
      for (let index = 0; index < definition.steps.length; index++) {
        if (controller.signal.aborted || !this.jobs.has(id)) return;
        if (!this.options.canRunProfile(job.profileId)) throw new Error("This profile must be running in manual control");
        const step = definition.steps[index]!;
        const audit: WorkflowStepStatus = { index, kind: step.kind, status: "running", startedAt: this.now() };
        this.updateJob(id, { stepIndex: index, steps: [...(this.jobs.get(id)?.steps ?? []), audit] });
        const result = step.kind === "wait" ? await wait(step.ms, controller.signal) : await this.options.execute(job.profileId, clone(step), controller.signal);
        if (controller.signal.aborted || !this.jobs.has(id)) return;
        if (!this.options.canRunProfile(job.profileId)) throw new Error("This profile must be running in manual control");
        if (step.kind === "extract") {
          if (typeof result !== "string") throw new Error("Workflow execution failed");
          const clean = step.source === "url" ? publicPageUrl(result) : result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
          if (clean.length > (step.source === "title" ? 512 : WORKFLOW_LIMITS.textChars)) throw new Error("Workflow output exceeds its limit");
          values[step.field] = clean;
          if (Buffer.byteLength(JSON.stringify(values)) > WORKFLOW_LIMITS.outputBytes) throw new Error("Workflow output exceeds its limit");
        }
        audit.status = "completed"; audit.finishedAt = this.now();
        const steps = [...(this.jobs.get(id)?.steps ?? [])]; steps[index] = audit;
        this.updateJob(id, { stepIndex: index + 1, steps });
      }
      this.outputs.set(id, values); this.updateJob(id, { status: "completed", finishedAt: this.now(), outputsAvailable: true });
    } catch (error) {
      if (controller.signal.aborted || !this.jobs.has(id)) return;
      const message = error instanceof Error && safeErrors.has(error.message) ? error.message : "Workflow execution failed";
      const steps = clone(this.jobs.get(id)?.steps ?? []); const last = steps.at(-1); if (last?.status === "running") { last.status = "failed"; last.finishedAt = this.now(); }
      this.outputs.delete(id); this.updateJob(id, { status: "failed", finishedAt: this.now(), error: message, steps, outputsAvailable: false });
    } finally { clearTimeout(timer); }
  }
  private updateJob(id: string, patch: Partial<WorkflowJob>): void {
    const previous = this.jobs.get(id); if (!previous) return;
    this.jobs.set(id, { ...previous, ...patch });
    // Cancellation must stay effective even when the status disk is unavailable.
    try { this.persist(); } catch { this.storageFailed = true; }
    this.changed();
  }
  private requireWorkflow(id: string): WorkflowDefinition { const value = this.workflows.get(id); if (!value) throw new Error("Local workflow was not found"); return value; }
  private normalizeSchedule(value: Record<string, unknown>, restoring = false): WorkflowSchedule {
    if (typeof value.workflowId !== "string") throw new Error("Workflow identifier is invalid");
    this.requireWorkflow(value.workflowId); assertSafeProfileId(value.profileId);
    if (typeof value.enabled !== "boolean" || typeof value.kind !== "string" || !["once", "interval"].includes(value.kind)) throw new Error("Schedule must be a one-off time or an interval");
    const schedule: WorkflowSchedule = { id: String(value.id), workflowId: String(value.workflowId), profileId: value.profileId as string, kind: value.kind as WorkflowSchedule["kind"], enabled: value.enabled, createdAt: timestamp(value.createdAt), nextRunAt: 0 };
    if (schedule.kind === "once") {
      if (value.intervalMs !== undefined) throw new Error("One-off schedules do not accept an interval");
      schedule.runAt = timestamp(value.runAt); schedule.nextRunAt = schedule.runAt;
      if (!restoring && schedule.enabled && schedule.runAt <= this.now()) throw new Error("Choose a future one-off run time");
    } else {
      if (value.runAt !== undefined) throw new Error("Interval schedules do not accept a one-off run time");
      schedule.intervalMs = integer(value.intervalMs, 60000, 7 * 86400000, "Interval must be from one minute to seven days");
      schedule.nextRunAt = value.nextRunAt === undefined ? this.now() + schedule.intervalMs : timestamp(value.nextRunAt);
    }
    if (value.lastRunAt !== undefined) schedule.lastRunAt = timestamp(value.lastRunAt);
    if (value.lastJobId !== undefined) { if (typeof value.lastJobId !== "string" || !jobPattern.test(value.lastJobId)) throw new Error("Invalid scheduled job"); schedule.lastJobId = value.lastJobId; }
    if (value.lastResult !== undefined) { if (typeof value.lastResult !== "string" || !["queued", "skipped", "missed_offline"].includes(value.lastResult)) throw new Error("Invalid schedule status"); schedule.lastResult = value.lastResult as WorkflowSchedule["lastResult"]; }
    return schedule;
  }
  private restoreStepStatus(value: unknown): WorkflowStepStatus[] {
    if (!Array.isArray(value) || value.length > WORKFLOW_LIMITS.steps) throw new Error("Invalid workflow progress");
    return value.map((entry, index) => {
      const row = object(entry); if (row.index !== index || typeof row.kind !== "string" || !["navigate", "wait", "scroll", "extract"].includes(row.kind) || typeof row.status !== "string" || !["running", "completed", "failed"].includes(row.status)) throw new Error("Invalid workflow progress");
      return { index, kind: row.kind as WorkflowStep["kind"], status: row.status as WorkflowStepStatus["status"], startedAt: timestamp(row.startedAt), ...(row.finishedAt !== undefined ? { finishedAt: timestamp(row.finishedAt) } : {}) };
    });
  }
  private changed(): void { try { this.options.onChange?.(); } catch { /* Observers do not own workflow lifecycle. */ } }
  private persist(workflows = this.workflows, schedules = this.schedules, jobs = this.jobs): void {
    const data = JSON.stringify({ version: 1, workflows: [...workflows.values()], schedules: [...schedules.values()], jobs: [...jobs.values()].map(({ outputsAvailable: _available, ...job }) => job) });
    if (Buffer.byteLength(data) > WORKFLOW_LIMITS.storageBytes) throw new Error("Workflow storage exceeds 8 MiB");
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, data, { mode: 0o600, flag: "wx" }); renameSync(temporary, this.file); this.storageFailed = false; }
    catch (error) { this.storageFailed = true; throw error; }
    finally { rmSync(temporary, { force: true }); }
  }
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Workflow cancelled")); return; }
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", cancelled); resolve(); }
    function cancelled() { clearTimeout(timer); signal.removeEventListener("abort", cancelled); reject(new Error("Workflow cancelled")); }
    signal.addEventListener("abort", cancelled, { once: true });
  });
}
