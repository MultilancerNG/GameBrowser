/**
 * Windows DPAPI checks for Chromium's cookie key. Chromium stores the key in the
 * profile's root Local State, protected for the Windows account that wrote it;
 * another account cannot decrypt it, so that profile's saved cookies are lost.
 */

import { readFileSync } from "node:fs";

/** Base64 DPAPI blob (without the "DPAPI" prefix) from a Local State file, or null. */
export function localStateDpapiKey(path: string): string | null {
  let encoded: unknown;
  try { encoded = JSON.parse(readFileSync(path, "utf8"))?.os_crypt?.encrypted_key; } catch {}
  const bytes = typeof encoded === "string" ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
  if (bytes.length <= 5 || bytes.subarray(0, 5).toString() !== "DPAPI") return null;
  return bytes.subarray(5).toString("base64");
}

// One line per key: 1 = decrypted, 0 = DPAPI refused it, e = the check itself failed.
const UNPROTECT_SCRIPT = "Add-Type -AssemblyName System.Security;" +
  "$k=ConvertFrom-Json ([Console]::In.ReadToEnd());foreach($v in $k){try{" +
  "[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)|Out-Null;'1'" +
  "}catch{if($_.Exception -is [Security.Cryptography.CryptographicException] -or $_.Exception.InnerException -is [Security.Cryptography.CryptographicException]){'0'}else{'e'}}}";

/**
 * Per key, whether this Windows account can decrypt it. Null when the check
 * cannot answer (not Windows, PowerShell failure, or timeout).
 */
export async function dpapiKeysReadable(keys: string[], timeoutMs = 60_000): Promise<boolean[] | null> {
  if (process.platform !== "win32") return null;
  if (!keys.length) return [];
  try {
    const child = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", UNPROTECT_SCRIPT], {
      stdin: new Blob([JSON.stringify(keys)]), stdout: "pipe", stderr: "ignore",
    });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, Math.max(1, timeoutMs));
    const [raw, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
      .finally(() => clearTimeout(timer));
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (exitCode !== 0 || lines.length !== keys.length || lines.some((line) => line !== "0" && line !== "1")) return null;
    return lines.map((line) => line === "1");
  } catch {
    return null;
  }
}
