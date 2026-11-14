import { DESKTOP_PROTOCOL, desktopReadyRecord, isDesktopShutdownCommand } from "./desktop-runtime.ts";
import { startGameBrowser, type GameBrowserStartOptions } from "./standalone/runtime.ts";

export { startGameBrowser } from "./standalone/runtime.ts";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

export function gameBrowserStartOptions(args: string[]): GameBrowserStartOptions {
  const rawPort = flag(args, "port");
  if (rawPort !== undefined && !/^\d{1,5}$/.test(rawPort)) throw new Error("--port must be an integer from 0 to 65535");
  return {
    stateRoot: flag(args, "state-root"), desktopRoot: flag(args, "desktop-root"),
    workspaceStateRoot: flag(args, "workspace-state-root"),
    ...(rawPort !== undefined ? { port: Number(rawPort) } : {}),
    binaryPath: flag(args, "binary"), binarySha256: flag(args, "binary-sha256"),
    firefoxBinaryPath: flag(args, "firefox-binary"), firefoxBinarySha256: flag(args, "firefox-sha256"),
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args[0] === "help") {
    console.log("GameBrowser — independent StakeMode upgrade\n\n  bun GameBrowser-cli.ts start [--state-root PATH] [--port 8080]\n  bun GameBrowser-cli.ts import-state --source PATH --state-root DEST [--confirm-copy]\n\nThe Live workspace runs locally without an account. Original StakeMode SDKs use port 8080. Settings provides optional Cloud, Team and MCP features.");
    return;
  }
  if (args[0] === "__import-cloakpit") {
    const { runCloakpitImportCommand } = await import("./standalone/legacy-import.ts");
    console.log(JSON.stringify(await runCloakpitImportCommand(args.slice(1))));
    return;
  }
  if (args[0] === "import-state") {
    const sourceRoot = flag(args, "source"), destinationRoot = flag(args, "state-root");
    if (!sourceRoot || !destinationRoot) throw new Error("import-state requires --source PATH and --state-root DEST");
    const { planStateImport, importState } = await import("./standalone/migration.ts");
    const plan = await planStateImport(sourceRoot, destinationRoot);
    if (!args.includes("--confirm-copy")) {
      console.log(JSON.stringify({ ok: true, copied: false, plan, next: "Review this plan, close both applications, then repeat with --confirm-copy. The source remains unchanged." }, null, 2));
      return;
    }
    const result = await importState(plan);
    console.log(JSON.stringify({ ok: true, copied: true, result }, null, 2));
    return;
  }
  if (args[0] && !["start", "serve"].includes(args[0]) && !args[0].startsWith("--")) {
    throw new Error("GameBrowser supports start, serve and import-state");
  }
  const runtime = await startGameBrowser(gameBrowserStartOptions(args));
  let exiting = false;
  const shutdown = () => {
    if (exiting) return;
    exiting = true;
    void runtime.close().then(() => {
      if (runtime.health) {
        process.stdout.write(`${JSON.stringify({ protocol: DESKTOP_PROTOCOL, event: "shutdown-complete", nonce: runtime.health.instance })}\n`, () => process.exit(0));
      } else process.exit(0);
    }).catch(() => {
      console.error("GameBrowser could not confirm safe shutdown; owned launch records remain available for recovery");
      if (runtime.health) {
        process.stdout.write(`${JSON.stringify({ protocol: DESKTOP_PROTOCOL, event: "shutdown-failed", nonce: runtime.health.instance })}\n`, () => process.exit(1));
      } else process.exit(1);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && ["stakemode:stop", "gamebrowser:stop"].includes(String(message.type))) shutdown();
  });
  if (runtime.health) {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 65536) { shutdown(); return; }
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const line = input.slice(0, newline).trim();
        input = input.slice(newline + 1);
        if (runtime.credentials?.handleLine(line)) continue;
        if (isDesktopShutdownCommand(line, runtime.health!.instance)) shutdown();
      }
    });
    process.stdin.once("end", shutdown);
    process.stdin.once("close", shutdown);
    process.stdout.write(`${JSON.stringify(desktopReadyRecord(runtime.health.instance, runtime.port))}\n`);
  } else console.log(`GameBrowser workspace: ${runtime.url}`);
}

export function runCli(): void {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

if (import.meta.main) runCli();
