import { isSafeProfileId } from "../profile-id.ts";
import { validateActionPacket, type ActionPacket } from "./eventPolicy.ts";
import { approvedOrigin, approvedUrl, relayEndpoint, sameToken, sessionToken, type PacingMode, type SyncController, type SyncProfileConfig, type SyncRole } from "./protocol.ts";

export interface RelayTransport { send(packet: unknown): void; close(code?: number, reason?: string): void; }
interface RegisteredProfile {
  config: SyncProfileConfig;
  transport?: RelayTransport;
  paused: boolean;
  explicitPaused: boolean;
  activeOrigin: string;
  activeUrl: string;
  queued: ActionPacket[];
  timer?: ReturnType<typeof setTimeout>;
  awaiting?: { id: string; epoch: number; timer: ReturnType<typeof setTimeout> };
}
export interface RelayProfileStatus { profileId: string; role: SyncRole; paused: boolean; connected: boolean; origin: string; queued: number; }
export interface SyncRelayOptions {
  controller?: SyncController;
  preserveAssignments?: boolean;
  isAuthorized?: (profileId: string) => boolean;
  onChange?: () => void;
  onAction?: (profileId: string, action: ActionPacket) => void;
  onManual?: (profileId: string, reason: string) => void;
  random?: () => number;
  ackTimeoutMs?: number;
}
const MAX_QUEUE = 64;
/** Authenticated, bounded FIFO dispatcher. Pacing is scheduling, never a detection-evasion promise. */
export class SyncRelay {
  private profiles = new Map<string, RegisteredProfile>();
  private epochValue = 1;
  private lastAdminSequence = 0;
  private pacingValue: PacingMode = "fast";
  private approvedOrigins = new Set<string>();
  private relayUrlValue = "ws://127.0.0.1:8080/relay";
  get controller(): SyncController { return this.options.controller ?? "extension"; }
  setRelayUrl(value: string): void {
    const url = relayEndpoint(value);
    this.relayUrlValue = url;
    for (const profile of this.profiles.values()) profile.config.relayUrl = url;
  }
  private authorized(id: string): boolean { return this.options.isAuthorized?.(id) !== false; }
  /** Roles change only through explicit user commands, never browser focus. */
  setGroup(adminId: string | null, followerIds: string[]): void {
    if ((!adminId && followerIds.length) || new Set([...(adminId ? [adminId] : []), ...followerIds]).size !== followerIds.length + Number(!!adminId)) throw new Error("Sync group is invalid");
    if (adminId) this.require(adminId);
    for (const id of followerIds) this.require(id);
    const followers = new Set(followerIds);
    let changed = false;
    for (const [id, profile] of this.profiles) {
      const role: SyncRole = id === adminId ? "admin" : followers.has(id) ? "follower" : "manual";
      if (profile.config.role === role) continue;
      profile.config.role = role; profile.paused = false; profile.explicitPaused = false; changed = true;
      if (role === "manual") this.options.onManual?.(id, "operator_group_changed");
    }
    if (changed) this.invalidate();
  }
  constructor(private options: SyncRelayOptions = {}) {}
  get epoch(): number { return [...this.profiles.values()].find(p => p.config.role === "admin")?.config.epoch ?? this.epochValue; }
  get pacing(): PacingMode { return this.pacingValue; }
  get origins(): string[] { return [...this.approvedOrigins]; }
  configure(origins: unknown[], pacing: unknown = this.pacing): void {
    if (origins.length > 32 || (pacing !== "fast" && pacing !== "paced")) throw new Error("Workspace settings are invalid");
    this.approvedOrigins = new Set(origins.map(approvedOrigin));
    this.pacingValue = pacing;
    for (const p of this.profiles.values()) {
      p.config.origins = p.config.origins.filter(origin => this.approvedOrigins.has(origin));
      if (this.controller === "extension" && !p.config.origins.length && p.config.role !== "manual") this.interrupt(p.config.profileId, "origin_removed");
    }
    this.invalidate();
  }
  register(profileId: string, origin?: string): SyncProfileConfig {
    if (!isSafeProfileId(profileId)) throw new Error("Workspace profile ID is invalid");
    let p = this.profiles.get(profileId);
    if (!p) {
      p = { config: { profileId, token: sessionToken(), role: "manual", origins: [], relayUrl: this.relayUrlValue, ...(this.controller === "worker" ? { controller: "worker" as const } : {}), ...(this.options.preserveAssignments ? { preserveAssignments: true } : {}), epoch: ++this.epochValue }, paused: false, explicitPaused: false, activeOrigin: "", activeUrl: "", queued: [] };
      this.profiles.set(profileId, p);
    }
    if (origin) {
      const canonical = approvedOrigin(origin);
      if (!this.approvedOrigins.has(canonical)) throw new Error("This website origin has not been approved");
      p.config.origins = [canonical];
    }
    return { ...p.config, origins: [...p.config.origins] };
  }
  tokenFor(profileId: string): string | undefined { return this.profiles.get(profileId)?.config.token; }
  configFor(profileId: string): SyncProfileConfig | undefined {
    const p = this.profiles.get(profileId);
    return p ? { ...p.config, origins: [...p.config.origins], paused: p.paused } : undefined;
  }
  statuses(): RelayProfileStatus[] {
    return [...this.profiles].map(([profileId, p]) => ({ profileId, role: p.config.role, paused: p.paused, connected: !!p.transport, origin: p.activeOrigin, queued: p.queued.length + (p.awaiting ? 1 : 0) }));
  }
  setRole(profileId: string, role: SyncRole): void {
    const p = this.require(profileId);
    if (!["admin", "follower", "manual"].includes(role)) throw new Error("Role is invalid");
    const affectsAdmin = role === "admin" || p.config.role === "admin";
    if (role === "admin") for (const other of this.profiles.values()) if (other !== p && other.config.role === "admin") { other.config.role = "manual"; this.options.onManual?.(other.config.profileId, "administrator_changed"); }
    p.config.role = role;
    p.paused = false; p.explicitPaused = false;
    if (affectsAdmin) this.invalidate(); else this.invalidateProfile(p);
    if (role === "manual") this.options.onManual?.(profileId, "operator_manual");
  }
  explicitlyPausedProfileIds(): string[] { return [...this.profiles].filter(([, p]) => p.explicitPaused).map(([id]) => id); }
  setPaused(profileId: string, enabled: boolean): void {
    const p = this.require(profileId);
    p.explicitPaused = enabled; p.paused = enabled;
    if (p.config.role === "admin") this.invalidate(); else this.invalidateProfile(p);
  }
  setOrigin(profileId: string, origin: string): void {
    const canonical = approvedOrigin(origin);
    if (!this.approvedOrigins.has(canonical)) throw new Error("This website origin has not been approved");
    const p = this.require(profileId);
    p.config.origins = [canonical];
    p.activeOrigin = "";
    if (p.config.role === "admin") this.invalidate(); else this.invalidateProfile(p);
  }
  authenticate(profileId: unknown, token: unknown, transport: RelayTransport): boolean {
    if (typeof profileId !== "string") return false;
    const p = this.profiles.get(profileId);
    if (!p || !sameToken(token, p.config.token) || !this.authorized(profileId)) return false;
    if (p.transport) { p.transport.close(4009, "A profile connection already exists"); this.disconnect(profileId, p.transport); }
    p.transport = transport;
    if (this.controller === "worker" || this.options.preserveAssignments) { p.paused = p.explicitPaused; this.invalidateProfile(p); }
    transport.send(this.publicConfig(p));
    this.options.onChange?.();
    return true;
  }
  receive(profileId: string, transport: RelayTransport, packet: unknown): void {
    const p = this.require(profileId);
    if (p.transport !== transport || !packet || typeof packet !== "object") return;
    const v = packet as Record<string, unknown>;
    if (!this.authorized(profileId)) { this.suspend(p); return; }
    if (this.controller === "worker") {
      // The trusted Node observer is the only action controller. Legacy
      // content scripts cannot double-replay actions or dissolve a saved group.
      if (v.type === "MANUAL_OVERRIDE" && v.source === "extension-popup") this.manual(profileId, "operator_manual");
      else if (v.type === "PAGE") {
        try { const url = new URL(String(v.url)); p.activeOrigin = ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.origin : ""; } catch { p.activeOrigin = ""; }
        this.options.onChange?.();
      }
      return;
    }
    if (v.type === "PAGE") {
      if (this.options.preserveAssignments && v.url === "about:blank") { p.activeOrigin = ""; p.activeUrl = "about:blank"; this.options.onChange?.(); return; }
      try {
        const url = approvedUrl(v.url, p.config.origins);
        const changed = p.activeUrl !== url;
        p.activeOrigin = new URL(url).origin; p.activeUrl = url;
        if (changed && this.options.preserveAssignments && p.config.role === "admin") this.lastAdminSequence = 0;
      }
      catch { p.activeOrigin = ""; this.interrupt(profileId, "unapproved_page"); }
      this.options.onChange?.();
      return;
    }
    if (v.type === "MANUAL_OVERRIDE") {
      if (!this.options.preserveAssignments || v.source === "extension-popup") this.manual(profileId, "operator_manual");
      else this.interrupt(profileId, "page_requires_manual");
      return;
    }
    if (v.type === "ACK") {
      if (typeof v.id !== "string" || !p.awaiting || p.awaiting.id !== v.id || v.epoch !== p.awaiting.epoch || v.epoch !== p.config.epoch) return;
      clearTimeout(p.awaiting.timer);
      p.awaiting = undefined;
      if (v.status !== "applied") this.interrupt(profileId, "action_rejected");
      else this.dispatchNext(profileId, p);
      this.options.onChange?.();
      return;
    }
    if (v.type !== "ACTION") return;
    if (p.config.role !== "admin" || p.paused || !p.activeOrigin) return;
    const valid = validateActionPacket(packet, { origins: p.config.origins, epoch: p.config.epoch });
    if (!valid.ok) { transport.send({ type: "ACTION_REJECTED", reason: valid.reason }); return; }
    const action = valid.action;
    if (action.seq <= this.lastAdminSequence || action.origin !== p.activeOrigin) {
      transport.send({ type: "ACTION_REJECTED", reason: "sequence_or_origin_mismatch" }); return;
    }
    this.lastAdminSequence = action.seq;
    this.options.onAction?.(profileId, action);
    for (const [id, target] of this.profiles) {
      if (id === profileId || target.config.role !== "follower" || target.paused || !target.transport || target.activeOrigin !== action.origin || !target.config.origins.includes(action.origin)) continue;
      if (target.queued.length + (target.awaiting ? 1 : 0) >= MAX_QUEUE) { this.interrupt(id, "queue_limit"); continue; }
      target.queued.push({ ...action, epoch: target.config.epoch });
      this.dispatchNext(id, target);
    }
    this.options.onChange?.();
  }
  private dispatchNext(id: string, p: RegisteredProfile): void {
    if (p.timer || p.awaiting || !p.transport || p.paused || p.config.role !== "follower" || !p.queued.length) return;
    const epoch = p.config.epoch;
    const next = () => {
      p.timer = undefined;
      if (epoch !== p.config.epoch || !p.transport || p.paused || p.config.role !== "follower") return;
      const admin = [...this.profiles].find(([, profile]) => profile.config.role === "admin");
      if (!admin || !this.authorized(admin[0]) || !this.authorized(id)) { this.suspend(p); return; }
      const action = p.queued.shift();
      if (!action || action.epoch !== p.config.epoch || p.activeOrigin !== action.origin) { this.interrupt(id, "origin_changed"); return; }
      p.awaiting = { id: action.id, epoch: action.epoch, timer: setTimeout(() => {
        if (p.awaiting?.id === action.id && p.awaiting.epoch === action.epoch) this.interrupt(id, "ack_timeout");
      }, this.options.ackTimeoutMs ?? 6000) };
      try { p.transport.send(action); } catch { this.interrupt(id, "transport_error"); }
    };
    if (this.pacing === "fast") next();
    else p.timer = setTimeout(next, 450 + Math.floor(Math.min(0.999999, Math.max(0, (this.options.random ?? Math.random)())) * 1301));
  }
  disconnect(profileId: string, transport?: RelayTransport): void {
    const p = this.profiles.get(profileId);
    if (!p || (transport && p.transport !== transport)) return;
    p.transport = undefined;
    p.activeOrigin = ""; p.activeUrl = "";
    if (this.controller === "worker" || this.options.preserveAssignments) {
      // Advance the generation and discard all prior queued/awaited actions.
      p.paused = true;
      if (p.config.role === "admin") this.invalidate(); else this.invalidateProfile(p);
    } else this.manual(profileId, "disconnected");
  }
  /** Retire only a deleted local profile; its old token must never reconnect. */
  unregister(profileId: string): void {
    const p = this.profiles.get(profileId);
    if (!p) return;
    const affectsAdmin = p.config.role === "admin";
    this.profiles.delete(profileId);
    if (p.timer) clearTimeout(p.timer);
    if (p.awaiting) clearTimeout(p.awaiting.timer);
    p.timer = undefined; p.awaiting = undefined; p.queued = [];
    const transport = p.transport;
    p.transport = undefined;
    try { transport?.close(1000, "Local profile deleted"); } catch { /* The token is already revoked. */ }
    if (affectsAdmin) this.invalidate(); else this.options.onChange?.();
  }
  manualMany(profileIds: string[], reason: string): void {
    for (const profileId of profileIds) {
      const p = this.require(profileId);
      p.config.role = "manual"; p.paused = false; p.explicitPaused = false;
      this.options.onManual?.(profileId, reason);
    }
    this.invalidate();
  }
  manual(profileId: string, reason: string): void {
    const p = this.require(profileId);
    if (p.config.role === "manual" && !p.paused && !p.timer && !p.awaiting && !p.queued.length) { this.options.onManual?.(profileId, reason); return; }
    const affectsAdmin = p.config.role === "admin";
    p.config.role = "manual";
    p.paused = false; p.explicitPaused = false;
    if (affectsAdmin) this.invalidate(); else this.invalidateProfile(p);
    this.options.onManual?.(profileId, reason);
  }
  /** A protective pause never rewrites a user-selected role. */
  interrupt(profileId: string, reason: string): void {
    const p = this.require(profileId);
    if (!this.options.preserveAssignments) { this.manual(profileId, reason); return; }
    p.paused = true;
    if (p.config.role === "admin") this.invalidate(); else this.invalidateProfile(p);
  }
  private publicConfig(p: RegisteredProfile): object {
    return { type: "CONFIG", profileId: p.config.profileId, role: p.config.role, origins: p.config.origins, epoch: p.config.epoch, paused: p.paused, ...(this.controller === "worker" ? { controller: "worker" } : {}), ...(this.options.preserveAssignments ? { preserveAssignments: true } : {}) };
  }
  private suspend(p: RegisteredProfile): void {
    if (p.timer) clearTimeout(p.timer);
    if (p.awaiting) clearTimeout(p.awaiting.timer);
    p.timer = undefined; p.awaiting = undefined; p.queued = []; p.paused = true;
    try { p.transport?.send(this.publicConfig(p)); } catch { p.transport = undefined; }
    this.options.onChange?.();
  }
  private resetProfile(p: RegisteredProfile, epoch: number): void {
    if (p.timer) clearTimeout(p.timer);
    if (p.awaiting) clearTimeout(p.awaiting.timer);
    p.timer = undefined; p.awaiting = undefined; p.queued = []; p.config.epoch = epoch;
    try { p.transport?.send(this.publicConfig(p)); } catch { p.transport = undefined; if (this.controller === "worker" || this.options.preserveAssignments) p.paused = true; else p.config.role = "manual"; }
  }
  private invalidateProfile(p: RegisteredProfile): void {
    this.resetProfile(p, ++this.epochValue);
    this.options.onChange?.();
  }
  private invalidate(): void {
    const epoch = ++this.epochValue;
    this.lastAdminSequence = 0;
    for (const p of this.profiles.values()) this.resetProfile(p, epoch);
    this.options.onChange?.();
  }
  private require(profileId: string): RegisteredProfile {
    const p = this.profiles.get(profileId);
    if (!p) throw new Error("Workspace profile is missing");
    return p;
  }
  stop(): void {
    this.invalidate();
    for (const p of this.profiles.values()) { p.transport?.close(1001, "Workspace stopped"); p.transport = undefined; }
  }
}
