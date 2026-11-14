import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { AGENT_CONTROL_PATH, AGENT_CONTROL_PROTOCOL, type AgentControlSession } from "../agent-control.ts";
import { Launcher } from "../launcher.ts";
import { ProfileStore } from "../store.ts";
import { LifecycleAdmissionController } from "../lifecycle-admission.ts";
import { DesktopCredentialBridge, ManagedDesktopRuntime, agentControlNonce, desktopHealthMetadata } from "../desktop-runtime.ts";
import { verifyPlaywrightRuntime } from "../playwright-runtime.ts";
import { runtimeDownloads } from "../runtime-download.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { isLoopback, MAX_PACKET_BYTES, WORKSPACE_PORT } from "../workspace/protocol.ts";
import { StakeModeWorkspace, type SocketState } from "../workspace/server.ts";
import { createStandaloneServices } from "./services.ts";
import type { StandaloneCloudLifecycle } from "./cloud-lifecycle.ts";
import type { CloudFetch } from "../cloud-client.ts";

export interface GameBrowserStartOptions {
  stateRoot?: string;
  desktopRoot?: string;
  /** Retain beta 82's metadata in place, or select an explicit imported workspace. */
  workspaceStateRoot?: string;
  port?: number;
  binaryPath?: string;
  binarySha256?: string;
  firefoxBinaryPath?: string;
  firefoxBinarySha256?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable transport for compatible service clients; the local listener is unchanged. */
  cloudFetch?: CloudFetch;
  shutdownTimeoutMs?: number;
}

/** A desktop update keeps the native data directory; a source start gets its own product root. */
export function gameBrowserStateRoot(options: Pick<GameBrowserStartOptions, "stateRoot" | "desktopRoot" | "env"> = {}): string {
  const env = options.env ?? process.env;
  return resolve(options.stateRoot ?? env.GAMEBROWSER_STATE_ROOT ?? options.desktopRoot
    ?? env.STAKEMODE_STATE_ROOT ?? join(env.LOCALAPPDATA || homedir(), "GameBrowser"));
}

function containsWorkspaceData(root: string): boolean {
  try { return readdirSync(join(root, "workspace")).length > 0; } catch { return false; }
}

/** Original standalone and beta 82 metadata have different layouts. Neither is moved or overwritten. */
export function gameBrowserWorkspaceRoot(root: string, explicit?: string): string {
  if (explicit) return resolve(explicit);
  const previous = join(root, "live-workspace", "local");
  if (!containsWorkspaceData(previous)) return root;
  if (containsWorkspaceData(root)) {
    throw new Error("Both standalone and beta 82 workspace settings exist. Choose --workspace-state-root PATH to keep the intended workspace; neither directory was changed.");
  }
  return previous;
}

function workspaceAssets(resourceRoot?: string) {
  const bundled = resourceRoot && [join(resourceRoot, "gamebrowser", "workspace"), join(resourceRoot, "stakemode", "workspace")]
    .find(path => existsSync(join(path, "dashboard.html")));
  const root = bundled ?? join(import.meta.dir, "..", "workspace");
  return Object.fromEntries([
    ["dashboard.html", "text/html; charset=utf-8"],
    ["dashboard.js", "text/javascript; charset=utf-8"],
    ["dashboard.css", "text/css; charset=utf-8"],
    ["fonts/inter-latin.woff2", "font/woff2"],
  ].map(([name, contentType]) => [`/workspace/${name}`, { body: new Uint8Array(readFileSync(join(root, name!))), contentType: contentType! }]));
}

function localJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

type AgentSocketState = { session: AgentControlSession };
type WorkspaceSocketState = { workspace: StakeModeWorkspace; state: SocketState };
type RuntimeSocketState = WorkspaceSocketState | AgentSocketState;
function isAgentSocket(socket: ServerWebSocket<RuntimeSocketState>): socket is ServerWebSocket<AgentSocketState> {
  return "session" in socket.data;
}
const socketViews = new WeakMap<object, ServerWebSocket<SocketState>>();
function workspaceSocket(socket: ServerWebSocket<WorkspaceSocketState>): ServerWebSocket<SocketState> {
  const previous = socketViews.get(socket);
  if (previous) return previous;
  const view = new Proxy(socket, {
    get(target, key) {
      if (key === "data") return target.data.state;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as ServerWebSocket<SocketState>;
  socketViews.set(socket, view);
  return view;
}

/** Independent StakeMode composition: one local workspace, one identity store and one owned launcher. */
export async function startGameBrowser(options: GameBrowserStartOptions = {}) {
  const env = options.env ?? process.env;
  const root = gameBrowserStateRoot(options);
  const stateRoot = gameBrowserWorkspaceRoot(root, options.workspaceStateRoot);
  const port = options.port ?? WORKSPACE_PORT;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer from 0 to 65535");
  const health = desktopHealthMetadata(env, options.desktopRoot ? resolve(options.desktopRoot) : undefined);
  if (health && root !== health.root) throw new Error("Desktop state root must match --desktop-root so native health describes the actual data directory");
  const nonce = agentControlNonce(env);
  const credentials = health ? new DesktopCredentialBridge(health.instance) : undefined;
  const resourceRoot = env.ALIASMODE_PLAYWRIGHT_RUNTIME;
  await verifyPlaywrightRuntime(resourceRoot);
  const assets = workspaceAssets(resourceRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 });
  const log = (message: string) => {
    const sanitized = message.replace(/(https?:\/\/|socks5?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
    try { appendFileSync(join(root, "logs", `gamebrowser-${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${sanitized}\n`, { mode: 0o600 }); } catch { /* Logging cannot change browser ownership. */ }
    console.error(`[GameBrowser] ${sanitized}`);
  };
  const store = new ProfileStore(join(root, "profiles.sqlite"));
  const admission = new LifecycleAdmissionController();
  let workspace: StakeModeWorkspace | undefined;
  let services: ReturnType<typeof createStandaloneServices> | undefined;
  let cloud: StandaloneCloudLifecycle | undefined;
  let server: Server<RuntimeSocketState> | undefined;
  let stopping = false;
  const agentSockets = new Set<ServerWebSocket<AgentSocketState>>();
  const agentSessions = new Set<AgentControlSession>();
  const disconnects = new Map<AgentControlSession, Promise<void>>();
  const disconnect = (session: AgentControlSession) => {
    let pending = disconnects.get(session);
    if (!pending) {
      pending = (services?.agent.disconnect(session) ?? session.disconnect()).finally(() => { agentSessions.delete(session); disconnects.delete(session); });
      disconnects.set(session, pending);
    }
    return pending;
  };
  const extensionRoot = env.STAKEMODE_SYNC_EXTENSION_ROOT ?? (resourceRoot
    ? join(resourceRoot, existsSync(join(resourceRoot, "gamebrowser")) ? "gamebrowser" : "stakemode", "extensions", "stakemode-sync")
    : join(import.meta.dir, "..", "extensions", "stakemode-sync"));
  const launcher = new Launcher({
    store, dataRoot: join(root, "profiles"), chromiumRuntimeRoot: join(root, "runtimes"),
    resourcePolicy: id => store.getProfileResourcePolicy(id),
    headless: true, windowWidthScale: 1, windowHeightScale: 1, log,
    labelWindow: async () => {},
    binaryPath: options.binaryPath, expectedBinarySha256: options.binarySha256,
    firefoxBinaryPath: options.firefoxBinaryPath, expectedFirefoxBinarySha256: options.firefoxBinarySha256,
    profileExtensionDirs: profile => workspace?.extensionDirectories(profile),
    profileFirefoxAddonDirs: profile => workspace?.firefoxAddonDirectories(profile),
    profileFirefoxAddonUUIDs: profile => workspace?.firefoxAddonUUIDs(profile),
    profileNetworkMode: profile => workspace?.manager.getNetworkMode(profile.id),
    profileResourceLimits: profile => profile.engine === "firefox" ? undefined : workspace?.manager.getResourceLimits(profile.id),
  });
  let preparingCloud: Promise<StandaloneCloudLifecycle> | undefined;
  const requireCloud = (): Promise<StandaloneCloudLifecycle> => {
    if (stopping) return Promise.reject(new Error("GameBrowser is stopping"));
    if (cloud) return Promise.resolve(cloud);
    return preparingCloud ??= import("./cloud-lifecycle.ts").then(({ StandaloneCloudLifecycle }) => {
      if (stopping) throw new Error("GameBrowser is stopping");
      if (!server?.port) throw new Error("The local listener must be ready before opening Cloud browsers");
      cloud = new StandaloneCloudLifecycle({ root, assets, syncExtensionRoot: extensionRoot, admission, desktop: !!health,
        relayUrl: `ws://127.0.0.1:${server.port}/workspace/cloud/relay`,
        binaryPath: options.binaryPath, binarySha256: options.binarySha256,
        firefoxBinaryPath: options.firefoxBinaryPath, firefoxBinarySha256: options.firefoxBinarySha256, env, log,
        appFetch: (request, address) => services?.fetch(request, address, "cloud"),
      });
      return cloud;
    });
  };
  try {
    workspace = new StakeModeWorkspace({
      launcher, store, stateRoot, syncExtensionRoot: extensionRoot, assets, syncController: "relay",
      capabilities: { mode: "local", identityManagement: true, manageProfilesUrl: "/workspace/#profiles", settingsUrl: "/workspace/#settings" },
      appFetch: (request, address) => services?.fetch(request, address),
      extraFetch: async (request, address) => {
        const url = new URL(request.url);
        if (!isLoopback(address)) return localJson({ error: "Loopback access required" }, 403);
        // These native readiness routes never depend on an account, network or browser protocol.
        if (url.pathname === "/ui/api/health" && request.method === "GET") return localJson({
          ok: true, ...(health ?? { version: ALIASMODE_VERSION, root }),
          pid: process.pid, logDir: join(root, "logs"), readiness: "local", product: "GameBrowser", standalone: true,
        });
        if (url.pathname === "/ui/api/app-mode" && request.method === "GET") return localJson({ version: 1, mode: "local", localAnalytics: false });
        if (url.pathname === "/ui/api/runtime-downloads" && request.method === "GET") return localJson({ downloads: runtimeDownloads() });
        if (url.pathname === "/ui/api/profiles" && request.method === "GET") return localJson({ profiles: [...store.listProfiles().map(profile => ({
          id: profile.id, name: profile.name, group: profile.group, engine: profile.engine ?? "chromium", running: !!store.getLaunch(profile.id),
        })), ...(cloud?.listLaunches() ?? []).map(launch => ({ id: launch.profileId, name: "Cloud profile", group: "Cloud", engine: launch.engine ?? "chromium", running: true }))] });
        // Compatibility reads are separate from the token-authenticated app API.
        return url.pathname.startsWith("/ui/api/") ? services?.fetch(request, address) : undefined;
      },
    });
    services = createStandaloneServices({ root, store, launcher, workspace, admission, nonce: nonce ?? undefined, desktopCredentials: credentials, env, log, fetchFn: options.cloudFetch,
      onAuthenticated: async context => (await requireCloud()).authenticate(context), onSigningOut: async context => cloud?.signingOut(context),
      takeCreatedQueueKey: () => cloud?.takeCreatedQueueKey(),
      cloudAppContext: () => cloud?.appContext(),
      cloudProfiles: {
        list: async (...args) => (await requireCloud()).profiles.list(...args), create: async (...args) => (await requireCloud()).profiles.create(...args),
        open: async (...args) => (await requireCloud()).profiles.open(...args), close: async (...args) => (await requireCloud()).profiles.close(...args), retryPending: async (...args) => (await requireCloud()).profiles.retryPending(...args),
      },
    });
    await launcher.reconcileOrphans();
    await launcher.certifySurvivors();
    const currentWorkspace = workspace;
    server = Bun.serve<RuntimeSocketState>({
      hostname: "127.0.0.1", port, development: false, idleTimeout: 240, maxRequestBodySize: 16 * 1024 * 1024,
      fetch: async (request, listener) => {
        if (stopping) return localJson({ error: "GameBrowser is stopping" }, 503);
        const url = new URL(request.url), address = listener.requestIP(request)?.address ?? "";
        if (!isLoopback(address) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
          || request.headers.get("host") !== url.host) return localJson({ error: "Local GameBrowser host required" }, 403);
        if (url.pathname === "/workspace/cloud") return Response.redirect(`${url.origin}/workspace/cloud/dashboard.html`, 303);
        if (url.pathname.startsWith("/workspace/cloud/")) {
          try {
            const context = services?.cloud.context();
            if (!context?.auth.hasSession()) return localJson({ error: "Sign in to a compatible Cloud service in Settings before opening the Cloud workspace" }, 401);
            const cloudWorkspace = await (await requireCloud()).resolve(context, `ws://127.0.0.1:${listener.port}/workspace/cloud/relay`);
            if (stopping) return localJson({ error: "GameBrowser is stopping" }, 503);
            const rewrittenUrl = new URL(url);
            rewrittenUrl.pathname = `/workspace${url.pathname.slice("/workspace/cloud".length)}`;
            const rewritten = new Request(rewrittenUrl, request);
            if (rewrittenUrl.pathname === "/workspace/relay") return cloudWorkspace.upgradeRequest(rewritten, address,
              state => !stopping && listener.upgrade(request, { data: { workspace: cloudWorkspace, state } }));
            return cloudWorkspace.handleRequest(rewritten, address);
          } catch { return localJson({ error: "Sign in to a compatible Cloud service in Settings before opening the Cloud workspace" }, 401); }
        }
        if (["/relay", "/workspace/relay"].includes(url.pathname)) {
          return currentWorkspace.upgradeRequest(request, address, state => !stopping && listener.upgrade(request, { data: { workspace: currentWorkspace, state } }));
        }
        if (url.pathname === AGENT_CONTROL_PATH) {
          if (!isLoopback(address)) return localJson({ error: "Loopback access required" }, 403);
          if (!services?.agent) return localJson({ error: "Local agent control is unavailable" }, 503);
          if (request.headers.get("sec-websocket-protocol") !== AGENT_CONTROL_PROTOCOL) return localJson({ error: "Agent protocol mismatch" }, 426);
          if (!services.agent.authorize(request)) return localJson({ error: "Agent authorization failed" }, 401);
          if (agentSessions.size >= 32) return localJson({ error: "Local agent connection limit reached" }, 429);
          const session = services.agent.connect();
          // Track at upgrade, including a shutdown before Bun delivers its open callback.
          agentSessions.add(session);
          if (!listener.upgrade(request, { data: { session } })) { void disconnect(session).catch(() => {}); return localJson({ error: "WebSocket upgrade failed" }, 400); }
          return undefined;
        }
        return currentWorkspace.handleRequest(request, address);
      },
      websocket: {
        maxPayloadLength: Math.max(MAX_PACKET_BYTES, services.agent?.maxMessageBytes ?? 0), idleTimeout: 120,
        backpressureLimit: 6 * 1024 * 1024, closeOnBackpressureLimit: true,
        open(socket) {
          if (isAgentSocket(socket)) {
            agentSockets.add(socket);
            if (stopping) { socket.close(1001, "GameBrowser stopping"); void disconnect(socket.data.session).catch(() => {}); }
          } else {
            const scopedSocket = socket as ServerWebSocket<WorkspaceSocketState>;
            scopedSocket.data.workspace.socketHandlers.open(workspaceSocket(scopedSocket));
          }
        },
        message(socket, value) {
          if (stopping) { socket.close(1001, "GameBrowser stopping"); return; }
          if (isAgentSocket(socket)) void socket.data.session.enqueue(typeof value === "string" ? value : new Uint8Array(value))
            .then(response => { if (!stopping) socket.send(JSON.stringify(response)); }).catch(() => {});
          else {
            const scopedSocket = socket as ServerWebSocket<WorkspaceSocketState>;
            scopedSocket.data.workspace.socketHandlers.message(workspaceSocket(scopedSocket), typeof value === "string" ? value : Buffer.from(value));
          }
        },
        close(socket) {
          if (isAgentSocket(socket)) { agentSockets.delete(socket); void disconnect(socket.data.session).catch(() => {}); }
          else {
            const scopedSocket = socket as ServerWebSocket<WorkspaceSocketState>;
            scopedSocket.data.workspace.socketHandlers.close(workspaceSocket(scopedSocket));
          }
        },
      },
    });
    const listener = server;
    currentWorkspace.activate(`ws://127.0.0.1:${listener.port}/workspace/relay`);
    const managed = new ManagedDesktopRuntime({
      server: {
        stop(force) { stopping = true; return listener.stop(force); },
        get pendingRequests() { return listener.pendingRequests; },
        get pendingWebSockets() { return listener.pendingWebSockets; },
        async stopScripts() {
          stopping = true;
          const quiesce = currentWorkspace.quiesce();
          for (const socket of agentSockets) socket.close(1001, "GameBrowser stopping");
          const results = await Promise.allSettled([quiesce, ...(cloud ? [cloud.quiesce()] : []), ...[...agentSessions].map(disconnect)]);
          const failed = results.find(result => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        },
      },
      admission, store, launcher, shutdownTimeoutMs: options.shutdownTimeoutMs,
      remoteShutdown: async () => {
        await cloud?.close();
        await services!.close();
        await currentWorkspace.stop({ stopSync: false });
        if (store.listLaunches().length) throw new Error("Owned browser shutdown could not be confirmed");
      },
    });
    return { root, workspaceStateRoot: stateRoot, port: listener.port!, url: `http://127.0.0.1:${listener.port}/workspace/dashboard.html`,
      health, credentials, launcher, workspace: currentWorkspace, store, services, close: () => managed.shutdown() };
  } catch (error) {
    stopping = true;
    await cloud?.close().catch(() => {});
    await services?.close().catch(() => {});
    await workspace?.stop({ stopSync: false }).catch(() => {});
    await server?.stop(true);
    store.close();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE") {
      throw new Error(`GameBrowser could not bind 127.0.0.1:${port}. Close the application using that port, or choose --port PORT; no other service was adopted.`);
    }
    throw error;
  }
}
