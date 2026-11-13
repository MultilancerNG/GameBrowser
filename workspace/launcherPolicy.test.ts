import { test, expect } from 'bun:test';
import { Launcher, validateBrowserResourceLimits, validateForwardedLaunchArgs } from '../launcher.ts';
import { ProfileStore } from '../store.ts';
import { parseExport } from '../parse.ts';
test('StakeMode adds verified heap/scale policy without allowing arbitrary caller flags', () => {
  const store = new ProfileStore(':memory:');
  try {
    const profile = parseExport('id=resource-profile\nname=Resource profile\ngroup=Workspace\nproxy=\nresolution=1920*1080\n******************').profiles[0]!;
    store.upsertProfile(profile);
    const launcher = new Launcher({ store, profileResourceLimits: () => ({ v8OldSpaceMb: 512, deviceScaleFactor: 1 }), profileExtensionDirs: () => ['C:\\StakeMode\\managed-extension'] });
    const args = launcher.buildArgs(profile, 9333, 'C:\\StakeMode\\profiles\\resource-profile', [], undefined, true);
    expect(args).toContain('--js-flags=--max-old-space-size=512');
    expect(args).toContain('--force-device-scale-factor=1');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--load-extension=C:\\StakeMode\\managed-extension');
    expect(args).toContain('--user-data-dir=C:\\StakeMode\\profiles\\resource-profile');
    expect(() => validateForwardedLaunchArgs(['--js-flags=--max-old-space-size=1'])).toThrow('unsafe');
    expect(() => validateBrowserResourceLimits({ v8OldSpaceMb: 1, deviceScaleFactor: 1 })).toThrow();
    expect(() => validateBrowserResourceLimits({ v8OldSpaceMb: 512, deviceScaleFactor: 2 } as any)).toThrow();
  } finally { store.close(); }
});
