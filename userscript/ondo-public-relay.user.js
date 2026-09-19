// ==UserScript==
// @name         ONDO Public Mistral Relay
// @namespace    https://github.com/Ondo-Control/ondo-mistral-control-relay
// @version      0.4.0
// @description  Decrypts encrypted relay commands locally in Opera/Tampermonkey via public GitHub Raw transport.
// @match        https://chat.mistral.ai/*
// @run-at       document-idle
// @noframes
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/Ondo-Control/ondo-mistral-control-relay/main/userscript/ondo-public-relay.user.js
// @downloadURL  https://raw.githubusercontent.com/Ondo-Control/ondo-mistral-control-relay/main/userscript/ondo-public-relay.user.js
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.4.0';
  const SLOT_BASE_URL = 'https://raw.githubusercontent.com/Ondo-Control/ondo-mistral-control-relay/main/relay/slots';
  const POLL_MS = 5000;
  const PRIVATE_JWK_KEY = 'ondo.public.relay.private-jwk.v1';
  const PUBLIC_JWK_KEY = 'ondo.public.relay.public-jwk.v1';
  const SEEN_KEY = 'ondo.public.relay.seen.v1';
  const MARKER_ID = 'ondo-public-relay-marker';
  const MAX_TEXT = 20000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function clip(value, max = 220) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function bytesToB64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function b64urlToBytes(value) {
    const s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function keyId(publicJwk) {
    const canonical = `RSA-OAEP-256|${publicJwk.n}|${publicJwk.e}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return bytesToB64url(new Uint8Array(digest));
  }

  async function loadOrCreateKeypair() {
    let privateJwk = await GM.getValue(PRIVATE_JWK_KEY, null);
    let publicJwk = await GM.getValue(PUBLIC_JWK_KEY, null);

    if (!privateJwk || !publicJwk) {
      const pair = await crypto.subtle.generateKey(
        {
          name: 'RSA-OAEP',
          modulusLength: 3072,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['encrypt', 'decrypt']
      );

      privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      await GM.setValue(PRIVATE_JWK_KEY, privateJwk);
      await GM.setValue(PUBLIC_JWK_KEY, publicJwk);
    }

    const privateKey = await crypto.subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt']
    );

    return { privateKey, publicJwk, keyId: await keyId(publicJwk) };
  }

  function showMarker(state, detail, publicJwk, publicKeyId) {
    let marker = document.getElementById(MARKER_ID);
    if (!marker) {
      marker = document.createElement('div');
      marker.id = MARKER_ID;
      marker.setAttribute('role', 'status');
      marker.setAttribute('aria-live', 'polite');
      Object.assign(marker.style, {
        position: 'fixed',
        top: '10px',
        left: '10px',
        zIndex: '2147483647',
        padding: '8px 12px',
        borderRadius: '8px',
        color: '#fff',
        font: '600 12px/1.35 system-ui, sans-serif',
        boxShadow: '0 2px 10px rgba(0,0,0,.35)',
        pointerEvents: 'none',
      });
      document.documentElement.appendChild(marker);
    }

    marker.style.background = state === 'active' ? '#4058a6' : state === 'error' ? '#9d2c2c' : '#7a6200';
    marker.textContent = detail;

    if (publicJwk && publicKeyId) {
      const encoded = bytesToB64url(new TextEncoder().encode(JSON.stringify(publicJwk)));
      marker.setAttribute('aria-label', `ONDO_PUBLIC_RELAY_KEY ${publicKeyId} ${encoded}`);
      marker.dataset.relayKeyId = publicKeyId;
    }
  }

  try {
    const u = new URL(location.href);
    if (u.searchParams.get('ondo_controller') !== '1') {
      showMarker('idle', `ONDO Public Relay geladen · Aktivierung fehlt · v${VERSION}`);
      return;
    }
  } catch {
    showMarker('error', `ONDO Public Relay URL-Fehler · v${VERSION}`);
    return;
  }

  function gmRequest(details) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (v) => { if (!settled) { settled = true; resolve(v); } };
      const bad = (e) => { if (!settled) { settled = true; reject(e instanceof Error ? e : new Error(String(e))); } };
      try {
        const maybe = GM.xmlHttpRequest({
          timeout: 15000,
          ...details,
          onload: ok,
          onerror: () => bad(new Error('relay_network_error')),
          ontimeout: () => bad(new Error('relay_timeout')),
          onabort: () => bad(new Error('relay_aborted')),
        });
        if (maybe && typeof maybe.then === 'function') maybe.then(ok, bad);
      } catch (error) {
        bad(error);
      }
    });
  }

  function slotName(offsetMinutes = 0) {
    const d = new Date(Date.now() + offsetMinutes * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.enc.json`;
  }

  async function fetchOneSlot(name) {
    const r = await gmRequest({
      method: 'GET',
      url: `${SLOT_BASE_URL}/${name}?ondo_ts=${Date.now()}`,
      headers: {
        'cache-control': 'no-cache, no-store, max-age=0',
        'pragma': 'no-cache',
      },
    });
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new Error(`relay_slot_http_${r.status}`);
    const text = String(r.responseText || r.response || '').trim();
    if (!text) throw new Error('relay_slot_empty');
    return JSON.parse(text);
  }

  async function fetchEnvelope() {
    for (const offset of [0, -1, -2]) {
      const name = slotName(offset);
      const envelope = await fetchOneSlot(name);
      if (!envelope) continue;
      showMarker('active', `ONDO Public Relay aktiv · v${VERSION} · slot-ok · ${clip(envelope.command_id || name, 36)}`);
      return envelope;
    }
    showMarker('active', `ONDO Public Relay aktiv · v${VERSION} · slot-none`);
    return null;
  }

  async function seenList() {
    const value = await GM.getValue(SEEN_KEY, []);
    return Array.isArray(value) ? value : [];
  }

  async function markSeen(id) {
    const next = [...new Set([...(await seenList()), id])].slice(-200);
    await GM.setValue(SEEN_KEY, next);
  }

  async function decryptCommand(envelope, privateKey, expectedKeyId) {
    if (!envelope || envelope.schema !== 'ondo.mistral.relay.encrypted-command.v1') {
      throw new Error('invalid_envelope_schema');
    }
    if (envelope.alg !== 'RSA-OAEP-256+A256GCM') throw new Error('unsupported_alg');
    if (envelope.recipient_key_id !== expectedKeyId) throw new Error('recipient_key_mismatch');
    if (typeof envelope.command_id !== 'string' || !envelope.command_id) throw new Error('missing_command_id');
    if (typeof envelope.expires_at !== 'string') throw new Error('missing_expiry');

    const expires = Date.parse(envelope.expires_at);
    if (!Number.isFinite(expires) || Date.now() > expires) throw new Error('command_expired');
    if (expires - Date.now() > 60 * 60 * 1000) throw new Error('expiry_too_far');

    const aesRaw = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      privateKey,
      b64urlToBytes(envelope.wrapped_key)
    );

    const aesKey = await crypto.subtle.importKey(
      'raw',
      aesRaw,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlToBytes(envelope.iv) },
      aesKey,
      b64urlToBytes(envelope.ciphertext)
    );

    const command = JSON.parse(new TextDecoder().decode(plain));
    if (command.command_id !== envelope.command_id) throw new Error('command_id_mismatch');
    return command;
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function interactiveElements() {
    const selector = [
      'a[href]', 'button', 'input', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');
    return [...document.querySelectorAll(selector)].filter(visible).slice(0, 100);
  }

  function resolveTarget(target = {}) {
    if (typeof target.selector === 'string' && target.selector.trim()) {
      const found = [...document.querySelectorAll(target.selector)].filter(visible);
      if (found.length !== 1) throw new Error(`selector_match_count_${found.length}`);
      return found[0];
    }

    const exact = (value) => clip(value, 240).toLowerCase();
    const found = interactiveElements().filter((el) => {
      if (target.aria_label && exact(el.getAttribute('aria-label')) !== exact(target.aria_label)) return false;
      if (target.text && exact(el.innerText || el.textContent) !== exact(target.text)) return false;
      if (target.placeholder && exact(el.getAttribute('placeholder')) !== exact(target.placeholder)) return false;
      if (target.name && exact(el.getAttribute('name')) !== exact(target.name)) return false;
      if (target.role && exact(el.getAttribute('role')) !== exact(target.role)) return false;
      return Boolean(target.aria_label || target.text || target.placeholder || target.name || target.role);
    });
    if (found.length !== 1) throw new Error(`target_match_count_${found.length}`);
    return found[0];
  }

  function setInputValue(el, value) {
    if (value.length > MAX_TEXT) throw new Error('value_too_large');

    if (el instanceof HTMLInputElement) {
      if (el.type === 'password') throw new Error('password_field_refused');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
    } else if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else {
      throw new Error('target_not_typeable');
    }

    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function looksLikeSend(el) {
    const haystack = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.innerText,
      el.textContent,
    ].filter(Boolean).join(' ').toLowerCase();
    return /(^|\b)(send|senden|abschicken)(\b|$)/i.test(haystack);
  }

  async function execute(command) {
    if (!command || typeof command.command_id !== 'string' || typeof command.action !== 'string') {
      throw new Error('invalid_command');
    }

    if (command.target?.origin !== 'https://chat.mistral.ai') throw new Error('origin_not_authorized');
    if (location.origin !== 'https://chat.mistral.ai') throw new Error('wrong_page_origin');

    if (command.action === 'inspect_page') {
      return 'inspected';
    }

    if (command.action === 'type') {
      if (command.safety?.allow_type !== true) throw new Error('type_not_authorized');
      if (typeof command.value !== 'string') throw new Error('missing_value');
      const el = resolveTarget(command.target || {});
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      setInputValue(el, command.value);
      await sleep(150);
      return 'typed';
    }

    if (command.action === 'click') {
      if (command.safety?.allow_click !== true) throw new Error('click_not_authorized');
      const el = resolveTarget(command.target || {});
      if ('disabled' in el && el.disabled) throw new Error('target_disabled');
      if (looksLikeSend(el) && command.safety?.allow_send !== true) throw new Error('send_not_authorized');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      await sleep(120);
      el.click();
      await sleep(Math.max(150, Math.min(1200, Number(command.wait_ms) || 400)));
      return looksLikeSend(el) ? 'sent' : 'clicked';
    }

    throw new Error('unsupported_action');
  }

  async function main() {
    if (!globalThis.GM?.getValue || !globalThis.GM?.setValue || !globalThis.GM?.xmlHttpRequest) {
      showMarker('error', `ONDO Public Relay Fehler · GM API fehlt · v${VERSION}`);
      return;
    }

    let keyState;
    try {
      keyState = await loadOrCreateKeypair();
      showMarker('active', `ONDO Public Relay aktiv · v${VERSION} · key ${keyState.keyId.slice(0, 12)}`, keyState.publicJwk, keyState.keyId);
    } catch (error) {
      showMarker('error', `ONDO Public Relay Schlüssel-Fehler · ${clip(error?.message || error)} · v${VERSION}`);
      return;
    }

    for (;;) {
      try {
        const envelope = await fetchEnvelope();
        if (envelope && !(await seenList()).includes(envelope.command_id)) {
          showMarker('active', `ONDO Public Relay aktiv · v${VERSION} · empfangen · ${clip(envelope.command_id, 36)}`, keyState.publicJwk, keyState.keyId);
          const command = await decryptCommand(envelope, keyState.privateKey, keyState.keyId);
          await markSeen(command.command_id);
          const stage = await execute(command);
          showMarker('active', `ONDO Public Relay aktiv · v${VERSION} · ${stage} · ${clip(command.command_id, 36)}`, keyState.publicJwk, keyState.keyId);
        }
      } catch (error) {
        const message = clip(error?.message || error, 120);
        showMarker(
          ['command_expired', 'recipient_key_mismatch'].includes(message) ? 'idle' : 'error',
          `ONDO Public Relay · v${VERSION} · ${message}`,
          keyState.publicJwk,
          keyState.keyId
        );
      }
      await sleep(POLL_MS);
    }
  }

  main();
})();
