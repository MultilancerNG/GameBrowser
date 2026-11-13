/** Build-time compatibility patch; never changes the pinned native executable. */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const FIREFOX_EXTENSION_UI_PATCH_ID = 'gamebrowser-firefox-extension-ui-v1';
export interface FirefoxExtensionUiPatchMetadata {
  patchId: typeof FIREFOX_EXTENSION_UI_PATCH_ID;
  sourceRepository: string;
  sourceCommit: string;
  archives: Array<{ path: string; beforeSha256: string; afterSha256: string; modules: Array<{ path: string; beforeSha256: string; afterSha256: string }> }>;
}
async function readLimited(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Firefox extension UI patch output exceeds its limit');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function patchFirefoxExtensionUi(root: string, pythonExecutable: string): Promise<FirefoxExtensionUiPatchMetadata> {
  const child = Bun.spawn([pythonExecutable, fileURLToPath(new URL('./firefox-extension-ui-patch.py', import.meta.url)), root, join(fileURLToPath(new URL('../patches/firefox-extension-ui/', import.meta.url)), 'original')], { stdout: 'pipe', stderr: 'pipe' });
  let expired = false;
  const deadline = setTimeout(() => { expired = true; child.kill(); }, 120_000);
  let code: number, output: string, error: string;
  try { [code, output, error] = await Promise.all([child.exited, readLimited(child.stdout, 65536), readLimited(child.stderr, 65536)]); }
  catch (failure) { child.kill(); throw failure; }
  finally { clearTimeout(deadline); }
  if (expired) throw new Error('Firefox extension UI patch exceeded its build deadline');
  if (code !== 0) throw new Error(`Firefox extension UI patch rejected: ${error.trim().slice(0, 500) || 'archive verification failed'}`);
  const metadata = JSON.parse(output) as FirefoxExtensionUiPatchMetadata;
  if (metadata.patchId !== FIREFOX_EXTENSION_UI_PATCH_ID || metadata.sourceCommit !== '7eeccbdf0b2c7562dce9d11175c35667b9025a7f' || !Array.isArray(metadata.archives) || !metadata.archives.length) throw new Error('Firefox extension UI patch metadata is invalid');
  return metadata;
}
