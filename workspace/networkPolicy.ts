/** Browser proxy selection never creates or changes an operating-system VPN. */
import type { Profile, ProxySpec } from "../types.ts";
import { normalizeProxySpec } from "../proxy.ts";

export type NetworkMode = "direct" | "system" | "proxy";
export interface NetworkUpdate { networkMode: NetworkMode; proxy?: string | ProxySpec | null; }
export function normalizeNetworkMode(value: unknown): NetworkMode {
  if (value !== "direct" && value !== "system" && value !== "proxy") throw new Error("network mode must be direct, system, or proxy");
  return value;
}
export function legacyNetworkMode(profile: Pick<Profile, "proxy" | "proxyError">): NetworkMode {
  // Quarantined legacy proxy settings must never silently turn into direct mode.
  return profile.proxy || profile.proxyError ? "proxy" : "direct";
}
export function effectiveProfileProxy(profile: Pick<Profile, "proxy" | "proxyError">, mode: NetworkMode): ProxySpec | null {
  if (mode !== "proxy") return null;
  if (profile.proxyError) throw new Error("Saved proxy settings are invalid; replace the proxy before using proxy mode");
  const proxy = normalizeProxySpec(profile.proxy);
  if (!proxy) throw new Error("Proxy mode requires an explicit HTTP, HTTPS, or SOCKS5 endpoint");
  if (proxy.type === "https" && proxy.user) throw new Error("Authenticated HTTPS proxies are unsupported; use HTTP or SOCKS5 authentication");
  return proxy;
}
export function networkSummary(mode: NetworkMode, proxy: ProxySpec | null): string {
  if (mode === "direct") return "Direct browser connection; the operating-system VPN route still applies";
  if (mode === "system") return "Use the operating-system proxy and VPN route";
  if (!proxy) return "Explicit proxy required; saved proxy settings need attention";
  const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
  return `${proxy.type.toUpperCase()} proxy ${host}:${proxy.port}${proxy.user ? " (authenticated)" : ""}`;
}
