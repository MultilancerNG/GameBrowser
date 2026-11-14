/** Retain the native first-start import without loading the previous host application. */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrateLegacyState, type LegacyMigrationResult, type MigrationOptions } from "../migration.ts";
import { statePaths, type StatePaths } from "../paths.ts";
import { gameBrowserStateRoot } from "./runtime.ts";

export const CLOAKPIT_IMPORT_COMMAND = "__import-cloakpit";
const IMPORT_RESTRICTION = "Windows DPAPI protects persisted browser secrets, so this import works only for the same Windows machine and account. Persisted persona fields are preserved, but runtime or browser differences can change the account-visible fingerprint.";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runCloakpitImportCommand(
  args: string[],
  migrate: (source: string, destination: StatePaths, options?: MigrationOptions) => Promise<LegacyMigrationResult> = migrateLegacyState,
): Promise<{ ok: boolean; message: string }> {
  const source = flag(args, "source") ?? (existsSync(join("C:\\Cloakpit", "profiles.sqlite")) ? "C:\\Cloakpit" : undefined);
  if (!source) return { ok: false, message: `No Cloakpit source was selected. Pass an explicit source path. ${IMPORT_RESTRICTION}` };
  try {
    const root = gameBrowserStateRoot({ stateRoot: flag(args, "state-root"), desktopRoot: flag(args, "desktop-root") });
    const result = await migrate(source, statePaths(root), { profileRoot: flag(args, "cloakpit-profile-root") });
    if (result.status === "not_found") return { ok: false, message: `No profiles.sqlite was found in ${resolve(source)}. ${IMPORT_RESTRICTION}` };
    return { ok: true, message: `Imported ${result.profileCount} Cloakpit profile(s). ${IMPORT_RESTRICTION}` };
  } catch (error) {
    return { ok: false, message: `${error instanceof Error ? error.message : String(error)}. ${IMPORT_RESTRICTION}` };
  }
}
