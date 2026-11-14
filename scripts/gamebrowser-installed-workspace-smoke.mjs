/** Inspect the installed Tauri WebView and exercise its packaged Firefox through Live workspace. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyInstalledAddons } from './gamebrowser-installed-addon-smoke.mjs';
assert.equal(process.platform, 'win32', 'Installed workspace smoke requires Windows');
const [runtimeValue, debugValue, baseValue, screenshotValue, reportValue] = process.argv.slice(2);
const runtime = resolve(runtimeValue || ''), port = Number(debugValue), base = new URL(baseValue);
assert.ok(runtimeValue && screenshotValue && reportValue && Number.isSafeInteger(port) && port > 1024 && port < 65536);
assert.equal(base.protocol, 'http:'); assert.equal(base.hostname, '127.0.0.1'); assert.ok(Number(base.port) > 0);
const screenshot = resolve(screenshotValue), report = resolve(reportValue);
const playwright = await import(pathToFileURL(join(runtime, 'node_modules', 'playwright-core', 'index.mjs')).href);
const checks = {}, errors = [], observed = { clicked: false, typed: false, visited: false,
  firefox: { clicks: 0, financialClicks: 0, value: "", cookieChecks: 0, cookiePresent: false, addonMarkers: 0, addonClicks: 0, pageRequests: {} }, chromium: { clicks: 0, financialClicks: 0, value: "", cookieChecks: 0, cookiePresent: false, addonMarkers: 0, addonClicks: 0, pageRequests: {} } };
let browser, page, fixture, token, profileId, adminId, stage = 'debug-endpoint', failure, liveDiagnostics;
const deadline = setTimeout(() => {
  const error = 'Installed workspace smoke exceeded its twelve-minute bound';
  writeFileSync(report, `${JSON.stringify({ success: false, stage, checks, error, pageErrorCount: errors.length }, null, 2)}\n`);
  console.error(error); process.exit(1);
}, 720000);
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(200); }
  throw new Error(message);
}
async function api(operation, body, method) {
  const response = await fetch(new URL(`/workspace/api/${operation}`, base), {
    method: method || (body ? 'POST' : 'GET'), signal: AbortSignal.timeout(90000),
    headers: { 'x-stakemode-workspace': '1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.ok, true, `Installed workspace ${operation.split('/').at(-1)} request succeeds (${response.status})`);
  return response.json();
}
async function clickFixturePoint(canvas, y) {
  const box = await canvas.boundingBox();
  const pixels = await canvas.evaluate(element => ({ width: element.width, height: element.height }));
  assert.ok(box && box.width > 0 && box.height > 0, 'Live canvas has visible CSS geometry');
  assert.ok(Number.isSafeInteger(pixels.width) && pixels.width > 0 && Number.isSafeInteger(pixels.height) && pixels.height > y,
    'The real browser frame contains the fixture control');
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * (y / pixels.height) } });
}
try {
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 'Owned native WebView debug endpoint did not become ready');
  browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
  await until(() => { page = browser.contexts().flatMap(context => context.pages()).find(item => { try { return !item.isClosed() && new URL(item.url()).origin === base.origin; } catch { return false; } }); return !!page; }, 'Installed native WebView did not show its actual loopback application');
  page.on('pageerror', error => errors.push(error.message));
  await page.bringToFront();
  assert.equal(new URL(page.url()).pathname, '/workspace/dashboard.html', 'The independent desktop opens its own workspace directly');
  await page.waitForURL(url => url.origin === base.origin && url.pathname === '/workspace/dashboard.html', { timeout: 20000 });
  await page.locator('#view-title').filter({ hasText: 'Live workspace' }).waitFor();
  await page.locator('#connection-state').filter({ hasText: 'Relay connected' }).waitFor({ state: 'attached', timeout: 20000 });
  assert.equal(await page.title(), 'GameBrowser · Browser workspace');
  assert.equal(await page.locator('#full-admin-view').count(), 1);
  assert.equal(await page.locator('#following-admin').count(), 1);
  assert.equal(await page.locator('[data-view="extensions"]').count(), 1);
  assert.equal(await page.locator('[data-view="automation"]').count(), 1);
  const bootstrap = await api('bootstrap'); token = bootstrap.token;
  assert.equal(bootstrap.snapshot.capabilities.mode, 'local');
  assert.equal(bootstrap.snapshot.profiles.length, 0);
  checks.installedNativeWebViewRendered = true; checks.authenticatedLocalRelay = true;
  checks.independentWorkspaceEntrypoint = true;

  stage = 'bundled-firefox-profile';
  fixture = createServer((request, response) => {
    const address = new URL(request.url, 'http://127.0.0.1');
    const engine = /Firefox\//.test(request.headers['user-agent'] || '') ? observed.firefox : observed.chromium;
    if (address.pathname === '/clicked') { observed.clicked = true; engine.clicks++; }
    if (address.pathname === '/financial-click') engine.financialClicks++;
    if (address.pathname === '/typed') { engine.value = address.searchParams.get('value') || ''; if (engine.value === 'GameBrowser local smoke') observed.typed = true; }
    if (address.pathname === '/second') observed.visited = true;
    if (address.pathname === '/cookie-check') { engine.cookieChecks++; engine.cookiePresent = (request.headers.cookie || '').split(';').some(value => value.trim() === 'gamebrowser-installed-cookie=local-only'); }
    if (address.pathname === '/addon-marker') { const target = observed[address.searchParams.get('engine')]; if (target) target.addonMarkers++; }
    if (address.pathname === '/addon-click') { const target = observed[address.searchParams.get('engine')]; if (target) target.addonClicks++; }
    if (address.pathname.startsWith('/addon-') && ['/addon-marker', '/addon-click'].includes(address.pathname)) { response.writeHead(204, { 'access-control-allow-origin': '*' }); response.end(); return; }
    if (['/clicked', '/typed', '/financial-click'].includes(address.pathname)) { response.writeHead(204); response.end(); return; }
    engine.pageRequests[address.pathname] = (engine.pageRequests[address.pathname] || 0) + 1;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><title>GameBrowser installed fixture</title><style>body{margin:0;background:#172b26;color:#fff;font:24px sans-serif}input{display:block;box-sizing:border-box;width:100%;height:100px;font-size:32px}button{display:block;width:100%;height:400px;background:#bcf64a;color:#111;font-size:32px}</style><input id="smoke-text" aria-label="Smoke text" oninput="fetch('/typed?value='+encodeURIComponent(this.value))"><button id="smoke-click" onclick="fetch('/clicked')">Local browser control fixture</button><button id="financial-fixture" style="height:100px" onclick="fetch('/financial-click')">Place bet</button><p>This financial-labelled fixture only updates a local counter; it never places a wager.</p>`);
  });
  await new Promise((done, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const created = await api('bulk', { count: 1, prefix: 'Installed smoke', engine: 'firefox', urls: [origin], origin, resolutions: ['1280x720'], networkMode: 'direct', headless: true });
  assert.equal(created.profiles.length, 1); profileId = created.profiles[0].id;
  assert.match(profileId, /^[a-zA-Z0-9_-]{1,64}$/);
  const tile = page.locator(`.live-tile[data-profile-id="${profileId}"]`);
  await tile.waitFor();
  assert.deepEqual(await tile.locator('[data-role-for] option').allTextContents(), ['Admin', 'Follower', 'Manual']);
  await tile.locator('[data-action="start"]').click();
  await until(async () => { const snapshot = (await api('snapshot')).snapshot; const profile = snapshot.profiles.find(item => item.id === profileId); if (profile?.state === 'error') throw new Error('Installed bundled Firefox reported a launch failure'); return profile && ['running', 'manual'].includes(profile.state) && profile.pid > 0; }, 'Installed bundled Firefox did not launch', 90000);
  await tile.locator('.tile-heading-actions [data-action="browser"]').click();
  await page.locator('#browser-workspace').waitFor({ state: 'visible' });
  const canvas = tile.locator('canvas.manual-active');
  await canvas.waitFor({ state: 'visible', timeout: 45000 });
  await until(async () => tile.locator('.stream-message').evaluate(element => element.hidden), 'Installed Firefox did not stream a healthy live frame');
  checks.actualBundledFirefoxLaunch = true; checks.liveFirefoxFrames = true;

  stage = 'live-manual-controls';
  // Map fixed fixture content points through the actual streamed browser dimensions.
  await clickFixturePoint(canvas, 250);
  await until(() => observed.clicked, 'Live workspace click did not reach the real Firefox page');
  await clickFixturePoint(canvas, 40);
  await canvas.pressSequentially('GameBrowser local smoke', { delay: 60 });
  await until(() => observed.typed, 'Live workspace typing did not reach the real Firefox page');
  checks.liveManualClickAndTyping = true;

  stage = 'real-browser-tabs';
  await page.getByRole('button', { name: 'Open new tab', exact: true }).click();
  await until(async () => (await api(`profiles/${profileId}/browser`)).browser.tabs.length === 2, 'New tab did not reach the real Firefox browser');
  await page.locator('#browser-address').fill(`${origin}/second`);
  await page.locator('#browser-go').click();
  await until(() => observed.visited, 'Address-bar navigation did not reach the new Firefox tab');
  await page.locator('#browser-tabs .browser-tab.active [data-close-tab-id]').click();
  await until(async () => (await api(`profiles/${profileId}/browser`)).browser.tabs.length === 1, 'Closing a tab did not reach Firefox');
  checks.actualFirefoxTabsAndNavigation = true;
  const firefoxDownloads = await fetch(new URL('/ui/api/runtime-downloads', base)).then(response => response.json());
  assert.equal(firefoxDownloads.downloads.length, 0, 'Bundled Firefox needs no browser engine download');
  checks.bundledFirefoxWithoutDownload = true;

  stage = 'pinned-chromium-admin';
  await page.locator('#browser-return-grid').click();
  await api('settings', { origins: [origin], pacing: 'fast' });
  const adminCreated = await api('bulk', { count: 1, prefix: 'Installed Admin', engine: 'chromium', urls: [`${origin}/following`], origin, resolutions: ['1280x720'], networkMode: 'direct', headless: true });
  assert.equal(adminCreated.profiles.length, 1); adminId = adminCreated.profiles[0].id;
  assert.match(adminId, /^[a-zA-Z0-9_-]{1,64}$/);
  const editorResponse = await fetch(new URL(`/ui/api/profiles/${adminId}`, base));
  assert.equal(editorResponse.ok, true);
  const editor = await editorResponse.json();
  assert.equal(editor.profile.engine, 'chromium');
  assert.equal(editor.profile.chromiumRuntime, 'aliasmode', 'Admin uses the production SHA256-pinned Chromium155 runtime');
  const adminTile = page.locator(`.live-tile[data-profile-id="${adminId}"]`);
  await adminTile.waitFor(); await adminTile.locator('[data-action="start"]').click();
  async function running(id, message, timeout = 90000) {
    let result;
    await until(async () => {
      const snapshot = (await api('snapshot')).snapshot;
      result = snapshot.profiles.find(item => item.id === id);
      if (result?.state === 'error') throw new Error(message);
      return result && ['running', 'manual'].includes(result.state) && result.pid > 0;
    }, message, timeout);
    return result;
  }
  const adminLaunch = await running(adminId, 'Pinned Chromium155 Admin did not launch', 300000);
  const initialFollowerLaunch = await running(profileId, 'Bundled Firefox follower stopped unexpectedly');
  checks.pinnedChromium155AdminLaunch = true;
  async function startFollowing(chosenAdminId = adminId, chosenFollowerId = profileId) {
    if (await page.locator('#browser-workspace').isVisible()) await page.locator('#browser-return-grid').click();
    await tile.locator('.live-profile-select').check();
    await adminTile.locator('.live-profile-select').check();
    await page.locator('#following-admin').selectOption(chosenAdminId);
    if (!await page.locator('#following-apply').isVisible()) await page.locator('#following-controls-toggle').click();
    await page.locator('#following-apply').click();
    await until(async () => { const sync = await api('sync'); assert.equal(sync.error, null, 'Mixed following reports no error'); return sync.active && sync.adminId === chosenAdminId && sync.followerIds.length === 1 && sync.followerIds[0] === chosenFollowerId; }, 'Mixed native Admin and follower did not connect', 60000);
    const leaderTile = chosenAdminId === adminId ? adminTile : tile;
    const followerTile = chosenFollowerId === profileId ? tile : adminTile;
    await until(async () => (await leaderTile.getAttribute('data-role')) === 'admin' && (await followerTile.getAttribute('data-role')) === 'follower', 'Native workspace did not render Admin/Follower roles');
    const expectedRoleBorders = ['rgb(167, 139, 250)', 'rgb(45, 212, 191)'];
    let roleBorders;
    await until(async () => {
      roleBorders = await Promise.all([leaderTile.evaluate(element => getComputedStyle(element).borderTopColor), followerTile.evaluate(element => getComputedStyle(element).borderTopColor)]);
      return roleBorders.every((color, index) => color === expectedRoleBorders[index]);
    }, 'Installed Admin/Follower palette did not settle to the improved UI colors', 5000);
    assert.notEqual(roleBorders[0], roleBorders[1], 'Admin and follower borders have distinct colors');
    assert.deepEqual(roleBorders, expectedRoleBorders, 'Installed app uses the improved violet Admin and teal Follower UI');
    checks.distinctAdminFollowerBorders = true;
    checks.improvedWorkspaceRolePalette = true;
    await leaderTile.locator('.tile-heading-actions [data-action="browser"]').click();
    await leaderTile.locator('canvas.manual-active').waitFor({ state: 'visible', timeout: 30000 });
    await until(() => leaderTile.locator('.stream-message').evaluate(element => element.hidden), 'Native Admin did not render a healthy live frame');
  }
  async function mirroredInput(text, leaderTile = adminTile) {
    const target = leaderTile.locator('canvas.manual-active');
    const before = { firefox: observed.firefox.clicks, chromium: observed.chromium.clicks };
    await clickFixturePoint(target, 250);
    await until(() => observed.firefox.clicks > before.firefox && observed.chromium.clicks > before.chromium, 'Real Admin click did not reach both Chromium and Firefox');
    await delay(250);
    assert.equal(observed.firefox.clicks, before.firefox + 1, 'One Admin click reaches Firefox exactly once');
    assert.equal(observed.chromium.clicks, before.chromium + 1, 'One Admin click reaches Chromium exactly once');
    await clickFixturePoint(target, 40);
    await target.pressSequentially(text, { delay: 70 });
    await until(() => observed.firefox.value === text && observed.chromium.value === text, 'Real Admin typing did not reach the FirefoxFollower');
  }
  async function mirroredBrowserControls(leaderId, followerId, label) {
    const state = async id => (await api(`profiles/${id}/browser`)).browser;
    const activeUrl = browser => browser.tabs.find(tab => tab.id === browser.activeTabId)?.url;
    const path = `/${label}-browser-controls`, url = origin + path;
    await page.locator('#browser-address').fill(url); await page.locator('#browser-go').click();
    await until(async () => activeUrl(await state(leaderId)) === url && activeUrl(await state(followerId)) === url, 'Explicit Admin address navigation did not reach both native engines');
    const beforeReload = { firefox: observed.firefox.pageRequests[path] || 0, chromium: observed.chromium.pageRequests[path] || 0 };
    await page.locator('#browser-workspace [data-browser-action="reload"]').click();
    await until(() => observed.firefox.pageRequests[path] > beforeReload.firefox && observed.chromium.pageRequests[path] > beforeReload.chromium, 'Explicit Admin reload did not reload the real follower document');
    const original = await state(leaderId), originalFollower = await state(followerId);
    await page.getByRole('button', { name: 'Open new tab', exact: true }).click();
    await until(async () => (await state(leaderId)).tabs.length === original.tabs.length + 1 && (await state(followerId)).tabs.length === originalFollower.tabs.length + 1, 'Admin new-tab did not create a separate native follower tab');
    const added = (await state(leaderId)).tabs.find(tab => !original.tabs.some(old => old.id === tab.id));
    assert.ok(added, 'Admin new tab has its own opaque native identity');
    const secondUrl = `${url}-second`;
    await page.locator('#browser-address').fill(secondUrl); await page.locator('#browser-go').click();
    await until(async () => activeUrl(await state(leaderId)) === secondUrl && activeUrl(await state(followerId)) === secondUrl, 'New-tab address navigation did not reach the corresponding follower tab');
    await page.locator(`#browser-tabs [data-tab-id="${original.activeTabId}"]`).click();
    await until(async () => activeUrl(await state(leaderId)) === url && activeUrl(await state(followerId)) === url, 'Admin tab selection did not select the corresponding native follower tab');
    await page.locator(`#browser-tabs [data-close-tab-id="${added.id}"]`).click();
    await until(async () => (await state(leaderId)).tabs.length === original.tabs.length && (await state(followerId)).tabs.length === originalFollower.tabs.length, 'Admin tab close did not close its corresponding follower tab');
    const following = await api('sync');
    assert.equal(following.active, true); assert.equal(following.adminId, leaderId); assert.deepEqual(following.followerIds, [followerId]);
  }
  async function stopFollowingAndCheckProcesses(followerPid) {
    await page.locator('#browser-return-grid').click();
    await page.locator('#following-stop').click();
    await until(async () => { const sync = await api('sync'); return !sync.active && !sync.starting && sync.adminId === null; }, 'Stop following did not detach its worker');
    const snapshot = (await api('snapshot')).snapshot;
    for (const [id, pid] of [[adminId, adminLaunch.pid], [profileId, followerPid]]) {
      const current = snapshot.profiles.find(item => item.id === id);
      assert.equal(current?.pid, pid, 'Stop following retains the exact owned browser process');
      process.kill(pid, 0);
      const state = await api(`profiles/${id}/browser`);
      assert.ok(state.browser.tabs.length >= 1, 'Browser remains responsive after following stops');
    }
  }
  stage = 'mixed-admin-firefox-following';
  await api(`profiles/${profileId}/browser`, { action: 'navigate', url: `${origin}/following` });
  await startFollowing();
  await mirroredInput('GameBrowser mixed following');
  checks.actualChromiumAdminFirefoxFollower = true;
  await mirroredBrowserControls(adminId, profileId, 'chromium-admin');
  checks.actualChromiumAdminFirefoxBrowserControls = true;
  await page.screenshot({ path: screenshot, fullPage: false });
  // Retain the active improved UI before later shutdown checks replace the diagnostic image.
  await page.screenshot({ path: screenshot.replace(/\.png$/i, '.active.png'), fullPage: false });
  await stopFollowingAndCheckProcesses(initialFollowerLaunch.pid);
  checks.stopFollowingKeepsBrowsersAlive = true;

  stage = 'firefox-reopen-reconnect';
  await api('stop', { profileId });
  await until(async () => (await api('snapshot')).snapshot.profiles.find(item => item.id === profileId)?.state === 'stopped', 'Owned Firefox did not close before reopen');
  await tile.locator('[data-action="start"]').click();
  const reopened = await running(profileId, 'Bundled Firefox did not reopen');
  assert.notEqual(reopened.pid, initialFollowerLaunch.pid, 'Reopen starts a fresh Firefox generation');
  // Begin a fresh owned fixture page for a second independent mirrored input assertion.
  await api(`profiles/${adminId}/browser`, { action: 'navigate', url: `${origin}/following-reopened` });
  await api(`profiles/${profileId}/browser`, { action: 'navigate', url: `${origin}/following-reopened` });
  await startFollowing();
  await mirroredInput('GameBrowser reopened following');
  await stopFollowingAndCheckProcesses(reopened.pid);
  checks.mixedFollowingAfterFirefoxReopen = true;

  stage = 'firefox-admin-chromium-follower';
  for (const id of [profileId, adminId]) await api(`profiles/${id}/browser`, { action: 'navigate', url: `${origin}/firefox-admin` });
  await startFollowing(profileId, adminId);
  await mirroredInput('GameBrowser Firefox Admin', tile);
  checks.actualFirefoxAdminChromiumFollower = true;
  await mirroredBrowserControls(profileId, adminId, 'firefox-admin');
  checks.actualFirefoxAdminChromiumBrowserControls = true;
  await page.screenshot({ path: screenshot.replace(/\.png$/i, '.firefox-admin.png'), fullPage: false });

  stage = 'retained-sensitive-manual-boundary';
  const financialBefore = { firefox: observed.firefox.financialClicks, chromium: observed.chromium.financialClicks };
  await clickFixturePoint(tile.locator('canvas.manual-active'), 550);
  await until(() => observed.firefox.financialClicks > financialBefore.firefox, 'Direct manual input did not reach the local financial-labelled fixture');
  await delay(500);
  assert.equal(observed.chromium.financialClicks, financialBefore.chromium, 'A financial-labelled manual fixture action is not mirrored into the follower');
  const financialRoles = await api('sync');
  assert.equal(financialRoles.adminId, profileId); assert.deepEqual(financialRoles.followerIds, [adminId]);
  checks.nativeSensitiveActionsRemainManual = true;
  // An explicit reconnect restores the scope after the manual-boundary proof.
  await startFollowing(profileId, adminId);

  stage = 'retained-following-selection-and-reload';
  await page.locator('#browser-return-grid').click();
  // Selecting or deselecting a follower is a draft UI edit, not a disconnect command.
  await adminTile.locator('.live-profile-select').uncheck();
  const unchanged = await api('sync');
  assert.equal(unchanged.active, true); assert.equal(unchanged.adminId, profileId);
  assert.deepEqual(unchanged.followerIds, [adminId]);
  await adminTile.locator('.live-profile-select').check();
  await api('sync', { action: 'save', saveSession: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#connection-state').filter({ hasText: 'Relay connected' }).waitFor({ state: 'attached', timeout: 20000 });
  const retained = await api('sync');
  assert.equal(retained.active, true); assert.equal(retained.saved, true);
  assert.equal(retained.adminId, profileId); assert.deepEqual(retained.followerIds, [adminId]);
  await until(async () => (await tile.getAttribute('data-role')) === 'admin' && (await adminTile.getAttribute('data-role')) === 'follower', 'Reload did not preserve native Firefox Admin roles');
  checks.followerSelectionKeepsConnection = true;
  checks.savedFollowingSurvivesWorkspaceReload = true;
  await tile.locator('.tile-heading-actions [data-action="browser"]').click();
  await tile.locator('canvas.manual-active').waitFor({ state: 'visible', timeout: 30000 });
  await stopFollowingAndCheckProcesses(reopened.pid);
  await api('sync', { action: 'save', saveSession: false });

  stage = 'native-stakemode-feature-parity';
  for (const id of [profileId, adminId]) await api('manual', { profileId: id, enabled: true });
  const cookiePath = id => `profiles/${id}/cookies`;
  const exportedCookies = id => `${cookiePath(id)}?origin=${encodeURIComponent(origin)}`;
  await api(cookiePath(profileId), { action: 'import', origin, cookies: [{ name: 'gamebrowser-installed-cookie', value: 'local-only', domain: '127.0.0.1', path: '/', expires: -1, secure: false, httpOnly: false, sameSite: 'Lax' }] });
  assert.equal((await api(exportedCookies(profileId))).cookies.some(cookie => cookie.name === 'gamebrowser-installed-cookie' && cookie.value === 'local-only'), true);
  assert.equal((await api(exportedCookies(adminId))).cookies.some(cookie => cookie.name === 'gamebrowser-installed-cookie'), false, 'Cookie import stays inside its isolated browser profile');
  await api(`profiles/${profileId}/browser`, { action: 'navigate', url: `${origin}/cookie-check` });
  await until(() => observed.firefox.cookieChecks > 0 && observed.firefox.cookiePresent, 'Imported cookie did not reach the actual native Firefox jar');
  await api(cookiePath(profileId), { action: 'clear', origin });
  const previousCookieChecks = observed.firefox.cookieChecks;
  await api(`profiles/${profileId}/browser`, { action: 'reload' });
  await until(() => observed.firefox.cookieChecks > previousCookieChecks && !observed.firefox.cookiePresent, 'Clear cookies did not clear the actual native Firefox jar');
  checks.actualPrivateCookieIsolation = true;

  const workflow = (await api('workflows', { name: 'Installed native fixture inspection', steps: [
    { kind: 'navigate', url: origin }, { kind: 'wait', ms: 50 },
    { kind: 'extract', source: 'title', field: 'title' }, { kind: 'extract', source: 'url', field: 'url' },
  ] })).workflow;
  async function completeJob(id) {
    let job;
    await until(async () => { job = (await api(`jobs/${id}`)).job; if (['failed', 'timedout', 'interrupted', 'cancelled'].includes(job.status)) throw new Error(`Native workflow ended as ${job.status}`); return job.status === 'completed'; }, 'Native workflow did not complete', 30000);
    return job;
  }
  const jobs = await api(`workflows/${workflow.id}/run`, { profileIds: [profileId, adminId] });
  assert.deepEqual(jobs.rejected, []); assert.equal(jobs.jobs.length, 2);
  for (const pending of jobs.jobs) {
    const job = await completeJob(pending.id);
    const output = JSON.parse((await api(`jobs/${job.id}/output?format=json`)).content);
    assert.deepEqual(output.values, { title: 'GameBrowser installed fixture', url: `${origin}/` });
    assert.equal(output.profileId, pending.profileId);
    assert.match((await api(`jobs/${job.id}/output?format=csv`)).content, /field,value\r\n/);
  }
  checks.actualNativeWorkflowBothEngines = true;
  const schedule = (await api('schedules', { workflowId: workflow.id, profileId, kind: 'once', runAt: Date.now() + 1500, enabled: true })).schedule;
  let scheduled;
  await until(async () => { scheduled = (await api('jobs')).jobs.find(job => job.workflowId === workflow.id && job.trigger === 'schedule'); return !!scheduled; }, 'One-off native Firefox workflow did not start', 15000);
  await completeJob(scheduled.id);
  const schedules = await api('schedules');
  assert.equal(schedules.appMustRemainOpen, true);
  assert.equal(schedules.schedules.find(item => item.id === schedule.id)?.enabled, false);
  assert.equal((await api('jobs')).jobs.filter(job => job.workflowId === workflow.id && job.trigger === 'schedule').length, 1);
  await api(`schedules/${schedule.id}`, undefined, 'DELETE');
  await api(`workflows/${workflow.id}`, undefined, 'DELETE');
  checks.actualNativeOneOffSchedule = true;
  await until(async () => {
    const profiles = (await api('snapshot')).snapshot.profiles;
    return [profileId, adminId].every(id => profiles.some(profile => profile.id === id && profile.metricsVerified && profile.memoryMb > 0 && Number.isFinite(profile.cpuPercent) && profile.processCount >= 1));
  }, 'Installed native process memory/CPU metrics were not verified', 45000);
  checks.actualVerifiedResourceMetrics = true;

  stage = 'native-addons-and-package-ui';
  await verifyInstalledAddons({ api, until, page, origin, observed,
    profiles: [{ id: profileId, engine: 'firefox' }, { id: adminId, engine: 'chromium' }], clickFixturePoint });
  checks.actualNativeAddonBothEngines = true;
  checks.actualNativeAddonPopupAndOptions = true;
  checks.addonScopeAndDisabledRestart = true;

  await api('stop', { profileId: adminId });
  await until(async () => (await api('snapshot')).snapshot.profiles.find(item => item.id === adminId)?.state === 'stopped', 'Owned ChromiumAdmin did not stop');
  checks.ownedChromiumStopped = true;
  await page.screenshot({ path: screenshot, fullPage: false });
  assert.deepEqual(errors, [], 'Installed Live workspace has no uncaught page errors');
  checks.noPageErrors = true;
  stage = 'stop-owned-firefox';
  await api('stop', { profileId });
  await until(async () => (await api('snapshot')).snapshot.profiles.find(item => item.id === profileId)?.state === 'stopped', 'Owned Firefox did not stop');
  checks.ownedFirefoxStopped = true;
  stage = 'complete';
} catch (error) {
  failure = error instanceof Error ? error.message : 'Installed Live workspace smoke failed';
  if (page && !page.isClosed()) {
    // Preserve bounded live UI facts before owned browser/desktop cleanup removes the evidence.
    liveDiagnostics = await page.evaluate(({ profileId, adminId }) => {
      const tile = document.querySelector(`.live-tile[data-profile-id="${profileId || adminId || ''}"]`);
      const canvas = tile?.querySelector('canvas'), style = canvas ? getComputedStyle(canvas) : null;
      const box = canvas?.getBoundingClientRect();
      const text = selector => (document.querySelector(selector)?.textContent || '').trim().slice(0, 240);
      return { visibility: document.visibilityState, documentFocused: document.hasFocus(),
        relay: text('#connection-state'), workspaceHidden: document.querySelector('#browser-workspace')?.hidden ?? null,
        role: tile?.getAttribute('data-role') ?? null, state: tile?.getAttribute('data-state') ?? null,
        frameMessage: (tile?.querySelector('.stream-message-title')?.textContent || '').slice(0, 240),
        frameDetail: (tile?.querySelector('.stream-message-detail')?.textContent || '').slice(0, 240),
        frameMessageHidden: tile?.querySelector('.stream-message')?.hidden ?? null,
        browserError: text('#browser-error'), pageError: text('#error-text'),
        canvas: canvas ? { active: canvas.classList.contains('manual-active'), width: canvas.width, height: canvas.height,
          cssWidth: Math.round(box.width), cssHeight: Math.round(box.height), display: style.display, visibility: style.visibility } : null };
    }, { profileId, adminId }).catch(() => ({ unavailable: true }));
    failure += `; Live UI facts: ${JSON.stringify(liveDiagnostics)}`;
    await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {});
  }
} finally {
  if (token) await api('sync', undefined, 'DELETE').catch(() => {});
  if (adminId && token) await api('stop', { profileId: adminId }).catch(() => {});
  if (profileId && token) await api('stop', { profileId }).catch(() => {});
  // Closing this CDP connection detaches the inspector; the native desktop owns its window.
  await browser?.close().catch(() => {});
  await new Promise(done => fixture ? fixture.close(done) : done());
  clearTimeout(deadline);
  await writeFile(report, `${JSON.stringify({ success: !failure, stage, checks, error: failure ?? null, pageErrorCount: errors.length, liveDiagnostics,
    ...(!failure ? { session: { adminId: profileId, followerIds: [adminId] } } : {}) }, null, 2)}\n`);
}
if (failure) throw new Error(`Installed Live workspace smoke failed at ${stage}: ${failure}`);
console.log(JSON.stringify({ installedLiveWorkspace: true, independentEntrypoint: true, actualBundledFirefox: true, frames: true, manualInput: true, tabs: true, mixedFollowing: true, mixedBrowserNavigation: true, firefoxAdmin: true, firefoxReopen: true, sensitiveManualBoundary: true, cookies: true, workflows: true, schedules: true, resourceMetrics: true, nativeAddons: true }));
