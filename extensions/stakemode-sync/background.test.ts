import { isSafeProfileId } from '../../profile-id.ts';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(join(import.meta.dir, 'background.js'), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function harness(override: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const tabMessages: any[] = [];
  const stored: any[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let runtimeMessage: (message: any, sender: any, respond: (value: any) => void) => boolean;
  const config = { profileId: 'profile_test_1', token: 't'.repeat(64), role: 'manual', origins: ['https://stake.com'], relayUrl: 'ws://127.0.0.1:8080/relay', ...override };
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    packets: any[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (message: any) => void;
    onerror?: () => void;
    constructor(public url: string) { sockets.push(this); }
    send(value: string) { this.packets.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(packet: unknown) { this.onmessage?.({ data: JSON.stringify(packet) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const listener = () => ({ addListener: () => {} });
  const chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}`, onMessage: { addListener: (fn: typeof runtimeMessage) => { runtimeMessage = fn; } } },
    storage: { session: { set: async (value: any) => { stored.push(value); } } },
    tabs: {
      query: async () => [{ id: 1, url: 'https://stake.com/casino/games/limbo' }],
      get: async (id: number) => ({ id, url: 'https://stake.com/casino/games/limbo' }),
      sendMessage: async (id: number, packet: any) => { tabMessages.push({ id, packet }); },
      onActivated: listener(), onUpdated: listener(), onRemoved: listener(),
    },
  };
  runInNewContext(source, {
    chrome, fetch: async () => ({ ok: true, json: async () => config }), WebSocket: FakeSocket, URL, Date, Math,
    setTimeout: (fn: () => void) => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: (id: number) => timers.delete(id),
    setInterval: () => ++timerId, clearInterval: () => {},
  });
  await tick();
  const message = (packet: any, sender: any = { tab: { id: 1, url: 'https://stake.com/casino/games/limbo' }, url: 'https://stake.com/casino/games/limbo' }) => {
    let response: any; runtimeMessage(packet, sender, (value) => { response = value; }); return response;
  };
  return { config, sockets, timers, tabMessages, stored, message };
}
describe('MV3 synchronizer authenticated transport', () => {
  test('authenticates only in first HELLO and never exposes token in URL, content config or storage', async () => {
    const h = await harness();
    const socket = h.sockets[0]!;
    expect(socket.url).toBe('ws://127.0.0.1:8080/relay');
    expect(socket.url).not.toContain(h.config.token as string);
    socket.open();
    expect(socket.packets[0]).toEqual({ type: 'HELLO', profileId: 'profile_test_1', token: h.config.token });
    socket.receive({ type: 'CONFIG', role: 'admin', origins: ['https://stake.com'], epoch: 3 });
    await tick();
    expect(JSON.stringify(h.tabMessages)).not.toContain(h.config.token as string);
    expect(JSON.stringify(h.stored)).not.toContain(h.config.token as string);
    expect(h.message({ type: 'GET_STATE' }).role).toBe('admin');
  });
  test('capture fails closed before configuration, after manual takeover, on wrong tab and URL', async () => {
    const h = await harness(); const socket = h.sockets[0]!; socket.open();
    const action = { type: 'ACTION', id: 'action_test_123', seq: 100, epoch: 999, origin: 'https://stake.com', url: 'https://stake.com/casino/games/limbo', action: 'click', selector: 'button[name="rules"]', fingerprint: { tag: 'button', name: 'rules', text: 'Rules' } };
    h.message({ type: 'CAPTURE_ACTION', action });
    expect(socket.packets.filter((packet) => packet.type === 'ACTION')).toHaveLength(0);
    socket.receive({ type: 'CONFIG', role: 'admin', origins: ['https://stake.com'], epoch: 3 }); await tick();
    h.message({ type: 'CAPTURE_ACTION', action }, { tab: { id: 2 }, url: action.url });
    h.message({ type: 'CAPTURE_ACTION', action: { ...action, url: 'https://stake.com/account' } });
    expect(socket.packets.filter((packet) => packet.type === 'ACTION')).toHaveLength(0);
    h.message({ type: 'CAPTURE_ACTION', action });
    expect(socket.packets.find((packet) => packet.type === 'ACTION').seq).toBe(1);
    expect(socket.packets.find((packet) => packet.type === 'ACTION').epoch).toBe(3);
    h.message({ type: 'MANUAL_OVERRIDE', enabled: true }, {});
    h.message({ type: 'CAPTURE_ACTION', action });
    expect(socket.packets.filter((packet) => packet.type === 'ACTION')).toHaveLength(1);
    expect(h.message({ type: 'GET_STATE' }).role).toBe('manual');
  });
  test('disconnect immediately pauses and reconnect has no action backlog', async () => {
    const h = await harness(); const first = h.sockets[0]!; first.open();
    first.receive({ type: 'CONFIG', role: 'follower', origins: ['https://stake.com'], epoch: 3 }); await tick();
    first.close();
    expect(h.message({ type: 'GET_STATE' }).connected).toBe(false);
    expect(h.message({ type: 'GET_STATE' }).role).toBe('manual');
    for (const [id, callback] of [...h.timers]) { h.timers.delete(id); callback(); }
    await tick();
    const second = h.sockets[1]!; second.open();
    expect(second.packets).toHaveLength(1);
    expect(second.packets[0].type).toBe('HELLO');
    expect(h.message({ type: 'GET_STATE' }).role).toBe('manual');
  });
  test('rejects remote relay config and unexpected origins, and observes paused CONFIG', async () => {
    const invalid = await harness({ relayUrl: 'ws://remote.example/relay' });
    expect(invalid.sockets).toHaveLength(0);
    expect(invalid.message({ type: 'GET_STATE' }).role).toBe('manual');
    const h = await harness(); const socket = h.sockets[0]!; socket.open();
    socket.receive({ type: 'CONFIG', role: 'admin', origins: ['https://evil.example'], epoch: 3 });
    expect(h.message({ type: 'GET_STATE' }).role).toBe('manual');
    socket.receive({ type: 'CONFIG', role: 'admin', origins: ['https://stake.com'], epoch: 4, paused: true });
    expect(h.message({ type: 'GET_STATE' }).role).toBe('manual');
    expect(h.message({ type: 'GET_STATE' }).reason).toContain('paused');
  });
  test('ACK echoes recipient epoch and stale rejected ACK cannot pause a resumed profile', async () => {
    const h = await harness(); const socket = h.sockets[0]!; socket.open();
    socket.receive({ type: 'CONFIG', role: 'follower', origins: ['https://stake.com'], epoch: 5 }); await tick();
    h.message({ type: 'ACK', id: 'action_stale_123', epoch: 4, status: 'rejected' });
    expect(socket.packets.filter((packet) => packet.type === 'ACK')).toHaveLength(0);
    expect(h.message({ type: 'GET_STATE' }).role).toBe('follower');
    h.message({ type: 'ACK', id: 'action_current_123', epoch: 5, status: 'applied' });
    expect(socket.packets.find((packet) => packet.type === 'ACK')).toEqual({ type: 'ACK', id: 'action_current_123', epoch: 5, status: 'applied' });
    socket.receive({ type: 'ACTION', id: 'action_old_123', epoch: 4 });
    expect(socket.packets.find((packet) => packet.id === 'action_old_123')).toMatchObject({ type: 'ACK', epoch: 4, status: 'rejected' });
  });
});

test('worker controller uses dynamic loopback endpoint and ignores content-script takeover or action replay', async () => {
  const h = await harness({ relayUrl: 'ws://127.0.0.1:54321/workspace/relay', controller: 'worker' });
  const socket = h.sockets[0]!; expect(socket.url).toBe(h.config.relayUrl); socket.open();
  socket.receive({ type: 'CONFIG', controller: 'worker', role: 'follower', origins: ['https://stake.com'], epoch: 3 });
  await tick();
  h.message({ type: 'MANUAL_OVERRIDE', enabled: true });
  expect(h.message({ type: 'GET_STATE' }).role).toBe('follower');
  expect(socket.packets.some(packet => packet.type === 'MANUAL_OVERRIDE')).toBe(false);
  socket.receive({ type: 'ACTION', id: 'action0001', epoch: 3 });
  expect(h.tabMessages.some(packet => packet.packet.type === 'ACTION')).toBe(false);
  socket.close();
  expect(h.message({ type: 'GET_STATE' }).role).toBe('follower');
  h.config.relayUrl = 'ws://127.0.0.1:54322/workspace/relay';
  for (const [id, callback] of [...h.timers]) { h.timers.delete(id); callback(); }
  await tick();
  expect(h.sockets[1]?.url).toBe(h.config.relayUrl);
  h.sockets[1]!.open();
  h.message({ type: 'MANUAL_OVERRIDE', enabled: true }, { url: 'chrome-extension://fixture/popup.html' });
  expect(h.sockets[1]!.packets.some(packet => packet.type === 'MANUAL_OVERRIDE' && packet.source === 'extension-popup')).toBe(true);
});

test('standalone extension profile IDs agree with the central128-character device-safe grammar', async () => {
  for (const profileId of ['a', 'A_9', 'id-' + 'x'.repeat(125), 'x'.repeat(129), 'CON', 'nul', 'COM1', 'lpt9', 'COM10', '_first', '-first', 'a.b', 'a/b', '', 'é']) {
    const h = await harness({ profileId });
    expect(h.sockets.length > 0).toBe(isSafeProfileId(profileId));
  }
});

test('worker pause keeps the assigned follower role visible until explicit Manual', async () => {
  const h = await harness({ controller: 'worker' }); const socket = h.sockets[0]!; socket.open();
  socket.receive({ type: 'CONFIG', controller: 'worker', role: 'follower', origins: ['https://stake.com'], epoch: 3, paused: true });
  expect(h.message({ type: 'GET_STATE' }).role).toBe('follower'); expect(h.message({ type: 'GET_STATE' }).paused).toBe(true);
});
