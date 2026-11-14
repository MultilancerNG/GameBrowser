import type { BrowserSyncState } from "../browser-sync.ts";
import { sensitivePathPattern, type ActionPacket } from "./eventPolicy.ts";
import { approvedUrl, MAX_BROWSER_TABS, type BrowserCommand, type ProfileBrowserState } from "./protocol.ts";

export interface FollowedBrowserState {
  state: ProfileBrowserState;
  baseline: boolean;
  skipNavigation: boolean;
  reloadTabId?: string;
  stopTabId?: string;
}
export interface BrowserFollowingOptions {
  session(): BrowserSyncState;
  generation(): number;
  origins(): string[];
  pacing(): "fast" | "paced";
  ready(id: string): boolean;
  /** Relay epoch includes user pause, policy and browser reconnection changes. */
  stamp(id: string): number;
  apply(id: string, key: string, event: FollowedBrowserState, current: () => boolean): Promise<void>;
  pause(id: string): void;
}
/** Browser-owned tab/navigation events complement DOM click/input replay. This
 * controller never observes or forwards credentials, cookies or account URLs. */
export class RelayBrowserFollowing {
  private latest = new Map<string, ProfileBrowserState>();
  private queues = new Map<string, { key: string; count: number; chain: Promise<void> }>();
  private baseline = new Map<string, string>();
  private recentClick = new Map<string, number>();
  private stopped = false;
  constructor(private readonly options: BrowserFollowingOptions) {}
  noteAction(id: string, action: ActionPacket): void { if (action.action === "click") this.recentClick.set(id, Date.now()); }
  observe(state: ProfileBrowserState, command?: BrowserCommand): void {
    if (this.stopped || !validState(state, this.options.origins())) return;
    this.latest.set(state.profileId, structuredClone(state));
    const session = this.options.session();
    if (session.adminId !== state.profileId || !this.options.ready(state.profileId)) return;
    const baseKey = `${this.options.generation()}:${state.profileId}`;
    const sourceRecentClick = Date.now() - (this.recentClick.get(state.profileId) ?? 0) < 1500;
    for (const id of session.followerIds) {
      if (!this.options.ready(id)) { this.baseline.delete(id); continue; }
      const generation = this.options.generation(), sourceStamp = this.options.stamp(state.profileId), targetStamp = this.options.stamp(id);
      const key = `${baseKey}:${sourceStamp}:${targetStamp}`;
      const first = this.baseline.get(id) !== key;
      this.baseline.set(id, key);
      const event: FollowedBrowserState = { state: structuredClone(state), baseline: first,
        skipNavigation: !command && sourceRecentClick,
        ...(command?.action === "reload" && state.activeTabId ? { reloadTabId: state.activeTabId } : {}),
        ...(command?.action === "stop" && state.activeTabId ? { stopTabId: state.activeTabId } : {}) };
      const queue = this.queues.get(id);
      const next = queue?.key === key ? queue : { key, count: 0, chain: Promise.resolve() };
      if (next.count >= 32) { this.options.pause(id); this.baseline.delete(id); continue; }
      const current = () => !this.stopped && generation === this.options.generation()
        && sourceStamp === this.options.stamp(state.profileId) && targetStamp === this.options.stamp(id) && this.options.ready(id)
        && this.options.ready(state.profileId) && this.options.session().adminId === state.profileId
        && this.options.session().followerIds.includes(id);
      next.count++;
      next.chain = next.chain.then(async () => {
        if (!current()) return;
        if (this.options.pacing() === "paced" && !event.baseline) await new Promise(resolve => setTimeout(resolve, 450));
        if (!current()) return;
        await this.options.apply(id, key, event, current);
      }).catch(() => { if (current()) this.options.pause(id); }).finally(() => { next.count--; });
      this.queues.set(id, next);
    }
  }
  /** Seed current pages after explicit Apply/Resume, without replaying history. */
  seed(adminId: string): void { const state = this.latest.get(adminId); if (state) this.observe(state); }
  disconnected(id: string): void { this.baseline.delete(id); this.queues.delete(id); }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.queues.values()].map(queue => queue.chain));
    this.queues.clear(); this.latest.clear(); this.baseline.clear();
  }
}
function validState(state: ProfileBrowserState, origins: string[]): boolean {
  if (!state || state.tabs.length > MAX_BROWSER_TABS || !state.tabs.length || new Set(state.tabs.map(tab => tab.id)).size !== state.tabs.length) return false;
  try {
    for (const tab of state.tabs) {
      if (tab.url === "about:blank") continue;
      const url = new URL(approvedUrl(tab.url, origins));
      if (url.search || url.hash || sensitivePathPattern.test(url.pathname)) return false;
    }
    return !state.activeTabId || state.tabs.some(tab => tab.id === state.activeTabId);
  } catch { return false; }
}
