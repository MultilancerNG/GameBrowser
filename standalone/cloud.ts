import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { normalizeSecureServiceUrl } from "../app-config.ts";
import { CloudAuthRuntime } from "../cloud-auth.ts";
import { CloudConnectionRuntime } from "../cloud-connection.ts";
import { CloudApiError, CloudClient, type CloudFetch } from "../cloud-client.ts";
import { SupabaseAuthClient } from "../supabase-auth.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import type { DesktopCredentialBridge } from "../desktop-runtime.ts";

interface Settings {
  version: 1;
  installationId: string;
  localMcp: boolean;
  cloud?: { baseUrl: string; authUrl: string; anonKey: string };
}

export interface StandaloneCloudOptions {
  root: string;
  fetchFn?: CloudFetch;
  desktopCredentials?: DesktopCredentialBridge;
  env?: Record<string, string | undefined>;
  onAuthenticated?: (context: StandaloneCloudContext) => Promise<void>;
  onSigningOut?: (context: StandaloneCloudContext) => Promise<void>;
  onCloudAuthenticated?: (context: StandaloneCloudContext) => Promise<void>;
  onCloudSigningOut?: (context: StandaloneCloudContext) => Promise<void>;
}

export interface StandaloneCloudContext {
  auth: CloudAuthRuntime;
  connection: CloudConnectionRuntime;
  configuration: { baseUrl: string; authUrl: string; anonKey: string };
  generation: number;
  current: () => boolean;
  queueKey?: string;
  fetchFn?: CloudFetch;
}

/** Optional Cloud client. Local profiles are never used as a Cloud permission cache. */
export class StandaloneCloud {
  private readonly file: string;
  private settings: Settings;
  private auth?: CloudAuthRuntime;
  private connection?: CloudConnectionRuntime;
  private generation = 0;
  private queueKey?: string;
  private exiting = false;

  constructor(private readonly options: StandaloneCloudOptions) {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.file = join(options.root, "gamebrowser-settings.json");
    this.settings = { version: 1, installationId: randomUUID(), localMcp: true };
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved.version !== 1 || typeof saved.installationId !== "string" || typeof saved.localMcp !== "boolean") throw new Error("GameBrowser settings are invalid");
      this.settings = { version: 1, installationId: saved.installationId, localMcp: saved.localMcp,
        ...(saved.cloud ? { cloud: this.parseConfig(saved.cloud) } : {}) };
    } else this.persist();
    if (this.settings.cloud) this.buildConnection();
  }

  private parseConfig(value: Record<string, unknown>): NonNullable<Settings["cloud"]> {
    const baseUrl = normalizeSecureServiceUrl(String(value.baseUrl ?? ""), "Cloud");
    const authUrl = normalizeSecureServiceUrl(String(value.authUrl || baseUrl), "Cloud authentication");
    // Public client key, never an account credential. The compatible direct service uses this default.
    const anonKey = String(value.anonKey || "aliasmode-direct-gotrue").trim();
    if (!anonKey || anonKey.length > 8192 || /[\r\n\0]/.test(anonKey)) throw new Error("Invalid public authentication key");
    for (const address of [baseUrl, authUrl]) {
      const url = new URL(address);
      if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("Cloud addresses cannot include credentials, query strings, or fragments");
    }
    return { baseUrl, authUrl, anonKey };
  }

  private persist(): void {
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private buildConnection(): void {
    const config = this.settings.cloud!;
    this.auth = new CloudAuthRuntime(new SupabaseAuthClient({ baseUrl: config.authUrl, anonKey: config.anonKey, fetchFn: this.options.fetchFn }), undefined,
      this.options.desktopCredentials ? token => this.options.desktopCredentials!.persistRefreshToken(token) : undefined,
      this.options.desktopCredentials ? () => this.options.desktopCredentials!.clearCloudSessionCredentials() : undefined);
    this.connection = new CloudConnectionRuntime({ baseUrl: config.baseUrl, accessToken: () => this.auth!.accessTokenOrRefresh(), fetchFn: this.options.fetchFn,
      installation: { installationId: this.settings.installationId, label: `${hostname()} · GameBrowser`,
        platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", appVersion: ALIASMODE_VERSION } });
  }

  state() {
    const state = this.auth?.state();
    return { configured: !!this.settings.cloud, authenticated: state?.authenticated ?? false, ...this.settings.cloud,
      ...(state?.user ? { user: state.user } : {}), sessionPersistence: this.options.desktopCredentials ? "system-credential-store" : "memory" };
  }
  localMcpEnabled(): boolean { return this.settings.localMcp; }
  setLocalMcp(enabled: boolean): void { this.settings.localMcp = enabled; this.persist(); }

  context(): StandaloneCloudContext | undefined {
    if (!this.auth || !this.connection || !this.settings.cloud) return undefined;
    const generation = this.generation;
    const auth = this.auth, connection = this.connection;
    return { auth, connection, configuration: { ...this.settings.cloud }, generation,
      ...(this.queueKey ? { queueKey: this.queueKey } : {}),
      ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
      current: () => generation === this.generation && this.auth === auth && this.connection === connection };
  }

  configure(value: Record<string, unknown>): void {
    if (this.auth && !this.auth.canSignIn()) throw new CloudApiError("Sign out before changing the Cloud service", "workspace_conflict", 409);
    const config = this.parseConfig(value);
    this.generation++;
    this.settings.cloud = config;
    this.persist();
    this.buildConnection();
  }

  async signIn(email: string, password: string, queueKey?: string): Promise<ReturnType<StandaloneCloud["state"]>> {
    if (!this.auth || !this.connection) throw new Error("Configure a compatible Cloud service first");
    const auth = this.auth;
    if (!auth.canSignIn()) throw new Error("Sign out before signing in to another Cloud account");
    return this.authenticate(() => auth.signIn(email, password), queueKey);
  }

  async restore(refreshToken: string, queueKey?: string, deviceCredential?: string): Promise<ReturnType<StandaloneCloud["state"]>> {
    if (!this.auth || !this.connection) throw new Error("Configure a compatible Cloud service first");
    const auth = this.auth;
    if (!auth.canRestore(refreshToken)) throw new Error("Sign out before restoring another Cloud account");
    return this.authenticate(() => auth.restore(refreshToken), queueKey, deviceCredential);
  }

  private async authenticate(begin: () => Promise<unknown>, queueKey?: string, deviceCredential?: string): Promise<ReturnType<StandaloneCloud["state"]>> {
    const auth = this.auth!, connection = this.connection!;
    const generation = this.generation;
    this.queueKey = queueKey;
    await begin();
    try {
      if (deviceCredential) {
        connection.restoreCredential(deviceCredential);
        const status = await connection.client.status();
        if (generation !== this.generation || status.account.id !== auth.state().user?.id) throw new Error("Cloud account changed");
        connection.restoreAccount(status.account.id);
        connection.restoreDevice(status.device.id, deviceCredential);
      } else await connection.bootstrap(() => generation === this.generation);
      if (generation !== this.generation) throw new Error("Cloud account changed");
      await this.options.onAuthenticated?.(this.context()!);
      await this.options.onCloudAuthenticated?.(this.context()!);
    } catch (error) {
      if ((error as { retainCloudAuthentication?: unknown })?.retainCloudAuthentication === true) throw error;
      await auth.signOut().catch(() => {});
      connection.clearDevice();
      throw error;
    }
    return this.state();
  }

  async signOut(): Promise<void> {
    const context = this.context();
    this.exiting = true;
    try {
      if (context) await this.options.onSigningOut?.(context);
      if (context) await this.options.onCloudSigningOut?.(context);
      this.generation++;
      await this.auth?.signOut();
      this.connection?.clearDevice();
      this.queueKey = undefined;
    } finally { this.exiting = false; }
  }

  /** Every action uses a new client and a live status/roster, scoped to the active account. */
  private async verified() {
    const generation = this.generation;
    const connection = this.connection;
    const auth = this.auth;
    if (!auth || !connection) throw new CloudApiError("Cloud sign-in is required", "authentication_required", 401);
    const token = await auth.accessTokenOrRefresh();
    if (!token) throw new CloudApiError("Cloud sign-in is required", "authentication_required", 401);
    const accountId = connection.accountId();
    const current = () => !this.exiting && generation === this.generation && this.connection === connection && connection.accountId() === accountId;
    const client = new CloudClient({ baseUrl: this.settings.cloud!.baseUrl,
      accessToken: async () => current() ? auth.accessTokenOrRefresh() : undefined,
      deviceCredential: () => current() ? connection.deviceCredential() : undefined, fetchFn: this.options.fetchFn });
    const status = await client.status();
    if (!current() || !accountId || status.account.id !== accountId) throw new CloudApiError("Cloud account changed; reload Settings", "authentication_required", 401);
    return { client, status, current };
  }

  async team() {
    const { client, status, current } = await this.verified();
    const [members, invitations, folders, profiles] = await Promise.all([client.listMembers(), client.listInvitations(), client.listFolders(), client.listProfiles()]);
    if (!current()) throw new CloudApiError("Cloud account changed; reload Team", "authentication_required", 401);
    return { ok: true, status, members: members.members, invitations: invitations.invitations, folders: folders.folders,
      profiles: profiles.profiles.filter(profile => profile.trashedAt === null) };
  }

  async groups() {
    const { client, current } = await this.verified();
    const folders = await client.listFolders();
    if (!current()) throw new CloudApiError("Cloud account changed; reload groups", "authentication_required", 401);
    return { ok: true, folders: folders.folders };
  }

  async invite(email: string, role: "admin" | "member") {
    const { client, status, current } = await this.verified();
    if (!["owner", "admin"].includes(status.workspace.role)) throw new CloudApiError("Workspace administrator access is required", "owner_only", 403);
    if (!current()) throw new Error("Cloud account changed");
    return client.createInvitation(email, role);
  }

  async share(scope: "group" | "profile", id: string, accountId: string, permission: "view" | "edit") {
    const { client, status, current } = await this.verified();
    if (!["owner", "admin"].includes(status.workspace.role)) throw new CloudApiError("Workspace administrator access is required", "owner_only", 403);
    const [members, roster] = await Promise.all([client.listMembers(), scope === "group" ? client.listFolders() : client.listProfiles()]);
    if (!members.members.some(member => member.accountId === accountId)) throw new Error("Choose a current workspace member");
    if (scope === "group") {
      if (!("folders" in roster) || !roster.folders.some(folder => folder.name === id && folder.archivedAt === null)) throw new Error("Group is unavailable");
    } else if (!("profiles" in roster) || !roster.profiles.some(profile => profile.id === id && profile.trashedAt === null)) throw new Error("Profile is unavailable");
    if (!current()) throw new Error("Cloud account changed");
    return scope === "group" ? client.setFolderGrant(id, accountId, permission) : client.setProfileGrant(id, accountId, permission);
  }

  async close(): Promise<void> {
    const context = this.context();
    if (context && this.auth?.hasSession()) {
      await this.options.onSigningOut?.(context);
      await this.options.onCloudSigningOut?.(context);
    }
    this.generation++;
  }
}
