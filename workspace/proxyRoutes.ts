/** Called only after the workspace's same-origin and bearer-token guards. */
import { boundedJson } from "./protocol.ts";
import { MAX_PROXY_IMPORT_BYTES, ProxyLibrary, ProxyLibraryError, type ProxyAssignmentManager } from "./proxyLibrary.ts";

export interface ProxyRouteOptions {
  library: ProxyLibrary;
  manager: ProxyAssignmentManager & { list(): unknown[] };
  snapshot?: () => unknown;
  changed?: () => void;
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
export async function handleProxyRoute(request: Request, url: URL, options: ProxyRouteOptions): Promise<Response | undefined> {
  const prefix = "/workspace/api/proxies";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return undefined;
  try {
    if (url.pathname === prefix) {
      if (request.method === "GET") return json({ proxies: options.library.list() });
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const proxy = options.library.create(await boundedJson(request)); options.changed?.();
      return json({ proxy, proxies: options.library.list() }, 201);
    }
    if (url.pathname === `${prefix}/import`) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const body = await boundedJson(request, MAX_PROXY_IMPORT_BYTES);
      if (Object.keys(body).some(key => !["text", "group"].includes(key))) throw new ProxyLibraryError("Proxy import contains an unsupported field");
      const imported = options.library.importText(body.text, body.group ?? ""); options.changed?.();
      return json({ imported, proxies: options.library.list() }, 201);
    }
    const match = /^\/workspace\/api\/proxies\/(proxy_[a-f0-9]{32})(?:\/(assign))?$/.exec(url.pathname);
    if (!match) return json({ error: "Route not found" }, 404);
    const id = match[1]!;
    if (match[2] === "assign") {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const body = await boundedJson(request);
      if (Object.keys(body).some(key => key !== "profileIds")) throw new ProxyLibraryError("Proxy assignment contains an unsupported field");
      const results = options.library.assign(id, body.profileIds, options.manager); options.changed?.();
      return json({ results, snapshot: options.snapshot?.() ?? options.manager.list() });
    }
    if (request.method === "DELETE") {
      options.library.delete(id); options.changed?.();
      return json({ deleted: true, proxyId: id, proxies: options.library.list() });
    }
    if (request.method === "POST" || request.method === "PATCH") {
      const proxy = options.library.update(id, await boundedJson(request)); options.changed?.();
      return json({ proxy, proxies: options.library.list() });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    // Never echo parser input, filesystem paths, or an underlying manager error:
    // those may contain endpoint credentials in third-party implementations.
    if (error instanceof ProxyLibraryError) return json({ error: error.message }, error.status);
    return json({ error: "Saved proxy request could not finish; check the input and local storage" }, 400);
  }
}
