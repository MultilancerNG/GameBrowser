(() => {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome;
  async function refresh() {
    try {
      const state = await api.runtime.sendMessage({ type: 'GET_STATE' });
      document.getElementById('status').textContent = state.reason || (state.connected ? 'Connected' : 'Disconnected');
      document.getElementById('profile').textContent = state.profileId || 'Unconfigured';
      document.getElementById('role').textContent = state.role || 'manual';
    } catch { document.getElementById('status').textContent = 'Synchronizer unavailable; profile remains manual.'; }
  }
  document.getElementById('manual').addEventListener('click', async () => { await api.runtime.sendMessage({ type: 'MANUAL_OVERRIDE', enabled: true }); await refresh(); });
  void refresh();
})();
