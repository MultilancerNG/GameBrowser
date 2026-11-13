import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceWorkflowEngine } from "./workflowEngine.ts";
import { WorkflowRoutes } from "./workflowRoutes.ts";

test("workflow results and schedules follow current profile access, including direct output URLs", async () => {
  const root = mkdtempSync(join(tmpdir(), "gamebrowser-workflow-scope-"));
  const visible = new Set(["profile-one", "profile-two"]);
  const engine = new WorkspaceWorkflowEngine({ stateRoot: root, canRunProfile: () => true,
    execute: async id => `${id}:private-result` });
  const manager = { getProfile: (id: string) => visible.has(id) ? { id, overBudget: true, budgetAction: "notify" } : null,
    getLaunch: () => ({}) } as any;
  const routes = new WorkflowRoutes(engine, manager);
  const call = async (path: string, method = "GET", body?: unknown) => {
    const request = new Request(`http://127.0.0.1/workspace/api/${path}`, { method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return (await routes.handle(request, new URL(request.url)))!;
  };
  try {
    const workflow = engine.saveWorkflow({ name: "Read current title", steps: [{ kind: "extract", source: "title", field: "title" }] });
    const first = engine.run(workflow.id, "profile-one"), second = engine.run(workflow.id, "profile-two");
    const end = Date.now() + 2000;
    while (engine.listJobs().some(job => ["queued", "running"].includes(job.status))) {
      if (Date.now() > end) throw new Error("Workflow did not settle");
      await new Promise(done => setTimeout(done, 5));
    }
    const schedule = engine.createSchedule({ workflowId: workflow.id, profileId: "profile-two", kind: "interval", intervalMs: 60000 });
    visible.delete("profile-two");
    expect((await (await call("jobs")).json()).jobs.map((job: any) => job.id)).toEqual([first.id]);
    for (const path of [`jobs/${second.id}`, `jobs/${second.id}/output`, `jobs/${second.id}/cancel`]) {
      const response = await call(path, path.endsWith("cancel") ? "POST" : "GET", path.endsWith("cancel") ? {} : undefined);
      expect(response.status).toBe(404); expect(JSON.stringify(await response.json())).not.toContain("private-result");
    }
    expect((await (await call("schedules")).json()).schedules).toEqual([]);
    expect((await call(`schedules/${schedule.id}`, "DELETE")).status).toBe(404);
    expect((await call(`schedules/${schedule.id}`, "POST", { enabled: false })).status).toBe(404);
    expect((await call(`workflows/${workflow.id}/run`, "POST", { profileIds: ["profile-two"] })).status).toBe(409);
    const allowed = await call(`workflows/${workflow.id}/run`, "POST", { profileIds: ["profile-one"] });
    expect(allowed.status).toBe(200); expect((await allowed.json()).jobs).toHaveLength(1); // Notify is not an automatic stop.
  } finally { await engine.stop(); rmSync(root, { recursive: true, force: true }); }
});
