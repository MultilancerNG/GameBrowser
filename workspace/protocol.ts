import { randomBytes, timingSafeEqual } from "node:crypto";
import { isSafeProfileId } from "../profile-id.ts";

export const WORKSPACE_PORT = 8080;
export const MAX_PACKET_BYTES = 32 * 1024;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_VISIBLE_PROFILES = 12;
export type SyncRole = "admin" | "follower" | "manual";
export type PacingMode = "fast" | "paced";
export type SyncController = "extension" | "worker";
/** Only the authenticated local runtime may host a profile relay. */
export function relayEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Relay endpoint is invalid");
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !Number.isInteger(Number(url.port || (url.protocol === "wss:" ? 443 : 80))) || Number(url.port || (url.protocol === "wss:" ? 443 : 80)) < 1 || Number(url.port || (url.protocol === "wss:" ? 443 : 80)) > 65535
    || !["/relay", "/workspace/relay", "/workspace/cloud/relay"].includes(url.pathname) || url.username || url.password || url.search || url.hash) {
    throw new Error("Relay must use a validated loopback workspace endpoint");
  }
  return url.href;
}
export interface SyncProfileConfig {
  profileId: string;
  token: string;
  role: SyncRole;
  origins: string[];
  relayUrl: string;
  controller?: SyncController;
  /** Keep assigned roles through transient transport and page failures. */
  preserveAssignments?: boolean;
  paused?: boolean;
  epoch: number;
}
export interface ManualControl {
  profileId: string;
  kind: "click" | "key" | "text" | "scroll";
  x?: number;
  y?: number;
  key?: string;
  text?: string;
  deltaX?: number;
  deltaY?: number;
}
export interface LiveFrame {
  type: "FRAME";
  profileId: string;
  jpeg: string;
  width: number;
  height: number;
  sequence: number;
  at: number;
  url: string;
}
export function sessionToken(): string { return randomBytes(32).toString("base64url"); }
export function sameToken(left: unknown, right: string): boolean {
  if (typeof left !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(left) || left.length !== right.length) return false;
  const leftBytes = Buffer.from(left), rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
export function isLoopback(address: string | undefined | null): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
export function approvedOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Origin is invalid");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Use an exact HTTPS origin, or an HTTP loopback test origin");
  }
  return url.origin;
}
export function approvedUrl(value: unknown, origins: readonly string[]): string {
  if (typeof value !== "string" || value.length > 4096) throw new Error("URL is invalid");
  const url = new URL(value);
  if (url.username || url.password || !origins.includes(url.origin)) throw new Error("This website origin has not been approved");
  return url.href;
}
export function publicPageUrl(value: string): string {
  if (value === "about:blank") return value;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? `${url.origin}${url.pathname}` : ""; } catch { return ""; }
}
/** Cross-origin websites cannot obtain local dashboard credentials, including via navigation or form posts. */
export function trustedLocalRequest(request: Request, remoteAddress: string): boolean {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return isLoopback(remoteAddress)
    && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && (!host || host === url.host)
    && (!origin || origin === url.origin)
    && (!fetchSite || fetchSite === "same-origin" || fetchSite === "none")
    && request.headers.get("x-stakemode-workspace") === "1";
}
export async function boundedJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) throw new Error("Request body limit is invalid");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error("Request is too large");
  const reader = request.body?.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error("Request is too large"); }
      chunks.push(chunk.value);
    }
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request must contain JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request JSON must be an object");
  return value as Record<string, unknown>;
}
export function safeManualControl(value: unknown): ManualControl {
  if (!value || typeof value !== "object") throw new Error("Control is invalid");
  const v = value as Record<string, unknown>;
  if (!isSafeProfileId(v.profileId)) throw new Error("Profile is invalid");
  const finite = (n: unknown, max: number) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= max;
  if (v.kind === "click" && finite(v.x, 8192) && finite(v.y, 8192) && Number(v.x) >= 0 && Number(v.y) >= 0) return v as unknown as ManualControl;
  if (v.kind === "scroll" && finite(v.deltaX, 3000) && finite(v.deltaY, 3000)) return v as unknown as ManualControl;
  if (v.kind === "text" && typeof v.text === "string" && v.text.length <= 4096 && !v.text.includes("\u0000")) return v as unknown as ManualControl;
  if (v.kind === "key" && typeof v.key === "string" && /^(?:[a-zA-Z0-9]|Backspace|Delete|Enter|Tab|Escape|Space|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/.test(v.key)) return v as unknown as ManualControl;
  throw new Error("Control is invalid or exceeds its limit");
}

export const MAX_JPEG_BYTES = 4 * 1024 * 1024;
/** Native screenshots are the authority for their pixel dimensions. Browser
 * fingerprint settings may deliberately mask window.innerWidth/innerHeight. */
export function jpegDimensions(data: Uint8Array): { width: number; height: number } {
  if (data.byteLength < 4 || data.byteLength > MAX_JPEG_BYTES || data[0] !== 0xff || data[1] !== 0xd8) throw new Error("Browser frame is not a bounded JPEG");
  let offset = 2;
  while (offset < data.byteLength) {
    if (data[offset++] !== 0xff) throw new Error("Browser JPEG marker is invalid");
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) throw new Error("Browser JPEG dimensions are unavailable");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.byteLength) throw new Error("Browser JPEG header is truncated");
    const length = data[offset]! * 256 + data[offset + 1]!;
    if (length < 2 || offset + length > data.byteLength) throw new Error("Browser JPEG segment is invalid");
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (length < 8 || data[offset + 2] !== 8) throw new Error("Browser JPEG frame header is invalid");
      const height = data[offset + 3]! * 256 + data[offset + 4]!;
      const width = data[offset + 5]! * 256 + data[offset + 6]!;
      const components = data[offset + 7]!;
      if (components < 1 || components > 4 || length !== 8 + components * 3 || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 4096 * 2160) throw new Error("Browser JPEG dimensions exceed live-view limits");
      return { width, height };
    }
    offset += length;
  }
  throw new Error("Browser JPEG dimensions are unavailable");
}

export const MAX_BROWSER_TABS = 24;
export type BrowserAction = "navigate" | "back" | "forward" | "reload" | "stop" | "new-tab" | "select-tab" | "close-tab";
export interface BrowserCommand { action: BrowserAction; url?: string; tabId?: string; }
export interface BrowserTabState { id: string; title: string; url: string; loading: boolean; }
export interface ProfileBrowserState {
  profileId: string;
  activeTabId: string | null;
  tabs: BrowserTabState[];
  loading: boolean;
  canGoBack: boolean | null;
  canGoForward: boolean | null;
  error?: string;
  redacted?: boolean;
}
/** Manual browsing is independent of the explicit synchronization allowlist. */
export function browsingUrl(value: unknown, allowBlank = false): string {
  if (allowBlank && value === "about:blank") return "about:blank";
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Browser URL is invalid");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a complete HTTPS website address"); }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password) throw new Error("Use HTTPS, or HTTP for a loopback website; URL credentials are not supported");
  return url.href;
}
export function browserCommand(value: unknown): BrowserCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser command must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["action", "url", "tabId"].includes(key))) throw new Error("Browser command contains an unsupported field");
  if (!["navigate", "back", "forward", "reload", "stop", "new-tab", "select-tab", "close-tab"].includes(String(input.action))) throw new Error("Browser action is unsupported");
  if (input.tabId !== undefined && (typeof input.tabId !== "string" || !/^tab_[a-zA-Z0-9_-]{16,64}$/.test(input.tabId))) throw new Error("Browser tab identifier is invalid");
  if (["select-tab", "close-tab"].includes(String(input.action)) && !input.tabId) throw new Error("Choose a browser tab");
  if (input.action === "navigate") return { action: "navigate", url: browsingUrl(input.url), ...(input.tabId ? { tabId: input.tabId as string } : {}) };
  if (input.action === "new-tab") return { action: "new-tab", url: browsingUrl(input.url ?? "about:blank", true) };
  if (input.url !== undefined) throw new Error("This browser action does not accept an address");
  return { action: input.action as BrowserAction, ...(input.tabId ? { tabId: input.tabId as string } : {}) };
}

export interface SiteCookie {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None";
}
/** Parent domains are admitted only when this browser already owns that cookie
 * scope; this avoids guessing public-suffix boundaries or accepting a supercookie. */
export function siteCookies(value: unknown, origin: string, existingDomains: readonly string[] = []): SiteCookie[] {
  const hostname = new URL(approvedOrigin(origin)).hostname.toLowerCase();
  if (!Array.isArray(value) || value.length > 256 || Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error("Import at most 256 cookies and 64 KiB per site");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Cookie is invalid");
    const v = item as Record<string, unknown>;
    if (Object.keys(v).some(key => !["name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite"].includes(key))) throw new Error("Cookie contains an unsupported field");
    if (typeof v.name !== "string" || !v.name.length || v.name.length > 256 || /[\x00-\x20\x7f()<>@,;:\\"/\[\]?={}]/.test(v.name)
      || typeof v.value !== "string" || v.value.length > 4096 || /[\x00-\x1f\x7f;]/.test(v.value)) throw new Error("Cookie name or value is invalid");
    if (typeof v.domain !== "string" || v.domain.length > 253 || v.domain !== v.domain.toLowerCase() || /[\s/:@?#]/.test(v.domain)) throw new Error("Cookie domain is invalid");
    const domain = v.domain.replace(/^\./, "");
    const exactHost = domain === hostname;
    const knownParent = existingDomains.includes(v.domain) && hostname.endsWith(`.${domain}`);
    if (!exactHost && !knownParent) throw new Error("Cookie domain must belong to the requested website; new parent-domain scopes are not imported");
    if (typeof v.path !== "string" || !v.path.startsWith("/") || v.path.length > 2048 || /[\x00-\x1f\x7f;]/.test(v.path)) throw new Error("Cookie path is invalid");
    if (typeof v.expires !== "number" || !Number.isFinite(v.expires) || (v.expires !== -1 && (v.expires < 0 || v.expires > 253402300799))) throw new Error("Cookie expiry is invalid");
    if (typeof v.secure !== "boolean" || typeof v.httpOnly !== "boolean" || !["Strict", "Lax", "None"].includes(String(v.sameSite))) throw new Error("Cookie flags are invalid");
    if (v.sameSite === "None" && !v.secure) throw new Error("SameSite=None cookies require Secure");
    if (v.name.startsWith("__Secure-") && !v.secure) throw new Error("Secure cookie prefix requires Secure");
    if (v.name.startsWith("__Host-") && (!v.secure || v.path !== "/" || v.domain.startsWith("."))) throw new Error("Host cookie prefix requires a secure host-only root cookie");
    return { name: v.name, value: v.value, domain: v.domain, path: v.path, expires: v.expires, httpOnly: v.httpOnly, secure: v.secure, sameSite: v.sameSite } as SiteCookie;
  });
}
