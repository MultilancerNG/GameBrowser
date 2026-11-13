/* GameBrowser's dashboard is an authenticated loopback client. It never stores tokens,
 * credentials, browser frames, or profile inputs in browser persistence. */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { token: "", relayUrl: "", snapshot: { profiles: [], origins: [], pacing: "fast" }, socket: null, connected: false, view: "live", filter: "all", search: "", tiles: new Map(), rows: new Map(), subscriptions: new Set(), busy: new Set(), focusedProfile: null, killId: null, navigateId: null, browserProfileId: null, browserStates: new Map(), browserBusy: new Set(), browserStopBusy: new Set(), settingsProfileId: null, deleteProfileId: null, extensions: [], extensionsLoading: false, assignments: new Map(), reviewedExtensionId: null, extensionRemoval: null, reconnect: null, retry: 0, booting: false, toastTimer: null, disposed: false };
  const icons = { screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>' };
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const libraryState = { groups: [], profiles: new Map(), selected: new Set(), groupFilter: "all", tagFilter: "", loading: false, metadataId: null, copyId: null, batchBusy: false };
  const proxyState = { entries: [], loading: false, editId: null, assignId: null, deleteId: null };
  const automationState = { workflows: [], templates: [], jobs: [], schedules: [], loading: false, timer: null, editId: null, runId: null, deleteId: null };
  const workspaceUi = { selected: new Set(), order: [], orderReady: false, orderSaving: false, dragId: null, lastFocused: null, adminChoice: "", autoFollow: false, followingExpanded: false, autoTimer: null, syncBusy: false, syncRevision: 0, syncSeeded: false, sync: { active: false, starting: false, waiting: false, saved: false, adminId: null, followerIds: [], savedAdminId: null, savedFollowerIds: [], failedFollowerIds: [], error: null }, resourceId: null, resourcePolicies: new Map(), resourceLoading: new Set(), bookmarks: new Map(), bookmarksLoading: new Set(), trashIds: [] };
  let intersectionObserver;

  function text(element, value) { if (element && element.textContent !== String(value)) element.textContent = String(value); }
  function finite(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
  function number(value, digits = 0) { return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits }); }
  function profileId(profile) { return String(profile.id || profile.profileId || ""); }
  function getProfile(id) { return state.snapshot.profiles.find(profile => profileId(profile) === id); }
  function isRunning(profile) { return profile.status === "running"; }
  function displayState(profile) { if (!isRunning(profile)) return ["starting", "stopping"].includes(profile.status) ? "pending" : "stopped"; if (profile.role === "manual" || (!profile.role && profile.manual === true) || profile.paused === true) return "manual"; return profile.connected === false ? "pending" : "sync"; }
  function stateLabel(profile) { if (profile.status === "starting") return "Starting"; if (profile.status === "stopping") return "Stopping"; if (profile.status === "error") return "Error"; if (!isRunning(profile)) return "Stopped"; if (profile.paused) return "Sync paused"; if (profile.role === "manual" || (!profile.role && profile.manual)) return "Manual mode"; return profile.connected === false ? "Sync disconnected" : "Sync active"; }
  function metrics(profile) { if (profile.metricsVerified === false) return { cpu: null, memory: null, at: null }; const measured = profile.metrics || profile.stats || {}; return { cpu: finite(measured.cpuPercent ?? measured.cpu ?? profile.cpuPercent), memory: finite(measured.memoryMb ?? measured.rssMb ?? measured.memoryMB ?? profile.memoryMb), at: measured.at ?? measured.timestamp ?? profile.metricsSampledAt ?? null }; }
  function profileRole(profile) { return ["admin", "follower", "manual"].includes(profile.role) ? profile.role : "manual"; }
  function adminInputHint() { return state.snapshot.policy?.credentialsMirrored === false ? "Admin input · click the live view to focus. Sensitive actions stay manual. Shift+Tab exits live control." : "Admin input · click the live view to focus. Following uses its existing settings. Configure scope to apply workspace limits. Shift+Tab exits live control."; }
  function monitoredBudget(profile) { const resources = profile.resourceSettings; return resources?.policy && (resources.policy.autoOptimize || resources.policy.ramBudgetMb != null) ? finite(resources.allocation?.budgetMb) : finite(profile.ramMb); }
  function engineLabel(profile) { return profile.engine === "firefox" ? "Patched Firefox" : "Chromium"; }
  function allowedControl(profile) { return isRunning(profile) && (profileRole(profile) === "manual" || profileRole(profile) === "admin") && !state.busy.has(profileId(profile)) && state.connected; }
  function urlLabel(profile) { return profile.url || profile.origin || "No page available"; }
  function filteredProfiles() { return sortedProfiles(state.snapshot.profiles).filter(profile => { const metadata = libraryState.profiles.get(profileId(profile)), group = libraryState.groups.find(item => item.id === metadata?.groupId); return (state.filter === "all" || displayState(profile) === state.filter) && (!state.search || `${profile.name || ""} ${profileId(profile)} ${engineLabel(profile)} ${profileRole(profile)} ${group?.name || ""} ${(metadata?.tags || []).join(" ")}`.toLowerCase().includes(state.search)) && ((!["profiles", "live"].includes(state.view)) || ((libraryState.groupFilter === "all" || (libraryState.groupFilter === "ungrouped" ? !metadata?.groupId : metadata?.groupId === libraryState.groupFilter)) && (!libraryState.tagFilter || (metadata?.tags || []).some(tag => tag.toLowerCase().includes(libraryState.tagFilter))))); }); }
  function errorMessage(error) { return error instanceof Error ? error.message : String(error || "The request could not be completed."); }
  function showError(error) { text($("#error-text"), errorMessage(error)); $("#error-banner").hidden = false; }
  function toast(message) { clearTimeout(state.toastTimer); text($("#toast"), message); $("#toast").hidden = false; state.toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 4500); }

  async function api(path, body, bootstrap = false, method) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ["start", "batch"].includes(path) ? 180000 : path === "bulk" ? 90000 : 45000);
    try {
      const headers = { "X-StakeMode-Workspace": "1", Accept: "application/json" };
      if (!bootstrap) { if (!state.token) throw new Error("The local workspace is not connected yet."); headers.Authorization = `Bearer ${state.token}`; }
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(`/workspace/api/${path}`, { method: method || (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
      const content = await response.text();
      if (content.length > 4 * 1024 * 1024) throw new Error("The local server returned an oversized response.");
      let data;
      try { data = JSON.parse(content); } catch { throw new Error("The local server returned an invalid response. Restart GameBrowser and try again."); }
      if (response.status === 401 && !bootstrap) { state.token = ""; connection(false, "Session expired · reconnecting"); scheduleReconnect(true); }
      if (!response.ok || (data.error && data.ok !== true && !(path === "sync" && "adminId" in data))) throw new Error(typeof data.error === "string" ? data.error : `Local request failed (${response.status}).`);
      if (data.snapshot && path !== "sync") applySnapshot(data.snapshot);
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("The local request timed out. Refresh the workspace to check the actual profile state.");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function connection(connected, label) {
    // IntersectionObserver may compute visible IDs while the socket is still
    // authenticating. Those desired IDs were never sent. Resend the complete
    // subscription after the first authenticated snapshot, and after reconnect.
    if (connected && !state.connected) {
      state.subscriptions.clear();
      for (const tile of state.tiles.values()) {
        // A restarted relay begins a new sequence space. Existing browser
        // profiles can survive that restart, so their DOM tiles also survive.
        tile._streamGeneration = (tile._streamGeneration || 0) + 1;
        tile._frameSequence = -1;
        tile._frameAt = null;
        tile._frameHealthy = false;
      }
    }
    state.connected = connected;
    const target = $("#connection-state");
    target.replaceChildren();
    const dot = document.createElement("span"); dot.className = `status-dot ${connected ? "" : "pending"}`;
    target.append(dot, document.createTextNode(label));
    $("#sidebar-dot").className = `status-dot ${connected ? "" : "pending"}`;
    text($("#relay-address"), connected ? "This device · connected" : "This device · reconnecting");
    for (const [id, tile] of state.tiles) { const profile = getProfile(id); if (profile) updateTile(tile, profile); }
  }

  async function bootstrap() {
    if (state.booting || state.disposed) return;
    state.booting = true;
    try {
      const result = await api("bootstrap", undefined, true);
      applyWorkspaceVersion(result.version);
      if (typeof result.token !== "string" || !result.token || typeof result.relayUrl !== "string") throw new Error("The workspace bootstrap response is incomplete.");
      const relay = new URL(result.relayUrl, location.href);
      if (relay.protocol !== "ws:" || !["localhost", "127.0.0.1", "[::1]"].includes(relay.hostname) || relay.username || relay.password) throw new Error("The workspace relay must use a local loopback address.");
      state.token = result.token; state.relayUrl = relay.href;
      text($("#relay-address"), "This device · connecting");
      connectSocket();
      $("#error-banner").hidden = true;
    } catch (error) { connection(false, "Local server unavailable"); showError(error); scheduleReconnect(true); }
    finally { state.booting = false; }
  }

  function scheduleReconnect(rebootstrap = false) {
    clearTimeout(state.reconnect);
    if (state.disposed) return;
    const delay = Math.min(1000 * 2 ** state.retry++, 15000);
    state.reconnect = setTimeout(() => rebootstrap ? bootstrap() : connectSocket(), delay);
  }

  function connectSocket() {
    if (state.disposed || !state.token || !state.relayUrl) return;
    const old = state.socket;
    if (old) { old.onclose = null; old.close(); }
    state.subscriptions.clear(); state.focusedProfile = null;
    connection(false, "Connecting to relay");
    const socket = new WebSocket(state.relayUrl); state.socket = socket;
    socket.onopen = () => { if (socket !== state.socket) return; state.retry = 0; send({ type: "HELLO", client: "dashboard", token: state.token }); };
    socket.onmessage = event => {
      if (socket !== state.socket || typeof event.data !== "string" || event.data.length > 6 * 1024 * 1024) return;
      let packet;
      try { packet = JSON.parse(event.data); } catch { connection(false, "Invalid relay data"); socket.close(); return; }
      if (packet.type === "SNAPSHOT" && packet.snapshot) { const authenticated = !state.connected; connection(true, "Relay connected"); applySnapshot(packet.snapshot); if (authenticated) { refreshActiveView(); loadWorkspacePreferences(); loadFollowingStatus(); loadLibrary(); } }
      else if (packet.type === "FRAME") drawFrame(packet);
      else if (packet.type === "BROWSER_STATE" && packet.browser) applyBrowserState(packet.browser, false);
      else if (packet.type === "FRAME_ERROR") setFrameError(String(packet.profileId || ""), String(packet.error || "Live view unavailable"));
      else if (packet.type === "CONTROL_ERROR") { showError(packet.error || "Live control was rejected. Check the role, approved website, and tile focus."); state.focusedProfile = null; }
      else if (packet.type === "ERROR") showError(packet.error || "The relay rejected a request.");
      else if (packet.type === "PING") send({ type: "PONG" });
    };
    socket.onerror = () => { if (socket === state.socket) connection(false, "Relay unavailable"); };
    socket.onclose = event => {
      if (socket !== state.socket || state.disposed) return;
      connection(false, "Disconnected · retrying");
      state.subscriptions.clear(); state.focusedProfile = null;
      for (const [id] of state.tiles) setFrameError(id, "Relay disconnected. Live input is paused.");
      scheduleReconnect(event.code === 4001 || event.code === 1008 || event.code === 4401 || !state.token);
    };
  }

  function send(packet) { if (state.socket?.readyState === WebSocket.OPEN) { state.socket.send(JSON.stringify(packet)); return true; } return false; }

  function applySnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.profiles)) return;
    applyWorkspaceVersion(snapshot.version);
    $$(".loading-skeleton").forEach(element => element.remove());
    state.snapshot = { ...snapshot, profiles: snapshot.profiles.filter(profile => profile && profileId(profile)).map(profile => ({ ...profile, status: profile.state === "manual" ? "running" : profile.state || profile.status || "stopped", origin: profile.origin || profile.urls?.[0] || "", error: profile.lastError || profile.error })), origins: Array.isArray(snapshot.origins) ? snapshot.origins.filter(origin => typeof origin === "string") : [] };
    const contextKey = snapshot.capabilities?.contextKey;
    if (contextKey && workspaceUi.contextKey && contextKey !== workspaceUi.contextKey) { clearTimeout(workspaceUi.autoTimer); workspaceUi.autoFollow = false; workspaceUi.selected.clear(); workspaceUi.adminChoice = ""; workspaceUi.orderReady = false; workspaceUi.order = []; workspaceUi.resourcePolicies.clear(); workspaceUi.resourceLoading.clear(); workspaceUi.bookmarks.clear(); workspaceUi.bookmarksLoading.clear(); workspaceUi.syncRevision++; workspaceUi.syncBusy = false; workspaceUi.syncSeeded = false; workspaceUi.sync = { active:false,starting:false,waiting:false,saved:false,adminId:null,followerIds:[],savedAdminId:null,savedFollowerIds:[],failedFollowerIds:[],error:null }; queueMicrotask(loadWorkspacePreferences); }
    if (contextKey) workspaceUi.contextKey = contextKey;
    for (const profile of state.snapshot.profiles) if (profile.resourceSettings?.policy) workspaceUi.resourcePolicies.set(profileId(profile), profile.resourceSettings.policy);
    if (snapshot.syncSession && !workspaceUi.syncBusy) applySyncStatus(snapshot.syncSession);
    renderCapabilities();
    render();
  }

  function renderMetrics() {
    const profiles = state.snapshot.profiles;
    const running = profiles.filter(isRunning);
    text($("#metric-running"), running.length);
    text($("#metric-total"), profiles.length);
    const cpu = running.map(metrics).filter(reading => reading.cpu !== null); text($("#metric-cpu"), cpu.length ? `${number(cpu.reduce((sum, reading) => sum + reading.cpu, 0), 1)}%` : "—");
    text($("#metric-sync"), running.filter(profile => displayState(profile) === "sync" && profile.connected !== false).length);
    text($("#metric-manual"), running.filter(profile => profileRole(profile) === "manual").length);
    const readings = running.map(metrics).filter(reading => reading.memory !== null);
    const value = readings.length ? Math.round(readings.reduce((total, reading) => total + reading.memory, 0)) : null;
    const memory = $("#metric-memory"); memory.replaceChildren(document.createTextNode(number(value))); const unit = document.createElement("em"); unit.textContent = " MB"; memory.append(unit);
    text($("#metrics-time"), readings.length ? `Measured for ${readings.length} of ${running.length} running profiles` : "No process readings yet");
    text($("#all-count"), profiles.length);
    const scopes = state.snapshot.origins;
    text($("#scope-origins"), scopes.length ? scopes.join(" · ") : "No website approved");
    $("#scope-origins").title = scopes.join("\n");
    text($("#pacing-label"), state.snapshot.pacing === "paced" ? "Paced · 450–1,750 ms" : "Fast · immediate dispatch");
  }

  function buildRoleSelect(id) {
    const select = document.createElement("select"); select.className = "role-select"; select.dataset.roleFor = id; select.setAttribute("aria-label", "Profile synchronization role");
    for (const [value, label] of [["admin", "Admin"], ["follower", "Follower"], ["manual", "Manual"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option); }
    return select;
  }

  function actions(id) {
    const wrap = document.createElement("div"); wrap.className = "row-actions";
    for (const [action, label] of [["browser", "Full view"], ["settings", "Settings"], ["organize", "Organize"], ["copy", "Copy config"], ["delete", "Delete local"], ["start", "Start"], ["stop", "Stop"], ["pause", "Pause sync"], ["manual", "Manual"], ["kill", "Force kill"]]) { const button = document.createElement("button"); button.className = `button ${["kill", "delete"].includes(action) ? "danger" : "subtle"}${["organize", "copy"].includes(action) ? " library-row-action" : ""}`; button.dataset.action = action; button.dataset.profileId = id; button.textContent = label; wrap.append(button); }
    return wrap;
  }

  function createTile(profile) {
    const id = profileId(profile);
    const tile = document.createElement("article"); tile.className = "live-tile"; tile.dataset.profileId = id;
    tile.innerHTML = `<header class="tile-heading"><button class="drag-handle" draggable="true" aria-label="Rearrange profile" title="Drag to rearrange · Alt + ↑ or ↓">⠿</button><input type="checkbox" class="live-profile-select" aria-label="Select profile"><span class="profile-avatar" aria-hidden="true"></span><div class="tile-heading-main"><div class="tile-title-line"><h2 class="tile-name"></h2><span class="tile-role"></span></div><span class="tile-engine"></span></div><div class="tile-heading-actions"><button class="button subtle" data-action="browser">Full view</button><button class="button subtle" data-action="settings">Settings</button></div><span class="badge tile-badge"></span></header><form class="tile-browser-bar"><button type="button" class="browser-icon" data-tile-browser="back" aria-label="Back">←</button><button type="button" class="browser-icon" data-tile-browser="forward" aria-label="Forward">→</button><button type="button" class="browser-icon" data-tile-browser="reload" aria-label="Reload">↻</button><input class="tile-address" aria-label="Browser address" autocomplete="off" spellcheck="false"><button type="button" class="browser-icon tile-bookmark" data-action="organize" aria-label="Edit bookmarks" title="Edit bookmarks">☆</button></form><div class="tile-viewport"><canvas class="stream-canvas" tabindex="0" width="1280" height="720"></canvas><div class="stream-message">${icons.screen}<span class="stream-message-title"></span><small class="stream-message-detail"></small></div><span class="stream-corner" hidden></span></div><div class="tile-url"></div><div class="tile-telemetry"><span class="tile-live-status"></span><span>CPU <b class="tile-cpu">—</b></span><span>RAM <b class="tile-memory">—</b></span><span class="reading-age"></span></div><div class="tile-actions"></div><div class="manual-hint" hidden></div>`;
    $$("[data-action]", tile).forEach(button => button.dataset.profileId = id);
    $(".live-profile-select", tile).addEventListener("change", event => selectLiveProfile(id, event.target.checked));
    $(".drag-handle", tile).addEventListener("dragstart", event => { workspaceUi.dragId = id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); tile.classList.add("dragging"); });
    $(".drag-handle", tile).addEventListener("dragend", () => { workspaceUi.dragId = null; $$(".dragging,.drop-target").forEach(item => item.classList.remove("dragging", "drop-target")); });
    $(".drag-handle", tile).addEventListener("keydown", event => { if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return; event.preventDefault(); const ids = filteredProfiles().map(profileId), index = ids.indexOf(id), target = ids[index + (event.key === "ArrowUp" ? -1 : 1)]; if (target) arrangeProfiles(id, target, event.key === "ArrowDown"); });
    tile.addEventListener("dragover", event => { if (workspaceUi.dragId && workspaceUi.dragId !== id) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; tile.classList.add("drop-target"); } });
    tile.addEventListener("dragleave", event => { if (!tile.contains(event.relatedTarget)) tile.classList.remove("drop-target"); });
    tile.addEventListener("drop", event => { event.preventDefault(); tile.classList.remove("drop-target"); const source = workspaceUi.dragId; if (source && source !== id) arrangeProfiles(source, id, event.clientY > tile.getBoundingClientRect().top + tile.clientHeight / 2); });
    $(".tile-browser-bar", tile).addEventListener("submit", event => { event.preventDefault(); try { browserAction("navigate", { url: browserUrl($(".tile-address", tile).value) }, id); $(".tile-address", tile).blur(); } catch (error) { showError(error); } });
    $$("[data-tile-browser]", tile).forEach(button => button.addEventListener("click", () => browserAction(button.dataset.tileBrowser, {}, id)));
    $(".tile-actions", tile).append(buildRoleSelect(id), ...actions(id).children);
    const canvas = $("canvas", tile); canvas.setAttribute("aria-label", `Live browser view for ${profile.name || id}`);
    tile._frameSequence = -1; tile._frameAt = null; tile._frameHealthy = false; tile._streamGeneration = 0; tile._visible = false;
    canvas.addEventListener("focus", () => focusProfile(id));
    canvas.addEventListener("blur", () => { if (state.focusedProfile === id) { state.focusedProfile = null; send({ type: "FOCUS", profileId: null }); } });
    canvas.addEventListener("click", event => { const current = getProfile(id); if (!current || !allowedControl(current) || !canvas.width || !canvas.height) return; canvas.focus(); focusProfile(id); const bounds = canvas.getBoundingClientRect(); const scale = Math.min(bounds.width / canvas.width, bounds.height / canvas.height); if (!scale) return; const left = bounds.left + (bounds.width - canvas.width * scale) / 2, top = bounds.top + (bounds.height - canvas.height * scale) / 2; const x = Math.floor((event.clientX - left) / scale), y = Math.floor((event.clientY - top) / scale); if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return; control(id, { kind: "click", x, y }); });
    canvas.addEventListener("wheel", event => { const current = getProfile(id); if (!current || !allowedControl(current)) return; event.preventDefault(); canvas.focus({ preventScroll: true }); focusProfile(id); const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.height : 1; control(id, { kind: "scroll", deltaX: Math.max(-2000, Math.min(2000, Math.round(event.deltaX * factor))), deltaY: Math.max(-2000, Math.min(2000, Math.round(event.deltaY * factor))) }); }, { passive: false });
    canvas.addEventListener("keydown", event => { const current = getProfile(id); if (!current || !allowedControl(current) || event.isComposing) return; if (event.ctrlKey || event.metaKey || event.altKey) return; const key = event.key; if (key.length === 1) { event.preventDefault(); control(id, { kind: "text", text: key }); } else if (["Backspace", "Delete", "Tab", "Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(key)) { if (key === "Tab" && event.shiftKey) return; event.preventDefault(); control(id, { kind: "key", key }); } });
    canvas.addEventListener("paste", event => { const current = getProfile(id); if (!current || !allowedControl(current)) return; const value = event.clipboardData?.getData("text/plain") || ""; if (value && value.length <= 2048) { event.preventDefault(); control(id, { kind: "text", text: value }); } else if (value) { event.preventDefault(); toast("Paste is limited to 2,048 characters."); } });
    intersectionObserver?.observe(tile);
    return tile;
  }

  function focusProfile(id) { const profile = getProfile(id); if (!profile || !allowedControl(profile)) return; if (state.focusedProfile !== id) { state.focusedProfile = id; send({ type: "FOCUS", profileId: id }); } }
  function control(id, command) { const profile = getProfile(id); if (!profile || !allowedControl(profile) || !state.subscriptions.has(id) || !state.tiles.get(id)?._frameHealthy) return false; focusProfile(id); const submitted = send({ type: "CONTROL", profileId: id, ...command }); if (!submitted) toast("The relay is disconnected. No input was sent."); return submitted; }

  function updateButtons(root, profile) {
    const running = isRunning(profile), busy = state.busy.has(profileId(profile)), pending = ["starting", "stopping"].includes(profile.status);
    $$("[data-action]", root).forEach(button => { const action = button.dataset.action; button.hidden = ["browser", "settings", "organize", "copy"].includes(action) ? false : action === "delete" ? !profileStopped(profile) : action === "start" ? running || pending : action === "stop" || action === "kill" ? !running && !pending : !running; button.disabled = busy || !state.token || (pending && !["kill", "browser", "settings", "organize"].includes(action)); if (action === "pause") text(button, profile.paused ? "Resume sync" : "Pause sync"); if (action === "manual") { text(button, profileRole(profile) === "manual" ? "Return to sync" : "Manual"); button.setAttribute("aria-pressed", String(profileRole(profile) === "manual")); } });
    if (profile.managementAvailable === false) $$("[data-action]", root).forEach(button => { if (["organize", "copy", "delete"].includes(button.dataset.action)) { button.hidden = true; button.disabled = true; } });
    const select = $("[data-role-for]", root); if (select) { select.disabled = busy || pending || !state.token; if (document.activeElement !== select) select.value = profileRole(profile); select.setAttribute("aria-label", `${profile.name || profileId(profile)} synchronization role`); }
  }

  function updateTile(tile, profile) {
    const id = profileId(profile), currentState = displayState(profile), reading = metrics(profile);
    tile.dataset.state = currentState; tile.dataset.role = profileRole(profile); tile.classList.toggle("selected-profile", workspaceUi.selected.has(id));
    $(".live-profile-select", tile).checked = workspaceUi.selected.has(id); $(".live-profile-select", tile).setAttribute("aria-label", `Select ${profile.name || id}`);
    text($(".tile-role", tile), profileRole(profile) === "manual" ? "Manual" : profileRole(profile) === "admin" ? "Admin" : "Follower");
    text($(".tile-live-status", tile), isRunning(profile) ? tile._frameHealthy ? "Connected" : tile._visible ? "Waiting for frame" : "Stream idle" : stateLabel(profile));
    const address = $(".tile-address", tile), browser = state.browserStates.get(id); if (document.activeElement !== address) address.value = browser?.tabs.find(tab => tab.id === browser.activeTabId)?.url || tile._frameUrl || profile.url || profile.origin || ""; address.disabled = !allowedControl(profile);
    $$("[data-tile-browser]", tile).forEach(button => button.disabled = !allowedControl(profile));
    text($(".profile-avatar", tile), (profile.name || id).slice(0, 2).toUpperCase());
    text($(".tile-name", tile), profile.name || id); $(".tile-name", tile).title = profile.name || id;
    text($(".tile-engine", tile), engineLabel(profile));
    const badge = $(".tile-badge", tile); badge.className = `badge tile-badge ${currentState}`; text(badge, stateLabel(profile));
    text($(".tile-url", tile), urlLabel(profile)); $(".tile-url", tile).title = urlLabel(profile);
    text($(".tile-cpu", tile), reading.cpu === null ? "—" : `${number(reading.cpu, 1)}%`);
    text($(".tile-memory", tile), reading.memory === null ? "—" : `${number(reading.memory)} MB`);
    $(".tile-memory", tile).classList.toggle("memory-over", reading.memory !== null && reading.memory > (monitoredBudget(profile) ?? Infinity));
    text($(".reading-age", tile), reading.memory === null ? "No reading" : profile.pid ? `PID ${profile.pid}` : "Measured");
    updateButtons(tile, profile);
    const canControl = allowedControl(profile) && tile._frameHealthy; $("canvas", tile).classList.toggle("manual-active", canControl); $("canvas", tile).tabIndex = canControl ? 0 : -1;
    const hint = $(".manual-hint", tile); hint.hidden = !canControl; text(hint, profileRole(profile) === "admin" ? adminInputHint() : "Direct manual control · click to focus, type or scroll. Inputs are not relayed. Shift+Tab exits live control.");
    if (!isRunning(profile)) { tile._frameSequence = -1; tile._frameAt = null; $(".stream-corner", tile).hidden = true; setFrameError(id, profile.error || (profile.status === "starting" ? "Starting isolated browser…" : "Browser is stopped"), profile.status === "starting" ? "The first live frame appears when the page is ready." : "Start this profile to open its isolated session."); }
    else if (!tile._frameAt) { $(".stream-message", tile).hidden = false; text($(".stream-message-title", tile), "Waiting for a live frame…"); text($(".stream-message-detail", tile), "Visible running profiles stream through the local relay."); }
  }

  function createRow(profile) {
    const id = profileId(profile), row = document.createElement("tr"); row.dataset.profileId = id;
    row.innerHTML = '<td><div class="table-profile-name"></div><div class="table-profile-engine"></div></td><td class="table-role-cell"><span class="badge"></span></td><td class="number-cell process-cell" data-label="PROCESS"></td><td class="number-cell cpu-cell" data-label="CPU"></td><td class="number-cell memory-cell" data-label="MEMORY / BUDGET"><span class="memory-reading"></span><small class="memory-budget"></small><div class="memory-gauge"><span></span></div></td><td class="number-cell heap-cell" data-label="JS HEAP"></td><td></td>';
    row.firstElementChild.className = "profile-identity-cell";
    const selection = makeElement("input", "profile-row-select"); selection.type = "checkbox"; selection.dataset.selectProfile = id; selection.setAttribute("aria-label", `Select ${profile.name || id}`); row.firstElementChild.prepend(selection); row.firstElementChild.append(makeElement("div", "table-profile-library"));
    $(".table-role-cell", row).append(buildRoleSelect(id)); row.lastElementChild.append(actions(id));
    return row;
  }

  function updateRow(row, profile) {
    const reading = metrics(profile), budget = monitoredBudget(profile), resources = profile.resourceSettings, optimized = resources?.policy?.autoOptimize === true, heap = optimized ? finite(resources.allocation?.jsHeapMb) : profile.explicitHeap === true ? finite(profile.heapMb) : null, status = displayState(profile);
    text($(".table-profile-name", row), profile.name || profileId(profile)); $(".table-profile-name", row).title = profile.name || profileId(profile);
    text($(".table-profile-engine", row), engineLabel(profile));
    const metadata = libraryState.profiles.get(profileId(profile)), group = libraryState.groups.find(item => item.id === metadata?.groupId);
    text($(".table-profile-library", row), `${group?.name || "Ungrouped"}${metadata?.tags?.length ? " · " + metadata.tags.join(", ") : ""}`);
    $("[data-select-profile]", row).checked = libraryState.selected.has(profileId(profile));
    const badge = $(".badge", row); badge.className = `badge ${status}`; text(badge, stateLabel(profile));
    text($(".process-cell", row), profile.pid ? String(profile.pid) : "—");
    text($(".cpu-cell", row), reading.cpu === null ? "—" : `${number(reading.cpu, 1)}%`);
    text($(".memory-reading", row), reading.memory === null ? "—" : `${number(reading.memory)} MB`);
    text($(".memory-budget", row), budget === null ? "No memory alert configured" : `${number(budget)} MB ${resources?.policy && (optimized || resources.policy.ramBudgetMb != null) ? "target · advisory" : "alert threshold"}`);
    const over = reading.memory !== null && budget !== null && reading.memory > budget;
    $(".memory-reading", row).classList.toggle("memory-over", over); $(".memory-gauge", row).classList.toggle("over", over);
    $(".memory-gauge span", row).style.width = reading.memory !== null && budget ? `${Math.min(100, reading.memory / budget * 100)}%` : "0%";
    text($(".heap-cell", row), profile.engine === "firefox" ? "Not V8" : heap === null ? "Browser default" : `${number(heap)} MB · next launch`);
    updateButtons(row, profile);
  }

  function render() {
    renderMetrics();
    if (state.browserProfileId && !getProfile(state.browserProfileId)) returnToGrid();
    const visible = filteredProfiles(), selected = getProfile(state.browserProfileId), rendered = selected && !visible.some(profile => profileId(profile) === state.browserProfileId) ? [...visible, selected] : visible;
    const grid = $("#live-grid"), table = $("#profile-table-body"), ids = new Set(rendered.map(profileId));
    for (const [id, tile] of state.tiles) if (!ids.has(id)) { intersectionObserver?.unobserve(tile); tile.remove(); state.tiles.delete(id); }
    for (const [id, row] of state.rows) if (!ids.has(id)) { row.remove(); state.rows.delete(id); }
    let gridIndex = 0;
    for (const profile of rendered) {
      const id = profileId(profile);
      let tile = state.tiles.get(id); if (!tile) { tile = createTile(profile); state.tiles.set(id, tile); grid.append(tile); } updateTile(tile, profile);
      const parent = state.view === "browser" && id === state.browserProfileId ? $("#browser-stage") : grid;
      if (parent === grid) { const reference = grid.children[gridIndex] || null; if (reference !== tile) { if (typeof grid.moveBefore === "function" && tile.isConnected) grid.moveBefore(tile, reference); else { const focused = tile.contains(document.activeElement) ? document.activeElement : null; grid.insertBefore(tile, reference); focused?.focus({ preventScroll: true }); } } gridIndex++; }
      else if (tile.parentElement !== parent) parent.append(tile);
      let row = state.rows.get(id); if (!row) { row = createRow(profile); state.rows.set(id, row); table.append(row); } updateRow(row, profile);
      row.hidden = !visible.some(item => profileId(item) === id);
    }
    $("#live-empty").hidden = visible.length !== 0;
    $("#table-empty").hidden = visible.length !== 0;
    text($("#empty-copy"), state.snapshot.profiles.length ? "No profiles match your filter. Search another name or choose All." : "Create isolated profiles, choose an approved website, and start a session.");
    $("#empty-create").hidden = state.snapshot.profiles.length > 0;
    const admin = state.snapshot.profiles.find(profile => isRunning(profile) && profileRole(profile) === "admin");
    $("#full-admin-view").disabled = !admin; $("#full-admin-view").title = admin ? `Open ${admin.name || profileId(admin)} in the full browser workspace` : "Choose an administrator role for a running profile first";
    if (state.view === "browser") renderBrowserChrome();
    if ($("#profile-settings-dialog").open) updateProfileSettingsAvailability();
    for (const id of libraryState.selected) if (!getProfile(id)) libraryState.selected.delete(id);
    updateLibrarySelection();
    renderFollowing();
    renderSelectionTools();
    renderBookmarks();
    updateSubscriptions();
  }

  function updateSubscriptions() {
    const limit = Math.min(12, Math.max(1, Number(state.snapshot.limits?.maxVisible) || 12));
    const candidates = document.hidden ? [] : state.view === "browser" ? (getProfile(state.browserProfileId) && isRunning(getProfile(state.browserProfileId)) ? [state.browserProfileId] : []) : state.view === "live" ? filteredProfiles().filter(profile => isRunning(profile) && state.tiles.get(profileId(profile))?._visible).map(profileId) : [];
    const next = new Set(candidates.slice(0, limit));
    $("#stream-limit").hidden = candidates.length <= limit || state.view !== "live";
    if ([...next].join("|") !== [...state.subscriptions].join("|")) { state.subscriptions = next; if (state.connected) send({ type: "SUBSCRIBE", profileIds: [...next] }); }
    for (const [id, tile] of state.tiles) { const profile = getProfile(id); if (profile && isRunning(profile) && !next.has(id)) setFrameError(id, document.hidden || state.view !== "live" ? "Live view paused" : "Stream idle", "Bring this tile into view to resume its live stream."); }
  }

  function setFrameError(id, message, detail = "No input is sent while the live stream is unavailable.") {
    const tile = state.tiles.get(id); if (!tile) return;
    tile._frameHealthy = false;
    text($(".tile-live-status", tile), isRunning(getProfile(id) || {}) ? /idle|paused/i.test(message) ? "Stream idle" : "Live view unavailable" : stateLabel(getProfile(id) || {}));
    $(".stream-message", tile).hidden = false; text($(".stream-message-title", tile), message); text($(".stream-message-detail", tile), detail);
    const canvas = $("canvas", tile); canvas.classList.remove("manual-active"); canvas.tabIndex = -1;
    $(".manual-hint", tile).hidden = true;
    if (!isRunning(getProfile(id) || {})) { const context = canvas.getContext("2d"); context?.clearRect(0, 0, canvas.width, canvas.height); }
  }

  function drawFrame(packet) {
    const id = String(packet.profileId || ""), tile = state.tiles.get(id);
    if (!tile || !state.subscriptions.has(id) || document.hidden || typeof packet.jpeg !== "string" || packet.jpeg.length > 5 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(packet.jpeg) || !Number.isSafeInteger(packet.sequence) || packet.sequence <= tile._frameSequence) return;
    const width = finite(packet.width), height = finite(packet.height);
    if (!width || !height || width > 4096 || height > 4096) return;
    tile._frameSequence = packet.sequence;
    const generation = tile._streamGeneration;
    const image = new Image();
    image.onload = () => { if (!state.connected || state.tiles.get(id) !== tile || tile._streamGeneration !== generation || tile._frameSequence !== packet.sequence || !state.subscriptions.has(id)) return; const canvas = $("canvas", tile); if (image.naturalWidth !== width || image.naturalHeight !== height) return; canvas.width = width; canvas.height = height; $(".tile-viewport", tile).style.aspectRatio = `${width} / ${height}`; $(".tile-viewport", tile).style.setProperty("--frame-aspect", `${width} / ${height}`); const context = canvas.getContext("2d", { alpha: false }); if (!context) { setFrameError(id, "This browser cannot render the live canvas."); return; } context.drawImage(image, 0, 0, width, height); tile._frameAt = Date.now(); tile._frameHealthy = true; text($(".tile-live-status", tile), "Connected"); $(".stream-message", tile).hidden = true; const at = typeof packet.at === "number" && packet.at >= 0 && packet.at < 8.64e15 ? new Date(packet.at) : new Date(); text($(".stream-corner", tile), `${width}×${height} · ${timeFormat.format(at)}`); $(".stream-corner", tile).hidden = false; const profile = getProfile(id); const canControl = Boolean(profile && allowedControl(profile)); canvas.classList.toggle("manual-active", canControl); canvas.tabIndex = canControl ? 0 : -1; const hint = $(".manual-hint", tile); hint.hidden = !canControl; text(hint, profileRole(profile || {}) === "admin" ? adminInputHint() : "Direct manual control · click to focus, type or scroll. Inputs are not relayed. Shift+Tab exits live control."); if (typeof packet.url === "string") { tile._frameUrl = packet.url; const address = $(".tile-address", tile); if (document.activeElement !== address && !state.browserStates.get(id)) address.value = packet.url; text($(".tile-url", tile), packet.url); $(".tile-url", tile).title = packet.url; } if (state.view === "browser" && state.browserProfileId === id) renderBrowserChrome(); };
    image.onerror = () => { if (state.tiles.get(id) === tile && tile._streamGeneration === generation && tile._frameSequence === packet.sequence) setFrameError(id, "The live frame could not be decoded."); };
    image.src = `data:image/jpeg;base64,${packet.jpeg}`;
  }

  function setView(view) {
    if (state.view === "browser" && view !== "browser") { state.browserProfileId = null; exitWorkspaceFullscreen(); }
    state.view = ["live", "tasks", "profiles", "browser", "extensions", "proxies", "automation"].includes(view) ? view : "live";
    if (state.view === "browser" && !state.browserProfileId) state.view = "live";
    text($("#view-title"), { live: "Live workspace", tasks: "Task manager", profiles: "Profiles", browser: "Full Admin View", extensions: "Extensions & add-ons", proxies: "Proxy library", automation: "Local automation" }[state.view]);
    $("#live-view").hidden = state.view !== "live"; $("#table-view").hidden = !["tasks", "profiles"].includes(state.view); $("#browser-workspace").hidden = state.view !== "browser"; $("#extensions-view").hidden = state.view !== "extensions";
    $("#proxies-view").hidden = state.view !== "proxies"; $("#automation-view").hidden = state.view !== "automation";
    document.body.classList.toggle("browser-mode", state.view === "browser"); document.body.classList.toggle("extensions-mode", state.view === "extensions");
    document.body.classList.toggle("profiles-mode", state.view === "profiles"); $("#profile-management-toolbar").hidden = state.view !== "profiles";
    document.body.classList.toggle("tools-mode", ["proxies", "automation"].includes(state.view));
    text($("#view-hint"), state.view === "live" ? "Up to 12 visible live streams" : state.view === "tasks" ? "Live process readings" : "Isolated browser sessions");
    $$("[data-view]").forEach(button => { const active = button.dataset.view === state.view || (state.view === "browser" && button.dataset.view === "live"); button.classList.toggle("selected", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
    $("#following-band").hidden = !["live", "browser"].includes(state.view);
    if (state.view === "browser") $(".browser-workspace-heading").after($("#following-band"));
    else $(".scope-bar").before($("#following-band"));
    history.replaceState(null, "", `#${state.view}`);
    if (state.focusedProfile) { state.focusedProfile = null; send({ type: "FOCUS", profileId: null }); }
    render();
    if (state.view === "extensions") loadExtensions();
    if (state.view === "profiles") loadLibrary();
    if (state.view === "proxies") loadProxies();
    clearTimeout(automationState.timer); if (state.view === "automation") loadAutomation(true);
  }

  function profilePath(id, suffix = "") { return `profiles/${encodeURIComponent(id)}${suffix ? "/" + suffix : ""}`; }

  async function loadLibrary() {
    if (!state.token || libraryState.loading) return;
    libraryState.loading = true; const context = workspaceUi.contextKey; text($("#library-error"), "");
    try { const result = await api("library"); if (context !== workspaceUi.contextKey) return; workspaceUi.bookmarks.clear(); libraryState.groups = Array.isArray(result.groups) ? result.groups : []; libraryState.profiles = new Map((result.profiles || []).map(item => [item.profileId, item])); renderGroupChoices(); render(); }
    catch (error) { text($("#library-error"), errorMessage(error)); }
    finally { libraryState.loading = false; }
  }

  function fillGroupSelect(select, firstLabel, firstValue = "") {
    const value = select.value; select.replaceChildren(); const first = makeElement("option", "", firstLabel); first.value = firstValue; select.append(first);
    for (const group of libraryState.groups) { const option = makeElement("option", "", group.name); option.value = group.id; select.append(option); }
    if ([...select.options].some(option => option.value === value)) select.value = value;
  }

  function renderGroupChoices() {
    const filter = $("#profile-group-filter"); fillGroupSelect(filter, "All groups", "all"); const ungrouped = makeElement("option", "", "Ungrouped"); ungrouped.value = "ungrouped"; filter.append(ungrouped); filter.value = [...filter.options].some(option => option.value === libraryState.groupFilter) ? libraryState.groupFilter : "all"; libraryState.groupFilter = filter.value;
    fillGroupSelect($("#batch-group"), "Ungrouped"); fillGroupSelect($("#live-group-filter"), "All groups", "all"); const liveUngrouped = makeElement("option", "", "Ungrouped"); liveUngrouped.value = "ungrouped"; $("#live-group-filter").append(liveUngrouped); $("#live-group-filter").value = libraryState.groupFilter;
  }

  function updateLibrarySelection() {
    text($("#selected-profile-count"), `${libraryState.selected.size} selected`); $("#batch-submit").disabled = libraryState.selected.size === 0 || libraryState.batchBusy;
    const filtered = filteredProfiles(), selectedCount = filtered.filter(profile => libraryState.selected.has(profileId(profile))).length;
    $("#select-all-profiles").checked = filtered.length > 0 && selectedCount === filtered.length; $("#select-all-profiles").indeterminate = selectedCount > 0 && selectedCount < filtered.length;
  }

  function addBookmarkRow(bookmark = {}) {
    const row = makeElement("div", "bookmark-row"); row.dataset.bookmarkRow = "";
    const title = makeElement("input", ""); title.type = "text"; title.placeholder = "Bookmark title"; title.value = bookmark.title || ""; title.setAttribute("aria-label", "Bookmark title"); title.dataset.bookmarkTitle = ""; title.maxLength = 120;
    const url = makeElement("input", ""); url.type = "url"; url.placeholder = "https://example.com"; url.value = bookmark.url || ""; url.setAttribute("aria-label", "Bookmark address"); url.dataset.bookmarkUrl = ""; url.autocomplete = "off";
    const remove = makeElement("button", "icon-button", "×"); remove.type = "button"; remove.setAttribute("aria-label", "Remove bookmark"); remove.addEventListener("click", () => row.remove()); row.append(title, url, remove); $("#bookmark-rows").append(row);
  }

  async function openMetadata(id) {
    const profile = getProfile(id); if (!profile) return; libraryState.metadataId = id;
    const form = $("#metadata-form"); form.reset(); form.elements.name.value = profile.name || id; $("#bookmark-rows").replaceChildren(); text($("#metadata-title"), `Organize ${profile.name || "profile"}`); text($("#metadata-error"), "Reading profile details…"); $("#metadata-submit").disabled = true; $("#metadata-dialog").showModal();
    try { const result = await api(`library/profiles/${encodeURIComponent(id)}`); if (libraryState.metadataId !== id) return; const metadata = result.metadata || {}; workspaceUi.bookmarks.set(id, Array.isArray(metadata.bookmarks) ? metadata.bookmarks : []); if (Array.isArray(result.groups)) libraryState.groups = result.groups; fillGroupSelect(form.elements.groupId, "Ungrouped"); form.elements.groupId.value = metadata.groupId || ""; form.elements.tags.value = (metadata.tags || []).join(", "); form.elements.notes.value = metadata.notes || ""; for (const bookmark of metadata.bookmarks || []) addBookmarkRow(bookmark); text($("#metadata-error"), ""); $("#metadata-submit").disabled = false; }
    catch (error) { text($("#metadata-error"), errorMessage(error)); }
  }

  function openProfileCopy(id) { const profile = getProfile(id); if (!profile) return; libraryState.copyId = id; $("#copy-profile-form").reset(); $("#copy-profile-form").elements.name.value = `${profile.name || "Profile"} copy`.slice(0, 80); text($("#copy-profile-error"), ""); $("#copy-profile-dialog").showModal(); }

  function openGroups() { const form = $("#groups-form"); form.reset(); fillGroupSelect(form.elements.id, "Create a new group"); form.elements.id.value = ""; form.elements.name.value = ""; text($("#groups-error"), ""); text($("#group-save"), "Create group"); $("#group-delete").disabled = true; $("#groups-dialog").showModal(); }

  async function runBatch() {
    const ids = [...libraryState.selected].filter(id => getProfile(id)); if (!ids.length || libraryState.batchBusy) return;
    const action = $("#batch-action").value, base = { action: action === "resume" ? "pause" : action === "group" ? "metadata" : action };
    if (["manual", "pause", "resume"].includes(action)) base.enabled = action !== "resume";
    if (action === "network") { base.networkMode = $("#batch-network-mode").value; if (base.networkMode === "proxy" && $("#batch-proxy").value.trim()) base.proxy = $("#batch-proxy").value.trim(); }
    if (action === "group") base.metadata = { groupId: $("#batch-group").value || null };
    libraryState.batchBusy = true; updateLibrarySelection(); $("#batch-results").hidden = false; $("#batch-results").replaceChildren(); text($("#library-error"), ""); const allResults = [];
    try {
      for (let index = 0; index < ids.length; index += 32) {
        text($("#batch-submit"), `${Math.min(index + 32, ids.length)} / ${ids.length}…`);
        const result = await api("batch", { ...base, profileIds: ids.slice(index, index + 32) });
        if (!Array.isArray(result.results)) throw new Error("The batch response is incomplete. Refresh profiles before retrying."); allResults.push(...result.results);
      }
      const succeeded = allResults.filter(item => item.ok).length; $("#batch-results").append(makeElement("strong", "", `${succeeded} succeeded · ${allResults.length - succeeded} failed`));
      for (const result of allResults.filter(item => !item.ok)) $("#batch-results").append(makeElement("p", "", `${getProfile(result.profileId)?.name || result.profileId}: ${result.error || "The action was not completed."}`));
      $("#batch-proxy").value = ""; if (action === "group") await loadLibrary();
    } catch (error) { text($("#library-error"), `${allResults.length} profile results received before this request failed. ${errorMessage(error)}`); }
    finally { libraryState.batchBusy = false; text($("#batch-submit"), "Apply to selected"); updateLibrarySelection(); }
  }

  function browserError(message = "") { text($("#browser-error"), message); $("#browser-error").hidden = !message; }

  function applyBrowserState(browser, fromHttp = false) {
    if (!browser || typeof browser.profileId !== "string" || !Array.isArray(browser.tabs)) return;
    const previous = state.browserStates.get(browser.profileId);
    const tabs = browser.tabs.slice(0, 24).filter(tab => tab && typeof tab.id === "string").map(tab => {
      let url = typeof tab.url === "string" ? tab.url : "";
      if (!fromHttp) {
        const old = previous?.tabs.find(item => item.id === tab.id);
        try { if (old?.url) { const parsed = new URL(old.url), origin = ["chrome-extension:", "moz-extension:"].includes(parsed.protocol) ? `${parsed.protocol}//${parsed.host}` : parsed.origin; if (origin + parsed.pathname === url) url = old.url; } } catch { /* Keep the redacted server URL. */ }
      }
      return { ...tab, title: String(tab.title || "New tab"), url };
    });
    state.browserStates.set(browser.profileId, { ...browser, tabs });
    const tile = state.tiles.get(browser.profileId), address = tile && $(".tile-address", tile); if (address && document.activeElement !== address) address.value = tabs.find(tab => tab.id === browser.activeTabId)?.url || "";
    if (state.view === "browser" && state.browserProfileId === browser.profileId) renderBrowserChrome();
  }

  async function loadBrowserState(id) {
    if (!getProfile(id) || !isRunning(getProfile(id)) || state.browserBusy.has(id) || state.browserStopBusy.has(id)) return;
    state.browserBusy.add(id); renderBrowserChrome(); browserError("");
    try { const result = await api(profilePath(id, "browser")); applyBrowserState(result.browser, true); }
    catch (error) { if (state.browserProfileId === id) browserError(errorMessage(error)); }
    finally { state.browserBusy.delete(id); if (state.browserProfileId === id) renderBrowserChrome(); }
  }

  async function openProfileBrowser(id) {
    const profile = getProfile(id); if (!profile) return;
    workspaceUi.lastFocused = id; state.browserProfileId = id; setView("browser"); browserError("");
    await loadBrowserState(id);
  }

  function returnToGrid() { state.browserProfileId = null; setView("live"); }

  function renderBrowserChrome() {
    if (state.view !== "browser") return;
    const id = state.browserProfileId, profile = getProfile(id); if (!profile) return;
    const browser = state.browserStates.get(id), active = browser?.tabs.find(tab => tab.id === browser.activeTabId);
    const running = isRunning(profile), controlling = profileRole(profile) !== "follower", stopping = state.browserStopBusy.has(id), busy = state.browserBusy.has(id) || stopping || state.busy.has(id);
    text($("#view-title"), profileRole(profile) === "admin" ? "Full Admin View" : "Profile browser");
    text($("#browser-profile-name"), profile.name || id);
    text($("#browser-role-badge"), profileRole(profile) === "admin" ? "Admin" : profileRole(profile) === "follower" ? "Follower" : "Manual");
    text($("#browser-profile-meta"), `${engineLabel(profile)} · ${profileRole(profile)} · ${profile.networkSummary || "Network: " + (profile.networkMode || "direct")}`);
    $("#browser-workspace").dataset.role = profileRole(profile);
    renderFollowerStrip();
    const tabs = $("#browser-tabs");
    const signature = JSON.stringify([browser?.activeTabId, browser?.tabs.map(tab => [tab.id, tab.title, tab.url, tab.loading]), busy, controlling]);
    if (tabs._signature !== signature) {
      tabs._signature = signature; tabs.replaceChildren();
      if (!browser?.tabs.length) { const empty = document.createElement("span"); empty.className = "browser-tabs-empty"; empty.textContent = running ? busy ? "Reading browser tabs…" : "No browser tab is available" : "Start this profile to browse"; tabs.append(empty); }
      for (const tab of browser?.tabs || []) {
        const item = document.createElement("div"); item.className = `browser-tab ${tab.id === browser.activeTabId ? "active" : ""}`;
        const select = document.createElement("button"); select.type = "button"; select.dataset.tabId = tab.id; select.setAttribute("role", "tab"); select.setAttribute("aria-selected", String(tab.id === browser.activeTabId)); select.tabIndex = tab.id === browser.activeTabId ? 0 : -1; select.disabled = busy || !controlling; select.title = tab.title || tab.url || "New tab"; select.textContent = `${tab.loading ? "↻ " : ""}${tab.title || "New tab"}`;
        const close = document.createElement("button"); close.type = "button"; close.className = "browser-tab-close"; close.dataset.closeTabId = tab.id; close.setAttribute("aria-label", `Close ${tab.title || "tab"}`); close.title = "Close tab"; close.textContent = "×"; close.disabled = busy || !controlling;
        item.append(select, close); tabs.append(item);
      }
    }
    const address = $("#browser-address"); if (document.activeElement !== address) address.value = active?.url || "";
    address.disabled = !running || !controlling || busy;
    $("#browser-go").disabled = !running || !controlling || busy;
    $("#browser-type-text").disabled = !running || !controlling || busy || !state.tiles.get(id)?._frameHealthy || !state.connected;
    $$("[data-browser-action]").forEach(button => {
      const action = button.dataset.browserAction;
      button.disabled = !running || !controlling || (action === "stop" ? stopping || state.busy.has(id) || (!state.browserBusy.has(id) && browser?.loading === false) : busy) || (action === "new-tab" && (browser?.tabs.length || 0) >= 24) || (action === "back" && browser?.canGoBack === false) || (action === "forward" && browser?.canGoForward === false);
    });
    renderBookmarks();
    const manual = $("#browser-take-manual"); manual.hidden = !running || controlling; manual.disabled = busy;
    text($("#browser-control-status"), !running ? "Browser stopped. Start the profile to open its isolated browser." : !controlling ? "Follower view · switch to manual to manage tabs or browse independently." : profileRole(profile) === "admin" ? `Admin · ${(workspaceUi.sync.followerIds || []).length} followers assigned. Eligible browser actions follow this Admin.` : "Direct manual control · inputs stay on this profile.");
    $("#browser-page-loading").hidden = !browser?.loading && !busy;
    text($("#browser-page-loading"), busy ? "Updating browser…" : "Loading page…");
    let start = $("#browser-start"); if (!start) { start = document.createElement("button"); start.id = "browser-start"; start.className = "button primary"; start.textContent = "Start profile"; start.addEventListener("click", async () => { await mutateProfile(state.browserProfileId, "start"); await loadBrowserState(state.browserProfileId); }); $("#browser-permission-bar").append(start); }
    start.hidden = running; start.disabled = busy || ["starting", "stopping"].includes(profile.status);
    if (browser?.error) browserError(browser.error);
  }

  function browserUrl(value) {
    const input = value.trim(); if (!input) throw new Error("Enter a website address.");
    let url; try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`); } catch { throw new Error("Enter a valid HTTPS address."); }
    const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password) throw new Error("Use an HTTPS address without URL credentials. HTTP is available only for local loopback pages.");
    return url.href;
  }

  async function browserAction(action, extra = {}, targetId = state.browserProfileId) {
    const id = targetId, profile = getProfile(id);
    const stopping = action === "stop";
    if (!profile || !isRunning(profile) || profileRole(profile) === "follower" || state.busy.has(id) || state.browserStopBusy.has(id) || (!stopping && state.browserBusy.has(id))) return;
    // Stop must reach the browser while a navigation request is still pending.
    // Each request clears only its own busy state, whichever completes first.
    const pending = stopping ? state.browserStopBusy : state.browserBusy;
    pending.add(id); renderBrowserChrome(); browserError("");
    try { const result = await api(profilePath(id, "browser"), { action, ...extra }); applyBrowserState(result.browser, true); }
    catch (error) { if (state.browserProfileId === id) browserError(errorMessage(error)); else showError(error); }
    finally { pending.delete(id); if (state.browserProfileId === id) renderBrowserChrome(); }
  }

  async function exitWorkspaceFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    $("#browser-workspace").classList.remove("workspace-fullscreen"); $("#browser-fullscreen").setAttribute("aria-pressed", "false"); text($("#browser-fullscreen"), "Fullscreen");
  }

  async function toggleWorkspaceFullscreen() {
    const panel = $("#browser-workspace");
    if (document.fullscreenElement || panel.classList.contains("workspace-fullscreen")) { await exitWorkspaceFullscreen(); return; }
    try { if (panel.requestFullscreen) await panel.requestFullscreen(); else panel.classList.add("workspace-fullscreen"); }
    catch { panel.classList.add("workspace-fullscreen"); }
    $("#browser-fullscreen").setAttribute("aria-pressed", "true"); text($("#browser-fullscreen"), "Exit fullscreen");
  }

  function profileStopped(profile) { return profile && !isRunning(profile) && !["starting", "stopping"].includes(profile.status); }

  function desktopScreen(widthValue, heightValue) {
    const width = Number(widthValue), height = Number(heightValue);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 320 || width > 4096 || height < 200 || height > 4096 || width * height > 4096 * 2160) throw new Error("Use a whole-number viewport from 320 × 200 to 4,096 px per side, with at most 8,847,360 pixels.");
    return { width, height };
  }

  function updateCreateScreenFields() {
    const form = $("#create-form"), custom = [...form.elements.resolution.selectedOptions].some(option => option.value === "custom");
    $("#create-custom-screen").hidden = !custom;
    for (const name of ["screenWidth", "screenHeight"]) { form.elements[name].disabled = !custom; form.elements[name].required = custom; }
  }

  function updateProfileSettingsAvailability() {
    const profile = getProfile(state.settingsProfileId); if (!profile) { $("#profile-settings-dialog").close(); return; }
    const stopped = profileStopped(profile) && profile.managementAvailable !== false;
    $("#network-settings-fields").disabled = !stopped || state.busy.has(profileId(profile)); $("#network-save").disabled = !stopped || state.busy.has(profileId(profile));
    $("#screen-settings-fields").disabled = !stopped || state.busy.has(profileId(profile)); $("#screen-save").disabled = !stopped || state.busy.has(profileId(profile));
    text($("#screen-stored"), Number.isSafeInteger(profile.screenWidth) && Number.isSafeInteger(profile.screenHeight) ? `Stored browser viewport: ${profile.screenWidth.toLocaleString()} × ${profile.screenHeight.toLocaleString()} px` : "Stored browser viewport is unavailable.");
    $("#profile-delete-button").disabled = !stopped || state.busy.has(profileId(profile));
    const cookieAllowed = isRunning(profile) && profileRole(profile) !== "follower";
    for (const selector of ["#cookie-export", "#cookie-show-import"]) $(selector).disabled = !cookieAllowed;
    $("#cookie-clear").disabled = !cookieAllowed || !$("#cookie-form").elements.confirmClear.checked;
    $$("[data-assignment-toggle],[data-assignment-remove]", $("#profile-extension-list")).forEach(button => { button.disabled = !stopped || state.busy.has(profileId(profile)); });
    text($("#network-stopped-notice"), stopped ? "Network and extension changes apply the next time this profile starts." : "Stop this profile before changing its network or extension assignments.");
    text($("#network-stored"), `Stored route: ${profile.networkSummary || profile.networkMode || "direct"}${profile.proxy && profile.networkMode !== "proxy" ? " · a proxy endpoint is saved for later use" : ""}`);
  }

  function updateProxyFields() {
    const form = $("#profile-settings-form"), profile = getProfile(state.settingsProfileId), proxyMode = form.elements.networkMode.value === "proxy";
    $("#replace-proxy-label").hidden = !proxyMode || !profile?.proxy;
    const replacing = proxyMode && (!profile?.proxy || form.elements.replaceProxy.checked);
    $("#profile-proxy-fields").hidden = !replacing;
    for (const name of ["proxyType", "proxyPort", "proxyHost", "proxyUsername", "proxyPassword"]) form.elements[name].disabled = !replacing || !profileStopped(profile);
    form.elements.proxyHost.required = replacing; form.elements.proxyPort.required = replacing;
  }

  async function openProfileSettings(id) {
    const profile = getProfile(id); if (!profile) return;
    state.settingsProfileId = id; const form = $("#profile-settings-form");
    form.reset(); form.elements.networkMode.value = profile.networkMode || (profile.proxy ? "proxy" : "direct");
    form.elements.proxyType.value = profile.proxy?.type === "socks5" ? "socks5" : "http"; form.elements.proxyHost.value = profile.proxy?.host || ""; form.elements.proxyPort.value = profile.proxy?.port || "";
    const screenForm = $("#profile-screen-form"), screenPreset = `${profile.screenWidth}x${profile.screenHeight}`;
    screenForm.elements.width.value = profile.screenWidth ?? ""; screenForm.elements.height.value = profile.screenHeight ?? "";
    screenForm.elements.screenPreset.value = [...screenForm.elements.screenPreset.options].some(option => option.value === screenPreset) ? screenPreset : "custom"; text($("#screen-error"), "");
    text($("#profile-settings-title"), profile.name || id); text($("#profile-settings-identity"), `${engineLabel(profile)} · ${id}`); text($("#network-error"), "");
    updateProfileSettingsAvailability(); updateProxyFields(); $("#profile-settings-dialog").showModal();
    const cookieForm = $("#cookie-form"); cookieForm.reset(); $("#cookie-import-fields").hidden = true; text($("#cookie-status"), "");
    const active = state.browserStates.get(id)?.tabs.find(tab => tab.id === state.browserStates.get(id)?.activeTabId);
    try { cookieForm.elements.origin.value = new URL(active?.url || profile.url || profile.urls?.[0] || profile.origin).origin; } catch { cookieForm.elements.origin.value = ""; }
    updateProfileSettingsAvailability();
    loadResourcePolicy(id);
    if (profile.managementAvailable !== false) await loadProfileExtensions(id);
    else { $("#profile-extension-list").replaceChildren(); text($("#profile-extensions-error"), "Manage this Cloud profile’s extensions and identity in Profiles."); }
  }

  function openDeleteProfile(id) {
    const profile = getProfile(id); if (!profile || !profileStopped(profile)) return;
    state.deleteProfileId = id; $("#delete-form").reset(); $("#delete-submit").disabled = true; text($("#delete-error"), "");
    text($("#delete-profile-copy"), `${profile.name || id} · ${id}`);
    const label = $("#delete-confirm-label"); label.firstChild.textContent = `Type this exact profile ID: ${id}`; $("#delete-form").elements.confirmation.placeholder = id;
    $("#delete-dialog").showModal();
  }

  function makeElement(tag, className, value) { const element = document.createElement(tag); if (className) element.className = className; if (value !== undefined) element.textContent = String(value); return element; }

  function refreshActiveView() { if (state.view === "profiles") loadLibrary(); else if (state.view === "extensions") loadExtensions(); else if (state.view === "proxies") loadProxies(); else if (state.view === "automation") loadAutomation(true); else if (state.view === "browser") loadBrowserState(state.browserProfileId); }

  async function loadProxies() {
    if (!state.token || proxyState.loading) return; proxyState.loading = true; text($("#proxy-library-error"), "");
    try { const result = await api("proxies"); if (!Array.isArray(result.proxies)) throw new Error("The proxy library response is incomplete."); proxyState.entries = result.proxies; renderProxyLibrary(); }
    catch (error) { text($("#proxy-library-error"), errorMessage(error)); }
    finally { proxyState.loading = false; }
  }

  function renderProxyLibrary() {
    const library = $("#proxy-library"); library.replaceChildren(); $("#proxy-library-empty").hidden = proxyState.entries.length !== 0;
    for (const proxy of proxyState.entries) {
      const card = makeElement("article", "proxy-card"); card.dataset.proxyId = proxy.id;
      card.append(makeElement("h3", "", proxy.alias), makeElement("p", "proxy-endpoint", `${proxy.type}://${proxy.host}:${proxy.port}`), makeElement("p", "profile-extension-empty", `${proxy.group || "Ungrouped"} · ${proxy.authenticated ? "Credentials saved privately" : "No proxy credentials"}`));
      const buttons = makeElement("div", "proxy-card-actions");
      for (const [action, label] of [["assign", "Assign to profiles"], ["edit", "Edit"], ["delete", "Remove"]]) { const button = makeElement("button", `button ${action === "delete" ? "danger" : "subtle"}`, label); button.type = "button"; button.dataset.proxyAction = action; button.dataset.proxyId = proxy.id; buttons.append(button); }
      card.append(buttons); library.append(card);
    }
  }

  function openProxyEditor(id = null) {
    proxyState.editId = id; const proxy = proxyState.entries.find(item => item.id === id), form = $("#proxy-form"); form.reset(); form.elements.alias.value = proxy?.alias || ""; form.elements.group.value = proxy?.group || ""; form.elements.proxy.value = ""; form.elements.proxy.required = !proxy;
    text($("#proxy-title"), proxy ? "Edit saved proxy" : "Save proxy endpoint"); text($("#proxy-endpoint-help"), proxy ? "Leave the endpoint blank to keep the stored address and credentials. Entering a replacement overwrites them." : "HTTP or SOCKS5 URL. Credentials are saved privately and never returned to this form."); text($("#proxy-form-error"), ""); $("#proxy-dialog").showModal();
  }

  function openProxyAssignment(id) {
    const proxy = proxyState.entries.find(item => item.id === id); if (!proxy) return; proxyState.assignId = id; const form = $("#proxy-assign-form"); form.reset(); form.elements.profileIds.replaceChildren();
    for (const profile of state.snapshot.profiles) { const option = makeElement("option", "", `${profile.name || profileId(profile)}${profileStopped(profile) ? "" : " · stop first"}`); option.value = profileId(profile); option.disabled = !profileStopped(profile); form.elements.profileIds.append(option); }
    text($("#proxy-assign-copy"), `${proxy.alias} · ${proxy.type}://${proxy.host}:${proxy.port}`); text($("#proxy-assign-error"), ""); $("#proxy-assign-submit").disabled = !state.snapshot.profiles.some(profileStopped); $("#proxy-assign-dialog").showModal();
  }

  function workflowName(id) { return automationState.workflows.find(item => item.id === id)?.name || id; }
  function localTime(value) { return typeof value === "number" && value > 0 && value < 8.64e15 ? new Date(value).toLocaleString() : "—"; }
  function canRunWorkflow(profile) { return isRunning(profile) && profileRole(profile) === "manual" && (!profile.overBudget || !profile.budgetAction || profile.budgetAction === "notify"); }

  function scheduleAutomationRefresh() { clearTimeout(automationState.timer); if (state.view === "automation" && !document.hidden && !state.disposed) automationState.timer = setTimeout(() => loadAutomation(false), 3000); }

  async function loadAutomation(full = false) {
    if (!state.token || state.disposed || document.hidden || state.view !== "automation") return;
    if (automationState.loading) { if (full) automationState.needsFull = true; return; }
    automationState.loading = true;
    $("#automation-view").setAttribute("aria-busy", "true");
    if (!$("#workflow-jobs")._signature) $("#workflow-jobs").replaceChildren(makeElement("p", "profile-extension-empty", "Reading local workflow jobs…"));
    try {
      const [definitions, jobs, schedules] = await Promise.all([full ? api("workflows") : Promise.resolve(null), api("jobs"), api("schedules")]);
      if (definitions) { automationState.workflows = definitions.workflows || []; automationState.templates = definitions.templates || []; text($("#workflow-storage-warning"), definitions.storageWarning || ""); $("#workflow-storage-warning").hidden = !definitions.storageWarning; }
      automationState.jobs = jobs.jobs || []; automationState.schedules = schedules.schedules || []; renderAutomation();
    } catch (error) { text($("#automation-error"), errorMessage(error)); }
    finally { automationState.loading = false; $("#automation-view").setAttribute("aria-busy", "false"); if (automationState.needsFull) { automationState.needsFull = false; loadAutomation(true); } else scheduleAutomationRefresh(); }
  }

  function renderAutomation() {
    const library = $("#workflow-library"), templates = $("#workflow-templates"), signature = JSON.stringify([automationState.workflows, automationState.templates]);
    if (library._signature !== signature) {
      library._signature = signature; library.replaceChildren(); templates.replaceChildren();
      for (const template of automationState.templates) { const button = makeElement("button", "workflow-template-button", `Use template: ${template.document?.workflow?.name || template.key}`); button.type = "button"; button.dataset.workflowTemplate = template.key; button.title = template.description || "Reviewed local read-only template"; templates.append(button); }
      for (const workflow of automationState.workflows) {
        const card = makeElement("article", "workflow-card"); card.append(makeElement("h3", "", workflow.name), makeElement("p", "profile-extension-empty", `${workflow.steps.length} read-only steps · updated ${localTime(workflow.updatedAt)}`));
        const actions = makeElement("div", "workflow-card-actions"); for (const [action, label] of [["run", "Run"], ["edit", "Edit JSON"], ["export", "Export"], ["delete", "Remove"]]) { const button = makeElement("button", `button ${action === "run" ? "primary" : action === "delete" ? "danger" : "subtle"}`, label); button.type = "button"; button.dataset.workflowAction = action; button.dataset.workflowId = workflow.id; actions.append(button); } card.append(actions); library.append(card);
      }
    }
    $("#workflow-empty").hidden = automationState.workflows.length !== 0; $("#schedule-create-button").disabled = !automationState.workflows.length || !state.snapshot.profiles.length;
    const jobs = $("#workflow-jobs"), jobSignature = JSON.stringify(automationState.jobs);
    if (jobs._signature !== jobSignature) {
      jobs._signature = jobSignature; jobs.replaceChildren();
      if (!automationState.jobs.length) jobs.append(makeElement("p", "profile-extension-empty", "No jobs have run on this device."));
      for (const job of automationState.jobs) {
        const row = makeElement("article", "workflow-job"); row.dataset.jobId = job.id;
        const summary = makeElement("div", "workflow-job-summary"); summary.append(makeElement("strong", "", workflowName(job.workflowId)), makeElement("span", `badge ${job.status === "completed" ? "sync" : ["queued", "running"].includes(job.status) ? "manual" : "stopped"}`, job.status));
        row.append(summary, makeElement("p", "profile-extension-empty", `${getProfile(job.profileId)?.name || job.profileId} · ${job.stepIndex} / ${job.stepCount} steps · ${job.trigger} · ${localTime(job.createdAt)}`));
        const progress = makeElement("progress", "workflow-job-progress"); progress.max = job.stepCount || 1; progress.value = job.stepIndex || 0; progress.setAttribute("aria-label", "Completed workflow steps"); row.append(progress);
        if (job.error) row.append(makeElement("p", "extension-warning", job.error));
        const actions = makeElement("div", "workflow-card-actions");
        if (["queued", "running"].includes(job.status)) { const cancel = makeElement("button", "button danger", "Cancel job"); cancel.type = "button"; cancel.dataset.jobCancel = job.id; actions.append(cancel); }
        for (const format of ["json", "csv"]) { const output = makeElement("button", "button subtle", `Download ${format.toUpperCase()}`); output.type = "button"; output.dataset.jobOutput = job.id; output.dataset.format = format; output.disabled = job.status !== "completed" || !job.outputsAvailable; actions.append(output); } row.append(actions); jobs.append(row);
      }
    }
    const schedules = $("#workflow-schedules"), scheduleSignature = JSON.stringify(automationState.schedules);
    if (schedules._signature !== scheduleSignature) {
      schedules._signature = scheduleSignature; schedules.replaceChildren();
      if (!automationState.schedules.length) schedules.append(makeElement("p", "profile-extension-empty", "No local schedules saved."));
      for (const schedule of automationState.schedules) {
        const row = makeElement("article", "workflow-schedule"), info = makeElement("div", "");
        info.append(makeElement("strong", "", workflowName(schedule.workflowId)), makeElement("p", "profile-extension-empty", `${getProfile(schedule.profileId)?.name || schedule.profileId} · ${schedule.kind === "interval" ? "every " + number(schedule.intervalMs / 60000, 1) + " minutes" : "once"} · ${schedule.enabled ? "next " + localTime(schedule.nextRunAt) : "disabled"}${schedule.lastResult ? " · last " + schedule.lastResult : ""}`)); row.append(info);
        const actions = makeElement("div", "workflow-card-actions"); const toggle = makeElement("button", "button subtle", schedule.enabled ? "Disable" : "Enable"); toggle.type = "button"; toggle.dataset.scheduleToggle = schedule.id; const remove = makeElement("button", "button danger", "Remove"); remove.type = "button"; remove.dataset.scheduleDelete = schedule.id; actions.append(toggle, remove); row.append(actions); schedules.append(row);
      }
    }
  }

  function openWorkflowEditor(id = null, template) {
    const workflow = id ? automationState.workflows.find(item => item.id === id) : template?.workflow;
    automationState.editId = id; const form = $("#workflow-form"); form.reset(); form.elements.name.value = workflow?.name || "New read-only workflow"; form.elements.steps.value = JSON.stringify(workflow?.steps || [{ kind: "extract", source: "title", field: "title" }], null, 2); text($("#workflow-form-error"), ""); $("#workflow-dialog").showModal();
  }

  function fillProfileOptions(select, predicate, includeUnavailable = true) {
    select.replaceChildren(); for (const profile of state.snapshot.profiles) { const eligible = predicate(profile); if (!eligible && !includeUnavailable) continue; const option = makeElement("option", "", `${profile.name || profileId(profile)}${eligible ? "" : " · running manual control required"}`); option.value = profileId(profile); option.disabled = !eligible; select.append(option); }
  }

  function openWorkflowRun(id) {
    automationState.runId = id; const form = $("#workflow-run-form"); form.reset(); fillProfileOptions(form.elements.profileIds, canRunWorkflow); text($("#workflow-run-copy"), workflowName(id)); text($("#workflow-run-error"), ""); $("#workflow-run-submit").disabled = !state.snapshot.profiles.some(canRunWorkflow); $("#workflow-run-dialog").showModal();
  }

  function openScheduleEditor() {
    const form = $("#schedule-form"); form.reset(); form.elements.workflowId.replaceChildren(); for (const workflow of automationState.workflows) { const option = makeElement("option", "", workflow.name); option.value = workflow.id; form.elements.workflowId.append(option); }
    fillProfileOptions(form.elements.profileId, () => true); form.elements.kind.value = "once"; $("#schedule-time-label").hidden = false; $("#schedule-interval-label").hidden = true; form.elements.runAt.required = true; const future = new Date(Date.now() + 5 * 60000); future.setMinutes(future.getMinutes() - future.getTimezoneOffset()); form.elements.runAt.value = future.toISOString().slice(0, 16); text($("#schedule-error"), ""); $("#schedule-dialog").showModal();
  }

  function downloadContent(content, filename, mime = "application/json") { const blob = new Blob([content], { type: mime }), url = URL.createObjectURL(blob), anchor = makeElement("a", ""); anchor.href = url; anchor.download = filename; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); }

  function permissionDetails(extension, parent) {
    const groups = [["Browser permissions", extension.permissions], ["Requested websites", extension.hostPermissions], ["Optional browser permissions", extension.optionalPermissions], ["Optional websites", extension.optionalHostPermissions]];
    for (const [label, values] of groups) if (Array.isArray(values) && values.length) {
      parent.append(makeElement("h4", "extension-permission-heading", label)); const list = makeElement("ul", "permission-list");
      for (const value of values) list.append(makeElement("li", "", value)); parent.append(list);
    }
    for (const warning of extension.warnings || []) parent.append(makeElement("p", "extension-warning", warning));
  }

  function extensionDigest(extension) { const digest = makeElement("div", "extension-digest"); digest.append(makeElement("strong", "", "PACKAGE SHA-256"), document.createTextNode(extension.sha256 || "Unavailable")); return digest; }

  async function loadExtensions() {
    if (!state.token || state.extensionsLoading) return;
    state.extensionsLoading = true; text($("#extensions-error"), ""); renderExtensionLibrary();
    try { const result = await api("extensions"); if (!Array.isArray(result.extensions)) throw new Error("The extension library response is incomplete."); state.extensions = result.extensions; }
    catch (error) { text($("#extensions-error"), errorMessage(error)); }
    finally { state.extensionsLoading = false; renderExtensionLibrary(); }
  }

  function renderExtensionLibrary() {
    const library = $("#extension-library"); library.replaceChildren();
    $("#extensions-empty").hidden = state.extensionsLoading || state.extensions.length > 0;
    if (state.extensionsLoading) { library.append(makeElement("p", "profile-extension-empty", "Reading the local extension library…")); return; }
    for (const extension of state.extensions) {
      const card = makeElement("article", "extension-card"); card.dataset.extensionId = extension.id;
      const heading = makeElement("div", "extension-card-heading"); heading.append(makeElement("h3", "", extension.name), makeElement("span", "badge pending", extension.engine === "firefox" ? "Firefox" : "Chromium")); card.append(heading);
      card.append(makeElement("p", "extension-card-meta", `Version ${extension.version || "unspecified"} · ${extension.sourceFormat || "package"} · ${number(finite(extension.sizeBytes))} bytes · ${extension.assignedProfiles || 0} assigned profiles`));
      card.append(extensionDigest(extension));
      const permissions = makeElement("details", "extension-permissions-preview"); permissions.append(makeElement("summary", "extension-permission-heading", "View permissions and package warnings")); permissionDetails(extension, permissions); card.append(permissions);
      const actions = makeElement("div", "extension-card-actions"), review = makeElement("button", "button subtle", "Review & assign"); review.type = "button"; review.dataset.extensionReview = extension.id;
      const remove = makeElement("button", "button danger", "Remove import"); remove.type = "button"; remove.dataset.extensionRemove = extension.id; remove.disabled = Number(extension.assignedProfiles) > 0; remove.title = remove.disabled ? "Remove all profile assignments before removing this import" : "Remove this unassigned package from the local library";
      actions.append(review, remove); card.append(actions); library.append(card);
    }
  }

  async function loadProfileExtensions(id) {
    text($("#profile-extensions-error"), ""); $("#profile-extension-list").replaceChildren(makeElement("p", "profile-extension-empty", "Reading assigned extensions…"));
    try { const result = await api(profilePath(id, "extensions")); state.assignments.set(id, Array.isArray(result.assignments) ? result.assignments : []); if (Array.isArray(result.extensions)) state.extensions = result.extensions; if (state.settingsProfileId === id) renderProfileExtensions(id); }
    catch (error) { if (state.settingsProfileId === id) { $("#profile-extension-list").replaceChildren(); text($("#profile-extensions-error"), errorMessage(error)); } }
  }

  function renderProfileExtensions(id) {
    const profile = getProfile(id), list = $("#profile-extension-list"), assignments = state.assignments.get(id) || []; list.replaceChildren();
    if (!assignments.length) { list.append(makeElement("p", "profile-extension-empty", "No extensions assigned. Open the library to import or review a compatible package.")); return; }
    for (const assignment of assignments) {
      const extension = state.extensions.find(item => item.id === assignment.extensionId), row = makeElement("div", "profile-extension-row"), info = makeElement("div", "profile-extension-info");
      info.append(makeElement("strong", "", extension?.name || assignment.extensionId), makeElement("small", "", `${assignment.enabled ? "Enabled for next start" : "Disabled"} · ${assignment.siteAccess === "sites" ? (assignment.origins || []).join(", ") || "No websites selected" : "All requested websites"}`));
      const toggle = makeElement("button", "button subtle", assignment.enabled ? "Disable" : "Review & enable"); toggle.type = "button"; toggle.disabled = !profileStopped(profile); toggle.dataset.assignmentToggle = assignment.extensionId; toggle.dataset.profileId = id;
      const remove = makeElement("button", "button danger", "Unassign"); remove.type = "button"; remove.disabled = !profileStopped(profile); remove.dataset.assignmentRemove = assignment.extensionId; remove.dataset.profileId = id;
      row.append(info, toggle, remove); list.append(row);
      for (const kind of ["popup", "options"]) if (assignment.enabled && extension?.ui?.[kind]) { const open = makeElement("button", "button subtle", kind === "popup" ? "Open popup" : "Options"); open.type = "button"; open.dataset.extensionOpen = assignment.extensionId; open.dataset.extensionKind = kind; open.dataset.profileId = id; open.disabled = !isRunning(profile) || profileRole(profile) === "follower"; row.append(open); }
    }
  }

  function openExtensionImport() { $("#import-extension-form").reset(); text($("#import-extension-error"), ""); $("#import-extension-dialog").showModal(); }

  function downloadJson(documentValue, filename) {
    const blob = new Blob([JSON.stringify(documentValue, null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob), anchor = makeElement("a", "");
    anchor.href = url; anchor.download = filename; anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function cookieOperation(action) {
    const id = state.settingsProfileId, profile = getProfile(id), form = $("#cookie-form"); if (!isRunning(profile || {}) || profileRole(profile || {}) === "follower") return;
    text($("#cookie-status"), "");
    try {
      const origin = approveOrigin(form.elements.origin.value);
      if (action === "export") { const result = await api(`${profilePath(id, "cookies")}?origin=${encodeURIComponent(origin)}`); if (!Array.isArray(result.cookies)) throw new Error("The cookie response is incomplete."); downloadJson(result.cookies, `gamebrowser-${id}-cookies.json`); text($("#cookie-status"), `${result.cookies.length} cookies exported. Keep the downloaded file private.`); }
      else if (action === "clear") { if (!form.elements.confirmClear.checked) throw new Error("Confirm the cookie-clearing effect first."); const result = await api(profilePath(id, "cookies"), { action: "clear", origin }); form.elements.confirmClear.checked = false; text($("#cookie-status"), `Cookies cleared for ${origin}. Other website cookies were not changed.`); }
      else { let cookies; try { cookies = JSON.parse(form.elements.cookies.value); } catch { throw new Error("Paste a valid cookie JSON array."); } if (!Array.isArray(cookies)) throw new Error("Cookie import must be a JSON array."); await api(profilePath(id, "cookies"), { action: "import", origin, cookies }); form.elements.cookies.value = ""; form.elements.file.value = ""; text($("#cookie-status"), `${cookies.length} cookie objects imported into this profile.`); }
    } catch (error) { text($("#cookie-status"), errorMessage(error)); }
    finally { updateProfileSettingsAvailability(); }
  }

  function openExtensionReview(id, preferredProfileId) {
    const extension = state.extensions.find(item => item.id === id); if (!extension) { showError("Refresh the extension library before reviewing this package."); return; }
    state.reviewedExtensionId = id; state.reviewedExtensionSha = extension.sha256;
    const form = $("#extension-assignment-form"); form.reset(); const details = $("#extension-review-details"); details.replaceChildren();
    details.append(makeElement("h3", "", `${extension.name} · ${extension.version || "version unspecified"}`), makeElement("p", "", `${extension.engine === "firefox" ? "Firefox add-on" : "Chromium extension"} · browser-wide permissions remain active even when website access is narrowed.`), extensionDigest(extension)); permissionDetails(extension, details);
    const select = form.elements.profileId; select.replaceChildren();
    const profiles = state.snapshot.profiles.filter(profile => profile.engine === extension.engine);
    for (const profile of profiles) { const option = makeElement("option", "", `${profile.name || profileId(profile)}${profileStopped(profile) ? "" : " · stop this profile first"}`); option.value = profileId(profile); option.disabled = !profileStopped(profile); select.append(option); }
    const available = profiles.filter(profileStopped); if (available.length) select.value = available.some(profile => profileId(profile) === preferredProfileId) ? preferredProfileId : profileId(available[0]);
    form.elements.origins.value = state.snapshot.origins.join("\n");
    const previous = state.assignments.get(select.value)?.find(item => item.extensionId === id); if (previous) { form.elements.siteAccess.value = previous.siteAccess; form.elements.origins.value = (previous.origins || []).join("\n"); }
    $("#extension-origins-label").hidden = form.elements.siteAccess.value !== "sites";
    $("#extension-assignment-submit").disabled = available.length === 0;
    text($("#extension-assignment-error"), available.length ? "" : "Create or stop a compatible profile before assigning this package.");
    $("#extension-review-dialog").showModal();
  }

  async function changeAssignment(id, extensionId, unassign = false) {
    const profile = getProfile(id); if (!profileStopped(profile)) return;
    const assignment = state.assignments.get(id)?.find(item => item.extensionId === extensionId); if (!assignment) return;
    if (!unassign && !assignment.enabled) { openExtensionReview(extensionId, id); return; }
    text($("#profile-extensions-error"), "");
    try {
      if (unassign) await api(profilePath(id, `extensions/${encodeURIComponent(extensionId)}`), {}, false, "DELETE");
      else await api(profilePath(id, "extensions"), { extensionId, enabled: false, siteAccess: assignment.siteAccess, origins: assignment.origins || [] });
      await loadProfileExtensions(id); toast(unassign ? "Extension unassigned from this profile." : "Extension disabled for this profile.");
    } catch (error) { text($("#profile-extensions-error"), errorMessage(error)); }
  }

  function openCreate() {
    if (state.snapshot.capabilities?.identityManagement === false) { location.href = manageProfilesUrl(); return; }
    const form = $("#create-form"); $("#create-error").textContent = "";
    const origins = state.snapshot.origins;
    if (origins.length && !form.elements.origin.value) form.elements.origin.value = origins[0];
    updateCreateScreenFields();
    $("#create-dialog").showModal();
  }

  function openSettings() {
    const form = $("#settings-form"); form.elements.origins.value = state.snapshot.origins.join("\n"); form.elements.pacing.value = state.snapshot.pacing === "paced" ? "paced" : "fast"; $("#settings-error").textContent = ""; $("#settings-dialog").showModal();
  }

  function approveOrigin(value) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error("Enter a valid HTTPS website origin."); }
    const localTestOrigin = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !localTestOrigin) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.hostname.includes("*")) throw new Error("Use exact HTTPS origins without paths, credentials, query strings, or wildcards. HTTP is supported only for local loopback pages.");
    return url.origin;
  }

  async function mutateProfile(id, path, extra = {}) {
    if (state.busy.has(id)) return;
    state.busy.add(id); render();
    try { const result = await api(path, { profileId: id, ...extra }); if (!result.snapshot) { const fresh = await api("snapshot"); applySnapshot(fresh.snapshot || fresh); } }
    catch (error) { showError(error); }
    finally { state.busy.delete(id); render(); }
  }

  async function onAction(event) {
    const button = event.target.closest("[data-action]"); if (!button || button.disabled) return;
    const id = button.dataset.profileId, profile = getProfile(id); if (!profile) return;
    const action = button.dataset.action;
    if (action === "browser") { await openProfileBrowser(id); return; }
    if (action === "settings") { await openProfileSettings(id); return; }
    if (action === "organize") { await openMetadata(id); return; }
    if (action === "copy") { openProfileCopy(id); return; }
    if (action === "delete") { openDeleteProfile(id); return; }
    if (action === "kill") { state.killId = id; text($("#kill-copy"), `“${profile.name || id}” will close immediately. Unsaved work may be lost.`); $("#kill-dialog").showModal(); return; }
    if (action === "navigate") { state.navigateId = id; text($("#navigate-profile"), `${profile.name || id} · ${engineLabel(profile)}`); $("#navigate-form").elements.url.value = profile.url || profile.urls?.[0] || profile.origin || ""; text($("#navigate-error"), ""); $("#navigate-dialog").showModal(); return; }
    if (action === "manual") await mutateProfile(id, "manual", { enabled: profileRole(profile) !== "manual" });
    else if (action === "pause") await mutateProfile(id, "pause", { enabled: !profile.paused });
    else if (action === "start" || action === "stop") await mutateProfile(id, action);
  }

  function applyWorkspaceVersion(version) { if ((typeof version !== "string" && typeof version !== "number") || !String(version).trim()) return; for (const label of $$(".workspace-version")) { label.hidden = false; text(label, String(version)); label.title = "Installed GameBrowser version"; } }
  function manageProfilesUrl() { return state.snapshot.capabilities?.manageProfilesUrl || "/?view=profiles"; }
  function settingsUrl() { return state.snapshot.capabilities?.settingsUrl || "/?view=settings&tab=team"; }
  function renderCapabilities() {
    const capabilities = state.snapshot.capabilities || {};
    $("#manage-profiles-link").href = manageProfilesUrl(); $("#cloud-settings-link").href = settingsUrl();
    $("#profile-management-toolbar").classList.toggle("cloud-managed", capabilities.identityManagement === false);
    if (capabilities.identityManagement === false) text($("#view-hint"), "Cloud identity and sharing are managed in Profiles");
  }
  function sortedProfiles(profiles) {
    const ranks = new Map(workspaceUi.order.map((id, i) => [id, i])), selected = new Map([...workspaceUi.selected].reverse().map((id, i) => [id, i]));
    return [...profiles].sort((left, right) => {
      const a = profileId(left), b = profileId(right);
      const adminA = a === workspaceUi.sync.adminId ? 0 : 1, adminB = b === workspaceUi.sync.adminId ? 0 : 1;
      return (selected.get(a) ?? Infinity) - (selected.get(b) ?? Infinity) || adminA - adminB || (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity) || profiles.indexOf(left) - profiles.indexOf(right);
    });
  }
  async function centralApi(path, body) {
    const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
    const result = await response.json(); if (!response.ok || result.ok === false) throw new Error(result.error || `Request failed (${response.status}).`); return result;
  }
  async function loadWorkspacePreferences() {
    if (workspaceUi.orderReady) return;
    const context = workspaceUi.contextKey;
    try { const result = await centralApi("/ui/api/profile-order"); if (context !== workspaceUi.contextKey) return; workspaceUi.order = Array.isArray(result.ids) ? result.ids.filter(id => typeof id === "string") : []; workspaceUi.orderReady = true; render(); }
    catch (error) { showError(error); }
  }
  async function arrangeProfiles(source, target, after = false) {
    if (workspaceUi.orderSaving || source === target || !getProfile(source) || !getProfile(target)) return;
    const before = workspaceUi.order, ids = sortedProfiles(state.snapshot.profiles).map(profileId).filter(id => id !== source), index = ids.indexOf(target); ids.splice(Math.max(0, index + (after ? 1 : 0)), 0, source);
    workspaceUi.orderSaving = true; workspaceUi.order = ids;
    const selectedBefore = new Set(workspaceUi.selected);
    if (workspaceUi.selected.has(source) && workspaceUi.selected.has(target)) workspaceUi.selected = new Set(ids.filter(id => workspaceUi.selected.has(id)).reverse());
    render();
    try { await centralApi("/ui/api/profile-order", { ids }); toast("Profile order saved on this device."); }
    catch (error) { workspaceUi.order = before; workspaceUi.selected = selectedBefore; render(); showError(error); }
    finally { workspaceUi.orderSaving = false; }
  }
  function desiredFollowing() {
    const profiles = [...workspaceUi.selected].map(getProfile).filter(Boolean), chromium = profiles.filter(profile => profile.engine !== "firefox");
    const admin = chromium.find(profile => profileId(profile) === workspaceUi.adminChoice) || chromium.at(-1);
    const adminId = admin ? profileId(admin) : null, followerIds = profiles.map(profileId).filter(id => id !== adminId);
    const invalid = profiles.some(profile => !isRunning(profile) || (profile.permission != null && profile.permission !== "edit"));
    return { adminId, followerIds, valid: Boolean(adminId && followerIds.length && !invalid), reason: profiles.length < 2 ? "Select at least two running profiles." : !adminId ? "A Chromium Admin is required. Firefox can follow." : invalid ? "Start selected profiles and use profiles you can edit." : "" };
  }
  function sameFollowing(left, right) { return left.adminId === right.adminId && [...(left.followerIds || [])].sort().join("|") === [...(right.followerIds || [])].sort().join("|"); }
  function selectLiveProfile(id, selected) {
    if (selected) { workspaceUi.selected.delete(id); workspaceUi.selected.add(id); workspaceUi.adminChoice = ""; workspaceUi.lastFocused = id; }
    else { workspaceUi.selected.delete(id); if (workspaceUi.adminChoice === id) workspaceUi.adminChoice = ""; }
    render(); scheduleAutoFollowing();
  }
  function applySyncStatus(value) {
    if (!value || typeof value !== "object") return;
    const incoming = value.syncSession || value.status || value;
    if (!("adminId" in incoming)) return;
    workspaceUi.sync = { ...workspaceUi.sync, ...incoming, followerIds: Array.isArray(incoming.followerIds) ? incoming.followerIds : [], savedFollowerIds: Array.isArray(incoming.savedFollowerIds) ? incoming.savedFollowerIds : [] };
    if (!workspaceUi.syncSeeded && incoming.adminId) { workspaceUi.selected = new Set([...workspaceUi.sync.followerIds, incoming.adminId]); workspaceUi.adminChoice = incoming.adminId; }
    workspaceUi.syncSeeded = true;
  }
  async function loadFollowingStatus() {
    const revision = workspaceUi.syncRevision;
    try { const result = await api("sync"); if (revision !== workspaceUi.syncRevision || workspaceUi.syncBusy) return; if (result.snapshot) applySnapshot(result.snapshot); applySyncStatus(result); render(); }
    catch (error) { if (revision === workspaceUi.syncRevision) { workspaceUi.sync.error = errorMessage(error); renderFollowing(); } }
  }
  async function changeFollowing(action) {
    const desired = desiredFollowing();
    if (action === "apply" && !desired.valid) return;
    const revision = ++workspaceUi.syncRevision;
    if (action === "stop") { workspaceUi.autoFollow = false; $("#auto-follow-selection").checked = false; clearTimeout(workspaceUi.autoTimer); }
    workspaceUi.syncBusy = true; renderFollowing();
    try {
      const payload = action === "reconnect" ? { adminId: workspaceUi.sync.adminId, followerIds: [...workspaceUi.sync.followerIds], saveSession: workspaceUi.sync.saved } : action === "apply" ? { adminId: desired.adminId, followerIds: desired.followerIds, saveSession: workspaceUi.sync.saved } : action === "resume" ? { action: "resume" } : action === "save" ? { action: "save", saveSession: !workspaceUi.sync.saved } : undefined;
      const result = await api("sync", payload, false, action === "stop" ? "DELETE" : "POST");
      if (revision !== workspaceUi.syncRevision) return;
      if (result.snapshot) applySnapshot(result.snapshot);
      applySyncStatus(result);
      if (action === "resume") { workspaceUi.selected = new Set([...workspaceUi.sync.followerIds, workspaceUi.sync.adminId].filter(Boolean)); workspaceUi.adminChoice = workspaceUi.sync.adminId || ""; }
    } catch (error) { if (revision === workspaceUi.syncRevision) { workspaceUi.sync.error = errorMessage(error); showError(error); } }
    finally { if (revision === workspaceUi.syncRevision) { workspaceUi.syncBusy = false; render(); } }
  }
  function scheduleAutoFollowing() {
    clearTimeout(workspaceUi.autoTimer);
    if (!workspaceUi.autoFollow) return;
    workspaceUi.autoTimer = setTimeout(() => { const desired = desiredFollowing(); if (workspaceUi.autoFollow && desired.valid && (workspaceUi.syncBusy || !sameFollowing(desired, workspaceUi.sync))) changeFollowing("apply"); }, 140);
  }
  function renderFollowing() {
    const sync = workspaceUi.sync, desired = desiredFollowing(), hasGroup = Boolean(sync.adminId), select = $("#following-admin"), signature = JSON.stringify([...workspaceUi.selected].map(id => [id, getProfile(id)?.name, getProfile(id)?.engine]));
    if (select._signature !== signature) { select._signature = signature; select.replaceChildren(); const empty = makeElement("option", "", "Select profiles below"); empty.value = ""; select.append(empty); for (const id of workspaceUi.selected) { const profile = getProfile(id); if (!profile || profile.engine === "firefox") continue; const option = makeElement("option", "", profile.name || id); option.value = id; select.append(option); } }
    if (document.activeElement !== select) select.value = desired.adminId || "";
    select.disabled = !desired.adminId;
    $("#following-apply").textContent = hasGroup ? "Apply selection" : "Start following";
    $("#following-apply").hidden = hasGroup && sameFollowing(desired, sync);
    $("#following-apply").disabled = !desired.valid || workspaceUi.syncBusy;
    $("#following-apply").title = desired.reason;
    $("#following-stop").hidden = !hasGroup && !sync.starting && !workspaceUi.syncBusy; $("#following-stop").disabled = !state.token;
    $("#following-reconnect").hidden = !hasGroup || sync.active || sync.starting || sync.waiting; $("#following-reconnect").disabled = workspaceUi.syncBusy || !state.token;
    $("#following-band").classList.toggle("controls-expanded", workspaceUi.followingExpanded); $("#following-controls-toggle").setAttribute("aria-expanded", String(workspaceUi.followingExpanded));
    $("#following-save").textContent = sync.saved ? "Forget saved session" : "Save session"; $("#following-save").disabled = (!hasGroup && !sync.saved) || workspaceUi.syncBusy;
    $("#following-resume").hidden = !sync.saved || hasGroup; $("#following-resume").disabled = workspaceUi.syncBusy;
    $("#auto-follow-selection").checked = workspaceUi.autoFollow;
    const admin = getProfile(sync.adminId), savedAdmin = getProfile(sync.savedAdminId);
    const message = workspaceUi.syncBusy ? "Updating following session… Stop remains available." : sync.error ? sync.error : sync.waiting ? `Waiting for ${admin?.name || "Admin"} and followers to reopen. The group is retained.` : sync.starting ? "Connecting Admin and follower browsers…" : hasGroup ? `${admin?.name || "Admin"} · ${sync.followerIds.length} follower${sync.followerIds.length === 1 ? "" : "s"} ${sync.active ? "connected" : "assigned"}${!sameFollowing(desired, sync) ? " · selection changed; Apply selection to update" : ""}` : sync.saved ? `Saved session: ${savedAdmin?.name || sync.savedAdminId || "Admin"} · ${sync.savedFollowerIds.length} followers. Resume when ready.` : desired.reason || "Ready to start following. Selection changes apply only when requested.";
    text($("#following-status"), message); $("#following-status").classList.toggle("following-error", Boolean(sync.error));
  }
  function renderFollowerStrip() {
    const strip = $("#browser-followers"), ids = workspaceUi.sync.followerIds || []; strip.replaceChildren(); strip.hidden = !ids.length;
    strip.append(makeElement("strong", "", `Followers (${ids.length})`));
    for (const id of ids) { const profile = getProfile(id); if (!profile) continue; const button = makeElement("button", "button subtle follower-link"); button.append(makeElement("span", "status-dot"), document.createTextNode(profile.name || id), makeElement("span", "", "›")); button.addEventListener("click", () => openProfileBrowser(id)); strip.append(button); }
  }
  async function loadResourcePolicy(id) {
    workspaceUi.resourceId = id; const form = $("#profile-resource-form"); form.reset(); $("#resource-save").disabled = true; text($("#resource-error"), ""); text($("#resource-summary"), "Reading this device’s resource policy…");
    try { const result = await centralApi(`/ui/api/profiles/${encodeURIComponent(id)}/resources`); if (workspaceUi.resourceId !== id || state.settingsProfileId !== id) return; const policy = result.policy || {}, value = policy.ramBudgetMb; workspaceUi.resourcePolicies.set(id, policy); renderBookmarks(); const option = [...form.elements.ramBudgetMb.options].some(item => item.value === String(value)); form.elements.ramBudgetMb.value = value == null ? "" : option ? String(value) : "custom"; form.elements.customRam.value = value ?? 2048; $("#custom-ram-label").hidden = form.elements.ramBudgetMb.value !== "custom"; form.elements.autoOptimize.checked = policy.autoOptimize === true; form.elements.alwaysShowBookmarks.checked = policy.alwaysShowBookmarks === true; form._bookmarks = policy.alwaysShowBookmarks; text($("#resource-summary"), `${result.allocation?.mode === "auto" || value == null ? "Auto allocation" : "Manual allocation"}${result.allocation?.budgetMb ? ` · ${number(result.allocation.budgetMb)} MB` : ""} · ${policy.autoOptimize ? "optimization applies at next launch" : "optimizer off"}.`); const editable = getProfile(id)?.permission == null || getProfile(id).permission === "edit"; for (const control of [...form.elements]) control.disabled = !editable; }
    catch (error) { if (workspaceUi.resourceId !== id || state.settingsProfileId !== id) return; text($("#resource-error"), errorMessage(error)); text($("#resource-summary"), "Resource policy unavailable."); }
  }
  function openTransfer(kind) {
    const exporting = kind === "export"; text($("#transfer-title"), exporting ? "Export profiles" : "Import profiles"); text($("#transfer-profiles-link"), exporting ? "Open profile export" : "Open profile import"); $("#transfer-profiles-link").href = `${manageProfilesUrl()}&action=${exporting ? "export" : "import"}`; $("#transfer-profiles-link").dataset.kind = kind; text($("#transfer-config-button"), exporting ? "Export configuration template" : "Import configuration template"); $("#transfer-config-button").dataset.kind = kind; $("#transfer-dialog").showModal();
  }
  async function ensureBookmarkPolicy(id) {
    if (!id || workspaceUi.resourcePolicies.has(id) || workspaceUi.resourceLoading.has(id)) return;
    const context = workspaceUi.contextKey; workspaceUi.resourceLoading.add(id);
    try { const result = await centralApi(`/ui/api/profiles/${encodeURIComponent(id)}/resources`); if (context !== workspaceUi.contextKey) return; workspaceUi.resourcePolicies.set(id, result.policy || {}); renderBookmarks(); }
    catch { /* Resource settings remain available in Profile settings. */ }
    finally { if (context === workspaceUi.contextKey) workspaceUi.resourceLoading.delete(id); }
  }
  async function ensureSavedBookmarks(id) {
    if (workspaceUi.bookmarks.has(id) || workspaceUi.bookmarksLoading.has(id)) return;
    const context = workspaceUi.contextKey; workspaceUi.bookmarksLoading.add(id);
    try { const result = await api(`library/profiles/${encodeURIComponent(id)}`); if (context !== workspaceUi.contextKey) return; workspaceUi.bookmarks.set(id, Array.isArray(result.metadata?.bookmarks) ? result.metadata.bookmarks : []); renderBookmarks(); }
    catch (error) { if (context !== workspaceUi.contextKey) return; workspaceUi.bookmarks.set(id, []); renderBookmarks(); showError(error); }
    finally { if (context === workspaceUi.contextKey) workspaceUi.bookmarksLoading.delete(id); }
  }
  function populateBookmarkBar(bar, id) {
    const profile = getProfile(id), metadata = libraryState.profiles.get(id), bookmarks = workspaceUi.bookmarks.get(id) || metadata?.bookmarks || profile?.bookmarks, policy = workspaceUi.resourcePolicies.get(id);
    const visible = profile?.alwaysShowBookmarks === true || policy?.alwaysShowBookmarks === true;
    bar.hidden = !visible; if (!visible) return;
    const signature = JSON.stringify([id, bookmarks, allowedControl(profile || {})]); if (bar._signature === signature) return; bar._signature = signature; bar.replaceChildren();
    if (!bookmarks) { bar.append(makeElement("span", "bookmark-empty", "Loading workspace bookmarks…")); ensureSavedBookmarks(id); return; }
    if (!bookmarks.length) { const edit = makeElement("button", "text-button bookmark-empty", "Add workspace bookmarks"); edit.type = "button"; edit.disabled = profile?.managementAvailable === false; edit.addEventListener("click", () => openMetadata(id)); bar.append(edit); return; }
    for (const bookmark of bookmarks) { const button = makeElement("button", "bookmark-link", `☆ ${bookmark.title || bookmark.url}`); button.type = "button"; button.title = bookmark.url; button.disabled = !profile || !allowedControl(profile); button.addEventListener("click", () => { try { browserAction("navigate", { url: browserUrl(bookmark.url) }, id); } catch (error) { showError(error); } }); bar.append(button); }
  }
  function renderBookmarks() {
    for (const [id, tile] of state.tiles) { let bar = $(".tile-bookmarks", tile); if (!bar) { bar = makeElement("div", "tile-bookmarks"); bar.setAttribute("aria-label", "Workspace bookmarks"); $(".tile-browser-bar", tile).after(bar); } populateBookmarkBar(bar, id); }
    if (state.view === "browser" && state.browserProfileId) { let bar = $("#browser-bookmarks"); if (!bar) { bar = makeElement("div", "tile-bookmarks"); bar.id = "browser-bookmarks"; bar.setAttribute("aria-label", "Workspace bookmarks"); $(".browser-chrome").after(bar); } populateBookmarkBar(bar, state.browserProfileId); ensureBookmarkPolicy(state.browserProfileId); }
  }
  function renderSelectionTools() { const count = [...workspaceUi.selected].filter(id => getProfile(id)).length; $("#live-selection-tools").hidden = state.view !== "live" || count === 0; text($("#live-selection-count"), `${count} selected`); }
  function updateTrashConfirmation() { $("#workspace-trash-submit").disabled = Number($("#workspace-trash-form").elements.confirmation.value) !== workspaceUi.trashIds.length || !workspaceUi.trashIds.length || workspaceUi.trashIds.some(id => !profileStopped(getProfile(id))); }
  $("#live-clear-selection").addEventListener("click", () => { workspaceUi.selected.clear(); workspaceUi.adminChoice = ""; render(); scheduleAutoFollowing(); });
  $("#live-trash-selected").addEventListener("click", () => { workspaceUi.trashIds = [...workspaceUi.selected].filter(id => getProfile(id)); if (!workspaceUi.trashIds.length) return; $("#workspace-trash-form").reset(); text($("#workspace-trash-title"), `Move ${workspaceUi.trashIds.length} profiles to Trash`); text($("#workspace-trash-copy"), workspaceUi.trashIds.map(id => getProfile(id)?.name || id).join(", ")); const open = workspaceUi.trashIds.filter(id => !profileStopped(getProfile(id))); text($("#workspace-trash-error"), open.length ? `${open.length} selected profiles are open. Stop them first; the selection is retained.` : ""); updateTrashConfirmation(); $("#workspace-trash-dialog").showModal(); });
  $("#workspace-trash-form").elements.confirmation.addEventListener("input", updateTrashConfirmation);
  $("#workspace-trash-form").addEventListener("submit", async event => { event.preventDefault(); updateTrashConfirmation(); if ($("#workspace-trash-submit").disabled) return; const ids = [...workspaceUi.trashIds]; $("#workspace-trash-submit").disabled = true; text($("#workspace-trash-error"), ""); try { const result = await centralApi("/ui/api/profiles/delete", { ids }); const fresh = await api("snapshot"); applySnapshot(fresh.snapshot || fresh); const remaining = ids.filter(id => getProfile(id)); workspaceUi.selected = new Set(remaining); render(); if (remaining.length || result.locked?.length || result.failed?.length) text($("#workspace-trash-error"), `${result.deleted || 0} profiles moved to Trash. Remaining profiles stay selected; check their access and stop open browsers before retrying.`); else { $("#workspace-trash-dialog").close(); toast(`${result.deleted || ids.length} profiles moved to Trash. Restore them from Profiles → Trash.`); } } catch (error) { text($("#workspace-trash-error"), errorMessage(error)); } finally { updateTrashConfirmation(); } });
  $("#following-admin").addEventListener("change", event => { const id = event.target.value; if (!id) return; workspaceUi.adminChoice = id; workspaceUi.selected.delete(id); workspaceUi.selected.add(id); render(); scheduleAutoFollowing(); });
  $("#auto-follow-selection").addEventListener("change", event => { workspaceUi.autoFollow = event.target.checked; workspaceUi.adminChoice = ""; renderFollowing(); scheduleAutoFollowing(); });
  $("#following-controls-toggle").addEventListener("click", () => { workspaceUi.followingExpanded = !workspaceUi.followingExpanded; renderFollowing(); });
  $("#following-reconnect").addEventListener("click", () => changeFollowing("reconnect"));
  $("#following-apply").addEventListener("click", () => changeFollowing("apply")); $("#following-stop").addEventListener("click", () => changeFollowing("stop")); $("#following-save").addEventListener("click", () => changeFollowing("save")); $("#following-resume").addEventListener("click", () => changeFollowing("resume"));
  $("#live-group-filter").addEventListener("change", event => { libraryState.groupFilter = event.target.value; $("#profile-group-filter").value = event.target.value; render(); });
  for (const [id, single] of [["grid-layout", false], ["list-layout", true]]) $("#" + id).addEventListener("click", () => { $("#live-grid").classList.toggle("single-column", single); for (const [buttonId, pressed] of [["grid-layout", !single], ["list-layout", single]]) { $("#" + buttonId).classList.toggle("selected", pressed); $("#" + buttonId).setAttribute("aria-pressed", String(pressed)); } });
  $("#transfer-profiles-link").addEventListener("click", event => {
    if (event.currentTarget.dataset.kind !== "export") return;
    const ids = [...workspaceUi.selected].filter(id => getProfile(id));
    try { if (ids.length) sessionStorage.setItem("gamebrowser.liveExportSelection", JSON.stringify({ ids, at: Date.now() })); else sessionStorage.removeItem("gamebrowser.liveExportSelection"); }
    catch { event.preventDefault(); showError("This browser could not carry the selected profiles to Export. Allow session storage and try again."); }
  });
  $("#workspace-import").addEventListener("click", () => openTransfer("import")); $("#workspace-export").addEventListener("click", () => openTransfer("export"));
  $("#transfer-config-button").addEventListener("click", event => { $("#transfer-dialog").close(); setView("profiles"); $("#" + (event.currentTarget.dataset.kind === "export" ? "export-config-button" : "import-config-button")).click(); });
  $("#profile-resource-form").elements.ramBudgetMb.addEventListener("change", event => { $("#custom-ram-label").hidden = event.target.value !== "custom"; });
  $("#profile-resource-form").addEventListener("submit", async event => { event.preventDefault(); const id = state.settingsProfileId, form = event.currentTarget; if (!id || (getProfile(id)?.permission != null && getProfile(id).permission !== "edit")) return; const context = workspaceUi.contextKey; const raw = form.elements.ramBudgetMb.value, ramBudgetMb = raw === "" ? null : Number(raw === "custom" ? form.elements.customRam.value : raw); if (ramBudgetMb !== null && (!Number.isInteger(ramBudgetMb) || ramBudgetMb < 128 || ramBudgetMb > 32768)) { text($("#resource-error"), "Use a whole number from 128 to 32,768 MB."); return; } $("#resource-save").disabled = true; text($("#resource-error"), ""); try { const bookmarks = form.elements.alwaysShowBookmarks.checked; await centralApi(`/ui/api/profiles/${encodeURIComponent(id)}/resources`, { ramBudgetMb, autoOptimize: form.elements.autoOptimize.checked, ...(bookmarks !== (form._bookmarks === true) ? { alwaysShowBookmarks: bookmarks } : {}) }); if (context !== workspaceUi.contextKey || state.settingsProfileId !== id || workspaceUi.resourceId !== id) return; await loadResourcePolicy(id); toast("Resource settings saved for the next launch."); } catch (error) { if (context !== workspaceUi.contextKey || state.settingsProfileId !== id || workspaceUi.resourceId !== id) return; text($("#resource-error"), errorMessage(error)); $("#resource-save").disabled = false; } });

  $("#main").addEventListener("click", onAction);
  $("#mobile-more").addEventListener("click", () => $("#more-dialog").showModal());
  $$("[data-more-view]").forEach(button => button.addEventListener("click", () => { $("#more-dialog").close(); setView(button.dataset.moreView); }));
  $("#mobile-relay-settings").addEventListener("click", () => { $("#more-dialog").close(); openSettings(); });
  $("#proxy-create-button").addEventListener("click", () => openProxyEditor());
  $("#proxy-import-button").addEventListener("click", () => { $("#proxy-import-form").reset(); text($("#proxy-import-error"), ""); $("#proxy-import-dialog").showModal(); });
  $("#proxy-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, button = $("#proxy-save"); button.disabled = true; text($("#proxy-form-error"), ""); try { const endpoint = form.elements.proxy.value.trim(); const body = { alias: form.elements.alias.value.trim(), group: form.elements.group.value.trim(), ...(endpoint ? { proxy: endpoint } : {}) }; await api(proxyState.editId ? `proxies/${encodeURIComponent(proxyState.editId)}` : "proxies", body); form.elements.proxy.value = ""; $("#proxy-dialog").close(); await loadProxies(); toast("Proxy saved in the local library."); } catch (error) { text($("#proxy-form-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#proxy-dialog").addEventListener("close", () => { $("#proxy-form").elements.proxy.value = ""; });
  $("#proxy-import-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, button = $("#proxy-import-submit"); button.disabled = true; text($("#proxy-import-error"), ""); try { const result = await api("proxies/import", { text: form.elements.text.value }); form.elements.text.value = ""; $("#proxy-import-dialog").close(); await loadProxies(); toast(`${Array.isArray(result.imported) ? result.imported.length : result.imported || 0} proxy endpoints imported.`); } catch (error) { text($("#proxy-import-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#proxy-import-dialog").addEventListener("close", () => { $("#proxy-import-form").elements.text.value = ""; });
  $("#proxy-assign-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, button = $("#proxy-assign-submit"); button.disabled = true; text($("#proxy-assign-error"), ""); try { const profileIds = [...form.elements.profileIds.selectedOptions].map(option => option.value); if (!profileIds.length) throw new Error("Select at least one stopped profile."); const result = await api(`proxies/${encodeURIComponent(proxyState.assignId)}/assign`, { profileIds }); const failures = (result.results || []).filter(item => item.success === false || item.ok === false); if (failures.length) { text($("#proxy-assign-error"), failures.map(item => `${getProfile(item.profileId)?.name || item.profileId}: ${item.error || "not assigned"}`).join(" · ")); } else { $("#proxy-assign-dialog").close(); toast("Saved endpoint copied into the selected profiles."); } const fresh = await api("snapshot"); applySnapshot(fresh.snapshot || fresh); } catch (error) { text($("#proxy-assign-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#proxy-delete-form").addEventListener("submit", async event => { event.preventDefault(); const id = proxyState.deleteId, button = $("#proxy-delete-submit"); if (!id) return; button.disabled = true; text($("#proxy-delete-error"), ""); try { await api(`proxies/${encodeURIComponent(id)}`, {}, false, "DELETE"); $("#proxy-delete-dialog").close(); await loadProxies(); toast("Saved library entry removed. Profile endpoints are unchanged."); } catch (error) { text($("#proxy-delete-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#proxy-library").addEventListener("click", event => { const button = event.target.closest("[data-proxy-action]"); if (!button) return; const id = button.dataset.proxyId; if (button.dataset.proxyAction === "edit") openProxyEditor(id); else if (button.dataset.proxyAction === "assign") openProxyAssignment(id); else { proxyState.deleteId = id; text($("#proxy-delete-copy"), proxyState.entries.find(item => item.id === id)?.alias || "Saved endpoint"); text($("#proxy-delete-error"), ""); $("#proxy-delete-dialog").showModal(); } });
  $("#workflow-create-button").addEventListener("click", () => openWorkflowEditor());
  $("#automation-refresh").addEventListener("click", () => { text($("#automation-error"), ""); loadAutomation(true); });
  $("#workflow-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, button = $("#workflow-save"); button.disabled = true; text($("#workflow-form-error"), ""); try { let steps; try { steps = JSON.parse(form.elements.steps.value); } catch { throw new Error("Enter a valid JSON array of read-only steps."); } if (!Array.isArray(steps) || steps.length < 1 || steps.length > 64) throw new Error("Use 1 to 64 read-only workflow steps."); await api("workflows", { ...(automationState.editId ? { id: automationState.editId } : {}), name: form.elements.name.value.trim(), steps }); $("#workflow-dialog").close(); await loadAutomation(true); toast("Read-only workflow saved."); } catch (error) { text($("#workflow-form-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#workflow-import-button").addEventListener("click", () => { $("#workflow-import-form").reset(); text($("#workflow-import-error"), ""); $("#workflow-import-dialog").showModal(); });
  $("#workflow-import-form").elements.file.addEventListener("change", async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 256 * 1024) { text($("#workflow-import-error"), "Choose a workflow document no larger than 256 KB."); return; } $("#workflow-import-form").elements.document.value = await file.text(); });
  $("#workflow-import-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, button = $("#workflow-import-submit"); button.disabled = true; text($("#workflow-import-error"), ""); try { let documentValue; try { documentValue = JSON.parse(form.elements.document.value); } catch { throw new Error("Choose or paste a valid workflow JSON document."); } await api("workflows/import", { document: documentValue }); $("#workflow-import-dialog").close(); form.elements.document.value = ""; await loadAutomation(true); toast("Read-only workflow imported."); } catch (error) { text($("#workflow-import-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#workflow-run-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, button = $("#workflow-run-submit"); button.disabled = true; text($("#workflow-run-error"), ""); try { const profileIds = [...form.elements.profileIds.selectedOptions].map(option => option.value); if (!profileIds.length || profileIds.length > 16) throw new Error("Choose 1 to 16 running manual profiles."); const result = await api(`workflows/${encodeURIComponent(automationState.runId)}/run`, { profileIds }); await loadAutomation(false); if (result.rejected?.length) text($("#workflow-run-error"), `${result.jobs?.length || 0} jobs queued. ${result.rejected.map(item => `${getProfile(item.profileId)?.name || item.profileId}: ${item.error}`).join(" · ")}`); else { $("#workflow-run-dialog").close(); toast(`${result.jobs?.length || 0} read-only jobs queued.`); } } catch (error) { text($("#workflow-run-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#workflow-delete-form").addEventListener("submit", async event => { event.preventDefault(); const id = automationState.deleteId, button = $("#workflow-delete-submit"); if (!id) return; button.disabled = true; text($("#workflow-delete-error"), ""); try { await api(`workflows/${encodeURIComponent(id)}`, {}, false, "DELETE"); $("#workflow-delete-dialog").close(); await loadAutomation(true); toast("Saved workflow removed."); } catch (error) { text($("#workflow-delete-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#schedule-create-button").addEventListener("click", openScheduleEditor);
  $("#schedule-form").elements.kind.addEventListener("change", event => { const interval = event.target.value === "interval"; $("#schedule-time-label").hidden = interval; $("#schedule-interval-label").hidden = !interval; $("#schedule-form").elements.runAt.required = !interval; $("#schedule-form").elements.intervalMinutes.required = interval; });
  $("#schedule-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, button = $("#schedule-save"); button.disabled = true; text($("#schedule-error"), ""); try { const payload = { workflowId: form.elements.workflowId.value, profileId: form.elements.profileId.value, kind: form.elements.kind.value, enabled: true }; if (payload.kind === "once") { payload.runAt = new Date(form.elements.runAt.value).getTime(); if (!Number.isFinite(payload.runAt) || payload.runAt <= Date.now()) throw new Error("Choose a future local date and time."); } else { const minutes = Number(form.elements.intervalMinutes.value); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error("Choose an interval from 1 to 10,080 whole minutes."); payload.intervalMs = minutes * 60000; } await api("schedules", payload); $("#schedule-dialog").close(); await loadAutomation(false); toast("Local schedule saved. Keep GameBrowser open for it to run."); } catch (error) { text($("#schedule-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#automation-view").addEventListener("click", async event => {
    const button = event.target.closest("button"); if (!button || button.disabled) return;
    try {
      if (button.dataset.workflowTemplate) { const template = automationState.templates.find(item => item.key === button.dataset.workflowTemplate); if (template?.document) openWorkflowEditor(null, template.document); }
      else if (button.dataset.workflowAction) { const id = button.dataset.workflowId, action = button.dataset.workflowAction; if (action === "edit") openWorkflowEditor(id); else if (action === "run") openWorkflowRun(id); else if (action === "export") { const result = await api(`workflows/${encodeURIComponent(id)}/export`); downloadJson(result.document, "gamebrowser-read-only-workflow.json"); } else { automationState.deleteId = id; text($("#workflow-delete-copy"), workflowName(id)); text($("#workflow-delete-error"), ""); $("#workflow-delete-dialog").showModal(); } }
      else if (button.dataset.jobCancel) { button.disabled = true; await api(`jobs/${encodeURIComponent(button.dataset.jobCancel)}/cancel`, {}); await loadAutomation(false); }
      else if (button.dataset.jobOutput) { button.disabled = true; const result = await api(`jobs/${encodeURIComponent(button.dataset.jobOutput)}/output?format=${button.dataset.format}`); if (typeof result.content !== "string") throw new Error("The workflow output is unavailable."); downloadContent(result.content, result.filename, result.format === "csv" ? "text/csv;charset=utf-8" : "application/json"); }
      else if (button.dataset.scheduleToggle) { const schedule = automationState.schedules.find(item => item.id === button.dataset.scheduleToggle); if (schedule) { button.disabled = true; await api(`schedules/${encodeURIComponent(schedule.id)}`, { enabled: !schedule.enabled }); await loadAutomation(false); } }
      else if (button.dataset.scheduleDelete) { button.disabled = true; await api(`schedules/${encodeURIComponent(button.dataset.scheduleDelete)}`, {}, false, "DELETE"); await loadAutomation(false); }
    } catch (error) { text($("#automation-error"), errorMessage(error)); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  $("#profile-table-body").addEventListener("change", event => { const input = event.target.closest("[data-select-profile]"); if (!input) return; if (input.checked) libraryState.selected.add(input.dataset.selectProfile); else libraryState.selected.delete(input.dataset.selectProfile); updateLibrarySelection(); });
  $("#select-all-profiles").addEventListener("change", event => { for (const profile of filteredProfiles()) { const id = profileId(profile); if (event.target.checked) libraryState.selected.add(id); else libraryState.selected.delete(id); } render(); });
  $("#clear-selection").addEventListener("click", () => { libraryState.selected.clear(); render(); });
  $("#profile-group-filter").addEventListener("change", event => { libraryState.groupFilter = event.target.value; render(); });
  $("#profile-tag-filter").addEventListener("input", event => { libraryState.tagFilter = event.target.value.trim().toLowerCase(); render(); });
  $("#batch-action").addEventListener("change", event => { const action = event.target.value; $("#batch-network-mode").hidden = action !== "network"; $("#batch-proxy").hidden = action !== "network" || $("#batch-network-mode").value !== "proxy"; $("#batch-group").hidden = action !== "group"; });
  $("#batch-network-mode").addEventListener("change", event => { $("#batch-proxy").hidden = event.target.value !== "proxy"; });
  $("#batch-submit").addEventListener("click", runBatch);
  $("#add-bookmark").addEventListener("click", () => { if ($$("[data-bookmark-row]", $("#bookmark-rows")).length >= 64) { text($("#metadata-error"), "A profile can have up to 64 bookmarks."); return; } addBookmarkRow(); });
  $("#metadata-form").addEventListener("submit", async event => {
    event.preventDefault(); const id = libraryState.metadataId, profile = getProfile(id), form = event.currentTarget, button = $("#metadata-submit"); if (!profile) return; button.disabled = true; text($("#metadata-error"), ""); let metadataSaved = false;
    try { const name = form.elements.name.value.trim(); if (!name) throw new Error("Enter a profile name."); const bookmarks = $$("[data-bookmark-row]", $("#bookmark-rows")).map(row => ({ title: $("[data-bookmark-title]", row).value.trim(), url: $("[data-bookmark-url]", row).value.trim() })).filter(item => item.title || item.url).map(item => { if (!item.title) throw new Error("Give each bookmark a title."); return { title: item.title, url: browserUrl(item.url) }; }); const tags = [...new Set(form.elements.tags.value.split(",").map(tag => tag.trim()).filter(Boolean))]; await api(`library/profiles/${encodeURIComponent(id)}`, { groupId: form.elements.groupId.value || null, tags, notes: form.elements.notes.value, bookmarks }); metadataSaved = true; if (name !== profile.name) await api(profilePath(id, "rename"), { name }); $("#metadata-dialog").close(); await loadLibrary(); toast("Profile details saved."); renderBookmarks(); }
    catch (error) { text($("#metadata-error"), `${metadataSaved ? "Organization details were saved. Renaming failed: " : ""}${errorMessage(error)}`); }
    finally { button.disabled = false; }
  });
  $("#copy-profile-form").addEventListener("submit", async event => { event.preventDefault(); const id = libraryState.copyId, button = $("#copy-profile-submit"); if (!id) return; button.disabled = true; text($("#copy-profile-error"), ""); try { await api(profilePath(id, "copy"), { name: event.currentTarget.elements.name.value.trim() }); $("#copy-profile-dialog").close(); await loadLibrary(); toast("New isolated profile created from the configuration."); } catch (error) { text($("#copy-profile-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#manage-groups-button").addEventListener("click", openGroups);
  $("#groups-form").elements.id.addEventListener("change", event => { const group = libraryState.groups.find(item => item.id === event.target.value); $("#groups-form").elements.name.value = group?.name || ""; text($("#group-save"), group ? "Rename group" : "Create group"); $("#group-delete").disabled = !group; });
  $("#groups-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, id = form.elements.id.value, button = $("#group-save"); button.disabled = true; text($("#groups-error"), ""); try { await api("library/groups", { ...(id ? { id } : {}), name: form.elements.name.value.trim() }); await loadLibrary(); fillGroupSelect(form.elements.id, "Create a new group"); form.elements.id.value = ""; form.elements.name.value = ""; text(button, "Create group"); $("#group-delete").disabled = true; toast(id ? "Group renamed." : "Group created."); } catch (error) { text($("#groups-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#group-delete").addEventListener("click", async () => { const id = $("#groups-form").elements.id.value; if (!id) return; const button = $("#group-delete"); button.disabled = true; text($("#groups-error"), ""); try { await api(`library/groups/${encodeURIComponent(id)}`, {}, false, "DELETE"); await loadLibrary(); fillGroupSelect($("#groups-form").elements.id, "Create a new group"); $("#groups-form").elements.id.value = ""; $("#groups-form").elements.name.value = ""; text($("#group-save"), "Create group"); toast("Group removed. Its profiles are now Ungrouped."); } catch (error) { text($("#groups-error"), errorMessage(error)); button.disabled = false; } });
  $("#export-config-button").addEventListener("click", async () => { text($("#library-error"), ""); try { const ids = [...libraryState.selected]; const result = await api(`library/export${ids.length ? "?ids=" + encodeURIComponent(ids.join(",")) : ""}`); if (!result.document) throw new Error("The configuration export is incomplete."); downloadJson(result.document, "gamebrowser-configuration.json"); toast(ids.length ? "Selected profile configurations exported." : "All profile configurations exported."); } catch (error) { text($("#library-error"), errorMessage(error)); } });
  $("#import-config-button").addEventListener("click", () => { $("#import-config-form").reset(); text($("#import-config-error"), ""); $("#import-config-dialog").showModal(); });
  $("#import-config-form").elements.file.addEventListener("change", async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 1024 * 1024) { text($("#import-config-error"), "Choose a configuration file no larger than 1 MB."); return; } $("#import-config-form").elements.document.value = await file.text(); });
  $("#import-config-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, button = $("#import-config-submit"); button.disabled = true; text($("#import-config-error"), ""); try { let documentValue; try { documentValue = JSON.parse(form.elements.document.value); } catch { throw new Error("Choose or paste a valid configuration JSON document."); } if (new Blob([JSON.stringify({ document: documentValue })]).size > 1024 * 1024) throw new Error("The configuration import exceeds 1 MB."); const result = await api("library/import", { document: documentValue }); $("#import-config-dialog").close(); form.elements.document.value = ""; await loadLibrary(); toast(`${result.profiles?.length || 0} new profile configurations imported.`); } catch (error) { text($("#import-config-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#full-admin-view").addEventListener("click", () => { const admin = state.snapshot.profiles.find(profile => isRunning(profile) && profileRole(profile) === "admin"); if (admin) openProfileBrowser(profileId(admin)); });
  $("#browser-return-grid").addEventListener("click", returnToGrid);
  $("#browser-fullscreen").addEventListener("click", toggleWorkspaceFullscreen);
  $("#browser-profile-settings").addEventListener("click", () => openProfileSettings(state.browserProfileId));
  $("#browser-type-text").addEventListener("click", () => { $("#browser-text-form").reset(); text($("#browser-text-error"), ""); $("#browser-text-dialog").showModal(); });
  $("#browser-text-form").addEventListener("submit", event => { event.preventDefault(); const id = state.browserProfileId, value = event.currentTarget.elements.text.value; if (!value || value.length > 2048) { text($("#browser-text-error"), "Type between 1 and 2,048 characters."); return; } if (!control(id, { kind: "text", text: value })) { text($("#browser-text-error"), "The selected live browser must be healthy and under manual or administrator control."); return; } event.currentTarget.elements.text.value = ""; $("#browser-text-dialog").close(); toast("Text submitted to the selected browser."); });
  $("#browser-text-dialog").addEventListener("close", () => { $("#browser-text-form").elements.text.value = ""; });
  $("#browser-take-manual").addEventListener("click", async () => { const id = state.browserProfileId; if (id) { await mutateProfile(id, "manual", { enabled: true }); await loadBrowserState(id); } });
  $("#browser-address-form").addEventListener("submit", event => { event.preventDefault(); try { const url = browserUrl($("#browser-address").value); $("#browser-address").value = url; $("#browser-address").blur(); browserAction("navigate", { url }); } catch (error) { browserError(errorMessage(error)); } });
  $("#browser-workspace").addEventListener("click", event => { const action = event.target.closest("[data-browser-action]"); if (action && !action.disabled) browserAction(action.dataset.browserAction); const select = event.target.closest("[data-tab-id]"); if (select && !select.disabled) browserAction("select-tab", { tabId: select.dataset.tabId }); const close = event.target.closest("[data-close-tab-id]"); if (close && !close.disabled) browserAction("close-tab", { tabId: close.dataset.closeTabId }); });
  $("#browser-tabs").addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; const tabs = $$("[data-tab-id]:not(:disabled)", event.currentTarget), index = tabs.indexOf(document.activeElement); if (index < 0 || !tabs.length) return; event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; tabs[next].focus(); browserAction("select-tab", { tabId: tabs[next].dataset.tabId }); });
  document.addEventListener("fullscreenchange", () => { const active = document.fullscreenElement === $("#browser-workspace") || $("#browser-workspace").classList.contains("workspace-fullscreen"); $("#browser-fullscreen").setAttribute("aria-pressed", String(active)); text($("#browser-fullscreen"), active ? "Exit fullscreen" : "Fullscreen"); });
  document.addEventListener("keydown", event => { if (state.view !== "browser" || $$("dialog[open]").length) return; if (event.key === "Escape") { if (document.fullscreenElement || $("#browser-workspace").classList.contains("workspace-fullscreen")) exitWorkspaceFullscreen(); else if (!event.defaultPrevented) returnToGrid(); } if ((event.ctrlKey || event.metaKey) && !event.altKey) { if (event.key.toLowerCase() === "l") { event.preventDefault(); $("#browser-address").focus(); $("#browser-address").select(); } else if (event.key.toLowerCase() === "t") { event.preventDefault(); browserAction("new-tab"); } else if (event.key.toLowerCase() === "w") { const active = state.browserStates.get(state.browserProfileId)?.activeTabId; if (active) { event.preventDefault(); browserAction("close-tab", { tabId: active }); } } } });
  $("#main").addEventListener("change", event => { const select = event.target.closest("[data-role-for]"); if (select) mutateProfile(select.dataset.roleFor, "role", { role: select.value }); });
  $$("[data-view]").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("[data-filter]").forEach(button => button.addEventListener("click", () => { state.filter = button.dataset.filter; $$("[data-filter]").forEach(other => { const active = other === button; other.classList.toggle("selected", active); other.setAttribute("aria-pressed", String(active)); }); render(); }));
  $("#profile-search").addEventListener("input", event => { state.search = event.target.value.trim().toLowerCase(); render(); });
  $("#create-button").addEventListener("click", openCreate); $("#empty-create").addEventListener("click", openCreate);
  $("#nav-settings").addEventListener("click", () => { location.href = settingsUrl(); }); $("#edit-scope").addEventListener("click", openSettings);
  $$("[data-close]").forEach(button => button.addEventListener("click", () => $("#" + button.dataset.close).close()));
  $("#dismiss-error").addEventListener("click", () => { $("#error-banner").hidden = true; });
  $("#profile-settings-form").elements.networkMode.addEventListener("change", updateProxyFields);
  $("#profile-settings-form").elements.replaceProxy.addEventListener("change", updateProxyFields);
  $("#profile-screen-form").elements.screenPreset.addEventListener("change", event => {
    if (event.target.value === "custom") return;
    const [width, height] = event.target.value.split("x"), form = $("#profile-screen-form"); form.elements.width.value = width; form.elements.height.value = height;
  });
  for (const name of ["width", "height"]) $("#profile-screen-form").elements[name].addEventListener("input", () => { $("#profile-screen-form").elements.screenPreset.value = "custom"; });
  $("#profile-screen-form").addEventListener("submit", async event => {
    event.preventDefault(); const id = state.settingsProfileId, profile = getProfile(id), form = event.currentTarget;
    if (!profileStopped(profile) || state.busy.has(id)) return;
    text($("#screen-error"), "");
    try {
      const screen = desktopScreen(form.elements.width.value, form.elements.height.value);
      state.busy.add(id); updateProfileSettingsAvailability(); text($("#screen-save"), "Saving…");
      await api(profilePath(id, "screen"), screen); toast("Browser viewport saved for the next profile start.");
    } catch (error) { text($("#screen-error"), errorMessage(error)); }
    finally { state.busy.delete(id); text($("#screen-save"), "Save screen size"); updateProfileSettingsAvailability(); render(); }
  });
  $("#profile-settings-form").addEventListener("submit", async event => {
    event.preventDefault(); const id = state.settingsProfileId, profile = getProfile(id), form = event.currentTarget; if (!profileStopped(profile)) return;
    text($("#network-error"), ""); state.busy.add(id); $("#network-save").disabled = true;
    try {
      const payload = { networkMode: form.elements.networkMode.value };
      if (payload.networkMode === "proxy" && (!profile.proxy || form.elements.replaceProxy.checked)) {
        const host = form.elements.proxyHost.value.trim(), port = Number(form.elements.proxyPort.value);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter a proxy host and a port between 1 and 65,535.");
        payload.proxy = { type: form.elements.proxyType.value, host, port: String(port), user: form.elements.proxyUsername.value, pass: form.elements.proxyPassword.value };
      }
      await api(profilePath(id, "network"), payload); form.elements.proxyPassword.value = ""; form.elements.proxyUsername.value = ""; form.elements.replaceProxy.checked = false; updateProxyFields(); toast("Network settings saved for the next profile start.");
    } catch (error) { text($("#network-error"), errorMessage(error)); }
    finally { state.busy.delete(id); updateProfileSettingsAvailability(); render(); }
  });
  $("#profile-delete-button").addEventListener("click", () => openDeleteProfile(state.settingsProfileId));
  $("#delete-form").elements.confirmation.addEventListener("input", event => { const profile = getProfile(state.deleteProfileId); $("#delete-submit").disabled = !profileStopped(profile) || event.target.value !== state.deleteProfileId; });
  $("#delete-form").addEventListener("submit", async event => {
    event.preventDefault(); const id = state.deleteProfileId, profile = getProfile(id), confirmation = event.currentTarget.elements.confirmation.value; if (!profileStopped(profile) || confirmation !== id) return;
    const button = $("#delete-submit"); button.disabled = true; text(button, "Deleting…"); text($("#delete-error"), "");
    try { await api(profilePath(id), { confirmation }, false, "DELETE"); $("#delete-dialog").close(); $("#profile-settings-dialog").close(); state.deleteProfileId = null; state.settingsProfileId = null; state.browserStates.delete(id); state.assignments.delete(id); if (state.browserProfileId === id) returnToGrid(); const fresh = await api("snapshot"); applySnapshot(fresh.snapshot || fresh); toast("Local profile deleted. Website accounts are unchanged."); }
    catch (error) { text($("#delete-error"), errorMessage(error)); button.disabled = false; }
    finally { text(button, "Delete local profile"); }
  });
  $("#profile-settings-dialog").addEventListener("close", () => { $("#profile-settings-form").elements.proxyPassword.value = ""; $("#profile-settings-form").elements.proxyUsername.value = ""; $("#cookie-form").elements.cookies.value = ""; $("#cookie-form").elements.file.value = ""; });
  $("#cookie-export").addEventListener("click", () => cookieOperation("export")); $("#cookie-clear").addEventListener("click", () => cookieOperation("clear"));
  $("#cookie-show-import").addEventListener("click", () => { $("#cookie-import-fields").hidden = !$("#cookie-import-fields").hidden; });
  $("#cookie-form").elements.confirmClear.addEventListener("change", updateProfileSettingsAvailability);
  $("#cookie-form").addEventListener("submit", event => { event.preventDefault(); cookieOperation("import"); });
  $("#cookie-form").elements.file.addEventListener("change", async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 48 * 1024) { text($("#cookie-status"), "Choose a cookie JSON file smaller than 48 KB."); return; } $("#cookie-form").elements.cookies.value = await file.text(); });
  $("#profile-manage-extensions").addEventListener("click", () => { $("#profile-settings-dialog").close(); setView("extensions"); });
  $("#import-extension-button").addEventListener("click", openExtensionImport); $("#empty-import-extension").addEventListener("click", openExtensionImport);
  $("#import-extension-form").addEventListener("submit", async event => { event.preventDefault(); const form = event.currentTarget, button = $("#import-extension-submit"); button.disabled = true; text(button, "Importing…"); text($("#import-extension-error"), ""); try { await api("extensions/import", { path: form.elements.path.value.trim(), engine: form.elements.engine.value }); $("#import-extension-dialog").close(); await loadExtensions(); toast("Extension imported inactive. Review its permissions before assigning it."); } catch (error) { text($("#import-extension-error"), errorMessage(error)); } finally { button.disabled = false; text(button, "Import package"); } });
  $("#extension-assignment-form").elements.siteAccess.addEventListener("change", event => { $("#extension-origins-label").hidden = event.target.value !== "sites"; });
  $("#extension-assignment-form").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget, id = form.elements.profileId.value, extension = state.extensions.find(item => item.id === state.reviewedExtensionId), button = $("#extension-assignment-submit"); text($("#extension-assignment-error"), ""); button.disabled = true;
    try { if (!extension || !form.elements.reviewed.checked || extension.sha256 !== state.reviewedExtensionSha) throw new Error("Review the current package and its permissions before enabling it."); if (!profileStopped(getProfile(id))) throw new Error("Stop the selected profile before assigning extensions."); const siteAccess = form.elements.siteAccess.value; const origins = siteAccess === "sites" ? [...new Set(form.elements.origins.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(approveOrigin))] : []; if (siteAccess === "sites" && !origins.length) throw new Error("Choose at least one website origin or select all requested websites."); await api(profilePath(id, "extensions"), { extensionId: extension.id, enabled: true, siteAccess, origins, reviewedSha256: state.reviewedExtensionSha }); $("#extension-review-dialog").close(); if ($("#profile-settings-dialog").open && state.settingsProfileId === id) await loadProfileExtensions(id); await loadExtensions(); toast("Extension enabled for the next profile start."); }
    catch (error) { text($("#extension-assignment-error"), errorMessage(error)); }
    finally { button.disabled = false; }
  });
  document.addEventListener("click", event => {
    const extensionOpen = event.target.closest("[data-extension-open]"); if (extensionOpen && !extensionOpen.disabled) { const id = extensionOpen.dataset.profileId; api(profilePath(id, `extensions/${encodeURIComponent(extensionOpen.dataset.extensionOpen)}/open`), { kind: extensionOpen.dataset.extensionKind }).then(result => { $("#profile-settings-dialog").close(); state.browserProfileId = id; setView("browser"); applyBrowserState(result.browser, true); }).catch(error => text($("#profile-extensions-error"), errorMessage(error))); }
    const review = event.target.closest("[data-extension-review]"); if (review) openExtensionReview(review.dataset.extensionReview, state.settingsProfileId);
    const toggle = event.target.closest("[data-assignment-toggle]"); if (toggle && !toggle.disabled) changeAssignment(toggle.dataset.profileId, toggle.dataset.assignmentToggle);
    const unassign = event.target.closest("[data-assignment-remove]"); if (unassign && !unassign.disabled) changeAssignment(unassign.dataset.profileId, unassign.dataset.assignmentRemove, true);
    const remove = event.target.closest("[data-extension-remove]"); if (remove && !remove.disabled) { const extension = state.extensions.find(item => item.id === remove.dataset.extensionRemove); if (extension) { state.extensionRemoval = extension.id; text($("#extension-remove-copy"), extension.name); text($("#extension-remove-error"), ""); $("#extension-remove-dialog").showModal(); } }
  });
  $("#extension-remove-form").addEventListener("submit", async event => { event.preventDefault(); const id = state.extensionRemoval, button = $("#extension-remove-submit"); if (!id) return; button.disabled = true; text($("#extension-remove-error"), ""); try { await api(`extensions/${encodeURIComponent(id)}`, {}, false, "DELETE"); $("#extension-remove-dialog").close(); state.extensionRemoval = null; await loadExtensions(); toast("Imported extension removed from the local library."); } catch (error) { text($("#extension-remove-error"), errorMessage(error)); } finally { button.disabled = false; } });
  $("#refresh-button").addEventListener("click", async () => { const button = $("#refresh-button"); button.disabled = true; try { if (!state.token) await bootstrap(); else { const result = await api("snapshot"); applySnapshot(result.snapshot || result); if (!state.connected) { clearTimeout(state.reconnect); connectSocket(); } refreshActiveView(); toast("Workspace refreshed."); } } catch (error) { showError(error); } finally { button.disabled = false; } });

  $("#create-form").elements.engine.addEventListener("change", event => { const firefox = event.target.value === "firefox"; $("#create-form").elements.heapMb.disabled = firefox; text($("#heap-help"), firefox ? "Firefox does not use V8. Its JS heap is managed by Firefox." : "Limits V8 heap only. Firefox uses its own runtime."); });
  $("#create-form").elements.networkMode.addEventListener("change", event => { const proxy = event.target.value === "proxy"; $("#bulk-proxy-fields").hidden = !proxy; $("#create-form").elements.proxies.disabled = !proxy; });
  $("#create-form").elements.resolution.addEventListener("change", updateCreateScreenFields);
  $("#create-form").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget, button = $("#create-submit"), failure = $("#create-error"); button.disabled = true; text(button, "Creating…"); text(failure, "");
    try {
      const count = Number(form.elements.count.value); if (!Number.isInteger(count) || count < 1 || count > 256) throw new Error("Choose between 1 and 256 profiles.");
      const origin = approveOrigin(form.elements.origin.value); if (!state.snapshot.origins.includes(origin)) throw new Error("Approve this website in Relay settings before creating profiles.");
      const networkMode = form.elements.networkMode.value;
      const proxies = networkMode === "proxy" ? form.elements.proxies.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : []; if (networkMode === "proxy" && proxies.length !== count && proxies.length !== 1) throw new Error("Supply one shared proxy endpoint or exactly one endpoint per profile.");
      const resolutions = [...form.elements.resolution.selectedOptions].map(option => { const [width, height] = option.value === "custom" ? [form.elements.screenWidth.value, form.elements.screenHeight.value] : option.value.split("x"); return desktopScreen(width, height); }); if (!resolutions.length) throw new Error("Choose at least one viewport preset or Custom viewport size.");
      const result = await api("bulk", { count, prefix: form.elements.prefix.value.trim(), engine: form.elements.engine.value, origin, networkMode, proxies, ramMb: Number(form.elements.ramMb.value), ...(form.elements.heapMb.value ? { heapMb: Number(form.elements.heapMb.value), explicitHeap: true } : { explicitHeap: false }), resolutions, headless: true });
      form.elements.proxies.value = "";
      if (!result.snapshot) { const fresh = await api("snapshot"); applySnapshot(fresh.snapshot || fresh); }
      $("#create-dialog").close(); toast(`${count} isolated profile${count === 1 ? "" : "s"} created.`);
    } catch (error) { text(failure, errorMessage(error)); }
    finally { button.disabled = false; text(button, "Create profiles"); }
  });

  $("#settings-form").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget, button = $("#settings-submit"), failure = $("#settings-error"); button.disabled = true; text(button, "Saving…"); text(failure, "");
    try { const origins = [...new Set(form.elements.origins.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(approveOrigin))]; if (!origins.length || origins.length > 32) throw new Error("Approve between 1 and 32 exact HTTPS origins."); await api("settings", { origins, pacing: form.elements.pacing.value }); $("#settings-dialog").close(); toast("Relay settings saved. Review profile roles before resuming sync."); }
    catch (error) { text(failure, errorMessage(error)); }
    finally { button.disabled = false; text(button, "Save settings"); }
  });

  $("#kill-form").addEventListener("submit", async event => { event.preventDefault(); const id = state.killId; $("#kill-dialog").close(); state.killId = null; if (id) await mutateProfile(id, "kill"); });
  $("#navigate-form").addEventListener("submit", async event => { event.preventDefault(); const id = state.navigateId, form = event.currentTarget, button = $("#navigate-submit"); button.disabled = true; text($("#navigate-error"), ""); try { const destination = new URL(form.elements.url.value); if (destination.username || destination.password || !state.snapshot.origins.includes(destination.origin)) throw new Error("Choose a page on an approved website without URL credentials."); if (!id) throw new Error("Select a profile first."); await api("navigate", { profileId: id, url: destination.href }); $("#navigate-dialog").close(); state.navigateId = null; toast("Page opened in the selected profile."); } catch (error) { text($("#navigate-error"), errorMessage(error)); } finally { button.disabled = false; } });
  document.addEventListener("visibilitychange", () => { if (document.hidden && state.focusedProfile) { state.focusedProfile = null; send({ type: "FOCUS", profileId: null }); } updateSubscriptions(); clearTimeout(automationState.timer); if (!document.hidden && state.view === "automation") loadAutomation(false); });
  window.addEventListener("pagehide", () => { state.disposed = true; clearTimeout(state.reconnect); clearTimeout(state.toastTimer); clearTimeout(automationState.timer); send({ type: "SUBSCRIBE", profileIds: [] }); state.socket?.close(); state.token = ""; });

  if (typeof IntersectionObserver !== "undefined") intersectionObserver = new IntersectionObserver(entries => { for (const entry of entries) { entry.target._visible = entry.isIntersecting; if (entry.isIntersecting) ensureBookmarkPolicy(entry.target.dataset.profileId); } updateSubscriptions(); }, { rootMargin: "100px" });
  else intersectionObserver = { observe(tile) { tile._visible = true; }, unobserve() {} };

  const profilesNav = $(".navigation [data-view=profiles]"), tasksNav = $(".navigation [data-view=tasks]"); tasksNav.before(profilesNav);
  setView(location.hash.slice(1));
  $("#live-grid").innerHTML = '<div class="loading-skeleton" aria-label="Loading workspace"></div><div class="loading-skeleton" aria-hidden="true"></div>';
  bootstrap();
})();
