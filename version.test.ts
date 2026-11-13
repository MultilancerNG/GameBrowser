import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALIASMODE_VERSION } from "./version.ts";
const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

test("GameBrowser release versions agree across runtime and Windows bundles", () => {
  const pkg = JSON.parse(read("package.json"));
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargoVersion = read("src-tauri/Cargo.toml").match(/^version = "([^"]+)"$/m)?.[1];
  const lockedVersion = read("src-tauri/Cargo.lock").match(/name = "aliasmode-desktop"\r?\nversion = "([^"]+)"/)?.[1];
  for (const version of [pkg.version, config.version, cargoVersion, lockedVersion]) expect(version).toBe(ALIASMODE_VERSION);
  expect(config.productName).toBe("GameBrowser");
  expect(config.identifier).toBe("ng.solomon.gamebrowser");
  expect(config.bundle.targets).toEqual(["nsis"]);
  expect(config.bundle.windows.nsis.installMode).toBe("currentUser");
  expect(config.bundle.windows.webviewInstallMode.type).toBe("offlineInstaller");
  expect(config.plugins.updater.pubkey.length).toBeGreaterThan(40);
  const slim = JSON.parse(read("src-tauri/tauri.updater.conf.json"));
  expect(slim.bundle.windows.webviewInstallMode.type).toBe("downloadBootstrapper");
});

test("Windows release path uses GameBrowser assets and keeps verification", () => {
  const updater = read("src-tauri/src/releases.rs");
  expect(updater).toContain("https://api.github.com/repos/MultilancerNG/GameBrowser/releases?per_page=10");
  expect(updater).toContain('/MultilancerNG/GameBrowser/releases/download/{tag}/{name}');
  expect(updater).toContain('format!("GameBrowser_{version}_x64-setup.exe")');
  expect(updater).not.toContain("https://api.github.com/repos/aliasmode/aliasmode/releases");
  const workflow = read(".github/workflows/windows.yml");
  expect(workflow).toContain("bun test");
  expect(workflow).toContain("bun run typecheck");
  expect(workflow).toContain("Runtime checksum mismatch");
  expect(workflow).toContain("--verify-tag");
  expect(workflow).toContain("Tag must match application version");
  expect(workflow).not.toContain("--clobber");
});
