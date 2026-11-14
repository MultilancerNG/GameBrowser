/** GameBrowser local REST client, compatible with existing StakeMode scripts. */
export type JsonObject = Record<string, unknown>;
export type HttpMethod = "GET" | "POST" | "DELETE";
export interface ClientOptions { baseUrl?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch; }
const MAX_BYTES = 1024 * 1024;
const ID = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ROUTES = new RegExp(`^(?:snapshot|bulk|start|stop|kill|manual|pause|role|navigate|policy|settings|batch|sync|proxies(?:/(?:import|${ID}(?:/assign)?))?|library(?:/(?:profiles/${ID}|groups(?:/${ID})?|import|export))?|extensions(?:/(?:import|${ID}))?|profiles/${ID}(?:/(?:browser|network|screen|cookies|rename|copy|extensions(?:/${ID}(?:/open)?)?))?|workflows(?:/(?:import|${ID}(?:/(?:run|export))?))?|jobs(?:/${ID}(?:/(?:cancel|output))?)?|schedules(?:/${ID})?)$`);
export class StakeModeError extends Error {
  readonly code: "CONFIG" | "AUTH_REQUIRED" | "TIMEOUT" | "TRANSPORT" | "PROTOCOL" | "HTTP";
  readonly status?: number;
  constructor(code: "CONFIG" | "AUTH_REQUIRED" | "TIMEOUT" | "TRANSPORT" | "PROTOCOL" | "HTTP", status?: number) {
    super(({ CONFIG: "Invalid local StakeMode client configuration or request", AUTH_REQUIRED: "StakeMode authorization expired; call connect() before another write", TIMEOUT: "Local StakeMode request timed out", TRANSPORT: "Could not reach the local StakeMode service", PROTOCOL: "Local StakeMode response is invalid or exceeds its limit", HTTP: "Local StakeMode request was rejected" })[code]);
    this.name = "StakeModeError"; this.code = code; this.status = status;
  }
}
/** Tokens live only in this client instance. Requests never follow redirects. */
export class StakeModeClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  #token?: string;
  #connecting?: Promise<JsonObject>;
  #fetch: typeof globalThis.fetch;
  #requestTimeout: number;
  constructor(options: ClientOptions = {}) {
    const base = options.baseUrl ?? "http://127.0.0.1:8080";
    if (!/^http:\/\/127\.0\.0\.1:8080\/?$/.test(base)) throw new StakeModeError("CONFIG");
    this.baseUrl = "http://127.0.0.1:8080";
    this.timeoutMs = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60000) throw new StakeModeError("CONFIG");
    this.#requestTimeout = this.timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new StakeModeError("CONFIG");
  }
  connect(): Promise<JsonObject> {
    if (this.#connecting) return this.#connecting;
    const operation = this.#send("GET", "bootstrap").then(result => {
      if (typeof result.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.token) || !record(result.snapshot)) throw new StakeModeError("PROTOCOL");
      this.#token = result.token;
      return result.snapshot;
    }).catch(error => { this.#token = undefined; throw error; }).finally(() => { this.#connecting = undefined; });
    this.#connecting = operation;
    return operation;
  }
  disconnect(): void { this.#token = undefined; }
  async request<T extends JsonObject = JsonObject>(method: HttpMethod, path: string, body?: JsonObject): Promise<T> {
    validateRequest(method, path, body);
    if (!this.#token) throw new StakeModeError("AUTH_REQUIRED");
    const usedToken = this.#token;
    try { return await this.#send(method, path, body, usedToken) as T; }
    catch (error) {
      if (!(error instanceof StakeModeError) || error.status !== 401) throw error;
      if (this.#token === usedToken) this.#token = undefined;
      if (method !== "GET") { this.#token = undefined; throw new StakeModeError("AUTH_REQUIRED", 401); }
      if (!this.#token) await this.connect();
      try { return await this.#send(method, path, undefined, this.#token) as T; }
      catch (retryError) { if (retryError instanceof StakeModeError && retryError.status === 401) { this.#token = undefined; throw new StakeModeError("AUTH_REQUIRED", 401); } throw retryError; }
    }
  }
  async #send(method: HttpMethod, path: string, body?: JsonObject, token?: string): Promise<JsonObject> {
    let serialized: string | undefined;
    try { if (body !== undefined) serialized = JSON.stringify(body); } catch { throw new StakeModeError("CONFIG"); }
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > MAX_BYTES) throw new StakeModeError("CONFIG");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new StakeModeError("TIMEOUT")); }, this.#requestTimeout); });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await this.#fetch(`http://127.0.0.1:8080/workspace/api/${path}`, { method, headers: { "x-stakemode-workspace": "1", accept: "application/json", ...(serialized === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: serialized,
          signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new StakeModeError(response.status === 401 ? "AUTH_REQUIRED" : "HTTP", response.status); }
        const length = response.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) { void response.body?.cancel().catch(() => {}); throw new StakeModeError("PROTOCOL"); }
        const chunks: Uint8Array[] = []; let bytes = 0;
        const reader = response.body?.getReader();
        if (reader) try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > MAX_BYTES) { void reader.cancel().catch(() => {}); throw new StakeModeError("PROTOCOL"); } chunks.push(chunk.value); } } finally { reader.releaseLock(); }
        const combined = new Uint8Array(bytes); let at = 0; for (const chunk of chunks) { combined.set(chunk, at); at += chunk.byteLength; }
        let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)); } catch { throw new StakeModeError("PROTOCOL"); }
        if (!record(value)) throw new StakeModeError("PROTOCOL"); return value;
      })()]);
    } catch (error) { if (error instanceof StakeModeError) throw error; if (controller.signal.aborted) throw new StakeModeError("TIMEOUT"); throw new StakeModeError("TRANSPORT"); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  async listProfiles(): Promise<JsonObject[]> { const result = await this.request("GET", "snapshot"); if (!record(result.snapshot) || !Array.isArray(result.snapshot.profiles) || !result.snapshot.profiles.every(record)) throw new StakeModeError("PROTOCOL"); return result.snapshot.profiles; }
  createProfiles(input: JsonObject) { return this.request("POST", "bulk", input); }
  start(profileId: string) { return this.request("POST", "start", { profileId: id(profileId) }); }
  stop(profileId: string) { return this.request("POST", "stop", { profileId: id(profileId) }); }
  manual(profileId: string, enabled = true) { return this.request("POST", "manual", { profileId: id(profileId), enabled }); }
  deleteProfile(profileId: string, confirmation: string) { return this.request("DELETE", `profiles/${id(profileId)}`, { confirmation }); }
  browserState(profileId: string) { return this.request("GET", `profiles/${id(profileId)}/browser`); }
  browserAction(profileId: string, command: JsonObject) { return this.request("POST", `profiles/${id(profileId)}/browser`, command); }
  groups() { return this.request("GET", "library"); }
  saveGroup(name: string, groupId?: string) { return this.request("POST", "library/groups", { name, ...(groupId ? { id: id(groupId) } : {}) }); }
  metadata(profileId: string) { return this.request("GET", `library/profiles/${id(profileId)}`); }
  setMetadata(profileId: string, metadata: JsonObject) { return this.request("POST", `library/profiles/${id(profileId)}`, metadata); }
  importProfiles(document: JsonObject) { return this.request("POST", "library/import", { document }); }
  exportProfiles(profileIds?: string[]) { return this.request("GET", `library/export${profileIds ? `?ids=${profileIds.map(id).join(",")}` : ""}`); }
  extensions() { return this.request("GET", "extensions"); }
  importExtension(options: JsonObject) { return this.request("POST", "extensions/import", options); }
  profileExtensions(profileId: string) { return this.request("GET", `profiles/${id(profileId)}/extensions`); }
  assignExtension(profileId: string, assignment: JsonObject) { return this.request("POST", `profiles/${id(profileId)}/extensions`, assignment); }
  assignProxy(profileId: string, options: JsonObject) { return this.request("POST", `profiles/${id(profileId)}/network`, options); }
  setScreen(profileId: string, width: number, height: number) { return this.request("POST", `profiles/${id(profileId)}/screen`, { width, height }); }
  workflows() { return this.request("GET", "workflows"); }
  saveWorkflow(workflow: JsonObject) { return this.request("POST", "workflows", workflow); }
  runWorkflow(workflowId: string, profileIds: string[]) { return this.request("POST", `workflows/${id(workflowId)}/run`, { profileIds: profileIds.map(id) }); }
  jobs() { return this.request("GET", "jobs"); }
  cancelJob(jobId: string) { return this.request("POST", `jobs/${id(jobId)}/cancel`, {}); }
  jobOutput(jobId: string, format: "json" | "csv" = "json") { return this.request("GET", `jobs/${id(jobId)}/output?format=${format}`); }
  /** Changing selection alone never changes a saved following assignment. */
  syncStatus() { return this.request("GET", "sync"); }
  follow(adminId: string, followerIds: string[], saveSession = false) { return this.request("POST", "sync", { adminId: id(adminId), followerIds: followerIds.map(id), saveSession }); }
  stopFollowing() { return this.request("DELETE", "sync"); }
  resumeSession() { return this.request("POST", "sync", { action: "resume" }); }
  saveSession(saveSession = true) { return this.request("POST", "sync", { action: "save", saveSession }); }
  proxies() { return this.request("GET", "proxies"); }
  importProxies(options: JsonObject) { return this.request("POST", "proxies/import", options); }
  schedules() { return this.request("GET", "schedules"); }
  saveSchedule(schedule: JsonObject, scheduleId?: string) { return this.request("POST", `schedules${scheduleId ? `/${id(scheduleId)}` : ""}`, schedule); }
}
function record(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value); }
function id(value: string): string { if (typeof value !== "string" || !new RegExp(`^${ID}$`).test(value) || DEVICE_NAME.test(value)) throw new StakeModeError("CONFIG"); return value; }
function validateRequest(method: string, path: string, body?: JsonObject): void {
  if (!["GET", "POST", "DELETE"].includes(method) || typeof path !== "string" || path.length > 8192 || /[#\\%\u0000-\u0020\u007f]/.test(path.split("?")[0]!) || (body !== undefined && (!record(body) || method === "GET"))) throw new StakeModeError("CONFIG");
  const [pathname, query, extra] = path.split("?");
  if (!ROUTES.test(pathname!) || extra !== undefined) throw new StakeModeError("CONFIG");
  const profileId = /^(?:library\/)?profiles\/([^/]+)(?:\/|$)/.exec(pathname!)?.[1];
  if (profileId) id(profileId);
  if (query !== undefined) {
    const params = new URLSearchParams(query), keys = [...params.keys()];
    if (keys.length !== 1) throw new StakeModeError("CONFIG");
    if (pathname === "library/export" && keys[0] === "ids") { const ids = params.get("ids")!.split(","); if (!ids.length || ids.length > 256) throw new StakeModeError("CONFIG"); ids.forEach(id); }
    else if (new RegExp(`^jobs/${ID}/output$`).test(pathname!) && keys[0] === "format" && ["json", "csv"].includes(params.get("format")!)) { /* fixed output format */ }
    else if (new RegExp(`^profiles/${ID}/cookies$`).test(pathname!) && keys[0] === "origin") {
      let origin: URL; try { origin = new URL(params.get("origin")!); } catch { throw new StakeModeError("CONFIG"); }
      if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) throw new StakeModeError("CONFIG");
    } else throw new StakeModeError("CONFIG");
  }
}

/** Preferred branding; original exports stay source-compatible. */
export { StakeModeClient as GameBrowserClient, StakeModeError as GameBrowserError };
