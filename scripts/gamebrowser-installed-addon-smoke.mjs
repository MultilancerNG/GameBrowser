/** Harmless locally generated packages exercise the installed extension pipeline. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A bounded, uncompressed ZIP is sufficient for this fresh local Firefox XPI.
function zipFiles(files) {
  const local = [], central = []; let offset = 0;
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const [filename, value] of Object.entries(files)) {
    const name = Buffer.from(filename), bytes = Buffer.from(value), crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(entry, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function verifyInstalledAddons({ api, until, page, origin, observed, profiles, clickFixturePoint }) {
  const directory = await mkdtemp(join(tmpdir(), 'gamebrowser-installed-addons-'));
  const delay = ms => new Promise(done => setTimeout(done, ms));
  try {
    for (const { id, engine } of profiles) {
      const tile = page.locator(`.live-tile[data-profile-id="${id}"]`);
      await api('stop', { profileId: id });
      await until(async () => (await api('snapshot')).snapshot.profiles.find(profile => profile.id === id)?.state === 'stopped', `Native ${engine} did not stop for add-on assignment`);
      const matches = ['http://127.0.0.1/*', 'http://localhost/*'];
      const ui = kind => `<!doctype html><title>GameBrowser ${engine} ${kind} package</title><style>body{margin:0;background:#34265b;color:#fff;font:24px sans-serif}input{display:block;box-sizing:border-box;width:100%;height:100px;font-size:32px}button{display:block;width:100%;height:400px;background:#a78bfa;font-size:32px}</style><input aria-label="Package input"><button id="package-button">Local ${kind} package control</button><script src="ui.js"></script>`;
      const common = { name: 'GameBrowser harmless installed package', version: '1.0.0', content_scripts: [{ matches, js: ['marker.js'], run_at: 'document_end' }], options_ui: { page: 'options.html', open_in_tab: true } };
      const manifest = engine === 'firefox'
        ? { ...common, manifest_version: 2, browser_specific_settings: { gecko: { id: 'installed-smoke@gamebrowser.local' } }, permissions: matches, browser_action: { default_popup: 'popup.html' } }
        : { ...common, manifest_version: 3, host_permissions: matches, action: { default_popup: 'popup.html' } };
      const files = { 'manifest.json': JSON.stringify(manifest),
        'marker.js': `fetch(${JSON.stringify(`${origin}/addon-marker?engine=${engine}`)});`,
        'ui.js': `document.querySelector('#package-button').addEventListener('click',()=>fetch(${JSON.stringify(`${origin}/addon-click?engine=${engine}`)}));`,
        'popup.html': ui('popup'), 'options.html': ui('options') };
      let path;
      if (engine === 'firefox') { path = join(directory, 'local-firefox.xpi'); await writeFile(path, zipFiles(files)); }
      else { path = join(directory, 'local-chromium'); await mkdir(path); for (const [name, contents] of Object.entries(files)) await writeFile(join(path, name), contents); }
      const extension = (await api('extensions/import', { path, engine })).extension;
      assert.match(extension.sha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(Object.keys(extension.ui).sort(), ['options', 'popup']);
      const assignment = { extensionId: extension.id, enabled: true, siteAccess: 'sites', origins: [origin], reviewedSha256: extension.sha256 };
      await api(`profiles/${id}/extensions`, assignment);
      const markerBefore = observed[engine].addonMarkers;
      await api('start', { profileId: id });
      await until(async () => { const profile = (await api('snapshot')).snapshot.profiles.find(profile => profile.id === id); if (profile?.state === 'error') throw new Error(`Native ${engine} add-on launch failed`); return profile?.pid > 0 && ['running', 'manual'].includes(profile.state); }, `Native ${engine} add-on profile did not launch`, 90000);
      await api('manual', { profileId: id, enabled: true });
      await api(`profiles/${id}/browser`, { action: 'navigate', url: `${origin}/addon-enabled` });
      await until(() => observed[engine].addonMarkers > markerBefore, `Native ${engine} did not execute its reviewed local package`);
      if (await page.locator('#browser-workspace').isVisible()) await page.locator('#browser-return-grid').click();
      await tile.locator('.tile-heading-actions [data-action="browser"]').click();
      const canvas = tile.locator('canvas.manual-active');
      await canvas.waitFor({ state: 'visible', timeout: 30000 });
      for (const kind of ['popup', 'options']) {
        const openedAt = Date.now();
        const opened = (await api(`profiles/${id}/extensions/${extension.id}/open`, { kind })).browser;
        assert.equal(opened.error, undefined, 'The installed package document is verified by its native bridge');
        const active = opened.tabs.find(tab => tab.id === opened.activeTabId);
        assert.ok(active?.url.startsWith(engine === 'firefox' ? 'moz-extension://' : 'chrome-extension://'), 'The real extension package page is selected');
        await until(() => tile.evaluate((element, at) => element._frameAt > at && /^(?:moz|chrome)-extension:/.test(element._frameUrl || ''), openedAt), `Native ${engine} ${kind} did not stream its actual package page`, 30000);
        const before = observed[engine].addonClicks;
        await clickFixturePoint(canvas, 250);
        await until(() => observed[engine].addonClicks > before, `Live input did not reach the native ${engine} ${kind} package`);
        await api(`profiles/${id}/browser`, { action: 'close-tab', tabId: active.id });
      }
      await page.locator('#browser-return-grid').click();
      const allowedCount = observed[engine].addonMarkers;
      const deniedBefore = observed[engine].pageRequests['/addon-denied'] || 0;
      await api(`profiles/${id}/browser`, { action: 'navigate', url: origin.replace('127.0.0.1', 'localhost') + '/addon-denied' });
      await until(() => observed[engine].pageRequests['/addon-denied'] > deniedBefore, 'The real native browser did not load the denied-host fixture');
      await delay(400);
      assert.equal(observed[engine].addonMarkers, allowedCount, 'Package site access excludes the unreviewed localhost host');
      await api('stop', { profileId: id });
      await api(`profiles/${id}/extensions`, { ...assignment, enabled: false });
      await api('start', { profileId: id });
      await until(async () => (await api('snapshot')).snapshot.profiles.some(profile => profile.id === id && profile.pid > 0 && ['running', 'manual'].includes(profile.state)), `Native ${engine} did not restart after disabling its package`, 90000);
      await api('manual', { profileId: id, enabled: true });
      const disabledBefore = observed[engine].pageRequests['/addon-disabled'] || 0;
      await api(`profiles/${id}/browser`, { action: 'navigate', url: `${origin}/addon-disabled` });
      await until(() => observed[engine].pageRequests['/addon-disabled'] > disabledBefore, 'The restarted native browser did not load the disabled-package fixture');
      await delay(400);
      assert.equal(observed[engine].addonMarkers, allowedCount, 'Disabled package stays inactive after a persistent-profile restart');
      await api('stop', { profileId: id });
      await api(`profiles/${id}/extensions/${extension.id}`, undefined, 'DELETE');
      await api(`extensions/${extension.id}`, undefined, 'DELETE');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
