/* StakeMode MV3 transport. Tokens stay in the extension background and are
 * never delivered to a website/content script or included in a URL. */
(() => {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  let socket = null;
  let config = null;
  let generation = 0;
  let sequence = 0;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let helloTimer = null;
  let lastHeartbeat = 0;
  let activeTab = null;
  let state = { connected: false, role: 'manual', origins: [], epoch: 0, reason: 'Connecting; synchronization is paused' };

  const retainAssignments = () => state.preserveAssignments === true || config?.preserveAssignments === true;
  const workerControlled = () => state.controller === 'worker' || config?.controller === 'worker';
  const validRelay = (value) => {
    try { const url = new URL(value); return typeof value === 'string' && value.length <= 2048 && ['ws:', 'wss:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port || (url.protocol === 'wss:' ? 443 : 80)) > 0 && ['/relay', '/workspace/relay', '/workspace/cloud/relay'].includes(url.pathname) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
  };
  const isRecord = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const cleanUrl = (value) => {
    try {
      const url = new URL(value);
      const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password) return null;
      return { origin: url.origin, url: `${url.origin}${url.pathname}` };
    } catch { return null; }
  };
  const send = (packet) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try { socket.send(JSON.stringify(packet)); return true; } catch { return false; }
  };
  async function publish() {
    const ticket = generation;
    const publicState = { ...state, origins: [...state.origins], profileId: config?.profileId ?? null };
    try { await api.storage.session.set({ stakeModeSyncState: publicState }); } catch { /* Session state is cosmetic; never substitute persistent credentials. */ }
    let tabs = [];
    try { tabs = await api.tabs.query({}); } catch { return; }
    if (ticket !== generation) return;
    await Promise.all(tabs.map(async (tab) => {
      if (!Number.isInteger(tab.id)) return;
      try { await api.tabs.sendMessage(tab.id, { type: 'CONFIG', ...publicState, active: tab.id === activeTab }); } catch { /* Unsupported pages contain no content script. */ }
    }));
  }
  function pause(reason, notify = false) {
    state = { ...state, ...(workerControlled() || retainAssignments() ? {} : { role: 'manual' }), paused: true, reason };
    generation++;
    if (Number.isInteger(activeTab)) {
      try { api.tabs.sendMessage(activeTab, { type: 'PAUSE', reason }).catch(() => {}); } catch { /* Page may already be closing. */ }
    }
    if (notify && state.connected && !workerControlled()) send({ type: 'MANUAL_OVERRIDE', source: 'content-script', enabled: true, reason: reason.slice(0, 160) });
    void publish();
  }
  function clearTimers() {
    clearInterval(heartbeatTimer); heartbeatTimer = null;
    clearTimeout(helloTimer); helloTimer = null;
  }
  function disconnected(reason) {
    clearTimers();
    state.connected = false;
    pause(reason);
    socket = null;
    if (!reconnectTimer && config) {
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt++, 5)) + Math.floor(Math.random() * 250);
      reconnectTimer = setTimeout(async () => { reconnectTimer = null; try { await loadConfig(); connect(); } catch { disconnected('Workspace configuration is unavailable; assignment retained'); } }, delay);
    }
  }
  async function reportPage(tabId = activeTab) {
    if (!Number.isInteger(tabId)) return;
    const ticket = generation;
    try {
      const tab = await api.tabs.get(tabId);
      if (tabId !== activeTab || ticket !== generation) return;
      const page = cleanUrl(tab.url);
      if (retainAssignments() && tab.url === 'about:blank') { send({ type: 'PAGE', origin: '', url: 'about:blank' }); await publish(); return; }
      if (page && (workerControlled() || state.origins.includes(page.origin))) send({ type: 'PAGE', ...page });
      else {
        send({ type: 'PAGE', origin: '', url: '' });
        if (state.role !== 'manual' && !workerControlled()) pause('Active page is outside the approved origin', true);
      }
      await publish();
    } catch { pause('Active page is unavailable', true); }
  }
  function handlePacket(packet) {
    if (!isRecord(packet) || typeof packet.type !== 'string') return;
    if (packet.type === 'PONG' || packet.type === 'PING') {
      lastHeartbeat = Date.now();
      if (packet.type === 'PING') send({ type: 'PONG' });
      return;
    }
    if (packet.type === 'CONFIG') {
      if (!['admin', 'follower', 'manual'].includes(packet.role) || !Number.isSafeInteger(packet.epoch) || packet.epoch < 0 || !Array.isArray(packet.origins) || packet.origins.length > 32) return pause('Invalid relay configuration', true);
      if (packet.controller !== 'worker' && packet.origins.some((origin) => !config.origins.includes(origin))) return pause('Relay origin configuration does not match this profile', true);
      clearTimeout(helloTimer); helloTimer = null;
      generation++;
      const role = packet.paused === true && packet.controller !== 'worker' && !retainAssignments() ? 'manual' : packet.role;
      state = { connected: true, role, paused: packet.paused === true, origins: [...packet.origins], epoch: packet.epoch, reason: packet.paused === true ? 'Synchronization paused by workspace' : role === 'manual' ? 'Manual control' : 'Ready', ...(packet.controller === 'worker' ? { controller: 'worker' } : {}), ...(retainAssignments() ? { preserveAssignments: true } : {}) };
      reconnectAttempt = 0;
      lastHeartbeat = Date.now();
      void reportPage();
      return;
    }
    if (packet.type === 'ACTION') {
      if (workerControlled()) return;
      if (!state.connected || state.paused || state.role !== 'follower' || packet.epoch !== state.epoch || !Number.isInteger(activeTab)) return send({ type: 'ACK', id: String(packet.id ?? '').slice(0, 80), epoch: Number.isSafeInteger(packet.epoch) ? packet.epoch : -1, status: 'rejected', reason: 'Profile is paused or action is stale' });
      const currentGeneration = generation;
      api.tabs.sendMessage(activeTab, packet).then(() => {
        if (generation !== currentGeneration) return;
      }).catch(() => pause('Follower page is unavailable', true));
      return;
    }
    if (packet.type === 'PAUSE' || packet.type === 'ERROR' || packet.type === 'ACTION_REJECTED') pause(typeof packet.reason === 'string' ? packet.reason.slice(0, 160) : 'Relay paused synchronization', packet.type === 'ACTION_REJECTED');
  }
  function connect() {
    if (!config || socket) return;
    state.connected = false;
    pause('Reconnected profiles start paused until configured by the workspace');
    const next = new WebSocket(config.relayUrl);
    socket = next;
    next.onopen = () => {
      if (socket !== next) return;
      send({ type: 'HELLO', profileId: config.profileId, token: config.token });
      helloTimer = setTimeout(() => { if (!state.connected) next.close(1008, 'Configuration timeout'); }, 8000);
      heartbeatTimer = setInterval(() => {
        if (state.connected && Date.now() - lastHeartbeat > 65_000) return next.close(1001, 'Heartbeat timeout');
        send({ type: 'PING' });
      }, 20_000);
    };
    next.onmessage = (event) => {
      if (socket !== next) return;
      if (typeof event.data !== 'string' || event.data.length > 16_384) return next.close(1009, 'Packet limit');
      try { handlePacket(JSON.parse(event.data)); } catch { pause('Invalid relay packet', true); }
    };
    next.onerror = () => { if (socket === next) pause('Relay connection failed'); };
    next.onclose = () => { if (socket === next) disconnected('Relay disconnected; no queued action will be replayed'); };
  }
  // Register listeners synchronously before asynchronous config loading so an
  // MV3 worker wake never loses the event that woke it.
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (!isRecord(message)) return false;
    if (message.type === 'GET_STATE') { respond({ ...state, profileId: config?.profileId ?? null, active: sender.tab?.id === activeTab }); return false; }
    if (message.type === 'MANUAL_OVERRIDE') {
      if (workerControlled() || retainAssignments() && sender.url === api.runtime.getURL('popup.html')) {
        if (sender.url !== api.runtime.getURL('popup.html')) { respond({ ok: false }); return false; }
        const ok = send({ type: 'MANUAL_OVERRIDE', source: 'extension-popup', enabled: true });
        state.reason = ok ? 'Manual control requested in Live workspace' : 'Reconnect the workspace to change this assignment';
        void publish(); respond({ ok }); return false;
      }
      if (retainAssignments()) {
        if (!sender.tab || sender.tab.id !== activeTab) return false;
        pause(typeof message.reason === 'string' ? message.reason.slice(0, 160) : 'Page requires manual control', true);
      } else pause('Operator selected manual control', true);
      respond({ ok: true }); return false;
    }
    if (workerControlled() && ['CAPTURE_ACTION', 'ACK'].includes(message.type)) return false;
    if (!sender.tab || sender.tab.id !== activeTab) return false;
    const page = cleanUrl(sender.url ?? sender.tab.url);
    if (!page || !state.origins.includes(page.origin)) return false;
    if (message.type === 'CAPTURE_ACTION') {
      if (!state.connected || state.paused || state.role !== 'admin' || !isRecord(message.action) || message.action.origin !== page.origin || message.action.url !== page.url) return false;
      const packet = { ...message.action, type: 'ACTION', epoch: state.epoch, seq: ++sequence };
      if (JSON.stringify(packet).length <= 8192) send(packet);
      else pause('Action exceeded packet limit', true);
    } else if (message.type === 'ACK') {
      if (!state.connected || !Number.isSafeInteger(message.epoch) || message.epoch !== state.epoch) return false;
      send({ type: 'ACK', id: String(message.id ?? '').slice(0, 80), epoch: message.epoch, status: message.status === 'applied' ? 'applied' : 'rejected', ...(typeof message.reason === 'string' ? { reason: message.reason.slice(0, 160) } : {}) });
      if (message.status !== 'applied') pause('Follower target verification failed', true);
    } else if (message.type === 'PAGE') void reportPage(sender.tab.id);
    return false;
  });
  api.tabs.onActivated.addListener((info) => {
    if (Number.isInteger(activeTab) && activeTab !== info.tabId) {
      try { api.tabs.sendMessage(activeTab, { type: 'PAUSE', reason: 'Active tab changed' }).catch(() => {}); } catch { /* Page may have closed. */ }
    }
    activeTab = info.tabId; generation++; void reportPage();
  });
  api.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId !== activeTab) return;
    if (change.status === 'loading' || change.url) { generation++; void publish(); }
    if (change.status === 'complete' || change.url) void reportPage();
  });
  api.tabs.onRemoved.addListener((tabId) => { if (tabId === activeTab) { activeTab = null; pause('Active tab closed', true); } });
  async function loadConfig() {
      const response = await fetch(api.runtime.getURL('config.json'), { cache: 'no-store' });
      if (!response.ok) throw new Error('Missing per-profile runtime configuration');
      const loaded = await response.json();
      if (!isRecord(loaded) || typeof loaded.profileId !== 'string' || !(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(loaded.profileId) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(loaded.profileId)) || typeof loaded.token !== 'string' || loaded.token.length < 32 || loaded.token.length > 256 || !Array.isArray(loaded.origins) || loaded.origins.length > 32) throw new Error('Invalid per-profile runtime configuration');
      if (loaded.origins.some((origin) => { try { const url = new URL(origin); const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); return (url.protocol !== 'https:' && !localHttp) || url.origin !== origin; } catch { return true; } })) throw new Error('Invalid approved origin');
      if (!validRelay(loaded.relayUrl)) throw new Error('Relay must use a validated loopback workspace endpoint');
      if (loaded.controller !== undefined && !['extension', 'worker'].includes(loaded.controller)) throw new Error('Invalid synchronization controller');
      config = { profileId: loaded.profileId, token: loaded.token, origins: [...loaded.origins], relayUrl: loaded.relayUrl, ...(loaded.controller ? { controller: loaded.controller } : {}), ...(loaded.preserveAssignments === true ? { preserveAssignments: true } : {}) };
  }
  (async () => {
    try {
      await loadConfig();
      const tabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
      activeTab = tabs[0]?.id ?? null;
      connect();
    } catch (error) { pause(error instanceof Error ? error.message : 'Extension configuration is unavailable'); }
  })();
})();
