/* This script runs in Chrome's isolated content-script world. The Firefox
 * fallback may be injected by StakeMode's authenticated browser bridge. It
 * contains no transport token and never handles credentials or wagering. */
(() => {
  'use strict';
  if (window !== window.top) return;
  const extensionApi = typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome : (typeof browser !== 'undefined' && browser.runtime?.id ? browser : null);
  // Firefox's transport adapter is lexical inside the bridge's private wrapper.
  // No public window binding carries the nonce or profile transport token.
  const injectedSend = !extensionApi && typeof __stakemodePrivateSend === 'function' ? __stakemodePrivateSend : null;
  if (!extensionApi && !injectedSend) return;
  if (!extensionApi && typeof window.__stakemodeDispose === 'function') {
    try { window.__stakemodeDispose(); } catch { return; }
  }
  let config = { connected: false, role: 'manual', origins: [], epoch: 0, active: false };
  let generation = 0;
  let replaying = false;
  let disposed = false;
  let scrollTimer = null;
  let lastScrollCaptured = 0;
  let lastScrollIntent = 0;
  let lastReplaySeq = 0;
  let localSeq = 0;
  let observedUrl = '';
  const replayIds = new Set();
  const maxSelector = 512;
  const maxValue = 512;
  const sensitive = /(?:^|[^a-z0-9])(?:pass(?:word|code)?|pwd|secret|token|api[\s_-]*key|auth(?:entication|orize|orisation|orization)?|log[\s_-]*in|sign[\s_-]*in|sign[\s_-]*up|register|credential|username|user[\s_-]*name|email|phone|pin|code|otp|2fa|mfa|two[\s_-]*factor|verification|verify|captcha|turnstile|hcaptcha|recaptcha|challenge|deposit|withdraw(?:al)?|payout|payment|pay|purchase|buy|sell|checkout|wallet|bank|card|amount|stake|wager|bet(?:s|ting)?|place[\s_-]*bet|cash[\s_-]*out|trade|transfer|send[\s_-]*money|tip)(?:$|[^a-z0-9])/i;
  const sensitivePath = /(?:^|\/)(?:login|sign[-_]?in|sign[-_]?up|register|auth|oauth|verify|verification|2fa|mfa|captcha|challenge|deposit|withdraw(?:al)?|payout|payment|checkout|wallet|cashier)(?:\/|$)/i;
  const editableTypes = new Set(['text', 'search']);
  const interactiveSelector = 'button,a[href],input,textarea,select,[role="button"],[role="link"],[role="tab"],[contenteditable="true"]';
  const compact = (value, limit = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const sensitiveText = (value) => sensitive.test(String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2'));
  const pageIdentity = () => ({ origin: location.origin, url: `${location.origin}${location.pathname}` });
  const localHttp = () => location.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const isReady = (role) => !disposed && config.connected && config.controller !== 'worker' && config.role === role && config.active && config.origins.includes(location.origin) && (location.protocol === 'https:' || localHttp());
  const send = (message) => {
    if (disposed || JSON.stringify(message).length > 8192) return;
    if (extensionApi) {
      try { const result = extensionApi.runtime.sendMessage(message); result?.catch?.(() => localPause('Extension disconnected', false)); } catch { localPause('Extension disconnected', false); }
    } else {
      try { const result = injectedSend(message); result?.catch?.(() => localPause('Browser bridge disconnected', false)); } catch { localPause('Browser bridge disconnected', false); }
    }
  };
  function localPause(reason, notify = true) {
    config = { ...config, role: 'manual', active: false };
    generation++;
    clearTimeout(scrollTimer); scrollTimer = null;
    if (notify) send({ type: 'MANUAL_OVERRIDE', enabled: true, reason: compact(reason) });
  }
  function configure(packet) {
    if (!packet || !['admin', 'follower', 'manual'].includes(packet.role) || !Number.isSafeInteger(packet.epoch) || packet.epoch < 0 || !Array.isArray(packet.origins) || packet.origins.length > 32) return localPause('Invalid browser configuration');
    if (packet.origins.some((origin) => { try { const url = new URL(origin); const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); return (url.protocol !== 'https:' && !local) || url.origin !== origin; } catch { return true; } })) return localPause('Invalid approved origin');
    const role = packet.paused === true && packet.controller !== 'worker' ? 'manual' : packet.role;
    const changed = config.epoch !== packet.epoch || config.role !== role || config.active !== (packet.active !== false) || config.connected !== (packet.connected !== false) || config.origins.join('|') !== packet.origins.join('|');
    if (changed) { generation++; clearTimeout(scrollTimer); scrollTimer = null; lastReplaySeq = 0; replayIds.clear(); }
    config = { connected: packet.connected !== false, role, origins: [...packet.origins], epoch: packet.epoch, active: packet.active !== false, ...(packet.controller === 'worker' ? { controller: 'worker' } : {}) };
    if (changed) reportPage();
    if (config.controller !== 'worker' && (sensitivePath.test(location.pathname) || hasChallenge())) localPause('Authentication or verification page requires manual control');
  }
  function hasChallenge() {
    return !!document.querySelector('iframe[src*="challenges.cloudflare.com"],iframe[src*="hcaptcha.com"],iframe[src*="recaptcha"],.cf-turnstile,.h-captcha,.g-recaptcha,[data-sitekey],input[autocomplete="one-time-code"],input[type="password"]');
  }
  function reportPage() {
    const current = pageIdentity();
    observedUrl = current.url;
    send({ type: 'PAGE', ...current });
  }
  function metadata(element) {
    const tag = element.localName?.toLowerCase() || '';
    const result = { tag };
    const inputType = element.getAttribute('type');
    if (inputType) result.type = compact(inputType, 24).toLowerCase();
    const role = element.getAttribute('role');
    if (role) result.role = compact(role, 80);
    const name = ['name', 'id', 'data-testid', 'data-test', 'aria-label', 'title', 'autocomplete'].map((attr) => element.getAttribute(attr)).filter(Boolean).join(' | ');
    if (name) result.name = compact(name);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) result.placeholder = compact(placeholder);
    // Never include field values, account identifiers from URL parameters,
    // surrounding page content, or arbitrary form data in verification.
    if (!['input', 'textarea', 'select'].includes(tag)) {
      const text = compact(element.textContent);
      if (text) result.text = text;
    }
    if (element.hasAttribute('href')) {
      try { result.href = new URL(element.getAttribute('href'), location.href).pathname.slice(0, 512); } catch { result.href = ''; }
    }
    return result;
  }
  function targetSensitive(element) {
    if (!(element instanceof Element)) return true;
    if (element.matches('select,[contenteditable="true"],input[type="password"],input[type="email"],input[type="tel"],input[type="number"],input[type="file"],input[type="hidden"],input[type="submit"],input[type="image"]')) return true;
    if (element instanceof HTMLInputElement && !editableTypes.has(element.type.toLowerCase()) && element.type !== 'checkbox' && element.type !== 'radio') return true;
    if (element instanceof HTMLInputElement && element.maxLength > 0 && element.maxLength <= 8 && element.inputMode === 'numeric') return true;
    if (['name', 'id', 'data-testid', 'data-test', 'aria-label', 'title', 'autocomplete', 'placeholder'].some((attr) => sensitiveText(element.getAttribute(attr)))) return true;
    for (const value of Object.values(metadata(element)).slice(1)) if (sensitiveText(value)) return true;
    // Scan the associated labels and form identity rather than the entire site
    // text, which would make a site name incorrectly taint every control.
    if (element.labels && [...element.labels].some((label) => sensitiveText(label.textContent))) return true;
    const form = element.closest('form');
    if (form) {
      if (['action', 'id', 'name', 'aria-label', 'data-testid'].some((attr) => sensitiveText(form.getAttribute(attr)))) return true;
      if (form.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]')) return true;
    }
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 2 && !['body', 'html', 'main'].includes(parent.localName); depth++, parent = parent.parentElement) {
      if (['id', 'name', 'aria-label', 'data-testid', 'data-test'].some((attr) => sensitiveText(parent.getAttribute(attr)))) return true;
    }
    return false;
  }
  const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, ' ')}"`;
  const unique = (selector, element) => {
    if (selector.length > maxSelector) return false;
    try { const matches = document.querySelectorAll(selector); return matches.length === 1 && matches[0] === element; } catch { return false; }
  };
  const stableId = (value) => /^[a-zA-Z][a-zA-Z0-9_:-]{0,79}$/.test(value) && !/[a-f0-9]{10,}|\d{5,}/i.test(value);
  function directSelectors(element) {
    const tag = element.localName.toLowerCase();
    const candidates = [];
    for (const attr of ['data-testid', 'data-test', 'name', 'id', 'placeholder', 'aria-label']) {
      const value = element.getAttribute(attr);
      if (!value || value.length > 100 || sensitiveText(value) || (attr === 'id' && !stableId(value))) continue;
      candidates.push(`${tag}[${attr}=${quote(value)}]`);
    }
    if (element.getAttribute('role')) candidates.push(`${tag}[role=${quote(element.getAttribute('role'))}]`);
    return candidates;
  }
  function selectorFor(element) {
    for (const selector of directSelectors(element)) if (unique(selector, element)) return selector;
    const parts = [];
    let current = element;
    for (let depth = 0; current instanceof Element && depth < 6; depth++, current = current.parentElement) {
      const parent = current.parentElement;
      const siblings = parent ? [...parent.children].filter((item) => item.localName === current.localName) : [current];
      const structural = `${current.localName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`;
      parts.unshift(structural);
      for (const anchor of directSelectors(current)) {
        const combined = [anchor, ...parts.slice(1)].join(' > ');
        if (unique(combined, element)) return combined;
      }
      const fallback = parts.join(' > ');
      if (unique(fallback, element)) return fallback;
    }
    return null;
  }
  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    if (element.matches(':disabled,[aria-disabled="true"]') || element.closest('[inert]')) return false;
    return true;
  }
  function fingerprintMatches(element, expected) {
    const actual = metadata(element);
    if (!expected || typeof expected !== 'object' || actual.tag !== expected.tag) return false;
    for (const key of ['type', 'role', 'name', 'text', 'placeholder', 'href']) if ((actual[key] ?? '') !== (expected[key] ?? '')) return false;
    return true;
  }
  function capture(event, kind) {
    if (!event.isTrusted || replaying || !isReady('admin')) return;
    if (sensitivePath.test(location.pathname) || hasChallenge()) return localPause('Authentication or verification requires manual control');
    const raw = event.composedPath?.()[0] ?? event.target;
    const element = raw instanceof Element ? (kind === 'click' ? raw.closest(interactiveSelector) : raw) : null;
    if (!element) return;
    if (targetSensitive(element)) return localPause('Sensitive interaction requires independent manual control');
    if (!isVisible(element)) return;
    if (kind === 'input' && !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return;
    if (kind === 'input' && element instanceof HTMLInputElement && !editableTypes.has(element.type)) return;
    const selector = selectorFor(element);
    if (!selector) return localPause('No unique stable selector; use manual control');
    const packet = { type: 'ACTION', id: crypto.randomUUID(), seq: ++localSeq, epoch: config.epoch, ...pageIdentity(), action: kind, selector, fingerprint: metadata(element) };
    if (kind === 'input') {
      if (element.value.length > maxValue) return localPause('Input exceeds synchronized text limit');
      packet.value = element.value;
    }
    send(extensionApi ? { type: 'CAPTURE_ACTION', action: packet } : packet);
  }
  function scrollCapture(event) {
    if (!event.isTrusted || replaying || !isReady('admin') || event.target !== document || Date.now() - lastScrollIntent > 1000) return;
    const ticket = generation;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (ticket !== generation || !isReady('admin') || Date.now() - lastScrollCaptured < 70) return;
      if (sensitivePath.test(location.pathname) || hasChallenge()) return localPause('Authentication or verification requires manual control');
      lastScrollCaptured = Date.now();
      const packet = { type: 'ACTION', id: crypto.randomUUID(), seq: ++localSeq, epoch: config.epoch, ...pageIdentity(), action: 'scroll', x: Math.max(0, Math.min(1_000_000, Math.round(scrollX))), y: Math.max(0, Math.min(1_000_000, Math.round(scrollY))) };
      send(extensionApi ? { type: 'CAPTURE_ACTION', action: packet } : packet);
    }, 90);
  }
  const acknowledge = (packet, status, reason) => send({ type: 'ACK', id: String(packet?.id ?? '').slice(0, 80), epoch: Number.isSafeInteger(packet?.epoch) ? packet.epoch : -1, status, ...(reason ? { reason: compact(reason) } : {}) });
  function rejectReplay(packet, reason) { acknowledge(packet, 'rejected', reason); localPause(reason); }
  function receive(packet) {
    if (packet?.type === 'CONFIG') return configure(packet);
    if (packet?.type === 'PAUSE' || packet?.type === 'DISCONNECTED') return localPause('Relay paused or disconnected', false);
    if (packet?.type !== 'ACTION') return;
    if (!isReady('follower') || packet.epoch !== config.epoch) return acknowledge(packet, 'rejected', 'Profile is paused or action epoch is stale');
    if (!Number.isSafeInteger(packet.seq) || packet.seq <= lastReplaySeq || typeof packet.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(packet.id) || replayIds.has(packet.id)) return rejectReplay(packet, 'Duplicate or out-of-order action');
    if (JSON.stringify(packet).length > 8192 || packet.origin !== location.origin || packet.url !== pageIdentity().url) return rejectReplay(packet, 'Follower page does not match the administrator');
    if (sensitivePath.test(location.pathname) || hasChallenge()) return rejectReplay(packet, 'Authentication or verification requires manual control');
    const ticket = generation;
    replaying = true;
    try {
      if (packet.action === 'scroll') {
        if (![packet.x, packet.y].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000)) return rejectReplay(packet, 'Invalid scroll coordinates');
        window.scrollTo({ left: packet.x, top: packet.y, behavior: 'instant' });
      } else {
        if (!['click', 'input'].includes(packet.action) || typeof packet.selector !== 'string' || packet.selector.length > maxSelector) return rejectReplay(packet, 'Invalid action selector');
        const unquoted = packet.selector.replace(/"(?:[^"\\]|\\.)*"/g, '""');
        if (/[.<`{};]/.test(unquoted) || /:(?!nth-of-type\([1-9]\d{0,2}\))/i.test(unquoted) || sensitiveText(packet.selector)) return rejectReplay(packet, 'Unsafe action selector');
        let matches;
        try { matches = document.querySelectorAll(packet.selector); } catch { return rejectReplay(packet, 'Invalid selector syntax'); }
        if (matches.length !== 1) return rejectReplay(packet, 'Selector is missing or ambiguous');
        const element = matches[0];
        if (targetSensitive(element)) return rejectReplay(packet, 'Sensitive interaction requires manual control');
        if (!isVisible(element) || !fingerprintMatches(element, packet.fingerprint)) return rejectReplay(packet, 'Follower target verification failed');
        if (ticket !== generation || !isReady('follower')) return rejectReplay(packet, 'Manual override invalidated the action');
        if (packet.action === 'input') {
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || (element instanceof HTMLInputElement && !editableTypes.has(element.type)) || typeof packet.value !== 'string' || packet.value.length > maxValue) return rejectReplay(packet, 'Target cannot receive synchronized text');
          element.focus({ preventScroll: true });
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (!setter) return rejectReplay(packet, 'Native input setter unavailable');
          setter.call(element, packet.value);
          element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: null }));
          element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          if (element.value !== packet.value) return rejectReplay(packet, 'Framework rejected the input value');
        } else {
          if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) return rejectReplay(packet, 'Choice inputs require manual control');
          if (!(element instanceof HTMLElement)) return rejectReplay(packet, 'Target is not an HTML control');
          element.focus({ preventScroll: true });
          // DOM replay is explicitly untrusted (isTrusted=false). It is not an
          // evasion mechanism and cannot promise a website will accept it.
          element.click();
        }
      }
      lastReplaySeq = packet.seq;
      replayIds.add(packet.id);
      if (replayIds.size > 256) replayIds.delete(replayIds.values().next().value);
      acknowledge(packet, 'applied');
    } catch { rejectReplay(packet, 'Follower replay failed; use manual control'); }
    finally { replaying = false; }
  }
  const onClick = (event) => capture(event, 'click');
  const onInput = (event) => capture(event, 'input');
  const onScrollIntent = (event) => {
    if (event.isTrusted && !replaying && isReady('admin') && (event.type !== 'keydown' || ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key))) lastScrollIntent = Date.now();
  };
  const onNavigation = () => { generation++; reportPage(); if (config.controller !== 'worker' && config.role !== 'manual') localPause('Page navigation requires synchronization review'); };
  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('scroll', scrollCapture, true);
  document.addEventListener('wheel', onScrollIntent, { capture: true, passive: true });
  document.addEventListener('touchmove', onScrollIntent, { capture: true, passive: true });
  document.addEventListener('keydown', onScrollIntent, true);
  window.addEventListener('pagehide', onNavigation, true);
  window.addEventListener('popstate', onNavigation, true);
  window.addEventListener('hashchange', onNavigation, true);
  const pageWatcher = setInterval(() => {
    if (pageIdentity().url !== observedUrl) onNavigation();
    else if (config.controller !== 'worker' && config.role !== 'manual' && hasChallenge()) localPause('Verification challenge requires manual control');
  }, 1000);
  function dispose() {
    localPause('Browser bridge disposed', false);
    disposed = true;
    clearInterval(pageWatcher); clearTimeout(scrollTimer);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('scroll', scrollCapture, true);
    document.removeEventListener('wheel', onScrollIntent, true);
    document.removeEventListener('touchmove', onScrollIntent, true);
    document.removeEventListener('keydown', onScrollIntent, true);
    window.removeEventListener('pagehide', onNavigation, true);
    window.removeEventListener('popstate', onNavigation, true);
    window.removeEventListener('hashchange', onNavigation, true);
  }
  if (extensionApi) {
    extensionApi.runtime.onMessage.addListener((message, _sender, respond) => { receive(message); respond({ received: true }); return false; });
    try { extensionApi.runtime.sendMessage({ type: 'GET_STATE' }).then(configure).catch(() => localPause('Extension configuration unavailable', false)); } catch { localPause('Extension configuration unavailable', false); }
  } else {
    // Bridge entry points contain no token. Server-side role, origin, sequence
    // and event policy remain authoritative for every forwarded action.
    Object.defineProperties(window, {
      __stakemodeConfigure: { value: configure, configurable: true },
      __stakemodeReceive: { value: receive, configurable: true },
      __stakemodeDispose: { value: dispose, configurable: true },
    });
  }
  reportPage();
})();
