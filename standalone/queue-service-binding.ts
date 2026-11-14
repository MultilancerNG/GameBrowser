/** Keep an encrypted pending queue attached to the service that created it. */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeSecureServiceUrl, parseAppConfig } from "../app-config.ts";
import type { PendingSyncInitialization, PendingSyncRuntime } from "../pending-sync.ts";

export interface BoundPendingQueueOptions { runtime: PendingSyncRuntime; root: string; baseUrl: string; queueKey?: string; }
const BINDING = "pending-sync-service.json";

function service(value: string): string {
  const normalized = normalizeSecureServiceUrl(value, "Cloud"), url = new URL(normalized);
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("Cloud queue service must be an HTTPS address without credentials or query strings");
  return normalized;
}
function noLinkedParents(root: string): void {
  for (let current = root; ; current = dirname(current)) {
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Cloud queue service storage must use regular directories without links or junctions");
    }
    if (dirname(current) === current) return;
  }
}
function jsonFile(path: string): unknown {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 64 * 1024) throw new Error("Cloud queue service record is unsafe or unreadable");
  return JSON.parse(readFileSync(path, "utf8"));
}
function bindingAt(path: string): string | undefined {
  try {
    const value = jsonFile(path) as { version?: unknown; baseUrl?: unknown };
    if (!value || value.version !== 1 || typeof value.baseUrl !== "string") throw new Error();
    return service(value.baseUrl);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cloud queue service record could not be verified; preserve the queue and recover it with its original service");
  }
}
function legacyService(root: string): string | undefined {
  try { return parseAppConfig(jsonFile(join(root, "config.json"))).cloudUrl; } catch { return undefined; }
}
function mismatch(): Error { return new Error("Pending browser sessions belong to another or unknown Cloud service. Reconnect the original configured service and finish synchronization before changing services; the encrypted queue was preserved."); }

/** Call before constructing a coordinator or reading any queued session payload. */
export function initializeBoundPendingQueue({ runtime, root: input, baseUrl, queueKey }: BoundPendingQueueOptions): PendingSyncInitialization {
  const root = resolve(input), selectedService = service(baseUrl);
  noLinkedParents(root); mkdirSync(root, { recursive: true, mode: 0o700 }); noLinkedParents(root);
  const path = join(root, BINDING), lock = join(root, ".pending-sync-service.lock");
  let descriptor: number;
  try { descriptor = openSync(lock, "wx", 0o600); }
  catch { throw new Error("Cloud queue service verification is already in progress or its lock needs recovery; the encrypted queue was preserved"); }
  let temporary: string | undefined, initialized = false;
  try {
    const previous = bindingAt(path), encrypted = runtime.hasEncryptedState();
    if (encrypted && (previous ? previous !== selectedService : legacyService(root) !== selectedService)) throw mismatch();
    const result = runtime.initialize(queueKey);
    initialized = true;
    // Another writer must not populate an empty queue between proof and binding.
    if (!encrypted && previous !== selectedService && runtime.hasEncryptedState()) throw mismatch();
    if (previous !== selectedService) {
      temporary = join(root, `.${BINDING}.${randomUUID()}.tmp`);
      writeFileSync(temporary, `${JSON.stringify({ version: 1, baseUrl: selectedService })}\n`, { flag: "wx", mode: 0o600 });
      // Check again before the atomic record replacement. A linked file is never replaced.
      if (bindingAt(path) !== previous) throw new Error("Cloud queue service record changed while it was being verified");
      renameSync(temporary, path); temporary = undefined;
    }
    return result;
  } catch (error) {
    if (initialized) runtime.close();
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { force: true });
    closeSync(descriptor); rmSync(lock, { force: true });
  }
}
