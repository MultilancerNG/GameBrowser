import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { generateSyncExtension, removeSyncExtension } from './syncExtension';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'content.js'), 'utf8');
type Message = Record<string, any>;
function harness() {
  const sent: Message[] = [];
  const listeners = new Map<string, (event: any) => void>();
  const elements: FakeElement[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let challenge = false;
  class FakeElement {
    parentElement: FakeElement | null = null;
    children: FakeElement[] = [];
    attrs: Record<string, string> = {};
    textContent = '';
    labels: FakeElement[] = [];
    focused = false;
    clicks = 0;
    events: string[] = [];
    form: FakeElement | null = null;
    constructor(public localName: string, attrs: Record<string, string> = {}, text = '') { this.attrs = attrs; this.textContent = text; elements.push(this); }
    getAttribute(key: string) { return this.attrs[key] ?? null; }
    hasAttribute(key: string) { return key in this.attrs; }
    closest(selector: string) { if (selector === 'form') return this.form; if (selector === '[inert]') return null; return this; }
    querySelector() { return null; }
    matches(selector: string) {
      if (selector.startsWith(':disabled')) return this.attrs.disabled === 'true';
      if (this.localName === 'input') return selector.includes(`input[type="${this.attrs.type ?? 'text'}"]`);
      return this.localName === 'select' && selector.includes('select,');
    }
    getBoundingClientRect() { return { width: 80, height: 32 }; }
    focus() { this.focused = true; }
    click() { this.clicks++; listeners.get('click')?.({ isTrusted: false, target: this, composedPath: () => [this] }); }
    dispatchEvent(event: any) { this.events.push(event.type); listeners.get(event.type)?.({ isTrusted: false, target: this, composedPath: () => [this] }); return true; }
  }
  class FakeInput extends FakeElement {
    private currentValue = '';
    maxLength = -1;
    inputMode = 'text';
    constructor(attrs: Record<string, string>) { super('input', attrs); }
    get type() { return this.attrs.type ?? 'text'; }
    get value() { return this.currentValue; }
    set value(value: string) { this.currentValue = value; }
  }
  class FakeTextarea extends FakeElement {
    private currentValue = '';
    get value() { return this.currentValue; }
    set value(value: string) { this.currentValue = value; }
  }
  const document = {
    querySelector: () => challenge ? {} : null,
    querySelectorAll: (selector: string) => {
      const match = selector.match(/^([a-z]+)\[([a-z-]+)="([^"]*)"\]$/);
      if (match) return elements.filter((element) => element.localName === match[1] && element.attrs[match[2]!] === match[3]);
      return elements.filter((element) => element.localName === selector);
    },
    addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const location = { protocol: 'https:', origin: 'https://stake.com', hostname: 'stake.com', pathname: '/casino/games/limbo', href: 'https://stake.com/casino/games/limbo?private=never-forwarded' };
  const window: any = { __fixtureRawCapture: (message: Message, nonce: string) => { if (nonce === 'private_fixture_nonce') sent.push(message); }, addEventListener: (type: string, fn: (event: any) => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type), scrollTo: () => {} };
  window.top = window;
  runInNewContext(`(() => {
    const rawCapture = window.__fixtureRawCapture;
    const privateCaptureNonce = 'private_fixture_nonce';
    const __stakemodePrivateSend = (packet) => rawCapture(packet, privateCaptureNonce);
    ${source}
  })();`, {
    window, document, location, Element: FakeElement, HTMLElement: FakeElement, HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextarea,
    crypto: webcrypto, URL, Date, InputEvent: class { constructor(public type: string, _options: any) {} }, Event: class { constructor(public type: string, _options: any) {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id), scrollX: 0, scrollY: 400,
  });
  const configure = (role: 'admin' | 'follower' | 'manual', epoch = 7, extra: Record<string, unknown> = {}) => window.__stakemodeConfigure({ role, epoch, origins: ['https://stake.com'], connected: true, active: true, ...extra });
  const trigger = (type: string, target: any, trusted = true, extras = {}) => listeners.get(type)?.({ type, isTrusted: trusted, target, composedPath: () => [target], ...extras });
  return { window, document, location, sent, configure, trigger, FakeElement, FakeInput, timers, challenge: () => { challenge = true; } };
}
describe('companion synchronization content script', () => {
  test('Firefox captures through private lexical adapter without a public transport function', () => {
    const h = harness();
    expect(h.window.__stakemodeSend).toBeUndefined();
    expect(h.window.__stakemodePrivateSend).toBeUndefined();
    h.window.__fixtureRawCapture({ type: 'ACTION', id: 'forged_packet_123' });
    expect(h.sent.some((packet) => packet.id === 'forged_packet_123')).toBe(false);
    h.configure('admin');
    h.trigger('click', new h.FakeElement('button', { 'data-testid': 'game-rules' }, 'Game rules'));
    expect(h.sent.filter((packet) => packet.type === 'ACTION')).toHaveLength(1);
  });
  test('starts manual and captures only trusted permitted interaction', () => {
    const h = harness();
    const rules = new h.FakeElement('button', { 'data-testid': 'game-rules' }, 'Game rules');
    h.trigger('click', rules);
    expect(h.sent.filter((packet) => packet.type === 'ACTION')).toHaveLength(0);
    h.configure('admin');
    h.trigger('click', rules, false);
    expect(h.sent.filter((packet) => packet.type === 'ACTION')).toHaveLength(0);
    h.trigger('click', rules);
    const action = h.sent.find((packet) => packet.type === 'ACTION')!;
    expect(action.selector).toBe('button[data-testid="game-rules"]');
    expect(action.url).toBe('https://stake.com/casino/games/limbo');
    expect(action.fingerprint.text).toBe('Game rules');
    expect(JSON.stringify(action)).not.toContain('private=');
  });
  test('never captures financial controls or authentication text, and switches manual', () => {
    for (const text of ['Place bet', 'Cash out', 'Log in', 'Deposit']) {
      const h = harness(); h.configure('admin');
      h.trigger('click', new h.FakeElement('button', { 'data-testid': 'continue' }, text));
      expect(h.sent.filter((packet) => packet.type === 'ACTION')).toHaveLength(0);
      expect(h.sent.some((packet) => packet.type === 'MANUAL_OVERRIDE')).toBe(true);
    }
    const h = harness(); h.configure('admin');
    const input = new h.FakeInput({ name: 'password', type: 'password' }); input.value = 'private password'; h.trigger('input', input);
    expect(JSON.stringify(h.sent)).not.toContain('private password');
  });
  test('follower verifies target before replay and pauses ambiguous/mismatched target', () => {
    const h = harness(); h.configure('follower');
    const rules = new h.FakeElement('button', { 'data-testid': 'game-rules' }, 'Game rules');
    const action = { type: 'ACTION', id: 'action_rules_123', seq: 1, epoch: 7, origin: 'https://stake.com', url: 'https://stake.com/casino/games/limbo', action: 'click', selector: 'button[data-testid="game-rules"]', fingerprint: { tag: 'button', name: 'game-rules', text: 'Game rules' } };
    h.window.__stakemodeReceive(action);
    expect(rules.clicks).toBe(1);
    expect(h.sent.some((packet) => packet.type === 'ACK' && packet.status === 'applied' && packet.epoch === 7)).toBe(true);
    expect(h.sent.filter((packet) => packet.type === 'ACTION')).toHaveLength(0);
    h.window.__stakemodeReceive({ ...action, id: 'action_rules_456', seq: 2, fingerprint: { ...action.fingerprint, text: 'Changed' } });
    expect(rules.clicks).toBe(1);
    expect(h.sent.some((packet) => packet.type === 'ACK' && packet.status === 'rejected' && packet.epoch === 7)).toBe(true);
    h.window.__stakemodeReceive({ ...action, id: 'action_rules_789', seq: 3 });
    expect(rules.clicks).toBe(1);
  });
  test('native input replay emits input/change without capture loop and rejects stale epoch', () => {
    const h = harness(); h.configure('follower');
    const search = new h.FakeInput({ type: 'search', name: 'search' });
    const action = { type: 'ACTION', id: 'action_search_123', seq: 1, epoch: 7, origin: 'https://stake.com', url: 'https://stake.com/casino/games/limbo', action: 'input', selector: 'input[name="search"]', value: 'rules', fingerprint: { tag: 'input', type: 'search', name: 'search' } };
    h.window.__stakemodeReceive(action);
    expect(search.value).toBe('rules'); expect(search.events).toEqual(['input', 'change']);
    h.configure('follower', 8);
    h.window.__stakemodeReceive({ ...action, id: 'action_search_456', seq: 2, value: 'stale' });
    expect(search.value).toBe('rules');
    expect(h.sent.find((packet) => packet.type === 'ACK' && packet.id === 'action_search_456')).toMatchObject({ epoch: 7, status: 'rejected' });
    expect(h.sent.filter((packet) => packet.type === 'ACTION')).toHaveLength(0);
  });
  test('pause/manual takeover cancels deferred scroll and excludes unprompted programmatic scroll', () => {
    const h = harness(); h.configure('admin');
    h.trigger('scroll', h.document);
    expect(h.timers.size).toBe(0);
    h.trigger('wheel', h.document);
    h.trigger('scroll', h.document);
    expect(h.timers.size).toBe(1);
    h.configure('manual', 8);
    expect(h.timers.size).toBe(0);
    h.configure('admin', 9, { paused: true });
    h.trigger('click', new h.FakeElement('button', { name: 'rules' }, 'Rules'));
    expect(h.sent.filter((packet) => packet.type === 'ACTION')).toHaveLength(0);
  });
  test('repeated configuration does not cause PAGE feedback loop and challenge blocks capture', () => {
    const h = harness(); h.configure('admin');
    const count = h.sent.filter((packet) => packet.type === 'PAGE').length;
    h.configure('admin');
    expect(h.sent.filter((packet) => packet.type === 'PAGE')).toHaveLength(count);
    h.challenge();
    h.trigger('click', new h.FakeElement('button', { name: 'rules' }, 'Rules'));
    expect(h.sent.filter((packet) => packet.type === 'ACTION')).toHaveLength(0);
    expect(h.sent.some((packet) => packet.type === 'MANUAL_OVERRIDE')).toBe(true);
  });
});

test('profile extension generator creates private scoped config without source mutation', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'stakemode-ext-'));
  const config = { profileId: 'profile_test_1', token: 'a'.repeat(64), role: 'manual' as const, origins: ['https://stake.com'], relayUrl: 'ws://127.0.0.1:8080/relay' };
  try {
    const directory = await generateSyncExtension({ stateRoot, profileId: config.profileId, config });
    expect(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))).toEqual(config);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.host_permissions).toEqual(['https://stake.com/*']);
    expect(manifest.content_scripts[0].matches).toEqual(['https://stake.com/*']);
    if (process.platform !== 'win32') expect((await stat(join(directory, 'config.json'))).mode & 0o777).toBe(0o600);
    await expect(generateSyncExtension({ stateRoot, profileId: '../escape', config })).rejects.toThrow();
    await expect(generateSyncExtension({ stateRoot, profileId: config.profileId, config: { ...config, relayUrl: 'ws://remote.example/relay' } })).rejects.toThrow();
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});

test('manual browsing without an approved sync website grants no page injection access', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'stakemode-manual-ext-'));
  const config = { profileId: 'manual_profile', token: 'a'.repeat(64), role: 'manual' as const, origins: [], relayUrl: 'ws://127.0.0.1:8080/relay' };
  try {
    const directory = await generateSyncExtension({ stateRoot, profileId: config.profileId, config });
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    expect(manifest.content_scripts).toEqual([]);
    expect(manifest.host_permissions).toEqual([]);
    expect(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')).origins).toEqual([]);
    expect(manifest.background.service_worker).toBe('background.js');
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});

test('deletion removes only the selected generated sync credentials and rejects linked directories', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'stakemode-delete-ext-'));
  try {
    const parent = join(stateRoot, 'sync-extensions');
    const kept = join(parent, 'kept'), removed = join(parent, 'removed'), outside = join(stateRoot, 'unrelated');
    for (const directory of [kept, removed, outside]) { mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'config.json'), 'secret'); }
    removeSyncExtension(stateRoot, 'removed');
    expect(existsSync(removed)).toBe(false);
    expect(readFileSync(join(kept, 'config.json'), 'utf8')).toBe('secret');
    expect(() => removeSyncExtension(stateRoot, '../unrelated')).toThrow();
    symlinkSync(outside, join(parent, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => removeSyncExtension(stateRoot, 'linked')).toThrow();
    expect(readFileSync(join(outside, 'config.json'), 'utf8')).toBe('secret');
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});

test('worker controller grants no second page observer or replay and accepts a dynamic workspace endpoint', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'gamebrowser-worker-ext-'));
  const config = { profileId: 'id-' + 'x'.repeat(125), token: 'a'.repeat(64), role: 'follower' as const, origins: ['https://stake.com'], relayUrl: 'ws://127.0.0.1:54321/workspace/relay', controller: 'worker' as const };
  try {
    const directory = await generateSyncExtension({ stateRoot, profileId: config.profileId, config });
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    expect(manifest.host_permissions).toEqual([]); expect(manifest.content_scripts).toEqual([]);
    expect(manifest.content_security_policy.extension_pages).toContain('ws://127.0.0.1:*');
    expect(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')).controller).toBe('worker');
  } finally { await rm(stateRoot, { recursive: true, force: true }); }
});
