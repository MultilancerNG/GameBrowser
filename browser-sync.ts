import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isSafeProfileId } from "./profile-id.ts";
import { playwrightWorkerEnvironment, resolvePlaywrightRuntime } from "./playwright-runtime.ts";

export interface BrowserSyncPlan { adminId: string; followerIds: string[] }
export interface BrowserSyncPolicy {
  origins: string[];
  pacing: "fast" | "paced";
  sensitiveControls: "manual";
  pausedProfileIds?: string[];
}

export interface BrowserSyncState {
  active: boolean;
  starting: boolean;
  waiting: boolean;
  saved: boolean;
  /** Desired roles remain fixed while a browser is closed or needs attention. */
  adminId: string | null;
  followerIds: string[];
  savedAdminId: string | null;
  savedFollowerIds: string[];
  failedFollowerIds: string[];
  error: string | null;
}

export interface BrowserSyncTarget {
  id: string;
  engine: "chromium" | "firefox";
  endpoint: string;
  /** Internal ownership snapshot; never sent to the UI or worker. */
  generation: string;
}

export interface BrowserSyncChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  once(event: "exit" | "close" | "error", listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface BrowserSyncOptions {
  scope(): string | undefined;
  /** Authorizes the logical group even while its browser windows are closed. */
  authorizePlan?(ids: readonly string[]): Promise<void>;
  resolveTargets(ids: readonly string[]): Promise<BrowserSyncTarget[]>;
  current(targets: readonly BrowserSyncTarget[]): boolean;
  authorize?(targets: readonly BrowserSyncTarget[]): Promise<void>;
  loadSaved?(scope: string): BrowserSyncPlan | null;
  savePlan?(scope: string, plan: BrowserSyncPlan | null): void;
  spawnChild?(command: readonly string[]): BrowserSyncChild;
  runtimeRoot?: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  guardIntervalMs?: number;
  retryIntervalMs?: number;
  authorizationIntervalMs?: number;
}

export interface BrowserSyncLifecycle {
  status(): BrowserSyncState;
  start(adminId: unknown, followerIds: unknown, saveSession?: boolean): Promise<BrowserSyncState>;
  stop(): Promise<BrowserSyncState>;
  resume(): Promise<BrowserSyncState>;
  save(saveSession: boolean): Promise<BrowserSyncState>;
  configurePolicy?(policy: BrowserSyncPolicy | undefined, reconnect?: boolean): Promise<BrowserSyncState>;
  currentPolicy?(): BrowserSyncPolicy | undefined;
  suspend?(message: string): Promise<BrowserSyncState>;
}

export class BrowserSyncError extends Error {
  constructor(message: string, readonly status = 400, readonly reason?: "browser-unavailable") { super(message); }
}

export function browserSyncSelection(adminId: unknown, followerIds: unknown): BrowserSyncPlan {
  if (!isSafeProfileId(adminId) || !Array.isArray(followerIds) || followerIds.length < 1 || followerIds.length > 20
    || followerIds.some((id) => !isSafeProfileId(id)) || followerIds.includes(adminId)
    || new Set(followerIds).size !== followerIds.length) {
    throw new BrowserSyncError("Choose one Admin and 1–20 different follower profiles");
  }
  return { adminId, followerIds: [...followerIds] };
}

interface DesiredPlan extends BrowserSyncPlan {
  scope: string;
  state: "connecting" | "active" | "waiting" | "attention";
  failed: Set<string>;
  lastAttempt: number;
  lastAuthorization: number;
  authorizing: boolean;
  guard?: ReturnType<typeof setInterval>;
}

interface Session {
  plan: DesiredPlan;
  targets: BrowserSyncTarget[];
  child: BrowserSyncChild;
  ready: boolean;
  closing: boolean;
  exited: boolean;
  exit: Promise<void>;
  readyPromise: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  cleanup?: Promise<void>;
}

const CONNECTION_FAILED = "Browser mirroring stopped because a browser connection failed. Review the profiles before resuming";
const UNAVAILABLE = "Waiting for the configured browser profiles to reopen on this computer";
const TRANSIENT_REASONS = new Set(["admin-disconnected", "follower-disconnected", "connection-unavailable"]);

/** Retains desired roles separately from ephemeral automation connections. */
export class BrowserSyncRuntime implements BrowserSyncLifecycle {
  private desired?: DesiredPlan;
  private session?: Session;
  private requestGeneration = 0;
  private operation: Promise<unknown> = Promise.resolve();
  private error: string | null = null;
  private policy?: BrowserSyncPolicy;
  private policyScope?: string;

  constructor(private readonly options: BrowserSyncOptions) {}

  currentPolicy(): BrowserSyncPolicy | undefined { return this.policy && this.policyScope === this.currentScope() ? structuredClone(this.policy) : undefined; }

  configurePolicy(policy: BrowserSyncPolicy | undefined, reconnect = true): Promise<BrowserSyncState> {
    const scope = this.currentScope();
    if (!scope) throw new BrowserSyncError("Sign in before changing dispatch settings", 401);
    if (policy) {
      if (!Array.isArray(policy.origins) || policy.origins.length > 32 || !["fast", "paced"].includes(policy.pacing)
        || policy.sensitiveControls !== "manual" || policy.pausedProfileIds?.some(id => !isSafeProfileId(id))) throw new BrowserSyncError("Workspace dispatch settings are invalid");
      for (const origin of policy.origins) {
        let url: URL; try { url = new URL(origin); } catch { throw new BrowserSyncError("Use exact website origins"); }
        if (url.origin !== origin || url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new BrowserSyncError("Use exact HTTPS website origins");
      }
    }
    const next = policy ? structuredClone(policy) : undefined;
    if (this.policyScope === scope && JSON.stringify(next) === JSON.stringify(this.policy)) return Promise.resolve(this.status());
    this.policy = next; this.policyScope = scope;
    const generation = ++this.requestGeneration;
    this.cancelSession(this.session);
    return this.enqueue(async () => {
      this.assertCurrent(generation, scope);
      if (this.session) await this.close(this.session);
      const plan = this.desired;
      if (!plan || generation !== this.requestGeneration || plan.state === "attention") return this.status();
      this.assertPlan(plan, generation);
      if (!reconnect) { plan.state = "attention"; this.error = "Apply the configured group to use the changed dispatch settings"; return this.status(); }
      plan.state = "connecting";
      // New policy applies only to future actions; no previous URL/action is replayed.
      return this.connect(plan, generation, false);
    });
  }

  status(): BrowserSyncState {
    this.checkBoundary();
    const plan = this.desired;
    const session = this.session;
    if (plan && session?.plan === plan && !session.closing && !this.targetsCurrent(session.targets)) this.wait(plan);
    const saved = this.savedPlan();
    return {
      active: !!plan && plan.state === "active" && !!session?.ready && !session.closing && session.plan === plan,
      starting: plan?.state === "connecting",
      waiting: plan?.state === "waiting",
      saved: !!saved,
      adminId: plan?.adminId ?? null,
      followerIds: plan ? [...plan.followerIds] : [],
      savedAdminId: saved?.adminId ?? null,
      savedFollowerIds: saved ? [...saved.followerIds] : [],
      failedFollowerIds: plan ? [...plan.failed] : [],
      error: this.error,
    };
  }

  start(adminId: unknown, followerIds: unknown, saveSession = false): Promise<BrowserSyncState> {
    const selection = browserSyncSelection(adminId, followerIds);
    const scope = this.currentScope();
    if (!scope) throw new BrowserSyncError("Sign in before controlling Cloud browser profiles", 401);
    const generation = ++this.requestGeneration;
    this.clearDesired();
    this.cancelSession(this.session);
    return this.enqueue(async () => {
      this.assertCurrent(generation, scope);
      if (this.session) await this.close(this.session);
      await this.options.authorizePlan?.([selection.adminId, ...selection.followerIds]);
      this.assertCurrent(generation, scope);
      if (saveSession && !this.options.savePlan) throw new BrowserSyncError("Saved mirroring sessions are unavailable", 503);
      this.options.savePlan?.(scope, saveSession ? selection : null);
      const plan: DesiredPlan = {
        ...selection, scope, state: "connecting", failed: new Set(), lastAttempt: Date.now(),
        lastAuthorization: Date.now(), authorizing: false,
      };
      this.desired = plan;
      this.error = null;
      this.startGuard(plan);
      return this.connect(plan, generation, true);
    });
  }

  resume(): Promise<BrowserSyncState> {
    const saved = this.savedPlan();
    if (!saved) throw new BrowserSyncError("There is no saved mirroring session for this account", 404);
    return this.start(saved.adminId, saved.followerIds, true);
  }

  save(saveSession: boolean): Promise<BrowserSyncState> {
    const scope = this.currentScope(), generation = this.requestGeneration;
    if (!scope) throw new BrowserSyncError("Sign in before saving a Cloud mirroring session", 401);
    return this.enqueue(async () => {
      this.checkBoundary();
      this.assertCurrent(generation, scope);
      if (!this.options.savePlan) throw new BrowserSyncError("Saved mirroring sessions are unavailable", 503);
      const plan = this.desired;
      if (saveSession && !plan) throw new BrowserSyncError("Configure a mirroring group before saving it");
      this.options.savePlan(scope, saveSession && plan ? { adminId: plan.adminId, followerIds: [...plan.followerIds] } : null);
      return this.status();
    });
  }

  /** Access uncertainty stops actions while retaining the explicit role assignment. */
  suspend(message: string): Promise<BrowserSyncState> {
    ++this.requestGeneration;
    const plan = this.desired;
    if (plan) this.attention(plan, message);
    return this.enqueue(async () => { if (this.session) await this.close(this.session); return this.status(); });
  }

  stop(): Promise<BrowserSyncState> {
    ++this.requestGeneration;
    this.clearDesired();
    this.cancelSession(this.session);
    return this.enqueue(async () => {
      if (this.session) await this.close(this.session);
      this.error = null;
      return this.status();
    });
  }

  private async connect(plan: DesiredPlan, generation: number, explicit: boolean): Promise<BrowserSyncState> {
    let session: Session | undefined;
    try {
      if (this.session) await this.close(this.session);
      this.assertPlan(plan, generation);
      plan.state = "connecting";
      plan.lastAttempt = Date.now();
      if (!explicit) await this.options.authorizePlan?.([plan.adminId, ...plan.followerIds]);
      this.assertPlan(plan, generation);
      const ids = [plan.adminId, ...plan.followerIds];
      const targets = await this.options.resolveTargets(ids);
      this.assertPlan(plan, generation);
      if (targets.length !== ids.length || targets.some((target, index) => target.id !== ids[index])) {
        throw new BrowserSyncError("The configured browser profiles could not be resolved", 409);
      }
      if (targets[0]!.engine !== "chromium") throw new BrowserSyncError("The Admin browser must use Chromium. Firefox profiles can be followers");
      await this.options.authorize?.(targets);
      this.assertPlan(plan, generation);
      if (!this.targetsCurrent(targets)) throw new BrowserSyncError(UNAVAILABLE, 409, "browser-unavailable");
      const runtime = resolvePlaywrightRuntime({ runtimeRoot: this.options.runtimeRoot });
      const command = [runtime.nodeExecutable, join(runtime.root, "agent", "browser-sync-worker.mjs")];
      let child: BrowserSyncChild;
      try {
        child = this.options.spawnChild?.(command) ?? spawn(command[0]!, command.slice(1), {
          stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: playwrightWorkerEnvironment(),
        });
      } catch { throw new BrowserSyncError("Browser mirroring runtime is unavailable", 503); }
      session = this.attach(child, plan, targets);
      this.session = session;
      child.stdin.write(`${JSON.stringify({
        type: "start", admin: this.wireTarget(targets[0]!), followers: targets.slice(1).map((target) => this.wireTarget(target)),
        // Reopening a browser never replays a previous URL or queued action.
        alignOnStart: explicit,
        ...(this.currentPolicy() ? { policy: this.currentPolicy() } : {}),
      })}\n`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.readyPromise,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BrowserSyncError("Browser mirroring did not become ready in time", 504)), this.options.startupTimeoutMs ?? 35_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      this.assertPlan(plan, generation);
      if (session.closing || session.exited) {
        if (this.desired?.state === "waiting") return this.status();
        throw new BrowserSyncError(CONNECTION_FAILED, 503);
      }
      if (!this.targetsCurrent(targets)) throw new BrowserSyncError(UNAVAILABLE, 409, "browser-unavailable");
      session.ready = true;
      plan.state = "active";
      plan.failed.clear();
      plan.lastAuthorization = Date.now();
      this.error = null;
      return this.status();
    } catch (error) {
      if (session) await this.close(session);
      if (generation !== this.requestGeneration || this.desired !== plan || plan.scope !== this.currentScope()) {
        throw new BrowserSyncError("The configured group or signed-in account changed", 409);
      }
      if (plan.state === "waiting" || error instanceof BrowserSyncError && error.reason === "browser-unavailable") {
        this.wait(plan);
        return this.status();
      }
      const safe = error instanceof BrowserSyncError ? error : new BrowserSyncError("Browser mirroring could not be authorized or connected", 503);
      this.attention(plan, safe.message);
      throw safe;
    }
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operation.then(run, run);
    this.operation = next.catch(() => undefined);
    return next;
  }

  private currentScope(): string | undefined {
    try { return this.options.scope(); } catch { return undefined; }
  }

  private targetsCurrent(targets: readonly BrowserSyncTarget[]): boolean {
    try { return this.options.current(targets); } catch { return false; }
  }

  private savedPlan(): BrowserSyncPlan | null {
    const scope = this.currentScope();
    if (!scope) return null;
    try {
      const saved = this.options.loadSaved?.(scope);
      return saved ? browserSyncSelection(saved.adminId, saved.followerIds) : null;
    } catch { return null; }
  }

  private assertCurrent(generation: number, scope: string): void {
    if (generation !== this.requestGeneration || scope !== this.currentScope()) throw new BrowserSyncError("The configured group or signed-in account changed", 409);
  }

  private assertPlan(plan: DesiredPlan, generation: number): void {
    this.assertCurrent(generation, plan.scope);
    if (this.desired !== plan) throw new BrowserSyncError("The configured mirroring group changed", 409);
  }

  private clearDesired(): void {
    if (this.desired?.guard) clearInterval(this.desired.guard);
    this.desired = undefined;
  }

  private checkBoundary(): void {
    if (!this.desired || this.currentScope() === this.desired.scope) return;
    ++this.requestGeneration;
    this.clearDesired();
    this.error = "Browser mirroring stopped because the signed-in account or mode changed. Resume explicitly after signing in";
    this.cancelSession(this.session);
    if (this.session) void this.close(this.session).catch(() => {});
  }

  private wireTarget(target: BrowserSyncTarget) { return { id: target.id, engine: target.engine, endpoint: target.endpoint }; }

  private attach(child: BrowserSyncChild, plan: DesiredPlan, targets: BrowserSyncTarget[]): Session {
    let resolveExit!: () => void;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
    const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    readyPromise.catch(() => {});
    const session: Session = { plan, targets, child, ready: false, closing: false, exited: false, exit, readyPromise, resolveReady, rejectReady };
    let buffer = "";
    const failed = () => this.workerFailed(session, undefined);
    child.stdin.on("error", failed);
    child.stdout.on("error", failed);
    child.stderr?.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (session.closing) return;
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 16 * 1024) { failed(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let value: unknown;
        try { value = JSON.parse(line); } catch { failed(); return; }
        if (!value || typeof value !== "object") { failed(); return; }
        const message = value as { type?: unknown; profileId?: unknown; reason?: unknown };
        if (message.type === "ready") session.resolveReady();
        else if (message.type === "failure") { this.workerFailed(session, message.reason); return; }
        else if (message.type === "follower-error" && plan.followerIds.includes(String(message.profileId))) {
          plan.failed.add(String(message.profileId));
          this.workerFailed(session, message.reason);
          return;
        } else { failed(); return; }
      }
    });
    child.stderr?.on("data", () => {});
    const exited = () => {
      if (session.exited) return;
      session.exited = true;
      resolveExit();
      if (!session.closing) failed();
    };
    child.once("exit", exited);
    child.once("close", exited);
    child.once("error", failed);
    return session;
  }

  private workerFailed(session: Session, reason: unknown): void {
    if (session.closing || this.desired !== session.plan) return;
    if (typeof reason === "string" && TRANSIENT_REASONS.has(reason)) {
      session.rejectReady(new BrowserSyncError(UNAVAILABLE, 409, "browser-unavailable"));
      this.wait(session.plan);
    } else {
      session.rejectReady(new BrowserSyncError(CONNECTION_FAILED, 503));
      this.attention(session.plan, CONNECTION_FAILED);
    }
  }

  private cancelSession(session: Session | undefined): void {
    if (!session || session.closing) return;
    session.closing = true;
    session.rejectReady(new BrowserSyncError("The configured group changed or mirroring was stopped", 409));
    try { session.child.stdin.write('{"type":"stop"}\n'); session.child.stdin.end(); } catch { /* exited helper */ }
  }

  private close(session: Session): Promise<void> {
    if (session.cleanup) return session.cleanup;
    this.cancelSession(session);
    session.cleanup = (async () => {
      if (!session.exited && !await this.exitedWithin(session, this.options.stopTimeoutMs ?? 3_000)) {
        try { session.child.kill("SIGKILL"); } catch { /* helper already exited */ }
        await this.exitedWithin(session, 1_000);
      }
      if (!session.exited) {
        this.error = "The previous mirroring helper could not be stopped. Restart the app before starting mirroring again";
        if (this.desired) this.desired.state = "attention";
        throw new BrowserSyncError(this.error, 503);
      }
      session.child.stdout.destroy();
      session.child.stderr?.destroy();
      if (this.session === session) this.session = undefined;
    })();
    return session.cleanup;
  }

  private async exitedWithin(session: Session, timeout: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([session.exit.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeout); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private wait(plan: DesiredPlan): void {
    if (this.desired !== plan || plan.state === "attention") return;
    plan.state = "waiting";
    plan.lastAttempt = Date.now();
    this.error = null;
    const session = this.session;
    if (session?.plan === plan) {
      this.cancelSession(session);
      void this.close(session).catch(() => {});
    }
  }

  private attention(plan: DesiredPlan, message: string): void {
    if (this.desired !== plan) return;
    plan.state = "attention";
    this.error = message;
    const session = this.session;
    if (session?.plan === plan) {
      this.cancelSession(session);
      void this.close(session).catch(() => {});
    }
  }

  private startGuard(plan: DesiredPlan): void {
    plan.guard = setInterval(() => {
      this.checkBoundary();
      if (this.desired !== plan || plan.state === "attention") return;
      const session = this.session;
      if (session?.plan === plan && !session.closing && !this.targetsCurrent(session.targets)) this.wait(plan);
      if (plan.state === "waiting" && Date.now() - plan.lastAttempt >= (this.options.retryIntervalMs ?? 2_000)) {
        plan.state = "connecting";
        const generation = this.requestGeneration;
        void this.enqueue(async () => {
          if (this.desired === plan && generation === this.requestGeneration) await this.connect(plan, generation, false);
        }).catch(() => {});
        return;
      }
      if (plan.state !== "active" || !session || !this.options.authorize || plan.authorizing
        || Date.now() - plan.lastAuthorization < (this.options.authorizationIntervalMs ?? 5_000)) return;
      plan.authorizing = true;
      void this.options.authorize(session.targets).catch((error) => {
        if (error instanceof BrowserSyncError && error.reason === "browser-unavailable") this.wait(plan);
        else this.attention(plan, "Browser mirroring stopped because profile edit access could not be verified. Resume explicitly after access is restored");
      }).finally(() => { plan.authorizing = false; plan.lastAuthorization = Date.now(); });
    }, this.options.guardIntervalMs ?? 500);
    plan.guard.unref?.();
  }
}
