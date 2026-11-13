import type { LifecycleAdmissionController } from "./lifecycle-admission.ts";

export const DESKTOP_PROTOCOL = "aliasmode-desktop-v1";
const NONCE_RE = /^[a-f0-9]{64}$/;

export interface DesktopHealthMetadata {
  version: string;
  root: string;
  instance: string;
}

export interface DesktopReadyRecord {
  protocol: typeof DESKTOP_PROTOCOL;
  event: "ready";
  nonce: string;
  pid: number;
  port: number;
}

interface DesktopCredentialResult {
  protocol: typeof DESKTOP_PROTOCOL;
  event: "credential-result";
  nonce: string;
  request: number;
  ok: boolean;
}

interface PendingCredentialRequest {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  failure: string;
}

interface ManagedServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
  /** Bun's counters let shutdown preserve every active HTTP exchange. */
  readonly pendingRequests?: number;
  readonly pendingWebSockets?: number;
  /** Quiesce owned WebSocket sessions and script producers before listener drain/capture. */
  stopScripts?(): Promise<void>;
}

interface ManagedStore {
  listLaunches(): Array<{ profileId: string }>;
  close(): void;
}

interface ManagedLauncher {
  stop(profileId: string): Promise<boolean>;
}

export interface ManagedDesktopRuntimeOptions {
  server: ManagedServer;
  automationServer?: ManagedServer;
  admission: LifecycleAdmissionController;
  store: ManagedStore;
  launcher: ManagedLauncher;
  remoteShutdown?: (remainingMs: number) => Promise<void>;
  stopInbox?: () => void | Promise<void>;
  wait?: (ms: number) => Promise<void>;
  shutdownTimeoutMs?: number;
}

export function agentControlNonce(
  env: Record<string, string | undefined>,
): string | null {
  const nonce = env.ALIASMODE_AGENT_NONCE;
  if (nonce === undefined) return null;
  if (!NONCE_RE.test(nonce)) {
    throw new Error("ALIASMODE_AGENT_NONCE must be 64 lowercase hexadecimal characters");
  }
  return nonce;
}

export function desktopHealthMetadata(
  env: Record<string, string | undefined>,
  root: string | undefined,
): DesktopHealthMetadata | null {
  const desktop = env.ALIASMODE_DESKTOP_NONCE !== undefined || root !== undefined;
  if (!desktop) return null;
  const instance = env.ALIASMODE_DESKTOP_NONCE ?? "";
  const version = env.ALIASMODE_DESKTOP_VERSION ?? "";
  if (!NONCE_RE.test(instance)) throw new Error("ALIASMODE_DESKTOP_NONCE must be 64 lowercase hexadecimal characters");
  if (!version.trim()) throw new Error("ALIASMODE_DESKTOP_VERSION is required in desktop mode");
  if (!root) throw new Error("--desktop-root is required in desktop mode");
  return { instance, version: version.trim(), root };
}

export function desktopReadyRecord(nonce: string, port: number, pid = process.pid): DesktopReadyRecord {
  if (!NONCE_RE.test(nonce)) throw new Error("desktop readiness nonce is invalid");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("desktop readiness port is invalid");
  if (!Number.isInteger(pid) || pid < 1) throw new Error("desktop readiness pid is invalid");
  return { protocol: DESKTOP_PROTOCOL, event: "ready", nonce, pid, port };
}

export function isDesktopShutdownCommand(line: string, nonce: string): boolean {
  if (!NONCE_RE.test(nonce)) return false;
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    return value.protocol === DESKTOP_PROTOCOL && value.command === "shutdown" && value.nonce === nonce;
  } catch {
    return false;
  }
}

export class DesktopCredentialBridge {
  private request = 0;
  private readonly pending = new Map<number, PendingCredentialRequest>();

  constructor(
    private readonly nonce: string,
    private readonly write: (line: string) => void = (line) => { process.stdout.write(line); },
    private readonly timeoutMs = 10_000,
  ) {
    if (!NONCE_RE.test(nonce)) throw new Error("desktop credential nonce is invalid");
  }

  persistRefreshToken(secret: string): Promise<void> {
    return this.send("credential-set", "refresh_token", secret);
  }

  async clearCloudSessionCredentials(): Promise<void> {
    // Keep the queue key. Signed-out captures remain encrypted and must survive
    // until the same account authenticates and can retry them.
    const results = await Promise.allSettled([
      this.send("credential-delete", "refresh_token"),
      this.send("credential-delete", "device_credential"),
    ]);
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("Windows Credential Manager could not clear Cloud credentials");
    }
  }

  private send(event: "credential-set" | "credential-delete", key: string, secret?: string): Promise<void> {
    const request = ++this.request;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request);
        reject(new Error("desktop credential operation timed out"));
      }, this.timeoutMs);
      this.pending.set(request, {
        resolve,
        reject,
        timer,
        failure: event === "credential-set"
          ? "Windows Credential Manager rejected the rotated refresh token"
          : "Windows Credential Manager could not clear Cloud credentials",
      });
      try {
        this.write(`${JSON.stringify({
          protocol: DESKTOP_PROTOCOL,
          event,
          nonce: this.nonce,
          request,
          key,
          ...(secret === undefined ? {} : { secret }),
        })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request);
        reject(error instanceof Error ? error : new Error("desktop credential request failed"));
      }
    });
  }

  handleLine(line: string): boolean {
    let result: DesktopCredentialResult;
    try {
      result = JSON.parse(line) as DesktopCredentialResult;
    } catch {
      return false;
    }
    if (
      result.protocol !== DESKTOP_PROTOCOL
      || result.event !== "credential-result"
      || result.nonce !== this.nonce
      || !Number.isSafeInteger(result.request)
      || typeof result.ok !== "boolean"
    ) return false;
    const pending = this.pending.get(result.request);
    if (!pending) return false;
    this.pending.delete(result.request);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve();
    else pending.reject(new Error(pending.failure));
    return true;
  }
}

async function beforeDeadline<T>(pending: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("desktop shutdown deadline expired");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("desktop shutdown deadline expired")), remaining);
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface ListenerStop {
  server: ManagedServer;
  hadWebSockets: boolean;
  settled: boolean;
  failed: boolean;
  error?: unknown;
  pending: Promise<void>;
}

function pendingHttp(server: ManagedServer): number | undefined {
  const count = server.pendingRequests;
  return Number.isSafeInteger(count) && Number(count) >= 0 ? count : undefined;
}

function hasWebSockets(server: ManagedServer): boolean {
  const count = server.pendingWebSockets;
  return Number.isSafeInteger(count) && Number(count) > 0;
}

/** Request every listener stop synchronously, without waiting on its open UI sockets. */
function requestServerStops(servers: ManagedServer[]): ListenerStop[] {
  return servers.map(server => {
    const stop: ListenerStop = { server, hadWebSockets: hasWebSockets(server),
      settled: false, failed: false, pending: Promise.resolve() };
    const failed = (error: unknown) => { stop.settled = true; stop.failed = true; stop.error = error; };
    try {
      stop.pending = Promise.resolve(server.stop(false)).then(() => { stop.settled = true; }, failed);
    } catch (error) { failed(error); }
    return stop;
  });
}

async function finishServerStops(stops: ListenerStop[], quiescedServer?: ManagedServer): Promise<void> {
  const results = await Promise.allSettled(stops.map(async stop => {
    if (!stop.settled && (stop.hadWebSockets || hasWebSockets(stop.server))
      && stop.server === quiescedServer && pendingHttp(stop.server) === 0) {
      // Bun 1.2.21 can retain the first graceful-stop promise after a WebSocket
      // closes. Owned sessions are already closed and all HTTP/lifecycle work
      // has drained, so finish only its transport bookkeeping with a fresh stop.
      await stop.server.stop(true);
    } else await stop.pending;
    if (stop.failed) throw stop.error instanceof Error ? stop.error : new Error("desktop listener shutdown failed");
  }));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export class ManagedDesktopRuntime {
  private shutdownInFlight: Promise<void> | null = null;

  constructor(private readonly options: ManagedDesktopRuntimeOptions) {}

  shutdown(): Promise<void> {
    if (!this.shutdownInFlight) this.shutdownInFlight = this.runShutdown();
    return this.shutdownInFlight;
  }

  private async runShutdown(): Promise<void> {
    const {
      server,
      automationServer,
      admission,
      store,
      launcher,
      remoteShutdown,
      stopInbox = () => {},
      wait = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      shutdownTimeoutMs = 7 * 60_000,
    } = this.options;

    const deadline = Date.now() + shutdownTimeoutMs;
    let failure: unknown;
    try {
      const listeners = requestServerStops([
        server,
        ...(automationServer ? [automationServer] : []),
      ]);
      await beforeDeadline(server.stopScripts?.() ?? Promise.resolve(), deadline);
      try {
        await beforeDeadline(Promise.resolve(stopInbox()), deadline);
      } catch (error) {
        failure ??= error;
      }
      while (admission.stats().inFlight > 0 || admission.stats().queued > 0
        || listeners.some(listener => Number(pendingHttp(listener.server)) > 0)) {
        if (Date.now() >= deadline) throw new Error("lifecycle requests did not settle before desktop shutdown");
        await wait(25);
      }
      await beforeDeadline(finishServerStops(listeners, server.stopScripts ? server : undefined), deadline);

      if (remoteShutdown) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error("desktop shutdown deadline expired before remote cleanup");
        await beforeDeadline(remoteShutdown(remainingMs), deadline);
      } else {
        const failed: string[] = [];
        for (const { profileId } of store.listLaunches()) {
          try {
            if (await beforeDeadline(launcher.stop(profileId), deadline) !== true) failed.push(profileId);
          } catch {
            failed.push(profileId);
          }
        }
        if (failed.length) {
          throw new Error(`browser teardown was not confirmed for ${failed.length} profile(s)`);
        }
      }
    } catch (error) {
      failure ??= error;
    } finally {
      try {
        store.close();
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure) throw failure;
  }
}
