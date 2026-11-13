import { expect, test } from "bun:test";
import { ManagementRoutes } from "./managementRoutes.ts";

function fixture(callbacks: { onRoleChange?: (id: string, role: "admin" | "follower" | "manual") => Promise<void>;
  onPauseChange?: (id: string, enabled: boolean) => Promise<void> }) {
  const routes = new ManagementRoutes({
    manager: { getProfile: (id: string) => ({ id }), setManual: () => { throw new Error("Legacy manual path must not run"); } } as any,
    relay: { setRole: () => { throw new Error("Legacy role path must not run"); }, setPaused: () => { throw new Error("Legacy pause path must not run"); } } as any,
    bridge: {} as any, extensions: {} as any, library: {} as any, snapshot: () => ({}), changed: () => {},
    openExtensionPage: async () => ({}), ...callbacks,
  });
  return async (body: unknown) => {
    const request = new Request("http://127.0.0.1/workspace/api/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await routes.handle(request, new URL(request.url)))!;
  };
}

test("batch pause and resume await integrated worker policy changes before reporting success", async () => {
  let release!: () => void, finished = false;
  const pending = new Promise<void>(done => { release = done; });
  const events: string[] = [];
  const call = fixture({ onPauseChange: async (id, enabled) => {
    events.push(`${id}:${enabled}:start`);
    if (id === "profile-one" && enabled) await pending;
    events.push(`${id}:${enabled}:done`);
  } });
  const task = call({ action: "pause", profileIds: ["profile-one", "profile-two"], enabled: true }).then(response => { finished = true; return response; });
  const end = Date.now() + 1000;
  while (!events.length) { if (Date.now() > end) throw new Error("Worker callback was not reached"); await new Promise(done => setTimeout(done, 1)); }
  expect(finished).toBe(false); expect(events).toEqual(["profile-one:true:start"]);
  release();
  const response = await task;
  expect((await response.json()).results).toEqual([{ profileId: "profile-one", ok: true }, { profileId: "profile-two", ok: true }]);
  expect(events).toEqual(["profile-one:true:start", "profile-one:true:done", "profile-two:true:start", "profile-two:true:done"]);
  expect((await call({ action: "pause", profileIds: ["profile-one"], enabled: false })).status).toBe(200);
  expect(events.slice(-2)).toEqual(["profile-one:false:start", "profile-one:false:done"]);
});

test("batch manual and follower changes use the integrated worker and retain callback failures", async () => {
  const roles: string[] = [];
  const call = fixture({ onRoleChange: async (id, role) => { roles.push(`${id}:${role}`); if (id === "profile-two") throw new Error("Control change rejected"); } });
  const response = await call({ action: "manual", profileIds: ["profile-one", "profile-two"], enabled: true });
  expect((await response.json()).results).toEqual([{ profileId: "profile-one", ok: true }, { profileId: "profile-two", ok: false, error: "Control change rejected" }]);
  expect(roles).toEqual(["profile-one:manual", "profile-two:manual"]);
  expect((await call({ action: "manual", profileIds: ["profile-one"], enabled: false })).status).toBe(200);
  expect(roles.at(-1)).toBe("profile-one:follower");
});
