import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserSyncLifecycle, BrowserSyncPlan, BrowserSyncPolicy, BrowserSyncState } from "../browser-sync.ts";
import { isSafeProfileId } from "../profile-id.ts";
import { approvedOrigin } from "./protocol.ts";
import type { SyncRelay } from "./syncRelay.ts";

export interface RelaySessionControllerOptions {
  stateRoot: string;
  relay: SyncRelay;
  profileExists(id: string): boolean;
  hasLaunch(id: string): boolean;
  isAuthorized?(id: string): boolean;
  setManual(id: string, enabled: boolean): void;
  changed?(): void;
}

/** The standalone StakeMode controller: desired assignments are independent of
 * browser connections. Only explicit user commands replace or remove the plan.
 * Browser capture/replay belongs exclusively to the authenticated relay. */
export class RelaySessionController implements BrowserSyncLifecycle {
  private desired?: BrowserSyncPlan;
  private revision = 0;
  get generation(): number { return this.revision; }
  private saved?: BrowserSyncPlan;
  private error: string | null = null;
  private suspended = false;
  private policy?: BrowserSyncPolicy;
  private readonly file: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RelaySessionControllerOptions) {
    this.file = join(options.stateRoot, "workspace", "following-session.json");
    if (existsSync(this.file)) {
      try {
        const raw = readFileSync(this.file, "utf8");
        if (raw.length > 65536) throw new Error("Saved following session exceeds its limit");
        const value = JSON.parse(raw);
        if (value.version !== 1) throw new Error("Saved following session is invalid");
        if (value.forgotten !== true) this.saved = selection(value.adminId, value.followerIds);
      } catch { this.error = "The saved following session could not be read; choose profiles and save it again"; }
    }
  }
  status(): BrowserSyncState {
    const plan = this.desired;
    const statuses = new Map(this.options.relay.statuses().map(row => [row.profileId, row]));
    const ready = (id: string) => this.options.profileExists(id) && this.options.hasLaunch(id)
      && this.options.isAuthorized?.(id) !== false && !!statuses.get(id)?.connected && !statuses.get(id)?.paused
      && statuses.get(id)?.role === (id === plan?.adminId ? "admin" : "follower");
    const ids = plan ? [plan.adminId, ...plan.followerIds] : [];
    const failedFollowerIds = plan?.followerIds.filter(id => !ready(id)) ?? [];
    const unavailable = ids.some(id => !this.options.profileExists(id) || !this.options.hasLaunch(id) || !statuses.get(id)?.connected);
    const active = !!plan && !this.suspended && ready(plan.adminId) && plan.followerIds.some(ready);
    const paused = !!plan && !unavailable && !active;
    return { active, starting: false, waiting: !!plan && unavailable && !this.suspended,
      saved: !!this.saved, adminId: plan?.adminId ?? null, followerIds: [...plan?.followerIds ?? []],
      savedAdminId: this.saved?.adminId ?? null, savedFollowerIds: [...this.saved?.followerIds ?? []], failedFollowerIds,
      error: this.error ?? (paused ? "Following is paused. Assigned roles are retained; review the profiles and reconnect when ready" : null) };
  }
  currentPolicy(): BrowserSyncPolicy | undefined { return this.policy && structuredClone(this.policy); }
  configurePolicy(policy: BrowserSyncPolicy | undefined): Promise<BrowserSyncState> {
    return this.enqueue(() => {
      if (!policy) { this.policy = undefined; return; }
      if (!Array.isArray(policy.origins) || policy.origins.length > 32 || !["fast", "paced"].includes(policy.pacing)
        || policy.sensitiveControls !== "manual" || policy.pausedProfileIds?.some(id => !isSafeProfileId(id))) throw new Error("Following policy is invalid");
      const next = { ...policy, origins: policy.origins.map(approvedOrigin), pausedProfileIds: [...policy.pausedProfileIds ?? []] };
      this.options.relay.configure(next.origins, next.pacing);
      this.policy = next;
    });
  }
  start(adminId: unknown, followerIds: unknown, saveSession?: boolean): Promise<BrowserSyncState> {
    return this.enqueue(() => {
      const plan = selection(adminId, followerIds);
      this.assertPlan(plan);
      if (saveSession !== undefined && typeof saveSession !== "boolean") throw new Error("Save session must be boolean");
      if (saveSession === true) this.persist(plan);
      else if (saveSession === false) this.persist(undefined);
      this.apply(plan);
    });
  }
  resume(): Promise<BrowserSyncState> {
    return this.enqueue(() => {
      if (!this.saved) throw new Error("Save a following session before resuming it");
      const plan = clonePlan(this.saved); this.assertPlan(plan); this.apply(plan);
    });
  }
  save(enabled: boolean): Promise<BrowserSyncState> {
    return this.enqueue(() => {
      if (typeof enabled !== "boolean") throw new Error("Save session must be boolean");
      if (enabled && !this.desired) throw new Error("Choose an Admin and followers before saving the session");
      this.persist(enabled ? this.desired : undefined);
    });
  }
  stop(): Promise<BrowserSyncState> {
    return this.enqueue(() => {
      this.revision++; this.desired = undefined; this.error = null; this.suspended = false;
      this.options.relay.setGroup(null, []);
    });
  }
  suspend(message: string): Promise<BrowserSyncState> {
    return this.enqueue(() => {
      this.revision++; this.suspended = true; this.error = message.slice(0, 200);
      if (this.desired) for (const id of [this.desired.adminId, ...this.desired.followerIds]) {
        if (this.options.relay.configFor(id)) this.options.relay.interrupt(id, "session_suspended");
      }
    });
  }
  private apply(plan: BrowserSyncPlan): void {
    // Policy changes and role selection do not start or close native browsers.
    for (const id of [plan.adminId, ...plan.followerIds]) this.options.setManual(id, false);
    this.revision++; this.desired = clonePlan(plan); this.suspended = false; this.error = null;
    this.options.relay.setGroup(plan.adminId, plan.followerIds);
    const paused = new Set(this.policy?.pausedProfileIds ?? []);
    for (const id of [plan.adminId, ...plan.followerIds]) this.options.relay.setPaused(id, paused.has(id));
  }
  private assertPlan(plan: BrowserSyncPlan): void {
    for (const id of [plan.adminId, ...plan.followerIds]) {
      if (!this.options.profileExists(id)) throw new Error("A following profile no longer exists; choose the group again");
      if (this.options.isAuthorized?.(id) === false) throw new Error("Profile edit access changed; following assignments were not changed");
    }
  }
  private persist(plan: BrowserSyncPlan | undefined): void {
    mkdirSync(join(this.options.stateRoot, "workspace"), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    // An empty record forgets the plan without deleting another process's file.
    writeFileSync(temporary, JSON.stringify(plan ? { version: 1, ...plan } : { version: 1, forgotten: true }), { mode: 0o600 });
    renameSync(temporary, this.file); this.saved = plan && clonePlan(plan);
  }
  private enqueue(change: () => void): Promise<BrowserSyncState> {
    const pending = this.operation.then(() => { change(); this.options.changed?.(); return this.status(); });
    this.operation = pending.catch(() => {}); return pending;
  }
}
function selection(adminId: unknown, followerIds: unknown): BrowserSyncPlan {
  if (!isSafeProfileId(adminId) || !Array.isArray(followerIds) || followerIds.length < 1 || followerIds.length > 255
    || followerIds.some(id => !isSafeProfileId(id)) || followerIds.includes(adminId) || new Set(followerIds).size !== followerIds.length) {
    throw new Error("Choose one Admin and 1–255 different follower profiles");
  }
  return { adminId, followerIds: [...followerIds] };
}
function clonePlan(plan: BrowserSyncPlan): BrowserSyncPlan { return { adminId: plan.adminId, followerIds: [...plan.followerIds] }; }
