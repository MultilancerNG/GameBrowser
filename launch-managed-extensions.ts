import type { LaunchManagedExtensions } from "./types.ts";

/** Validate and copy only device-local addon inputs, never a portable profile identity. */
export function normalizeLaunchManagedExtensions(value: unknown): LaunchManagedExtensions {
  const directories = (paths: unknown): paths is string[] => Array.isArray(paths) && paths.length <= 32 &&
    paths.every((path) => typeof path === "string" && path.length > 0 && path.length <= 4096 && !path.includes("\0"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid launch addon context");
  const context = value as Record<string, unknown>;
  if (Object.keys(context).some((key) => !["chromiumDirectories", "firefoxDirectories", "firefoxAddonUUIDs"].includes(key)) ||
    !directories(context.chromiumDirectories) || !directories(context.firefoxDirectories) ||
    !context.firefoxAddonUUIDs || typeof context.firefoxAddonUUIDs !== "object" || Array.isArray(context.firefoxAddonUUIDs) ||
    Object.keys(context.firefoxAddonUUIDs).length > 256 || Object.entries(context.firefoxAddonUUIDs).some(([id, uuid]) =>
      !/^[a-zA-Z0-9@._{}-]{1,200}$/.test(id) || ["__proto__", "prototype", "constructor"].includes(id) || typeof uuid !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid))) {
    throw new Error("Invalid launch addon context");
  }
  return {
    chromiumDirectories: [...context.chromiumDirectories], firefoxDirectories: [...context.firefoxDirectories],
    firefoxAddonUUIDs: { ...context.firefoxAddonUUIDs } as Record<string, string>,
  };
}
