import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const clients = [
  { file: "hub-client.ts", name: "HubClient", create: 'new HubClient("https://fixture.invalid", "fixture-token", "fixture-owner", fetchFn, 25)',
    request: "client.getRoster()", error: "hub request /hub/profiles timed out after 25ms" },
  { file: "cloud-client.ts", name: "CloudClient", create: 'new CloudClient({baseUrl: "https://fixture.invalid", accessToken: () => "fixture-token", fetchFn, requestTimeoutMs: 25})',
    request: "client.status()", error: "AliasMode Cloud request /status timed out after 25ms" },
  { file: "supabase-auth.ts", name: "SupabaseAuthClient", create: 'new SupabaseAuthClient({baseUrl: "https://fixture.invalid", anonKey: "fixture-anon", fetchFn, requestTimeoutMs: 25})',
    request: 'client.signIn("fixture@example.invalid", "fixture-password")', error: "AliasMode Auth request timed out after 25ms" },
];

const proofs = clients.map(client => ({
  file: client.file, name: client.name, expected: { message: client.error, aborted: true } as Record<string, unknown>,
  script: `
let signal;
const fetchFn = async (_url, init) => { signal = init.signal; return new Promise(() => {}); };
const client = ${client.create};
try {
  await ${client.request};
  throw new Error("A never-resolving fetch unexpectedly completed");
} catch (error) {
  console.log(JSON.stringify({ message: error.message, aborted: signal?.aborted === true }));
}
`,
}));
proofs.push({
  file: "workspace/windowsProcessScheduler.ts", name: "WindowsProcessScheduler", expected: { expired: true, ran: false },
  script: `
const scheduler = new WindowsProcessScheduler();
let ran = false;
void scheduler.schedule("resources", async () => new Promise(() => {}));
await Promise.resolve();
const result = await scheduler.schedule("ownership", async () => { ran = true; return "unexpected work"; }, 25);
console.log(JSON.stringify({ expired: result === null, ran }));
`,
});

for (const proof of proofs) {
  test(`${proof.name} awaited deadline settles without unrelated Node handles`, async () => {
    const root = mkdtempSync(join(tmpdir(), "gamebrowser-request-deadline-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const node = Bun.which("node");
      expect(node).not.toBeNull();
      const built = await Bun.build({ entrypoints: [join(import.meta.dir, proof.file)], target: "node", format: "esm" });
      expect(built.success).toBe(true);
      writeFileSync(join(root, "client.mjs"), await built.outputs[0]!.text());
      writeFileSync(join(root, "await-deadline.mjs"), `
import { ${proof.name} } from "./client.mjs";
${proof.script}
`);
      const running = Bun.spawn([node!, join(root, "await-deadline.mjs")], { cwd: root, stdout: "pipe", stderr: "pipe" });
      child = running;
      let timedOut = false;
      // This bounds the child from its parent; it has only its actual request/queue deadline.
      deadline = setTimeout(() => { timedOut = true; running.kill(); }, 5000);
      const [exitCode, stdout, stderr] = await Promise.all([
        running.exited, new Response(running.stdout).text(), new Response(running.stderr).text(),
      ]);
      expect({ exitCode, timedOut, stderr }).toEqual({ exitCode: 0, timedOut: false, stderr: "" });
      expect(JSON.parse(stdout)).toEqual(proof.expected);
    } finally {
      clearTimeout(deadline);
      if (child && child.exitCode === null) { child.kill(); await child.exited; }
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
}
