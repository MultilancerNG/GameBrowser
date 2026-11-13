import { boundedJson } from "./protocol.ts";
import { builtinWorkflows, WORKFLOW_LIMITS, WorkspaceWorkflowEngine } from "./workflowEngine.ts";
import type { ProcessManager } from "./processManager.ts";

/** All calls require the local workspace's existing dashboard authentication. */
export class WorkflowRoutes {
  constructor(private engine: WorkspaceWorkflowEngine, private manager: ProcessManager) {}
  async handle(request: Request, url: URL): Promise<Response | undefined> {
    const path = url.pathname.slice("/workspace/api/".length);
    if (!/^(?:workflows|jobs|schedules)(?:\/|$)/.test(path)) return undefined;
    try {
      if (path === "workflows" && request.method === "GET") return json({ workflows: this.engine.listWorkflows(), templates: builtinWorkflows(), limits: WORKFLOW_LIMITS, storageWarning: this.engine.storageWarning });
      if (path === "workflows" && request.method === "POST") return json({ workflow: this.engine.saveWorkflow(await boundedJson(request, WORKFLOW_LIMITS.documentBytes + 1024)) });
      if (path === "workflows/import" && request.method === "POST") return json({ workflow: this.engine.importWorkflow((await boundedJson(request, WORKFLOW_LIMITS.documentBytes + 1024)).document) });
      const workflow = /^workflows\/(wf_[a-f0-9]{32})(?:\/(run|export))?$/.exec(path);
      if (workflow) {
        const id = workflow[1]!;
        if (!workflow[2] && request.method === "GET") return json({ workflow: this.engine.getWorkflow(id) });
        if (!workflow[2] && request.method === "DELETE") { this.engine.deleteWorkflow(id); return json({ workflows: this.engine.listWorkflows() }); }
        if (workflow[2] === "export" && request.method === "GET") return json({ document: this.engine.exportWorkflow(id) });
        if (workflow[2] === "run" && request.method === "POST") {
          const body = await boundedJson(request);
          if (!Array.isArray(body.profileIds) || !body.profileIds.length || body.profileIds.length > 16 || body.profileIds.some(id => typeof id !== "string") || new Set(body.profileIds).size !== body.profileIds.length) throw new Error("Choose 1 to 16 different running manual profiles");
          for (const profileId of body.profileIds as string[]) {
            const profile = this.manager.getProfile(profileId);
            if (!profile || !this.manager.getLaunch(profileId) || (profile.overBudget && profile.budgetAction !== "notify")) return json({ error: "Every selected profile must be running with available manual control" }, 409);
          }
          const jobs: unknown[] = [], rejected: Array<{ profileId: string; error: string }> = [];
          for (const profileId of body.profileIds as string[]) {
            try { jobs.push(this.engine.run(id, profileId)); }
            catch (error) { rejected.push({ profileId, error: message(error) }); }
          }
          return json({ jobs, rejected });
        }
      }
      if (path === "jobs" && request.method === "GET") return json({ jobs: this.engine.listJobs().filter(job => !!this.manager.getProfile(job.profileId)), storageWarning: this.engine.storageWarning });
      const job = /^jobs\/(job_[a-f0-9]{32})(?:\/(cancel|output))?$/.exec(path);
      if (job) {
        const id = job[1]!;
        if (!this.manager.getProfile(this.engine.getJob(id).profileId)) return json({ error: "Workflow job was not found" }, 404);
        if (!job[2] && request.method === "GET") return json({ job: this.engine.getJob(id) });
        if (job[2] === "cancel" && request.method === "POST") { await boundedJson(request); return json({ job: this.engine.cancel(id) }); }
        if (job[2] === "output" && request.method === "GET") {
          const format = url.searchParams.get("format") ?? "json";
          if (format !== "json" && format !== "csv") throw new Error("Choose JSON or CSV output");
          return json({ format, filename: `gamebrowser-${id}.${format}`, content: this.engine.exportOutput(id, format) });
        }
      }
      const visibleSchedules = () => this.engine.listSchedules().filter(schedule => !!this.manager.getProfile(schedule.profileId));
      if (path === "schedules" && request.method === "GET") return json({ schedules: visibleSchedules(), appMustRemainOpen: true });
      if (path === "schedules" && request.method === "POST") {
        const body = await boundedJson(request);
        if (typeof body.profileId !== "string" || !this.manager.getProfile(body.profileId)) throw new Error("Choose an existing local profile");
        return json({ schedule: this.engine.createSchedule(body), schedules: visibleSchedules() });
      }
      const schedule = /^schedules\/(schedule_[a-f0-9]{32})$/.exec(path);
      if (schedule && !visibleSchedules().some(item => item.id === schedule[1])) return json({ error: "Workflow schedule was not found" }, 404);
      if (schedule && request.method === "POST") {
        const body = await boundedJson(request);
        if (Object.hasOwn(body, "profileId") && (typeof body.profileId !== "string" || !this.manager.getProfile(body.profileId))) throw new Error("Choose an existing local profile");
        return json({ schedule: this.engine.updateSchedule(schedule[1]!, body), schedules: visibleSchedules() });
      }
      if (schedule && request.method === "DELETE") { this.engine.deleteSchedule(schedule[1]!); return json({ schedules: visibleSchedules() }); }
      return json({ error: "Method or workflow route not allowed" }, 405);
    } catch (error) { return json({ error: message(error) }, 400); }
  }
}
function message(error: unknown): string { return error instanceof Error && error.message.length <= 200 ? error.message : "Local workflow request failed"; }
function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }); }
