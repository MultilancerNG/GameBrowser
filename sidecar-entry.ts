/**
 * Entry point of the compiled desktop program, aliasmode-sidecar. The same program runs the MCP
 * helper when the small aliasmode-mcp launcher next to it starts it with MCP_MODE first, so the
 * desktop app ships one Bun runtime instead of two.
 */

// Keep in step with src-tauri/src/bin/aliasmode-mcp.rs.
export const MCP_MODE = "__mcp";

/** Compatibility entry used by older session-capture callers. Browser protocol
 * work still runs in the packaged official Node worker, without loading a UI. */
export async function dispatchSessionWorker(
  argv: string[],
  deps?: Parameters<typeof import("./session.ts").runReadSessionWorker>[1],
): Promise<boolean> {
  const { READ_SESSION_WORKER_ARG } = await import("./session.ts");
  if (argv[0] !== READ_SESSION_WORKER_ARG) return false;
  const { runReadSessionWorker, readSession } = await import("./session.ts");
  await runReadSessionWorker(argv, deps ?? {
    readSession,
    write: value => Bun.write(Bun.stdout, value),
    exit: code => process.exit(code),
  });
  return true;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const [mode, ...args] = argv;
  if (mode === MCP_MODE) {
    const { runAgentHelper } = await import("./agent/aliasmode-mcp.ts");
    await runAgentHelper(args);
  } else {
    if (typeof ALIASMODE_COMPILED !== "undefined" && ALIASMODE_COMPILED === true && !process.env.ALIASMODE_PLAYWRIGHT_RUNTIME?.trim()) {
      const { defaultPlaywrightRuntimeRoot } = await import("./playwright-runtime.ts");
      process.env.ALIASMODE_PLAYWRIGHT_RUNTIME = defaultPlaywrightRuntimeRoot();
    }
    if (!await dispatchSessionWorker(argv)) {
      const { runCli } = await import("./GameBrowser-cli.ts");
      await runCli();
    }
  }
}
