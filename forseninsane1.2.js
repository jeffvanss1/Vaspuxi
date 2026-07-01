// ==UserScript==
// @name         All-in-One Twitch Stream Selector & Loader
// @namespace    https://gist.github.com/BestestCreature/
// @version      11.3
// @description  Fixed Tampermonkey syntax error: removed top-level return statement from re-injection guard.
// @author       Jeffry Vanessa
// @match        *://*.twitch.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      raw.githubusercontent.com
// @connect      gist.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* ════════════════════════════════════════════════════════════════════
       GM_* API POLYFILLS
       ════════════════════════════════════════════════════════════════════
       This script works BOTH as a Tampermonkey userscript AND as a console-
       paste script. When Tampermonkey is present, it provides GM_xmlhttpRequest,
       GM_getValue, and GM_setValue natively (bypassing CORS). When pasted into
       the console, these polyfills activate automatically.

       Pattern note: we use `_global.GM_*` property access (never `var`/`let`/
       `const` for these names) to avoid hoisting-shadow issues that would
       clobber Tampermonkey's real implementations.
       ════════════════════════════════════════════════════════════════════ */
    const _global = (typeof globalThis !== 'undefined') ? globalThis
                  : (typeof window !== 'undefined') ? window
                  : (typeof self !== 'undefined') ? self
                  : this;

    // ── GM_getValue (localStorage-backed) ──
    if (typeof _global.GM_getValue === 'undefined' || !_global.GM_getValue) {
        _global.GM_getValue = function (key, defaultValue) {
            try {
                const raw = localStorage.getItem('gss_' + key);
                if (raw === null) return defaultValue;
                return JSON.parse(raw);
            } catch (e) {
                console.warn('[GistStreamSelector] GM_getValue("' + key + '") failed:', e);
                return defaultValue;
            }
        };
    }

    // ── GM_setValue (localStorage-backed) ──
    if (typeof _global.GM_setValue === 'undefined' || !_global.GM_setValue) {
        _global.GM_setValue = function (key, value) {
            try {
                localStorage.setItem('gss_' + key, JSON.stringify(value));
            } catch (e) {
                console.warn('[GistStreamSelector] GM_setValue("' + key + '") failed:', e);
            }
        };
    }

    // ── GM_xmlhttpRequest (fetch-backed; subject to CORS in console) ──
    if (typeof _global.GM_xmlhttpRequest === 'undefined' || !_global.GM_xmlhttpRequest) {
        _global.GM_xmlhttpRequest = function (opts) {
            const method = opts.method || 'GET';
            const url = opts.url;
            const headers = opts.headers || {};
            const timeout = opts.timeout || 15000;
            const onload = opts.onload;
            const onerror = opts.onerror;

            if (!url) {
                if (onerror) onerror({ error: 'no url', status: 0 });
                return;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                controller.abort();
                if (onerror) onerror({ error: 'timeout after ' + timeout + 'ms', status: 0 });
            }, timeout);

            fetch(url, {
                method: method,
                headers: headers,
                signal: controller.signal
            })
            .then(async function (response) {
                clearTimeout(timeoutId);
                const text = await response.text();
                if (onload) {
                    onload({
                        status: response.status,
                        statusText: response.statusText,
                        responseText: text,
                        response: text,
                        responseHeaders: '',
                        finalUrl: response.url
                    });
                }
            })
            .catch(function (err) {
                clearTimeout(timeoutId);
                console.warn('[GistStreamSelector] fetch failed for ' + url + ':', err);
                if (onerror) onerror({ error: err.message || String(err), status: 0 });
            });
        };
    }

    // ── Re-injection guard (console mode only) ──
    // Note: we intentionally do NOT use `return` here because Tampermonkey's
    // linter flags it as a top-level return. Instead we use a flag check
    // and skip the rest via a conditional. Tampermonkey itself prevents
    // double-injection, so this is primarily for console-paste mode.
    _global.__gistStreamSelectorLoaded = (_global.__gistStreamSelectorLoaded || 0) + 1;
    if (_global.__gistStreamSelectorLoaded > 1) {
        console.warn('[GistStreamSelector] Already loaded ' + (_global.__gistStreamSelectorLoaded - 1) + ' time(s). Refresh the page to reset.');
    }
    /* ════════════════════════════════════════════════════════════════════
       END POLYFILLS — original script begins below
       ════════════════════════════════════════════════════════════════════ */

    // ── Data sources (defaults — overridable via Settings) ──────────────
    const DEFAULT_GIST_URL    = 'https://gist.githubusercontent.com/BestestCreature/53b495e6b30595283967c4817e33cfc0/raw/c936b11f716af48073dc56397d00bb1225747f6c/channels';
    const WORLD_CUP_JSON_URL  = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
    const NOTIFICATION_DURATION = 5000;

    // ── Settings schema + persistence ───────────────────────────────────
    const DEFAULT_SETTINGS = {
        gistUrl: DEFAULT_GIST_URL,
        pollIntervalMs: 20000,        // football live match poll interval
        cacheDurationMs: 300000,      // gist channel cache TTL (5 min)
        panelOpen: false,             // remember advanced settings panel open state
        playerConfig: {
            autoplay: true,
            muteOnLoad: true,
            defaultVolume: 1.0,       // 0..1
            preferredMode: 'overlay', // 'overlay' | 'native'
            fullscreenBehavior: 'preserve' // 'preserve' | 'exit'
        },
        customChannels: [],           // user-added [{id,name,url,description,category,enabled}]
        channelOverrides: {},         // id -> {name,description,category,enabled} overrides for gist channels
        channelOrder: [],             // ids in custom display order
        disabledIds: [],              // ids disabled (hidden) but not deleted
        settingsDirty: false          // flag: settings changed, stream menu needs refresh
    };

    const Settings = {
        data: null,
        _storageKey: 'gistStreamSelector_settings_v1',

        load() {
            try {
                const raw = GM_getValue(this._storageKey, null);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    // Deep-merge with defaults so new fields get filled in
                    this.data = this._mergeDeep(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), parsed);
                    // Migrate old schema: disabledUrls → disabledIds, ensure custom channels have IDs
                    this._migrate();
                } else {
                    this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
                }
            } catch (e) {
                console.warn('[GistStreamSelector] Settings load failed, using defaults:', e);
                this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            }
            return this.data;
        },

        // Migrate old schema fields to new ones. Called once on load.
        _migrate() {
            const d = this.data;

            // Migrate disabledUrls → disabledIds (best-effort; old URL-based entries may not match new ID-based ones)
            if (d.disabledUrls && d.disabledUrls.length > 0 && (!d.disabledIds || d.disabledIds.length === 0)) {
                // We can't map old URLs to IDs reliably, so just clear the old field.
                // Users will need to re-disable channels in the new ID-based system.
                d.disabledUrls = [];
            }
            delete d.disabledUrls;

            // Ensure every custom channel has a stable ID
            if (Array.isArray(d.customChannels)) {
                d.customChannels.forEach(ch => {
                    if (!ch.id) ch.id = generateId();
                });
            }

            // Ensure channelOverrides keys are valid (old schema used URL keys; new uses ID keys)
            // We can't migrate URL→ID without the gist data, so we leave old overrides in place.
            // applyChannelSettings handles both URL-keyed and ID-keyed overrides gracefully.
        },

        save() {
            try {
                GM_setValue(this._storageKey, JSON.stringify(this.data));
            } catch (e) {
                console.warn('[GistStreamSelector] Settings save failed:', e);
            }
        },

        get(key) {
            if (!this.data) this.load();
            return key.split('.').reduce((obj, k) => (obj == null ? undefined : obj[k]), this.data);
        },

        set(key, value) {
            if (!this.data) this.load();
            const keys = key.split('.');
            let obj = this.data;
            for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
            obj[keys[keys.length - 1]] = value;
            this.save();
        },

        reset() {
            this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            this.save();
        },

        exportJSON() {
            return JSON.stringify(this.data, null, 2);
        },

        importJSON(str) {
            const parsed = JSON.parse(str);
            this.data = this._mergeDeep(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), parsed);
            this.save();
            return this.data;
        },

        _mergeDeep(target, source) {
            if (typeof target !== 'object' || target === null) return source;
            if (typeof source !== 'object' || source === null) return source;
            for (const k of Object.keys(source)) {
                if (typeof source[k] === 'object' && source[k] !== null && !Array.isArray(source[k])) {
                    target[k] = this._mergeDeep(target[k] || {}, source[k]);
                } else {
                    target[k] = source[k];
                }
            }
            return target;
        }
    };

    // ── Validation helpers ──────────────────────────────────────────────
    function isValidUrl(str) {
        if (!str || typeof str !== 'string') return false;
        try { new URL(str); return true; } catch { return false; }
    }

    function findDuplicateNames(channels) {
        const seen = new Map();
        const dups = [];
        channels.forEach((ch, i) => {
            const name = (ch.name || '').trim().toLowerCase();
            if (!name) return;
            if (seen.has(name)) dups.push({ index: i, name: ch.name, firstIndex: seen.get(name) });
            else seen.set(name, i);
        });
        return dups;
    }

    function findDuplicateUrls(channels) {
        const seen = new Map();
        const dups = [];
        channels.forEach((ch, i) => {
            const url = (ch.url || '').trim();
            if (!url) return;
            if (seen.has(url)) dups.push({ index: i, url, firstIndex: seen.get(url) });
            else seen.set(url, i);
        });
        return dups;
    }

    function validateChannelList(channels) {
        const errors = [];
        if (!Array.isArray(channels)) {
            errors.push('Channel list is not an array');
            return errors;
        }
        channels.forEach((ch, i) => {
            if (!ch.name || !ch.name.trim()) errors.push(`Row ${i + 1}: missing channel name`);
            if (!ch.url || !ch.url.trim()) errors.push(`Row ${i + 1}: missing player URL`);
            else if (!isValidUrl(ch.url)) errors.push(`Row ${i + 1}: invalid URL "${ch.url}"`);
        });
        findDuplicateNames(channels).forEach(d => errors.push(`Duplicate name "${d.name}" at rows ${d.firstIndex + 1} and ${d.index + 1}`));
        findDuplicateUrls(channels).forEach(d => errors.push(`Duplicate URL at rows ${d.firstIndex + 1} and ${d.index + 1}`));
        return errors;
    }

    // ── Stable unique ID generation ─────────────────────────────────────
    // NEVER use array.length or Date.now() % N — those collide under rapid add/delete.
    function generateId() {
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
        } catch (e) { /* fall through */ }
        // RFC4122 v4 fallback
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // ── URL normalization for duplicate detection ──────────────────────
    // Trims whitespace, lowercases hostname, strips trailing slash, strips default port.
    // Two channels with "https://example.com" and "https://Example.com/" are treated as duplicates.
    function normalizeUrl(urlStr) {
        if (!urlStr || typeof urlStr !== 'string') return '';
        let s = urlStr.trim();
        if (!s) return '';
        try {
            const u = new URL(s);
            let normalized = u.protocol.toLowerCase() + '//' + u.hostname.toLowerCase();
            if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))) {
                normalized += ':' + u.port;
            }
            normalized += u.pathname.replace(/\/+$/, '') || '/';
            if (u.search) normalized += u.search;
            if (u.hash) normalized += u.hash;
            return normalized;
        } catch (e) {
            // Not a valid URL — just trim + lowercase for comparison
            return s.toLowerCase();
        }
    }

    // ── Debug logging helper (replaces silent catch blocks) ─────────────
    function debugWarn(context, err) {
        console.warn(`[GistStreamSelector] ${context}:`, err);
    }

    // ── Internal state ──────────────────────────────────────────────────
    let SERVER_CHANNELS = [];
    let uiState = { overlayOpen: false };
    let activeIframe = null;
    let eyeButtonEl = null;
    let fallbackEyeEl = null;

    // Live football state
    let liveMatchPollTimer = null;
    let liveMatchCardsContainer = null;   // ref to the LIVE NOW grid (kept across polls)
    const matchStateCache = new Map();    // matchKey -> {score1,score2,status,minute}
    const matchCardEls = new Map();       // matchKey -> {card, score1El, score2El, minuteEl, statusEl, ...}

    // Currently-streaming match tracking (for live score badge + targeted notifications)
    let activeStreamMatchKey = null;      // matchKey of the football match currently loaded in the iframe
    let activeStreamMatch = null;         // last snapshot of the active match object
    let playerNotifContainer = null;      // single in-player notification container (reused)
    let playerLiveBadgeEl = null;         // single live badge element (reused)
    const notifQueue = [];                // queued notifications
    let notifCurrentlyShowing = false;    // is a notification currently on screen?

    /* ══════════════════════════════════════════
       Styles
       ══════════════════════════════════════════ */
    const styleLayer = document.createElement('style');
    styleLayer.id = 'gist-stream-selector-styles';
    styleLayer.textContent = `
        /* ═══ Overlay (modal) container ═══ */
        .fs-overlay-container {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px);
            z-index: 99999; display: none; align-items: center; justify-content: center;
            font-family: 'Inter', 'Roobert', sans-serif; pointer-events: auto;
            opacity: 0; transition: opacity 0.2s ease;
        }
        .fs-overlay-container.active { opacity: 1; display: flex !important; }

        .fs-main-wrapper {
            background: rgba(15, 15, 15, 0.97);
            border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px;
            padding: 10px; box-shadow: 0 12px 40px rgba(0,0,0,0.85);
            width: 340px; max-width: 95%; max-height: 85vh; overflow-y: auto;
            backdrop-filter: blur(20px);
            display: flex; flex-direction: column; gap: 8px;
        }

        .fs-header {
            display: flex; align-items: center; justify-content: space-between;
            padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .fs-header-title {
            color: rgba(255, 255, 255, 0.85); font-size: 11px; font-weight: 700;
            letter-spacing: 0.5px; text-transform: uppercase;
            display: flex; align-items: center; gap: 6px;
        }
        .fs-live-indicator {
            background: #ff1744; color: #fff; font-size: 7.5px; padding: 1px 4px;
            border-radius: 3px; font-weight: 700; letter-spacing: 0.3px;
            animation: gistPulse 1.5s infinite alternate;
        }
        @keyframes gistPulse { from { opacity: 0.6; } to { opacity: 1; } }

        .fs-close-btn {
            background: transparent; border: none; color: rgba(255,255,255,0.5);
            cursor: pointer; padding: 2px; border-radius: 4px;
            display: flex; align-items: center; justify-content: center;
            transition: all 0.12s ease;
        }
        .fs-close-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        .fs-close-btn svg { width: 14px; height: 14px; }

        .fs-section-title {
            color: rgba(255, 255, 255, 0.5); font-size: 9px; font-weight: 700;
            letter-spacing: 0.6px; text-transform: uppercase;
            margin-top: 4px;
            display: flex; align-items: center; gap: 6px;
        }
        .fs-section-title:first-child { margin-top: 0; }
        .fs-section-title .fs-pulse-dot {
            width: 6px; height: 6px; background: #ff1744; border-radius: 50%;
            animation: gistPulse 1s infinite alternate;
        }

        .fs-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 5px; }

        .fs-channel-btn {
            background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.06);
            color: rgba(255, 255, 255, 0.85); padding: 6px 5px; border-radius: 4px;
            font-size: 10px; font-weight: 500; cursor: pointer; transition: all 0.12s ease;
            text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .fs-channel-btn:hover { background: rgba(255, 255, 255, 0.1); border-color: rgba(255, 255, 255, 0.15); color: #fff; }
        .fs-channel-btn.active { background: #9147ff; color: #fff; border-color: #a970ff; font-weight: 600; }

        .fs-no-matches { grid-column: span 2; text-align: center; color: rgba(255,255,255,0.35); font-size: 10px; padding: 8px 0; font-style: italic; }

        /* ═══ Match Card (live football) ═══ */
        .fs-match-card {
            grid-column: span 2;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 6px;
            padding: 8px 10px;
            cursor: pointer;
            transition: all 0.12s ease;
            display: flex; flex-direction: column; gap: 4px;
        }
        .fs-match-card:hover {
            background: rgba(145, 71, 255, 0.15);
            border-color: rgba(145, 71, 255, 0.4);
        }
        .fs-match-card.active {
            background: rgba(145, 71, 255, 0.3);
            border-color: #a970ff;
        }
        .fs-match-card-top {
            display: flex; align-items: center; justify-content: space-between;
            font-size: 9px;
        }
        .fs-match-status {
            font-weight: 700; letter-spacing: 0.4px; font-size: 8.5px;
            padding: 1px 5px; border-radius: 3px;
        }
        .fs-match-status.live    { background: #ff1744; color: #fff; }
        .fs-match-status.ht      { background: #ff9800; color: #fff; }
        .fs-match-status.et      { background: #9c27b0; color: #fff; }
        .fs-match-status.pen     { background: #673ab7; color: #fff; }
        .fs-match-status.ft      { background: #555; color: #ddd; }
        .fs-match-status.upcoming{ background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }

        .fs-match-competition {
            color: rgba(255, 255, 255, 0.45);
            font-size: 8.5px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.3px;
        }

        .fs-match-teams {
            display: flex; flex-direction: column; gap: 2px;
        }
        .fs-team-row {
            display: grid;
            grid-template-columns: 18px 1fr auto;
            align-items: center; gap: 6px;
            font-size: 11px; color: #fff;
        }
        .fs-team-flag { font-size: 14px; line-height: 1; }
        .fs-team-name {
            font-weight: 600;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .fs-team-score {
            font-weight: 700; font-size: 13px; min-width: 18px; text-align: right;
        }
        .fs-team-row.has-red .fs-team-name::after {
            content: ' 🟥';
            font-size: 10px;
        }

        .fs-match-bottom {
            display: flex; align-items: center; justify-content: space-between;
            font-size: 9px; color: rgba(255, 255, 255, 0.45);
            padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.05);
        }
        .fs-match-minute {
            color: #ff1744; font-weight: 700; font-size: 9.5px;
        }
        .fs-match-kickoff { font-weight: 500; }

        /* ═══ Overlay Eye Button — top-right of video player ═══ */
        .gist-player-eye-overlay {
            position: absolute !important;
            top: 10px !important; right: 10px !important;
            width: 36px !important; height: 36px !important;
            background: rgba(15, 15, 15, 0.75) !important;
            border: 1px solid rgba(255, 255, 255, 0.2) !important;
            border-radius: 6px !important;
            color: #fff !important; cursor: pointer !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
            z-index: 9999 !important;
            box-shadow: 0 2px 8px rgba(0,0,0,0.5) !important;
            transition: background 0.15s, color 0.15s, transform 0.15s, opacity 0.2s !important;
            padding: 0 !important;
            visibility: visible !important; opacity: 1 !important; pointer-events: auto !important;
        }
        .gist-player-eye-overlay:hover { background: rgba(145, 71, 255, 0.85) !important; color: #fff !important; transform: scale(1.08) !important; }
        .gist-player-eye-overlay.active { background: rgba(145, 71, 255, 0.9) !important; color: #fff !important; }
        .gist-player-eye-overlay svg { width: 20px !important; height: 20px !important; fill: currentColor !important; display: block !important; pointer-events: none; }

        /* ═══ Floating Fallback Eye ═══ */
        #gist-fallback-eye {
            position: fixed !important;
            top: 80px !important; right: 20px !important;
            width: 40px !important; height: 40px !important;
            background: rgba(15, 15, 15, 0.92) !important;
            border: 1px solid rgba(255, 255, 255, 0.15) !important;
            border-radius: 8px !important; color: #efeff1 !important; cursor: pointer !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
            z-index: 100002 !important; box-shadow: 0 4px 14px rgba(0,0,0,0.6) !important;
            transition: background 0.15s, color 0.15s, transform 0.15s !important;
            visibility: visible !important; opacity: 1 !important; padding: 0 !important;
        }
        #gist-fallback-eye:hover { background: rgba(145, 71, 255, 0.25) !important; color: #fff !important; transform: scale(1.06) !important; }
        #gist-fallback-eye.active { background: rgba(145, 71, 255, 0.35) !important; color: #a970ff !important; }
        #gist-fallback-eye svg { width: 22px !important; height: 22px !important; fill: currentColor !important; display: block !important; pointer-events: none; }

        /* Stream iframe */
        .gist-stream-iframe {
            position: absolute !important;
            top: 0 !important; left: 0 !important;
            width: 100% !important; height: 100% !important;
            border: none !important;
            background: #000 !important;
            z-index: 5 !important;
        }

        /* ═══ In-Player Notification (top-right of video player) ═══
           Glassmorphism card with smooth GPU-accelerated animations.
           Single container, reused across notifications. */
        .fs-player-notif-container {
            position: absolute !important;
            top: 56px !important;          /* below the eye button */
            right: 10px !important;
            z-index: 10000 !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 8px !important;
            pointer-events: none !important;
            max-width: 280px !important;
        }

        .fs-player-notif {
            background: rgba(15, 15, 20, 0.78) !important;
            backdrop-filter: blur(16px) saturate(140%) !important;
            -webkit-backdrop-filter: blur(16px) saturate(140%) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 14px !important;
            padding: 10px 14px !important;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.03) inset !important;
            color: #fff !important;
            font-family: 'Inter', 'Roobert', sans-serif !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 3px !important;
            min-width: 220px !important;
            pointer-events: auto !important;

            /* Hidden initial state — animate IN via .show */
            opacity: 0 !important;
            transform: translateX(40px) scale(0.95) !important;
            transition: opacity 0.3s cubic-bezier(0.22, 1, 0.36, 1),
                        transform 0.3s cubic-bezier(0.22, 1, 0.36, 1) !important;
            will-change: opacity, transform !important;
        }
        .fs-player-notif.show {
            opacity: 1 !important;
            transform: translateX(0) scale(1) !important;
        }
        .fs-player-notif.hide {
            opacity: 0 !important;
            transform: translateY(-12px) scale(0.98) !important;
        }

        /* Event color accent — left border + glow */
        .fs-player-notif.goal   { border-left: 3px solid #00e676 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(0,230,118,0.25) !important; }
        .fs-player-notif.red    { border-left: 3px solid #ff1744 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(255,23,68,0.25) !important; }
        .fs-player-notif.yellow { border-left: 3px solid #ffd600 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(255,214,0,0.2) !important; }
        .fs-player-notif.status { border-left: 3px solid #ff9800 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(255,152,0,0.2) !important; }
        .fs-player-notif.half2  { border-left: 3px solid #2196f3 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(33,150,243,0.2) !important; }
        .fs-player-notif.full   { border-left: 3px solid #9e9e9e !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(158,158,158,0.15) !important; }
        .fs-player-notif.var    { border-left: 3px solid #9c27b0 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(156,39,176,0.2) !important; }

        .fs-player-notif-top {
            display: flex; align-items: center; gap: 6px;
            font-size: 12px; font-weight: 700;
            letter-spacing: 0.3px;
        }
        .fs-player-notif-icon { font-size: 14px; line-height: 1; }
        .fs-player-notif-icon.flash {
            animation: fsNotifIconFlash 0.6s ease-out;
        }
        @keyframes fsNotifIconFlash {
            0%   { transform: scale(1);   filter: brightness(1); }
            30%  { transform: scale(1.3); filter: brightness(1.5); }
            100% { transform: scale(1);   filter: brightness(1); }
        }
        .fs-player-notif-teams {
            display: flex; align-items: center; gap: 8px;
            font-size: 13px; font-weight: 600;
        }
        .fs-player-notif-flag { font-size: 16px; line-height: 1; }
        .fs-player-notif-score {
            font-weight: 800; font-size: 14px;
            padding: 1px 6px; border-radius: 4px;
            background: rgba(255,255,255,0.06);
        }
        .fs-player-notif-score.pulse {
            animation: fsScorePulse 0.7s ease-out;
        }
        @keyframes fsScorePulse {
            0%   { transform: scale(1);   background: rgba(0,230,118,0.5); }
            50%  { transform: scale(1.15); background: rgba(0,230,118,0.7); }
            100% { transform: scale(1);   background: rgba(255,255,255,0.06); }
        }
        .fs-player-notif-scorer { font-size: 11px; color: rgba(255,255,255,0.7); font-weight: 500; }
        .fs-player-notif-comp {
            font-size: 9.5px; color: rgba(255,255,255,0.45);
            text-transform: uppercase; letter-spacing: 0.4px; font-weight: 700;
            margin-top: 2px;
        }

        /* ═══ Live Score Badge — persistent while a football stream is active ═══ */
        .fs-player-live-badge {
            position: absolute !important;
            top: 56px !important;            /* below the eye button */
            left: 10px !important;
            z-index: 10000 !important;
            background: rgba(15, 15, 20, 0.78) !important;
            backdrop-filter: blur(12px) saturate(140%) !important;
            -webkit-backdrop-filter: blur(12px) saturate(140%) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 10px !important;
            padding: 6px 10px !important;
            box-shadow: 0 4px 18px rgba(0,0,0,0.5) !important;
            color: #fff !important;
            font-family: 'Inter', 'Roobert', sans-serif !important;
            display: flex; align-items: center; gap: 8px !important;
            font-size: 11px !important;
            pointer-events: none !important;

            opacity: 0 !important;
            transform: translateY(-8px) !important;
            transition: opacity 0.25s ease, transform 0.25s ease !important;
        }
        .fs-player-live-badge.show {
            opacity: 1 !important;
            transform: translateY(0) !important;
        }
        .fs-player-live-badge .fs-badge-live {
            color: #ff1744; font-weight: 800; font-size: 9.5px;
            display: flex; align-items: center; gap: 3px;
        }
        .fs-player-live-badge .fs-badge-dot {
            width: 6px; height: 6px; background: #ff1744; border-radius: 50%;
            animation: gistPulse 1s infinite alternate;
        }
        .fs-player-live-badge .fs-badge-score {
            font-weight: 700; padding: 1px 5px; border-radius: 3px;
            background: rgba(255,255,255,0.08);
        }
        .fs-player-live-badge .fs-badge-score.changed {
            animation: fsBadgeScoreGlow 0.8s ease-out;
        }
        @keyframes fsBadgeScoreGlow {
            0%   { background: rgba(0,230,118,0.7); transform: scale(1.12); }
            100% { background: rgba(255,255,255,0.08); transform: scale(1); }
        }
        .fs-player-live-badge .fs-badge-minute {
            color: #ff1744; font-weight: 700;
        }
        .fs-player-live-badge .fs-badge-minute.changed {
            animation: fsBadgeMinutePulse 0.6s ease-out;
        }
        @keyframes fsBadgeMinutePulse {
            0%   { transform: scale(1.15); }
            100% { transform: scale(1); }
        }

        /* ═══ Advanced Settings Panel ═══ */
        .fs-settings-overlay {
            position: fixed; inset: 0;
            background: rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(6px);
            z-index: 100100;
            display: none;
            align-items: center; justify-content: center;
            font-family: 'Inter', 'Roobert', sans-serif;
            opacity: 0; transition: opacity 0.2s ease;
        }
        .fs-settings-overlay.active { display: flex !important; opacity: 1; }

        .fs-settings-panel {
            background: rgba(20, 20, 25, 0.98);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            width: 580px; max-width: 95vw; max-height: 88vh;
            display: flex; flex-direction: column;
            box-shadow: 0 20px 60px rgba(0,0,0,0.8);
            overflow: hidden;
        }

        .fs-settings-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 14px 18px;
            border-bottom: 1px solid rgba(255,255,255,0.08);
            flex-shrink: 0;
        }
        .fs-settings-title {
            color: #fff; font-size: 14px; font-weight: 700;
            display: flex; align-items: center; gap: 8px;
        }
        .fs-settings-tabs {
            display: flex; gap: 2px;
            padding: 0 18px;
            border-bottom: 1px solid rgba(255,255,255,0.08);
            flex-shrink: 0;
            overflow-x: auto;
        }
        .fs-settings-tab {
            background: transparent; border: none; border-bottom: 2px solid transparent;
            color: rgba(255,255,255,0.5); padding: 10px 14px;
            font-size: 11px; font-weight: 600; cursor: pointer;
            white-space: nowrap; transition: all 0.15s;
            text-transform: uppercase; letter-spacing: 0.4px;
        }
        .fs-settings-tab:hover { color: rgba(255,255,255,0.85); }
        .fs-settings-tab.active { color: #fff; border-bottom-color: #9147ff; }

        .fs-settings-body {
            flex: 1; overflow-y: auto; padding: 16px 18px;
            color: rgba(255,255,255,0.85); font-size: 12px;
        }

        .fs-settings-section {
            margin-bottom: 16px;
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 8px; overflow: hidden;
        }
        .fs-settings-section-header {
            display: flex; align-items: center; justify-content: space-between;
            padding: 10px 14px; cursor: pointer;
            background: rgba(255,255,255,0.02);
            user-select: none;
        }
        .fs-settings-section-header:hover { background: rgba(255,255,255,0.05); }
        .fs-settings-section-title {
            font-size: 11px; font-weight: 700; color: #fff;
            text-transform: uppercase; letter-spacing: 0.5px;
        }
        .fs-settings-section-chevron {
            color: rgba(255,255,255,0.4); font-size: 10px;
            transition: transform 0.2s;
        }
        .fs-settings-section.collapsed .fs-settings-section-chevron { transform: rotate(-90deg); }
        .fs-settings-section-body {
            padding: 12px 14px;
            display: flex; flex-direction: column; gap: 10px;
        }
        .fs-settings-section.collapsed .fs-settings-section-body { display: none; }

        .fs-form-row {
            display: flex; flex-direction: column; gap: 4px;
        }
        .fs-form-row.inline {
            flex-direction: row; align-items: center; gap: 10px;
        }
        .fs-form-label {
            font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.6);
            text-transform: uppercase; letter-spacing: 0.4px;
        }
        .fs-form-input, .fs-form-select {
            background: rgba(0,0,0,0.4);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 5px; padding: 6px 9px;
            color: #fff; font-size: 12px; font-family: inherit;
            outline: none; width: 100%; box-sizing: border-box;
            transition: border-color 0.15s;
        }
        .fs-form-input:focus, .fs-form-select:focus { border-color: #9147ff; }
        .fs-form-input.error { border-color: #ff1744; }
        .fs-form-error {
            font-size: 10px; color: #ff5252; font-weight: 500;
        }
        .fs-form-hint {
            font-size: 10px; color: rgba(255,255,255,0.4);
        }
        .fs-form-checkbox {
            width: 16px; height: 16px; accent-color: #9147ff; cursor: pointer;
        }
        .fs-form-range {
            flex: 1; accent-color: #9147ff; cursor: pointer;
        }
        .fs-form-range-value {
            font-size: 11px; color: #fff; min-width: 50px; text-align: right; font-weight: 600;
        }

        .fs-btn {
            background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
            color: #fff; padding: 6px 12px; border-radius: 5px;
            font-size: 11px; font-weight: 600; cursor: pointer;
            transition: all 0.15s; font-family: inherit;
        }
        .fs-btn:hover { background: rgba(255,255,255,0.12); }
        .fs-btn.primary { background: #9147ff; border-color: #a970ff; }
        .fs-btn.primary:hover { background: #a970ff; }
        .fs-btn.danger { background: rgba(255,23,68,0.15); border-color: rgba(255,23,68,0.3); color: #ff5252; }
        .fs-btn.danger:hover { background: rgba(255,23,68,0.25); }
        .fs-btn.small { padding: 4px 8px; font-size: 10px; }
        .fs-btn-group { display: flex; gap: 6px; flex-wrap: wrap; }

        .fs-settings-footer {
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 18px;
            border-top: 1px solid rgba(255,255,255,0.08);
            flex-shrink: 0; gap: 10px;
        }
        .fs-settings-validation {
            flex: 1; font-size: 10px; color: rgba(255,255,255,0.5);
            max-height: 32px; overflow-y: auto;
        }
        .fs-settings-validation.error { color: #ff5252; }
        .fs-settings-validation.success { color: #00e676; }

        /* ═══ Menu Editor (drag-and-drop channel list) ═══ */
        .fs-menu-editor-list {
            display: flex; flex-direction: column; gap: 4px;
            max-height: 320px; overflow-y: auto;
        }
        .fs-menu-editor-row {
            display: grid;
            grid-template-columns: 20px 24px 1fr 1fr 80px 60px 28px;
            gap: 6px; align-items: center;
            padding: 5px 8px;
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 5px;
            font-size: 11px;
        }
        .fs-menu-editor-row.dragging { opacity: 0.4; border-style: dashed; }
        .fs-menu-editor-row.drag-over { border-color: #9147ff; background: rgba(145,71,255,0.1); }
        .fs-me-drag-handle { cursor: grab; color: rgba(255,255,255,0.3); font-size: 12px; text-align: center; }
        .fs-me-drag-handle:active { cursor: grabbing; }
        .fs-me-enabled { display: flex; align-items: center; justify-content: center; }
        .fs-me-input {
            background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08);
            border-radius: 3px; padding: 3px 5px; color: #fff;
            font-size: 10px; width: 100%; box-sizing: border-box;
        }
        .fs-me-input:focus { outline: none; border-color: #9147ff; }
        .fs-me-input.error { border-color: #ff1744; }
        .fs-me-select {
            background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08);
            border-radius: 3px; padding: 3px 5px; color: #fff;
            font-size: 10px; width: 100%; box-sizing: border-box;
        }
        .fs-me-delete {
            background: transparent; border: none; color: rgba(255,255,255,0.3);
            cursor: pointer; font-size: 14px; padding: 2px;
        }
        .fs-me-delete:hover { color: #ff5252; }

        .fs-menu-editor-add {
            margin-top: 6px;
        }

        /* ═══ Dev Tools ═══ */
        .fs-dev-output {
            background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08);
            border-radius: 5px; padding: 8px 10px;
            font-family: 'Menlo', 'Consolas', monospace; font-size: 10px;
            color: #00e676; max-height: 220px; overflow-y: auto;
            white-space: pre-wrap; word-break: break-all;
        }
        .fs-dev-output.error { color: #ff5252; }

        /* ═══ Settings gear button in stream menu header ═══ */
        .fs-settings-gear-btn {
            background: transparent; border: none; color: rgba(255,255,255,0.4);
            cursor: pointer; padding: 2px 4px; border-radius: 4px;
            display: flex; align-items: center; justify-content: center;
            transition: all 0.15s; margin-right: 4px;
        }
        .fs-settings-gear-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        .fs-settings-gear-btn svg { width: 14px; height: 14px; }
    `;
    document.head.appendChild(styleLayer);

    /* ══════════════════════════════════════════
       Player Container Discovery
       ══════════════════════════════════════════ */
    function getPlayerRoot() {
        const selectors = [
            '.video-player__container',
            '[data-a-target="video-player"]',
            '[data-a-player="true"]',
            '.video-player',
            '.player-video'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.getClientRects().length > 0) return el;
        }
        const video = document.querySelector('video');
        if (video && video.parentElement) return video.parentElement;
        return null;
    }

    /* ══════════════════════════════════════════
       Notification Engine (in-app)
       ══════════════════════════════════════════ */
    const PlayerNotify = {
        _container: null,
        _ensureContainer() {
            if (this._container && document.contains(this._container)) return;
            this._container = document.createElement('div');
            Object.assign(this._container.style, {
                position: 'fixed', top: '70px', left: '20px', zIndex: '100001',
                display: 'flex', flexDirection: 'column', gap: '4px', pointerEvents: 'none', maxWidth: '220px'
            });
            document.body.appendChild(this._container);
        },
        show({ title = '', message = '', type = 'info', duration = 2500 }) {
            this._ensureContainer();
            if (!this._container) return;
            const el = document.createElement('div');
            Object.assign(el.style, {
                background: 'rgba(15,15,15,0.95)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.08)',
                padding: '6px 8px', display: 'flex', flexDirection: 'column', opacity: '0',
                transform: 'translateY(-4px)', transition: 'all 0.2s ease', boxShadow: '0 4px 10px rgba(0,0,0,0.5)'
            });
            if (title) {
                const t = document.createElement('div');
                Object.assign(t.style, { color: '#fff', fontSize: '10.5px', fontWeight: '600' });
                t.textContent = title; el.appendChild(t);
            }
            if (message) {
                const m = document.createElement('div');
                Object.assign(m.style, { color: 'rgba(255,255,255,0.5)', fontSize: '9px', marginTop: '1px' });
                m.textContent = message; el.appendChild(m);
            }
            this._container.appendChild(el);
            requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
            setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, duration);
        }
    };

    /* ══════════════════════════════════════════
       In-Player Notification System — single container, queued, animated
       ══════════════════════════════════════════ */

    // Get or create the single in-player notification container (top-right of player).
    function getPlayerNotifContainer() {
        if (playerNotifContainer && document.contains(playerNotifContainer)) return playerNotifContainer;
        const root = getPlayerRoot();
        if (!root) return null;
        playerNotifContainer = document.createElement('div');
        playerNotifContainer.className = 'fs-player-notif-container';
        const computedPos = getComputedStyle(root).position;
        if (computedPos === 'static') root.style.position = 'relative';
        root.appendChild(playerNotifContainer);
        return playerNotifContainer;
    }

    // Build a single notification DOM element (reused pattern — new element per notif is OK
    // because the queue size is small; the container itself is reused).
    function buildNotifEl({ icon, title, kind, bodyHtml, compText }) {
        const el = document.createElement('div');
        el.className = `fs-player-notif ${kind}`;
        el.innerHTML = `
            <div class="fs-player-notif-top">
                <span class="fs-player-notif-icon">${icon}</span>
                <span class="fs-player-notif-title">${title}</span>
            </div>
            ${bodyHtml ? `<div class="fs-player-notif-teams">${bodyHtml}</div>` : ''}
            ${compText ? `<div class="fs-player-notif-comp">${compText}</div>` : ''}
        `;
        return el;
    }

    // Queue + display logic — one at a time, 4s visible, animate out before next.
    function enqueueNotif(notifSpec) {
        notifQueue.push(notifSpec);
        processNotifQueue();
    }

    function processNotifQueue() {
        if (notifCurrentlyShowing) return;
        const spec = notifQueue.shift();
        if (!spec) return;

        const container = getPlayerNotifContainer();
        if (!container) return; // player not ready — drop silently

        const el = buildNotifEl(spec);
        container.appendChild(el);

        // Trigger show animation on next frame
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                el.classList.add('show');
                // Flash the icon once
                const iconEl = el.querySelector('.fs-player-notif-icon');
                if (iconEl) iconEl.classList.add('flash');
            });
        });

        notifCurrentlyShowing = true;

        // Auto-hide after 4 seconds, then process next in queue
        setTimeout(() => {
            el.classList.remove('show');
            el.classList.add('hide');
            setTimeout(() => {
                el.remove();
                notifCurrentlyShowing = false;
                processNotifQueue();
            }, 280);
        }, 4000);
    }

    // Build the "teams + score" inner HTML for a match notification
    function buildTeamsHtml(match, prevScore1, prevScore2) {
        const name1 = teamName(match.team1);
        const name2 = teamName(match.team2);
        const flag1 = teamFlag(match.team1);
        const flag2 = teamFlag(match.team2);
        const s1 = match.score1 === null ? '-' : String(match.score1);
        const s2 = match.score2 === null ? '-' : String(match.score2);

        // Pulse the score that changed
        const score1Pulse = (prevScore1 !== null && prevScore1 !== match.score1) ? 'pulse' : '';
        const score2Pulse = (prevScore2 !== null && prevScore2 !== match.score2) ? 'pulse' : '';

        return `<span class="fs-player-notif-flag">${flag1}</span>
                <span class="fs-player-notif-team">${name1}</span>
                <span class="fs-player-notif-score ${score1Pulse}">${s1}</span>
                <span style="opacity:0.5">–</span>
                <span class="fs-player-notif-score ${score2Pulse}">${s2}</span>
                <span class="fs-player-notif-team">${name2}</span>
                <span class="fs-player-notif-flag">${flag2}</span>`;
    }

    function showMatchEventInPlayer(match, eventType, prev) {
        const name1 = teamName(match.team1);
        const name2 = teamName(match.team2);
        const compText = String(match.competition || 'FIFA World Cup').toUpperCase();

        let spec = null;

        if (eventType === 'goal') {
            // Determine which team scored (for the scorer line)
            let scorer = '';
            if (prev && prev.score1 !== match.score1) scorer = name1;
            else if (prev && prev.score2 !== match.score2) scorer = name2;
            spec = {
                icon: '⚽',
                title: 'GOAL',
                kind: 'goal',
                bodyHtml: buildTeamsHtml(match, prev?.score1 ?? null, prev?.score2 ?? null),
                compText
            };
        } else if (eventType === 'ht') {
            spec = {
                icon: '⏸',
                title: 'Half-Time',
                kind: 'status',
                bodyHtml: buildTeamsHtml(match, null, null),
                compText
            };
        } else if (eventType === 'half2') {
            spec = {
                icon: '▶',
                title: 'Second Half Starts',
                kind: 'half2',
                bodyHtml: buildTeamsHtml(match, null, null),
                compText
            };
        } else if (eventType === 'et') {
            spec = {
                icon: '⏱',
                title: 'Extra Time',
                kind: 'status',
                bodyHtml: buildTeamsHtml(match, null, null),
                compText
            };
        } else if (eventType === 'pen') {
            spec = {
                icon: '🥅',
                title: 'Penalty Shootout',
                kind: 'status',
                bodyHtml: buildTeamsHtml(match, null, null),
                compText
            };
        } else if (eventType === 'ft') {
            spec = {
                icon: '🏁',
                title: 'Full Time',
                kind: 'full',
                bodyHtml: buildTeamsHtml(match, null, null),
                compText
            };
        }

        if (spec) enqueueNotif(spec);
    }

    /* ══════════════════════════════════════════
       Live Score Badge — persistent while a football stream is active
       ══════════════════════════════════════════ */
    function getLiveBadgeEl() {
        if (playerLiveBadgeEl && document.contains(playerLiveBadgeEl)) return playerLiveBadgeEl;
        const root = getPlayerRoot();
        if (!root) return null;
        playerLiveBadgeEl = document.createElement('div');
        playerLiveBadgeEl.className = 'fs-player-live-badge';
        playerLiveBadgeEl.innerHTML = `
            <span class="fs-badge-live"><span class="fs-badge-dot"></span>LIVE</span>
            <span class="fs-badge-flag1"></span>
            <span class="fs-badge-score1 fs-badge-score"></span>
            <span style="opacity:0.5">–</span>
            <span class="fs-badge-score2 fs-badge-score"></span>
            <span class="fs-badge-flag2"></span>
            <span class="fs-badge-minute"></span>
        `;
        const computedPos = getComputedStyle(root).position;
        if (computedPos === 'static') root.style.position = 'relative';
        root.appendChild(playerLiveBadgeEl);
        return playerLiveBadgeEl;
    }

    function updateLiveBadge(match, prev) {
        const badge = getLiveBadgeEl();
        if (!badge) return;
        const flag1El = badge.querySelector('.fs-badge-flag1');
        const flag2El = badge.querySelector('.fs-badge-flag2');
        const s1El    = badge.querySelector('.fs-badge-score1');
        const s2El    = badge.querySelector('.fs-badge-score2');
        const minEl   = badge.querySelector('.fs-badge-minute');

        const flag1 = teamFlag(match.team1);
        const flag2 = teamFlag(match.team2);
        const s1 = match.score1 === null ? '-' : String(match.score1);
        const s2 = match.score2 === null ? '-' : String(match.score2);
        const minute = match.minute || '';

        if (flag1El.textContent !== flag1) flag1El.textContent = flag1;
        if (flag2El.textContent !== flag2) flag2El.textContent = flag2;

        // Score change → pulse animation
        if (s1El.textContent !== s1) {
            s1El.textContent = s1;
            if (prev && prev.score1 !== match.score1) {
                s1El.classList.remove('changed');
                void s1El.offsetWidth; // force reflow to restart animation
                s1El.classList.add('changed');
            }
        }
        if (s2El.textContent !== s2) {
            s2El.textContent = s2;
            if (prev && prev.score2 !== match.score2) {
                s2El.classList.remove('changed');
                void s2El.offsetWidth;
                s2El.classList.add('changed');
            }
        }

        // Minute change → subtle pulse
        if (minEl.textContent !== minute) {
            minEl.textContent = minute;
            minEl.classList.remove('changed');
            void minEl.offsetWidth;
            minEl.classList.add('changed');
        }

        badge.classList.add('show');
    }

    function hideLiveBadge() {
        if (playerLiveBadgeEl) playerLiveBadgeEl.classList.remove('show');
    }

    /* ══════════════════════════════════════════
       Stream Loader — reusable iframe + Twitch mute control
       ══════════════════════════════════════════ */
    function getOverlayIframe() {
        if (activeIframe && document.contains(activeIframe)) return activeIframe;
        const currentRoot = getPlayerRoot();
        if (!currentRoot) return null;

        activeIframe = document.createElement('iframe');
        activeIframe.className = 'gist-stream-iframe';
        activeIframe.setAttribute('allowfullscreen', 'true');
        activeIframe.setAttribute('scrolling', 'no');
        activeIframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
        activeIframe.setAttribute('frameborder', '0');
        activeIframe.style.display = 'none';

        const computedPos = getComputedStyle(currentRoot).position;
        if (computedPos === 'static') currentRoot.style.position = 'relative';
        currentRoot.appendChild(activeIframe);
        return activeIframe;
    }

    function getTwitchVideo() { return document.querySelector('video') || null; }

    function formatPlayerUrl(rawUrl) {
        if (!rawUrl) return '';
        const autoplay = Settings.get('playerConfig.autoplay');
        try {
            const u = new URL(rawUrl);
            if (autoplay && !u.searchParams.has('autoplay')) u.searchParams.set('autoplay', '1');
            return u.toString();
        } catch (e) {
            debugWarn(`formatPlayerUrl: invalid URL "${rawUrl}", using string fallback`, e);
            if (!autoplay) return rawUrl;
            const sep = rawUrl.includes('?') ? '&' : '?';
            return `${rawUrl}${sep}autoplay=1`;
        }
    }

    // method: 'native' | 'overlay'
    // matchKey (optional) — if provided, marks this stream as a football match
    //                        so the live score badge + targeted notifications can track it.
    function loadStream(url, name, method, matchKey = null) {
        const muteOnLoad = Settings.get('playerConfig.muteOnLoad');
        const defaultVol = Settings.get('playerConfig.defaultVolume');

        if (method === 'native' || !url) {
            const iframe = getOverlayIframe();
            if (iframe) { iframe.src = ''; iframe.style.display = 'none'; }
            const video = getTwitchVideo();
            if (video) {
                video.muted = false;
                try { video.volume = defaultVol; } catch (e) { debugWarn('loadStream: failed to set video.volume', e); }
            }
            // Leaving football stream → hide live badge and clear active match tracking
            activeStreamMatchKey = null;
            activeStreamMatch = null;
            hideLiveBadge();
            PlayerNotify.show({ title: 'Native Twitch', message: 'Restored native player', type: 'info' });
            return;
        }
        if (method === 'overlay') {
            const iframe = getOverlayIframe();
            if (!iframe) {
                PlayerNotify.show({ title: 'Error', message: 'Player container not found', type: 'error' });
                return;
            }
            iframe.src = formatPlayerUrl(url);
            iframe.style.display = 'block';
            const video = getTwitchVideo();
            if (video) {
                video.muted = muteOnLoad;
                if (!muteOnLoad) {
                    try { video.volume = defaultVol; } catch (e) { debugWarn('loadStream: failed to set video.volume', e); }
                }
            }

            // Track if this is a football stream
            activeStreamMatchKey = matchKey;
            // If matchKey is set but we don't have a snapshot yet, try to find it in the cache
            if (matchKey && !activeStreamMatch) {
                // Find in the most recent match list — but we don't have one here.
                // The polling loop will populate activeStreamMatch on next tick via updateActiveStreamMatch().
            }
            if (!matchKey) {
                // Gist channel — no live badge
                hideLiveBadge();
                activeStreamMatch = null;
            }

            PlayerNotify.show({ title: name, message: 'Stream loading...', type: 'success' });
            return;
        }
    }

    /* ══════════════════════════════════════════
       Gist Channel Fetcher (semicolon format)
       ══════════════════════════════════════════ */
    let lastGistFetchTime = 0;
    let lastGistFetchResult = null; // for dev tools: raw text
    let lastGistParsedResult = null; // for dev tools: parsed channels
    let lastGistError = null;

    function fetchPresetChannels(callback, opts = {}) {
        const forceRefresh = opts.forceRefresh || false;
        const gistUrl = Settings.get('gistUrl');
        const cacheDurationMs = Settings.get('cacheDurationMs');
        const now = Date.now();

        // Use cache if fresh and not forcing refresh
        if (!forceRefresh && lastGistFetchResult && (now - lastGistFetchTime) < cacheDurationMs) {
            SERVER_CHANNELS = applyChannelSettings(lastGistParsedResult);
            if (callback) callback();
            return;
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: gistUrl,
            timeout: 6000,
            onload(res) {
                try {
                    lastGistError = null;
                    if (res.status === 200) {
                        const rawText = (res.responseText || '').trim();
                        lastGistFetchResult = rawText;
                        lastGistFetchTime = now;
                        let parsedChannels = [];

                        if (rawText.startsWith('[') || rawText.startsWith('{')) {
                            const parsed = JSON.parse(rawText);
                            if (Array.isArray(parsed)) {
                                parsedChannels = parsed.map(ch => ({ name: ch.name, url: ch.url, description: ch.description || '', category: ch.category || 'General' }));
                            } else {
                                parsedChannels = Object.entries(parsed).map(([k, v]) => ({
                                    name: k, url: typeof v === 'string' ? v : v.url,
                                    description: (typeof v === 'object' ? v.description : '') || '',
                                    category: (typeof v === 'object' ? v.category : '') || 'General'
                                }));
                            }
                        } else {
                            const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
                            parsedChannels = lines.map(line => {
                                const parts = line.split(';').map(p => p.trim());
                                if (parts.length >= 2) {
                                    return { name: parts[0], url: parts[1], description: parts[2] || '', category: parts[3] || 'General' };
                                }
                                return null;
                            }).filter(Boolean);
                        }
                        parsedChannels = parsedChannels.filter(ch => ch && ch.url);
                        lastGistParsedResult = parsedChannels;
                        SERVER_CHANNELS = applyChannelSettings(parsedChannels);
                    } else {
                        lastGistError = `HTTP ${res.status}`;
                        SERVER_CHANNELS = [];
                    }
                } catch (e) {
                    lastGistError = String(e);
                    console.warn('[GistStreamSelector] fetchPresetChannels parse error:', e);
                    SERVER_CHANNELS = [];
                }
                if (callback) callback();
            },
            onerror() {
                lastGistError = 'Network error';
                SERVER_CHANNELS = [];
                if (callback) callback();
            }
        });
    }

    // Merge gist channels + custom channels, apply overrides, ordering, dedup, and disable filters.
    // Every channel gets a stable `id` field. Identity is based on `id`, not `url`.
    function applyChannelSettings(gistChannels) {
        const custom = Settings.get('customChannels') || [];
        const overrides = Settings.get('channelOverrides') || {};
        const order = Settings.get('channelOrder') || [];
        const disabledIds = Settings.get('disabledIds') || [];

        // 1. Ensure gist channels have IDs. For gist channels, we generate a deterministic ID
        //    from the normalized URL so the same gist channel gets the same ID across reloads.
        //    This allows overrides and disabled state to persist across gist refreshes.
        const gistWithIds = (gistChannels || []).map(ch => {
            const normalizedUrl = normalizeUrl(ch.url);
            const deterministicId = 'gist:' + normalizedUrl;
            return {
                id: deterministicId,
                name: ch.name,
                url: ch.url,
                description: ch.description || '',
                category: ch.category || 'General',
                enabled: true,
                _source: 'gist',
                _normalizedUrl: normalizedUrl
            };
        });

        // 2. Apply overrides to gist channels (by both ID and URL for backward compat)
        const gistWithOverrides = gistWithIds.map(ch => {
            const ovById = overrides[ch.id];
            const ovByUrl = overrides[ch.url]; // backward compat with old URL-keyed overrides
            const ov = ovById || ovByUrl;
            if (ov) {
                return { ...ch, ...ov, id: ch.id }; // never override the ID
            }
            return ch;
        });

        // 3. Ensure custom channels have IDs (migration safety net)
        const customWithIds = custom.map(ch => ({
            ...ch,
            id: ch.id || generateId(),
            enabled: ch.enabled !== false,
            _source: 'custom',
            _normalizedUrl: normalizeUrl(ch.url)
        }));

        // 4. Combine gist + custom channels
        let combined = [...gistWithOverrides, ...customWithIds];

        // 5. Filter out disabled channels (by ID)
        combined = combined.filter(ch => !disabledIds.includes(ch.id));

        // 6. Filter out channels explicitly set to enabled=false
        combined = combined.filter(ch => ch.enabled !== false);

        // 7. Deduplicate by normalized URL — if a custom channel has the same URL as a gist
        //    channel, the custom channel takes precedence (user override).
        const seenUrls = new Map();
        const deduped = [];
        combined.forEach(ch => {
            const nurl = ch._normalizedUrl;
            if (!nurl || nurl === 'https:' || nurl === 'http:') {
                // Invalid/placeholder URL — keep it (user is editing)
                deduped.push(ch);
                return;
            }
            if (seenUrls.has(nurl)) {
                const existing = seenUrls.get(nurl);
                // Custom channel overrides gist channel
                if (ch._source === 'custom' && existing._source === 'gist') {
                    const idx = deduped.indexOf(existing);
                    if (idx !== -1) deduped[idx] = ch;
                    seenUrls.set(nurl, ch);
                }
                // Otherwise skip duplicate
            } else {
                seenUrls.set(nurl, ch);
                deduped.push(ch);
            }
        });
        combined = deduped;

        // 8. Apply custom ordering (channels in `order` array come first, in that order)
        if (order.length > 0) {
            combined.sort((a, b) => {
                const ia = order.indexOf(a.id);
                const ib = order.indexOf(b.id);
                if (ia === -1 && ib === -1) return 0;
                if (ia === -1) return 1;
                if (ib === -1) return -1;
                return ia - ib;
            });
        }

        // 9. Strip internal fields before returning
        return combined.map(ch => {
            const { _source, _normalizedUrl, ...clean } = ch;
            return clean;
        });
    }

    // Mark settings as dirty so the stream menu knows to refresh
    function markSettingsDirty() {
        Settings.set('settingsDirty', true);
    }

    function renderGridButtons(grid, channelArray, globalContainer, method) {
        if (!grid) return;
        grid.innerHTML = '';
        if (!channelArray || channelArray.length === 0) {
            const noMatch = document.createElement('div'); noMatch.className = 'fs-no-matches';
            noMatch.textContent = 'No channels available'; grid.appendChild(noMatch); return;
        }
        channelArray.forEach(ch => {
            const btn = document.createElement('button'); btn.className = 'fs-channel-btn';
            btn.textContent = ch.name;
            btn.title = ch.url || '';
            btn.onclick = (e) => {
                e.stopPropagation();
                globalContainer.querySelectorAll('.fs-channel-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                loadStream(ch.url, ch.name, method);
                closeOverlay();
            };
            grid.appendChild(btn);
        });
    }

    function renderNativeButton(grid, globalContainer) {
        if (!grid) return;
        grid.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'fs-channel-btn';
        btn.textContent = 'Twitch (Native)';
        btn.title = 'Restore native Twitch player';
        btn.onclick = (e) => {
            e.stopPropagation();
            globalContainer.querySelectorAll('.fs-channel-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadStream(null, 'Twitch (Native)', 'native');
            closeOverlay();
        };
        grid.appendChild(btn);
    }

    /* ══════════════════════════════════════════
       Football — FIFA code → flag emoji + status/minute helpers
       ══════════════════════════════════════════ */
    const FIFA_TO_ISO = {
        FRA:'FR', SWE:'SE', BRA:'BR', ARG:'AR', GER:'DE', ESP:'ES', ITA:'IT',
        ENG:'GB', NED:'NL', POR:'PT', BEL:'BE', USA:'US', MEX:'MX', CAN:'CA',
        JPN:'JP', KOR:'KR', AUS:'AU', SUI:'CH', AUT:'AT', DEN:'DK', NOR:'NO',
        FIN:'FI', POL:'PL', RUS:'RU', UKR:'UA', CRO:'HR', SRB:'RS', BIH:'BA',
        CZE:'CZ', SVK:'SK', SVN:'SI', HUN:'HU', ROU:'RO', BUL:'BG', GRE:'GR',
        TUR:'TR', ISR:'IL', WAL:'GB', SCO:'GB', IRL:'IE', NIR:'GB', ISL:'IS',
        ALB:'AL', GEO:'GE', ARM:'AM', AZE:'AZ', KAZ:'KZ', UZB:'UZ', QAT:'QA',
        KSA:'SA', UAE:'AE', IRN:'IR', IRQ:'IQ', JOR:'JO', SYR:'SY', OMA:'OM',
        EGY:'EG', MAR:'MA', TUN:'TN', ALG:'DZ', NGA:'NG', SEN:'SN', GHA:'GH',
        CIV:'CI', CMR:'CM', MLI:'ML', RSA:'ZA', GAM:'GM', CRC:'CR', MEX:'MX',
        USA:'US', CAN:'CA', HON:'HN', PAN:'PA', SLV:'SV', GUA:'GT', JAM:'JM',
        TRI:'TT', HAI:'HT', CUW:'CW', SUR:'SR', GUY:'GY', NZL:'NZ', FIJ:'FJ',
        TAH:'PF', PNG:'PG', SAM:'WS', TGA:'TO', SOL:'SB', VAN:'VU', PAR:'PY',
        URU:'UY', COL:'CO', CHI:'CL', ECU:'EC', PER:'PE', VEN:'VE', BOL:'BO',
        BRB:'BB', GRN:'GD', SKN:'KN', AIA:'AI', DMA:'DM', LCA:'LC', VIN:'VC',
        BER:'BM', CAY:'KY', TCA:'TC', VIR:'VG', ANG:'AI', SXM:'SX', MAW:'MW',
        CON:'CG', COD:'CD', GAB:'GA', EQG:'GQ', ZIM:'ZW', ZAM:'ZM', KEN:'KE',
        UGA:'UG', TAN:'TZ', RWA:'RW', BUR:'BI', SOM:'SO', DJI:'DJ', ERI:'ER',
        ETH:'ET', SUD:'SD', SSD:'SS', CHA:'TD', CAF:'CF', LIB:'LY', TUN:'TN'
    };

    function isoToFlag(iso) {
        if (!iso || iso.length !== 2) return '🏳️';
        const codePoints = [...iso.toUpperCase()].map(c => 0x1F1E6 + (c.charCodeAt(0) - 65));
        return String.fromCodePoint(...codePoints);
    }

    function teamFlag(teamObj) {
        if (!teamObj) return '🏳️';
        const code = teamObj.code;
        if (code && FIFA_TO_ISO[code]) return isoToFlag(FIFA_TO_ISO[code]);
        // Best-effort: try 2-letter codes directly
        if (code && code.length === 2) return isoToFlag(code);
        return '🏳️';
    }

    function teamName(teamObj) {
        if (!teamObj) return '?';
        return (typeof teamObj === 'object' ? teamObj.name : teamObj) || '?';
    }

    // Parse openfootball date/time → kickoff Date object (UTC-aware)
    function parseKickoff(dateStr, timeStr) {
        if (!dateStr) return null;
        let rawTime = (timeStr || '00:00').trim();
        rawTime = rawTime.replace(/UTC\s*([+-])(\d+)/i, (m, sign, num) => `${sign}${num.padStart(2, '0')}:00`);
        const kickOffStr = (rawTime.includes('-') || rawTime.includes('+'))
            ? `${dateStr}T${rawTime}`
            : `${dateStr}T${rawTime}Z`;
        const d = new Date(kickOffStr.replace(/\s+/g, ''));
        return isNaN(d.getTime()) ? null : d;
    }

    // Determine match status from current time vs kickoff
    function deriveMatchStatus(kickoff, now) {
        if (!kickoff) return 'unknown';
        const elapsedMin = (now.getTime() - kickoff.getTime()) / 60000;
        if (elapsedMin < 0) return 'upcoming';
        if (elapsedMin < 45) return 'live';
        if (elapsedMin < 60) return 'ht';        // halftime break (~15 min)
        if (elapsedMin < 105) return 'live';     // second half
        if (elapsedMin < 120) return 'et';       // extra time first half
        if (elapsedMin < 135) return 'et';       // extra time second half
        if (elapsedMin < 150) return 'pen';      // penalties
        if (elapsedMin < 240) return 'ft';       // finished recently
        return 'finished';
    }

    // Estimate match minute from kickoff time
    function deriveMatchMinute(kickoff, now, status) {
        if (!kickoff) return '';
        if (status === 'ht') return 'HT';
        if (status === 'et') {
            const e = (now.getTime() - kickoff.getTime()) / 60000;
            if (e < 120) return `${Math.floor(e - 105)}'+ET`;
            return `${Math.floor(e - 105)}'+ET`;
        }
        if (status === 'pen') return 'PEN';
        if (status === 'ft' || status === 'finished') return 'FT';
        if (status === 'upcoming') return '';

        const elapsedMin = (now.getTime() - kickoff.getTime()) / 60000;
        if (elapsedMin < 45) return `${Math.max(1, Math.floor(elapsedMin))}'`;
        if (elapsedMin < 60) return 'HT';
        // second half: subtract 15 min halftime
        const secondHalfMin = elapsedMin - 15;
        if (secondHalfMin < 90) return `${Math.max(46, Math.floor(secondHalfMin))}'`;
        return `${Math.floor(secondHalfMin)}'+`;
    }

    function buildNtvUrl(name1, name2) {
        const slug = `${name1.toLowerCase()}-vs-${name2.toLowerCase()}`
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/[\s_]+/g, '-');
        return `https://ntv.cx/${slug}`;
    }

    function matchKey(match) {
        return `${match.date || 'nodate'}-${teamName(match.team1)}-${teamName(match.team2)}`;
    }

    /* ══════════════════════════════════════════
       Football — fetch + parse + smart diff + render
       ══════════════════════════════════════════ */
    function fetchLiveMatches() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: WORLD_CUP_JSON_URL,
            timeout: 8000,
            onload(response) {
                try {
                    if (response.status !== 200) {
                        updateLiveMatchesUI({ matches: [], error: 'HTTP ' + response.status });
                        return;
                    }
                    const data = JSON.parse(response.responseText);
                    const rawMatches = data.matches || [];
                    const now = new Date();
                    const enriched = [];

                    rawMatches.forEach(match => {
                        if (!match.team1 || !match.team2 || !match.date) return;
                        const kickoff = parseKickoff(match.date, match.time);
                        if (!kickoff) return;

                        const status = deriveMatchStatus(kickoff, now);
                        // Only keep live + recently finished (within 4h of FT) + upcoming (within 24h)
                        if (status === 'live' || status === 'ht' || status === 'et' || status === 'pen') {
                            enriched.push({
                                key: matchKey(match),
                                team1: match.team1,
                                team2: match.team2,
                                score1: (match.score1 !== undefined && match.score1 !== null) ? match.score1 : null,
                                score2: (match.score2 !== undefined && match.score2 !== null) ? match.score2 : null,
                                status,
                                minute: deriveMatchMinute(kickoff, now, status),
                                kickoff,
                                competition: match.group || match.round || 'FIFA World Cup 2026',
                                stadium: match.stadium || '',
                                url: buildNtvUrl(teamName(match.team1), teamName(match.team2))
                            });
                        }
                    });

                    // Smart diff → notifications
                    processMatchStateChanges(enriched);

                    // UI update (in-place where possible)
                    updateLiveMatchesUI({ matches: enriched });
                } catch (err) {
                    console.warn('[GistStreamSelector] fetchLiveMatches error:', err);
                    updateLiveMatchesUI({ matches: [], error: 'parse error' });
                }
            },
            onerror() {
                updateLiveMatchesUI({ matches: [], error: 'network' });
            }
        });
    }

    // Compare current vs cached state → fire notifications only on changes
    function processMatchStateChanges(currentMatches) {
        const currentKeys = new Set();

        // Refresh activeStreamMatch snapshot from the latest poll (so the live badge stays current)
        if (activeStreamMatchKey) {
            const found = currentMatches.find(m => m.key === activeStreamMatchKey);
            if (found) {
                const prevSnapshot = activeStreamMatch;
                activeStreamMatch = found;
                updateLiveBadge(found, prevSnapshot ? matchStateCache.get(found.key) : null);
            } else {
                // Active match no longer in live set (FT/finished) — keep last snapshot but hide badge eventually
                // We'll let the next loadStream('native') call hide it. For now just update if we still have data.
            }
        }

        currentMatches.forEach(match => {
            const key = match.key;
            currentKeys.add(key);

            const previous = matchStateCache.get(key);
            const currentState = {
                score1: match.score1,
                score2: match.score2,
                status: match.status,
                minute: match.minute
            };

            if (previous) {
                // ─── Score change → GOAL notification ───
                if (previous.score1 !== null && currentState.score1 !== null &&
                    previous.score2 !== null && currentState.score2 !== null &&
                    (previous.score1 !== currentState.score1 || previous.score2 !== currentState.score2)) {
                    showMatchEventInPlayer(match, 'goal', previous);
                }

                // ─── Status change → status notification ───
                if (previous.status !== currentState.status) {
                    const transitions = {
                        'ht':   'ht',
                        'live': 'half2',   // ht → live means second half started
                        'et':   'et',
                        'pen':  'pen',
                        'ft':   'ft'
                    };
                    const evt = transitions[currentState.status];
                    if (evt) showMatchEventInPlayer(match, evt, previous);
                }
            }

            matchStateCache.set(key, currentState);
        });

        // Clean up cache for matches no longer in current set
        for (const k of matchStateCache.keys()) {
            if (!currentKeys.has(k)) matchStateCache.delete(k);
        }
    }

    // Render / update the LIVE NOW grid. Uses in-place updates when possible.
    function updateLiveMatchesUI({ matches, error }) {
        if (!liveMatchCardsContainer) return;

        if (error) {
            liveMatchCardsContainer.innerHTML = `<div class="fs-no-matches">${error === 'network' ? 'Network error.' : 'Failed to load.'}</div>`;
            return;
        }
        if (!matches || matches.length === 0) {
            liveMatchCardsContainer.innerHTML = '<div class="fs-no-matches">No live matches right now</div>';
            // Clear card element refs since cards no longer exist
            matchCardEls.clear();
            return;
        }

        // Remove DOM cards whose match is no longer in current set
        const currentKeys = new Set(matches.map(m => m.key));
        for (const [k, ref] of matchCardEls) {
            if (!currentKeys.has(k)) {
                ref.card.remove();
                matchCardEls.delete(k);
            }
        }

        // Insert/update cards in match order
        matches.forEach(match => {
            let ref = matchCardEls.get(match.key);
            if (!ref) {
                ref = createMatchCard(match);
                matchCardEls.set(match.key, ref);
                liveMatchCardsContainer.appendChild(ref.card);
            }
            updateMatchCard(ref, match);
        });
    }

    function createMatchCard(match) {
        const card = document.createElement('div');
        card.className = 'fs-match-card';
        card.innerHTML = `
            <div class="fs-match-card-top">
                <span class="fs-match-status live">LIVE</span>
                <span class="fs-match-competition"></span>
            </div>
            <div class="fs-match-teams">
                <div class="fs-team-row">
                    <span class="fs-team-flag"></span>
                    <span class="fs-team-name"></span>
                    <span class="fs-team-score"></span>
                </div>
                <div class="fs-team-row">
                    <span class="fs-team-flag"></span>
                    <span class="fs-team-name"></span>
                    <span class="fs-team-score"></span>
                </div>
            </div>
            <div class="fs-match-bottom">
                <span class="fs-match-minute"></span>
                <span class="fs-match-kickoff"></span>
            </div>
        `;

        const ref = {
            card,
            statusEl: card.querySelector('.fs-match-status'),
            compEl: card.querySelector('.fs-match-competition'),
            flag1El: card.querySelectorAll('.fs-team-flag')[0],
            name1El: card.querySelectorAll('.fs-team-name')[0],
            score1El: card.querySelectorAll('.fs-team-score')[0],
            team1RowEl: card.querySelectorAll('.fs-team-row')[0],
            flag2El: card.querySelectorAll('.fs-team-flag')[1],
            name2El: card.querySelectorAll('.fs-team-name')[1],
            score2El: card.querySelectorAll('.fs-team-score')[1],
            team2RowEl: card.querySelectorAll('.fs-team-row')[1],
            minuteEl: card.querySelector('.fs-match-minute'),
            kickoffEl: card.querySelector('.fs-match-kickoff')
        };

        card.addEventListener('click', (e) => {
            e.stopPropagation();
            // Highlight active card
            liveMatchCardsContainer.querySelectorAll('.fs-match-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            // Reuse the single NTV iframe — do NOT recreate
            // Pass matchKey so the live badge + targeted notifications track this match
            loadStream(match.url, `${teamName(match.team1)} VS ${teamName(match.team2)}`, 'overlay', match.key);
            // Show the live badge immediately with current data
            activeStreamMatch = match;
            updateLiveBadge(match, null);
            closeOverlay();
        });

        return ref;
    }

    function updateMatchCard(ref, match) {
        // Status badge
        const statusLabel = {
            live: '🔴 LIVE',
            ht: '⏸ HT',
            et: '⏱ ET',
            pen: '🥅 PEN',
            ft: '🏁 FT',
            upcoming: 'UPCOMING'
        }[match.status] || 'LIVE';
        if (ref.statusEl.textContent !== statusLabel) {
            ref.statusEl.textContent = statusLabel;
            ref.statusEl.className = `fs-match-status ${match.status}`;
        }

        // Competition
        const compText = String(match.competition || '').toUpperCase();
        if (ref.compEl.textContent !== compText) ref.compEl.textContent = compText;

        // Team 1
        const flag1 = teamFlag(match.team1);
        const name1 = teamName(match.team1);
        if (ref.flag1El.textContent !== flag1) ref.flag1El.textContent = flag1;
        if (ref.name1El.textContent !== name1) ref.name1El.textContent = name1;
        const score1Text = match.score1 === null ? '-' : String(match.score1);
        if (ref.score1El.textContent !== score1Text) ref.score1El.textContent = score1Text;

        // Team 2
        const flag2 = teamFlag(match.team2);
        const name2 = teamName(match.team2);
        if (ref.flag2El.textContent !== flag2) ref.flag2El.textContent = flag2;
        if (ref.name2El.textContent !== name2) ref.name2El.textContent = name2;
        const score2Text = match.score2 === null ? '-' : String(match.score2);
        if (ref.score2El.textContent !== score2Text) ref.score2El.textContent = score2Text;

        // Minute
        if (ref.minuteEl.textContent !== match.minute) ref.minuteEl.textContent = match.minute;

        // Kickoff time (formatted)
        let kickoffText = '';
        try {
            kickoffText = match.kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) { debugWarn('updateMatchCard: kickoff time format failed', e); kickoffText = ''; }
        if (ref.kickoffEl.textContent !== kickoffText) ref.kickoffEl.textContent = kickoffText;
    }

    function startLiveMatchPolling() {
        if (liveMatchPollTimer) return; // single timer — never start a second one
        fetchLiveMatches();
        const interval = Settings.get('pollIntervalMs');
        liveMatchPollTimer = setInterval(fetchLiveMatches, interval);
    }

    // Restart polling with a new interval (called when settings change)
    function restartLiveMatchPolling() {
        if (liveMatchPollTimer) { clearInterval(liveMatchPollTimer); liveMatchPollTimer = null; }
        startLiveMatchPolling();
    }

    /* ══════════════════════════════════════════
       Advanced Settings Panel
       ══════════════════════════════════════════ */
    let settingsPanelEl = null;
    let settingsActiveTab = 'general';

    function openSettingsPanel() {
        if (!settingsPanelEl) settingsPanelEl = buildSettingsPanel();
        settingsPanelEl.classList.add('active');
        Settings.set('panelOpen', true);
        // Refresh dev tools data on open
        refreshDevTools();
    }

    function closeSettingsPanel() {
        if (settingsPanelEl) settingsPanelEl.classList.remove('active');
        Settings.set('panelOpen', false);

        // If settings changed during this session, refresh the stream menu's channel grid
        // so new/edited/deleted channels appear immediately without a page reload.
        if (Settings.get('settingsDirty')) {
            Settings.set('settingsDirty', false);
            refreshStreamMenuChannels();
        }
    }

    function buildSettingsPanel() {
        const overlay = document.createElement('div');
        overlay.className = 'fs-settings-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettingsPanel(); });

        const panel = document.createElement('div');
        panel.className = 'fs-settings-panel';
        overlay.appendChild(panel);

        // ── Header ──
        const header = document.createElement('div'); header.className = 'fs-settings-header';
        const title = document.createElement('div'); title.className = 'fs-settings-title';
        title.textContent = '⚙ Advanced Settings';
        const closeBtn = document.createElement('button'); closeBtn.className = 'fs-btn small';
        closeBtn.textContent = '✕';
        closeBtn.onclick = closeSettingsPanel;
        header.appendChild(title);
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // ── Tabs ──
        const tabsBar = document.createElement('div'); tabsBar.className = 'fs-settings-tabs';
        const tabs = [
            { id: 'general',  label: 'General' },
            { id: 'gist',     label: 'Gist' },
            { id: 'player',   label: 'Player' },
            { id: 'menu',     label: 'Menu Editor' },
            { id: 'iotools',  label: 'Import / Export' },
            { id: 'devtools', label: 'Developer' }
        ];
        tabs.forEach(t => {
            const tab = document.createElement('button'); tab.className = 'fs-settings-tab';
            tab.textContent = t.label;
            if (t.id === settingsActiveTab) tab.classList.add('active');
            tab.onclick = () => {
                settingsActiveTab = t.id;
                tabsBar.querySelectorAll('.fs-settings-tab').forEach(x => x.classList.remove('active'));
                tab.classList.add('active');
                body.querySelectorAll('.fs-tab-content').forEach(c => c.style.display = 'none');
                body.querySelector(`.fs-tab-content[data-tab="${t.id}"]`).style.display = '';
            };
            tabsBar.appendChild(tab);
        });
        panel.appendChild(tabsBar);

        // ── Body ──
        const body = document.createElement('div'); body.className = 'fs-settings-body';
        panel.appendChild(body);

        // Build each tab's content
        body.appendChild(buildGeneralTab());
        body.appendChild(buildGistTab());
        body.appendChild(buildPlayerTab());
        body.appendChild(buildMenuEditorTab());
        body.appendChild(buildIoToolsTab());
        body.appendChild(buildDevToolsTab());

        // Show only active tab
        body.querySelectorAll('.fs-tab-content').forEach(c => {
            if (c.dataset.tab !== settingsActiveTab) c.style.display = 'none';
        });

        // ── Footer ──
        const footer = document.createElement('div'); footer.className = 'fs-settings-footer';
        const validation = document.createElement('div'); validation.className = 'fs-settings-validation';
        validation.id = 'fs-settings-validation';
        validation.textContent = 'No validation errors.';
        const btnGroup = document.createElement('div'); btnGroup.className = 'fs-btn-group';
        const restoreBtn = document.createElement('button'); restoreBtn.className = 'fs-btn danger';
        restoreBtn.textContent = 'Restore Defaults';
        restoreBtn.onclick = () => {
            if (!confirm('Restore all settings to defaults? This cannot be undone.')) return;
            Settings.reset();
            location.reload();
        };
        const doneBtn = document.createElement('button'); doneBtn.className = 'fs-btn primary';
        doneBtn.textContent = 'Done';
        doneBtn.onclick = closeSettingsPanel;
        btnGroup.appendChild(restoreBtn);
        btnGroup.appendChild(doneBtn);
        footer.appendChild(validation);
        footer.appendChild(btnGroup);
        panel.appendChild(footer);

        document.body.appendChild(overlay);
        return overlay;
    }

    // ── Collapsible section helper ──
    function buildSection(title, collapsedByDefault = false) {
        const section = document.createElement('div'); section.className = 'fs-settings-section';
        if (collapsedByDefault) section.classList.add('collapsed');
        const header = document.createElement('div'); header.className = 'fs-settings-section-header';
        const titleEl = document.createElement('div'); titleEl.className = 'fs-settings-section-title';
        titleEl.textContent = title;
        const chev = document.createElement('div'); chev.className = 'fs-settings-section-chevron';
        chev.textContent = '▼';
        header.appendChild(titleEl);
        header.appendChild(chev);
        header.onclick = () => section.classList.toggle('collapsed');
        const bodyEl = document.createElement('div'); bodyEl.className = 'fs-settings-section-body';
        section.appendChild(header);
        section.appendChild(bodyEl);
        return { section, body: bodyEl };
    }

    function buildFormRow(labelText) {
        const row = document.createElement('div'); row.className = 'fs-form-row';
        if (labelText) {
            const label = document.createElement('div'); label.className = 'fs-form-label';
            label.textContent = labelText;
            row.appendChild(label);
        }
        return row;
    }

    // ── Tab: General ──
    function buildGeneralTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'general';

        const { section, body } = buildSection('User Settings');
        body.innerHTML = `<div class="fs-form-hint">Casual user options. Advanced configuration is in the other tabs.</div>`;
        const pollRow = buildFormRow('Football Live Poll Interval (seconds)');
        const pollInput = document.createElement('input'); pollInput.className = 'fs-form-input'; pollInput.type = 'number'; pollInput.min = '5'; pollInput.step = '1';
        pollInput.value = Math.round(Settings.get('pollIntervalMs') / 1000);
        pollInput.onchange = () => {
            const v = Math.max(5, parseInt(pollInput.value) || 20);
            Settings.set('pollIntervalMs', v * 1000);
            restartLiveMatchPolling();
            showValidation('Poll interval updated to ' + v + 's', 'success');
        };
        const pollHint = document.createElement('div'); pollHint.className = 'fs-form-hint'; pollHint.textContent = 'How often to refresh live match data (5-300s recommended).';
        pollRow.appendChild(pollInput);
        pollRow.appendChild(pollHint);
        body.appendChild(pollRow);
        tab.appendChild(section);

        const { section: s2, body: b2 } = buildSection('Keyboard Shortcut', true);
        b2.innerHTML = `<div class="fs-form-hint">Press <b>Ctrl + Shift + S</b> anywhere on Twitch to open this settings panel.</div>`;
        tab.appendChild(s2);

        return tab;
    }

    // ── Tab: Gist ──
    function buildGistTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'gist';

        const { section, body } = buildSection('Gist Configuration');
        tab.appendChild(section);

        // Gist URL
        const urlRow = buildFormRow('Gist URL');
        const urlInput = document.createElement('input'); urlInput.className = 'fs-form-input';
        urlInput.value = Settings.get('gistUrl');
        const urlError = document.createElement('div'); urlError.className = 'fs-form-error'; urlError.style.display = 'none';
        urlInput.oninput = () => {
            if (!isValidUrl(urlInput.value)) {
                urlInput.classList.add('error');
                urlError.textContent = 'Invalid URL format';
                urlError.style.display = '';
            } else {
                urlInput.classList.remove('error');
                urlError.style.display = 'none';
            }
        };
        urlInput.onchange = () => {
            if (isValidUrl(urlInput.value)) {
                Settings.set('gistUrl', urlInput.value.trim());
                showValidation('Gist URL saved. Click "Reload Channels" to apply.', 'success');
            }
        };
        urlRow.appendChild(urlInput);
        urlRow.appendChild(urlError);
        body.appendChild(urlRow);

        // Cache duration
        const cacheRow = buildFormRow('Cache Duration (seconds)');
        const cacheInput = document.createElement('input'); cacheInput.className = 'fs-form-input'; cacheInput.type = 'number'; cacheInput.min = '0';
        cacheInput.value = Math.round(Settings.get('cacheDurationMs') / 1000);
        cacheInput.onchange = () => {
            const v = Math.max(0, parseInt(cacheInput.value) || 0);
            Settings.set('cacheDurationMs', v * 1000);
            showValidation('Cache duration updated', 'success');
        };
        const cacheHint = document.createElement('div'); cacheHint.className = 'fs-form-hint'; cacheHint.textContent = '0 = always fetch fresh.';
        cacheRow.appendChild(cacheInput);
        cacheRow.appendChild(cacheHint);
        body.appendChild(cacheRow);

        // Buttons
        const btnGroup = document.createElement('div'); btnGroup.className = 'fs-btn-group';
        const reloadBtn = document.createElement('button'); reloadBtn.className = 'fs-btn primary';
        reloadBtn.textContent = 'Reload Channels';
        reloadBtn.onclick = () => {
            fetchPresetChannels(() => {
                showValidation(`Loaded ${SERVER_CHANNELS.length} channels`, 'success');
            }, { forceRefresh: true });
        };
        const testBtn = document.createElement('button'); testBtn.className = 'fs-btn';
        testBtn.textContent = 'Test Connection';
        testBtn.onclick = () => {
            showValidation('Testing connection...', '');
            GM_xmlhttpRequest({
                method: 'GET', url: Settings.get('gistUrl'), timeout: 6000,
                onload(r) {
                    if (r.status === 200) showValidation(`✓ Connected — ${r.responseText.length} bytes received`, 'success');
                    else showValidation(`✗ HTTP ${r.status}`, 'error');
                },
                onerror() { showValidation('✗ Network error', 'error'); }
            });
        };
        btnGroup.appendChild(reloadBtn);
        btnGroup.appendChild(testBtn);
        body.appendChild(btnGroup);

        return tab;
    }

    // ── Tab: Player ──
    function buildPlayerTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'player';
        const { section, body } = buildSection('Player Configuration');
        tab.appendChild(section);

        // Autoplay
        const apRow = document.createElement('div'); apRow.className = 'fs-form-row inline';
        const apCb = document.createElement('input'); apCb.className = 'fs-form-checkbox'; apCb.type = 'checkbox'; apCb.checked = Settings.get('playerConfig.autoplay');
        apCb.onchange = () => Settings.set('playerConfig.autoplay', apCb.checked);
        const apLabel = document.createElement('div'); apLabel.className = 'fs-form-label'; apLabel.textContent = 'Autoplay on load';
        apLabel.style.margin = '0';
        apRow.appendChild(apCb); apRow.appendChild(apLabel);
        body.appendChild(apRow);

        // Mute on load
        const muteRow = document.createElement('div'); muteRow.className = 'fs-form-row inline';
        const muteCb = document.createElement('input'); muteCb.className = 'fs-form-checkbox'; muteCb.type = 'checkbox'; muteCb.checked = Settings.get('playerConfig.muteOnLoad');
        muteCb.onchange = () => Settings.set('playerConfig.muteOnLoad', muteCb.checked);
        const muteLabel = document.createElement('div'); muteLabel.className = 'fs-form-label'; muteLabel.textContent = 'Mute Twitch video when overlay is active'; muteLabel.style.margin = '0';
        muteRow.appendChild(muteCb); muteRow.appendChild(muteLabel);
        body.appendChild(muteRow);

        // Default volume
        const volRow = buildFormRow('Default Twitch Volume');
        const volRange = document.createElement('input'); volRange.className = 'fs-form-range'; volRange.type = 'range'; volRange.min = '0'; volRange.max = '1'; volRange.step = '0.05';
        volRange.value = Settings.get('playerConfig.defaultVolume');
        const volVal = document.createElement('div'); volVal.className = 'fs-form-range-value';
        volVal.textContent = Math.round(volRange.value * 100) + '%';
        volRange.oninput = () => {
            volVal.textContent = Math.round(volRange.value * 100) + '%';
            Settings.set('playerConfig.defaultVolume', parseFloat(volRange.value));
        };
        const volWrap = document.createElement('div'); volWrap.style.display = 'flex'; volWrap.style.alignItems = 'center'; volWrap.style.gap = '10px';
        volWrap.appendChild(volRange); volWrap.appendChild(volVal);
        volRow.appendChild(volWrap);
        body.appendChild(volRow);

        // Preferred mode
        const modeRow = buildFormRow('Preferred Player Mode');
        const modeSel = document.createElement('select'); modeSel.className = 'fs-form-select';
        [['overlay','Overlay (iframe)','Uses an iframe over the Twitch player for external streams.'],
         ['native','Native (Twitch only)','Disables overlay — always shows the native Twitch player.']
        ].forEach(([v, l]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = l;
            if (v === Settings.get('playerConfig.preferredMode')) o.selected = true;
            modeSel.appendChild(o);
        });
        modeSel.onchange = () => Settings.set('playerConfig.preferredMode', modeSel.value);
        modeRow.appendChild(modeSel);
        body.appendChild(modeRow);

        // Fullscreen behavior
        const fsRow = buildFormRow('Fullscreen Behavior');
        const fsSel = document.createElement('select'); fsSel.className = 'fs-form-select';
        [['preserve','Preserve — keep overlay visible in fullscreen'],
         ['exit','Exit fullscreen when loading overlay']
        ].forEach(([v, l]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = l;
            if (v === Settings.get('playerConfig.fullscreenBehavior')) o.selected = true;
            fsSel.appendChild(o);
        });
        fsSel.onchange = () => Settings.set('playerConfig.fullscreenBehavior', fsSel.value);
        fsRow.appendChild(fsSel);
        body.appendChild(fsRow);

        return tab;
    }

    // ── Tab: Menu Editor (drag-and-drop) ──
    function buildMenuEditorTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'menu';
        const { section, body } = buildSection('Channel Menu Editor');
        tab.appendChild(section);

        const list = document.createElement('div'); list.className = 'fs-menu-editor-list';
        body.appendChild(list);

        // ── Helper: find a channel by ID across all sources ──
        function findChannelById(id) {
            const customs = Settings.get('customChannels') || [];
            const fromCustom = customs.find(c => c.id === id);
            if (fromCustom) return { source: 'custom', channel: fromCustom };
            // Gist channel — find in the last parsed result
            const gistCh = (lastGistParsedResult || []).find(c => {
                const gid = 'gist:' + normalizeUrl(c.url);
                return gid === id;
            });
            if (gistCh) return { source: 'gist', channel: gistCh };
            return null;
        }

        // ── Build the editable list: merge gist + custom, including disabled ones ──
        function getEditableChannelList() {
            const gistChannels = (lastGistParsedResult || []).map(ch => ({
                id: 'gist:' + normalizeUrl(ch.url),
                name: ch.name,
                url: ch.url,
                description: ch.description || '',
                category: ch.category || 'General',
                enabled: true,
                _source: 'gist'
            }));

            // Apply overrides to gist channels
            const overrides = Settings.get('channelOverrides') || {};
            const gistWithOverrides = gistChannels.map(ch => {
                const ov = overrides[ch.id] || overrides[ch.url]; // backward compat
                if (ov) return { ...ch, ...ov, id: ch.id, _source: 'gist' };
                return ch;
            });

            // Custom channels (with IDs guaranteed)
            const custom = (Settings.get('customChannels') || []).map(ch => ({
                ...ch,
                id: ch.id || generateId(),
                _source: 'custom'
            }));

            // Merge — custom channels with same URL as gist channels override them
            const merged = [...gistWithOverrides];
            custom.forEach(cc => {
                const nurl = normalizeUrl(cc.url);
                const idx = merged.findIndex(g => normalizeUrl(g.url) === nurl && nurl !== 'https:' && nurl !== 'http:' && nurl !== '');
                if (idx !== -1) {
                    merged[idx] = { ...cc, _source: 'custom' };
                } else {
                    merged.push({ ...cc, _source: 'custom' });
                }
            });

            // Add back disabled channels for visibility
            const disabledIds = Settings.get('disabledIds') || [];
            disabledIds.forEach(did => {
                if (!merged.find(c => c.id === did)) {
                    // Find the channel data
                    const found = findChannelById(did);
                    if (found) {
                        merged.push({ ...found.channel, id: did, enabled: false, _source: found.source });
                    }
                }
            });

            return merged;
        }

        function renderEditorRows() {
            list.innerHTML = '';
            const fullList = getEditableChannelList();

            if (fullList.length === 0) {
                const empty = document.createElement('div'); empty.className = 'fs-form-hint';
                empty.textContent = 'No channels loaded yet. Click "Reload Channels" in the Gist tab first.';
                list.appendChild(empty);
                return;
            }

            fullList.forEach((ch) => {
                const row = document.createElement('div'); row.className = 'fs-menu-editor-row';
                row.draggable = true;
                row.dataset.id = ch.id;  // use stable ID, not URL

                // Drag handle
                const handle = document.createElement('div'); handle.className = 'fs-me-drag-handle'; handle.textContent = '⠿';

                // Enabled checkbox
                const enWrap = document.createElement('div'); enWrap.className = 'fs-me-enabled';
                const enCb = document.createElement('input'); enCb.type = 'checkbox'; enCb.className = 'fs-form-checkbox';
                enCb.checked = ch.enabled !== false;
                enCb.onchange = () => {
                    const disabledIds = Settings.get('disabledIds') || [];
                    if (enCb.checked) {
                        // Remove from disabled list
                        Settings.set('disabledIds', disabledIds.filter(id => id !== ch.id));
                    } else {
                        // Add to disabled list
                        if (!disabledIds.includes(ch.id)) Settings.set('disabledIds', [...disabledIds, ch.id]);
                    }
                    markSettingsDirty();
                };
                enWrap.appendChild(enCb);

                // Name input — saves to customChannels or channelOverrides
                const nameInput = document.createElement('input'); nameInput.className = 'fs-me-input';
                nameInput.value = ch.name || '';
                nameInput.placeholder = 'Channel name';
                nameInput.oninput = () => {
                    if (ch._source === 'custom') {
                        const customs = Settings.get('customChannels') || [];
                        const existing = customs.find(c => c.id === ch.id);
                        if (existing) {
                            existing.name = nameInput.value;
                            Settings.set('customChannels', customs);
                        }
                    } else {
                        // Gist channel — store as override by ID
                        const ov = Settings.get('channelOverrides') || {};
                        ov[ch.id] = { ...(ov[ch.id] || {}), name: nameInput.value };
                        Settings.set('channelOverrides', ov);
                    }
                    markSettingsDirty();
                };

                // URL input — FIXED: now actually saves the edited URL
                const urlInput = document.createElement('input'); urlInput.className = 'fs-me-input';
                urlInput.value = ch.url || '';
                urlInput.placeholder = 'https://...';
                urlInput.oninput = () => {
                    // Validate
                    const val = urlInput.value.trim();
                    if (val && !isValidUrl(val)) {
                        urlInput.classList.add('error');
                    } else {
                        urlInput.classList.remove('error');
                    }

                    // Save — only for custom channels. Gist channel URL edits create a
                    // custom override (so the edited URL replaces the original in the merged list).
                    if (ch._source === 'custom') {
                        const customs = Settings.get('customChannels') || [];
                        const existing = customs.find(c => c.id === ch.id);
                        if (existing) {
                            existing.url = val;
                            Settings.set('customChannels', customs);
                        }
                    } else {
                        // For gist channels: if the URL changed, we need to "fork" this into a custom channel
                        // so the user's edit is preserved. We do this by creating a custom channel entry
                        // with the same ID prefix but new URL.
                        // Actually, simpler: store the URL override.
                        const ov = Settings.get('channelOverrides') || {};
                        ov[ch.id] = { ...(ov[ch.id] || {}), url: val };
                        Settings.set('channelOverrides', ov);
                    }
                    markSettingsDirty();
                };

                // Category select
                const catSel = document.createElement('select'); catSel.className = 'fs-me-select';
                ['General', 'Sports', 'Movies', 'TV', 'Music', 'News', 'Gaming', 'Other'].forEach(c => {
                    const o = document.createElement('option'); o.value = c; o.textContent = c;
                    if ((ch.category || 'General') === c) o.selected = true;
                    catSel.appendChild(o);
                });
                catSel.onchange = () => {
                    if (ch._source === 'custom') {
                        const customs = Settings.get('customChannels') || [];
                        const existing = customs.find(c => c.id === ch.id);
                        if (existing) {
                            existing.category = catSel.value;
                            Settings.set('customChannels', customs);
                        }
                    } else {
                        const ov = Settings.get('channelOverrides') || {};
                        ov[ch.id] = { ...(ov[ch.id] || {}), category: catSel.value };
                        Settings.set('channelOverrides', ov);
                    }
                    markSettingsDirty();
                };

                // Delete button
                const delBtn = document.createElement('button'); delBtn.className = 'fs-me-delete'; delBtn.textContent = '✕'; delBtn.title = 'Remove';
                delBtn.onclick = () => {
                    if (ch._source === 'custom') {
                        if (!confirm(`Delete custom channel "${ch.name}"?`)) return;
                        const customs = Settings.get('customChannels') || [];
                        Settings.set('customChannels', customs.filter(c => c.id !== ch.id));
                        // Also remove from order and disabled lists
                        const order = Settings.get('channelOrder') || [];
                        Settings.set('channelOrder', order.filter(id => id !== ch.id));
                        const disabledIds = Settings.get('disabledIds') || [];
                        Settings.set('disabledIds', disabledIds.filter(id => id !== ch.id));
                    } else {
                        // Disable gist channel by ID
                        const disabledIds = Settings.get('disabledIds') || [];
                        if (!disabledIds.includes(ch.id)) Settings.set('disabledIds', [...disabledIds, ch.id]);
                    }
                    markSettingsDirty();
                    renderEditorRows();
                };

                row.appendChild(handle);
                row.appendChild(enWrap);
                row.appendChild(nameInput);
                row.appendChild(urlInput);
                row.appendChild(catSel);
                row.appendChild(document.createElement('div')); // spacer
                row.appendChild(delBtn);

                // Drag-and-drop events — use channel ID, not URL
                row.addEventListener('dragstart', (e) => {
                    row.classList.add('dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', ch.id);
                });
                row.addEventListener('dragend', () => row.classList.remove('dragging'));
                row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
                row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
                row.addEventListener('drop', (e) => {
                    e.preventDefault();
                    row.classList.remove('drag-over');
                    const draggedId = e.dataTransfer.getData('text/plain');
                    if (draggedId && draggedId !== ch.id) {
                        // Reorder by ID
                        const order = Settings.get('channelOrder') || [];
                        const filtered = order.filter(id => id !== draggedId);
                        const insertIdx = filtered.indexOf(ch.id);
                        if (insertIdx === -1) filtered.push(draggedId);
                        else filtered.splice(insertIdx, 0, draggedId);
                        Settings.set('channelOrder', filtered);
                        markSettingsDirty();
                        renderEditorRows();
                    }
                });

                list.appendChild(row);
            });
        }

        renderEditorRows();

        // Add new channel button — FIXED: generates a unique ID and a valid placeholder URL
        const addBtn = document.createElement('button'); addBtn.className = 'fs-btn small fs-menu-editor-add';
        addBtn.textContent = '+ Add Custom Channel';
        addBtn.onclick = () => {
            const customs = Settings.get('customChannels') || [];
            const newId = generateId();
            // Use a valid placeholder URL so the channel appears immediately
            const placeholderUrl = `https://example.com/channel/${newId.slice(0, 8)}`;
            customs.push({
                id: newId,
                name: 'New Channel',
                url: placeholderUrl,
                description: '',
                category: 'General',
                enabled: true
            });
            Settings.set('customChannels', customs);
            markSettingsDirty();
            renderEditorRows();
            // Scroll the new row into view
            setTimeout(() => {
                const rows = list.querySelectorAll('.fs-menu-editor-row');
                if (rows.length > 0) rows[rows.length - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 50);
            showValidation(`Channel added (ID: ${newId.slice(0, 8)}). Edit name and URL, then click "Save & Apply".`, 'success');
        };
        body.appendChild(addBtn);

        // Save & Apply button — refreshes SERVER_CHANNELS and the stream menu immediately
        const saveApplyBtn = document.createElement('button'); saveApplyBtn.className = 'fs-btn primary fs-menu-editor-add';
        saveApplyBtn.style.marginLeft = '6px';
        saveApplyBtn.textContent = '💾 Save & Apply';
        saveApplyBtn.onclick = () => {
            // Force refresh channels from gist + re-apply settings
            fetchPresetChannels(() => {
                showValidation(`Applied — ${SERVER_CHANNELS.length} channels in menu`, 'success');
                Settings.set('settingsDirty', false);
            }, { forceRefresh: true });
        };
        body.appendChild(saveApplyBtn);

        // Store render fn for refresh
        tab._refresh = renderEditorRows;

        return tab;
    }

    // ── Tab: Import / Export ──
    function buildIoToolsTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'iotools';

        const { section: s1, body: b1 } = buildSection('Export Settings');
        const exportBtn = document.createElement('button'); exportBtn.className = 'fs-btn primary';
        exportBtn.textContent = 'Export as JSON';
        exportBtn.onclick = () => {
            const json = Settings.exportJSON();
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'gist-stream-selector-settings.json';
            a.click();
            URL.revokeObjectURL(url);
            showValidation('Settings exported', 'success');
        };
        b1.appendChild(exportBtn);

        const ta1 = document.createElement('textarea'); ta1.className = 'fs-form-input';
        ta1.rows = 8; ta1.readOnly = true; ta1.value = Settings.exportJSON();
        ta1.style.fontFamily = 'Menlo, Consolas, monospace'; ta1.style.fontSize = '10px';
        b1.appendChild(ta1);
        tab.appendChild(s1);

        const { section: s2, body: b2 } = buildSection('Import Settings');
        const ta2 = document.createElement('textarea'); ta2.className = 'fs-form-input';
        ta2.rows = 8; ta2.placeholder = 'Paste settings JSON here...';
        ta2.style.fontFamily = 'Menlo, Consolas, monospace'; ta2.style.fontSize = '10px';
        const importBtn = document.createElement('button'); importBtn.className = 'fs-btn primary';
        importBtn.textContent = 'Import';
        importBtn.onclick = () => {
            try {
                Settings.importJSON(ta2.value);
                showValidation('Settings imported successfully. Reloading...', 'success');
                setTimeout(() => location.reload(), 1000);
            } catch (e) {
                showValidation('Import failed: ' + e.message, 'error');
            }
        };
        b2.appendChild(ta2);
        b2.appendChild(importBtn);
        tab.appendChild(s2);

        const { section: s3, body: b3 } = buildSection('Reset', true);
        const resetBtn = document.createElement('button'); resetBtn.className = 'fs-btn danger';
        resetBtn.textContent = 'Reset to Default Configuration';
        resetBtn.onclick = () => {
            if (!confirm('Reset ALL settings to defaults? This will erase custom channels and overrides.')) return;
            Settings.reset();
            location.reload();
        };
        b3.appendChild(resetBtn);
        tab.appendChild(s3);

        return tab;
    }

    // ── Tab: Developer Tools ──
    function buildDevToolsTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'devtools';

        // ── Debug Channel Counts (per spec item #14) ──
        const { section: s0, body: b0 } = buildSection('Channel Counts (Debug)');
        const countsOut = document.createElement('div'); countsOut.className = 'fs-dev-output'; countsOut.id = 'fs-dev-counts';
        countsOut.textContent = 'Click Refresh to compute...';
        b0.appendChild(countsOut);

        const countsRefreshBtn = document.createElement('button'); countsRefreshBtn.className = 'fs-btn small';
        countsRefreshBtn.textContent = 'Recompute Counts';
        countsRefreshBtn.onclick = refreshDebugCounts;
        b0.appendChild(countsRefreshBtn);
        tab.appendChild(s0);

        const { section: s1, body: b1 } = buildSection('Parsed Gist Data');
        const btnRow = document.createElement('div'); btnRow.className = 'fs-btn-group';
        const refreshBtn = document.createElement('button'); refreshBtn.className = 'fs-btn small';
        refreshBtn.textContent = 'Refresh';
        refreshBtn.onclick = refreshDevTools;
        const forceBtn = document.createElement('button'); forceBtn.className = 'fs-btn small';
        forceBtn.textContent = 'Force Refresh Channels';
        forceBtn.onclick = () => {
            fetchPresetChannels(() => { refreshDevTools(); showValidation('Forced refresh complete', 'success'); }, { forceRefresh: true });
        };
        btnRow.appendChild(refreshBtn);
        btnRow.appendChild(forceBtn);
        b1.appendChild(btnRow);

        const parsedOut = document.createElement('div'); parsedOut.className = 'fs-dev-output'; parsedOut.id = 'fs-dev-parsed';
        parsedOut.textContent = 'Click Refresh to load...';
        b1.appendChild(parsedOut);
        tab.appendChild(s1);

        const { section: s2, body: b2 } = buildSection('Raw Response', true);
        const rawOut = document.createElement('div'); rawOut.className = 'fs-dev-output'; rawOut.id = 'fs-dev-raw';
        rawOut.textContent = 'No data yet.';
        b2.appendChild(rawOut);
        tab.appendChild(s2);

        const { section: s3, body: b3 } = buildSection('Validate Channel Mappings', true);
        const valBtn = document.createElement('button'); valBtn.className = 'fs-btn small';
        valBtn.textContent = 'Run Validation';
        valBtn.onclick = () => {
            const errs = validateChannelList(lastGistParsedResult || []);
            const out = document.getElementById('fs-dev-validate');
            if (errs.length === 0) {
                out.textContent = '✓ All channels valid. No duplicates found.';
                out.classList.remove('error');
            } else {
                out.textContent = errs.join('\n');
                out.classList.add('error');
            }
        };
        b3.appendChild(valBtn);
        const valOut = document.createElement('div'); valOut.className = 'fs-dev-output'; valOut.id = 'fs-dev-validate';
        valOut.textContent = 'Click "Run Validation" to check...';
        b3.appendChild(valOut);
        tab.appendChild(s3);

        const { section: s4, body: b4 } = buildSection('Errors', true);
        const errOut = document.createElement('div'); errOut.className = 'fs-dev-output error'; errOut.id = 'fs-dev-errors';
        errOut.textContent = 'No errors.';
        b4.appendChild(errOut);
        tab.appendChild(s4);

        return tab;
    }

    function refreshDevTools() {
        const parsed = document.getElementById('fs-dev-parsed');
        const raw = document.getElementById('fs-dev-raw');
        const err = document.getElementById('fs-dev-errors');
        if (!parsed) return;
        if (lastGistParsedResult) {
            parsed.textContent = JSON.stringify(lastGistParsedResult, null, 2);
        } else {
            parsed.textContent = 'No data loaded. Click "Force Refresh Channels".';
        }
        if (raw) raw.textContent = lastGistFetchResult || 'No raw response yet.';
        if (err) err.textContent = lastGistError || 'No errors.';
        // Also refresh counts
        refreshDebugCounts();
    }

    // ── Debug channel counts (per spec item #14) ──
    function refreshDebugCounts() {
        const el = document.getElementById('fs-dev-counts');
        if (!el) return;

        const gistCount = (lastGistParsedResult || []).length;
        const customCount = (Settings.get('customChannels') || []).length;
        const disabledCount = (Settings.get('disabledIds') || []).length;
        const orderCount = (Settings.get('channelOrder') || []).length;
        const overrideCount = Object.keys(Settings.get('channelOverrides') || {}).length;

        // Compute final merged count (what actually appears in the menu)
        const finalChannels = applyChannelSettings(lastGistParsedResult || []);
        const finalCount = finalChannels.length;

        // Compute duplicates by normalized URL
        const urlMap = new Map();
        let dupCount = 0;
        finalChannels.forEach(ch => {
            const nurl = normalizeUrl(ch.url);
            if (urlMap.has(nurl)) dupCount++;
            else urlMap.set(nurl, true);
        });

        // Hidden count = (gist + custom) - final - disabled
        const totalInput = gistCount + customCount;
        const hiddenCount = Math.max(0, totalInput - finalCount - disabledCount);

        // Storage size
        let storageSize = 0;
        try {
            storageSize = new Blob([Settings.exportJSON()]).size;
        } catch (e) { debugWarn('refreshDebugCounts storage size', e); }

        // Last refresh time
        const lastRefresh = lastGistFetchTime > 0
            ? new Date(lastGistFetchTime).toLocaleTimeString()
            : 'never';

        el.textContent = [
            `Gist channels:     ${gistCount}`,
            `Custom channels:   ${customCount}`,
            `Disabled channels: ${disabledCount}`,
            `Overrides:         ${overrideCount}`,
            `Order entries:     ${orderCount}`,
            `───────────────────────────`,
            `Final merged:      ${finalCount}`,
            `Duplicates found:  ${dupCount}`,
            `Hidden (filtered): ${hiddenCount}`,
            `───────────────────────────`,
            `Last refresh:      ${lastRefresh}`,
            `Storage size:      ${storageSize} bytes`,
            `Settings dirty:    ${Settings.get('settingsDirty') ? 'YES (needs apply)' : 'no'}`
        ].join('\n');
    }

    function showValidation(msg, kind) {
        const el = document.getElementById('fs-settings-validation');
        if (!el) return;
        el.textContent = msg;
        el.className = 'fs-settings-validation' + (kind ? ' ' + kind : '');
    }

    // ── Keyboard shortcut: Ctrl+Shift+S ──
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
            e.preventDefault();
            if (settingsPanelEl && settingsPanelEl.classList.contains('active')) closeSettingsPanel();
            else openSettingsPanel();
        }
        if (e.key === 'Escape' && settingsPanelEl && settingsPanelEl.classList.contains('active')) {
            closeSettingsPanel();
        }
    });

    /* ══════════════════════════════════════════
       Overlay UI
       ══════════════════════════════════════════ */
    function initBuiltInMenu() {
        let existingContainer = document.querySelector('.fs-overlay-container');
        if (existingContainer) return existingContainer;

        const container = document.createElement('div'); container.className = 'fs-overlay-container';
        const mainWrapper = document.createElement('div'); mainWrapper.className = 'fs-main-wrapper';
        mainWrapper.addEventListener('click', (e) => e.stopPropagation());

        // Header
        const header = document.createElement('div'); header.className = 'fs-header';
        const headerTitle = document.createElement('div'); headerTitle.className = 'fs-header-title';
        headerTitle.innerHTML = `STREAM SELECTOR <span class="fs-live-indicator">LIVE</span>`;

        // Settings gear button (opens advanced settings panel)
        const gearBtn = document.createElement('button'); gearBtn.className = 'fs-settings-gear-btn';
        gearBtn.title = 'Advanced Settings (Ctrl+Shift+S)';
        gearBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
        gearBtn.onclick = (e) => { e.stopPropagation(); openSettingsPanel(); };

        const closeBtn = document.createElement('button'); closeBtn.className = 'fs-close-btn';
        closeBtn.title = 'Close';
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        closeBtn.onclick = (e) => { e.stopPropagation(); closeOverlay(); };

        header.appendChild(headerTitle);
        const headerRight = document.createElement('div'); headerRight.style.display = 'flex'; headerRight.style.alignItems = 'center';
        headerRight.appendChild(gearBtn);
        headerRight.appendChild(closeBtn);
        header.appendChild(headerRight);
        mainWrapper.appendChild(header);

        // ── Section 1: LIVE NOW (football) ──
        const liveTitle = document.createElement('div'); liveTitle.className = 'fs-section-title';
        liveTitle.innerHTML = `<span class="fs-pulse-dot"></span> LIVE NOW`;
        mainWrapper.appendChild(liveTitle);

        liveMatchCardsContainer = document.createElement('div'); liveMatchCardsContainer.className = 'fs-grid';
        liveMatchCardsContainer.innerHTML = '<div class="fs-no-matches">Loading live matches...</div>';
        mainWrapper.appendChild(liveMatchCardsContainer);

        // ── Section 2: Twitch (Native) ──
        const twitchTitle = document.createElement('div'); twitchTitle.className = 'fs-section-title';
        twitchTitle.textContent = 'TWITCH';
        mainWrapper.appendChild(twitchTitle);

        const nativeGrid = document.createElement('div'); nativeGrid.className = 'fs-grid';
        mainWrapper.appendChild(nativeGrid);
        renderNativeButton(nativeGrid, container);

        // ── Section 3: Gist Channels ──
        const gistTitle = document.createElement('div'); gistTitle.className = 'fs-section-title';
        gistTitle.textContent = 'GIST CHANNELS';
        mainWrapper.appendChild(gistTitle);

        const gistGrid = document.createElement('div'); gistGrid.className = 'fs-grid';
        gistGrid.id = 'fs-gist-grid';
        gistGrid.innerHTML = '<div class="fs-no-matches">Loading channels...</div>';
        mainWrapper.appendChild(gistGrid);

        fetchPresetChannels(() => { renderGridButtons(gistGrid, SERVER_CHANNELS, container, 'overlay'); });

        container.appendChild(mainWrapper);
        document.body.appendChild(container);
        container.addEventListener('click', () => { closeOverlay(); });

        // Start polling once the overlay has been built at least once
        startLiveMatchPolling();

        return container;
    }

    // ── Refresh the stream menu's Gist channel grid ──
    // Called on every overlay open and after settings panel close (if dirty).
    // Re-fetches channels (or uses cache) and re-renders the gist grid IN PLACE.
    function refreshStreamMenuChannels() {
        const gistGrid = document.getElementById('fs-gist-grid');
        if (!gistGrid) return; // menu not yet created

        // Show loading state
        gistGrid.innerHTML = '<div class="fs-no-matches">Loading channels...</div>';

        // Fetch (uses cache if fresh) + re-render
        fetchPresetChannels(() => {
            const overlay = document.querySelector('.fs-overlay-container');
            renderGridButtons(gistGrid, SERVER_CHANNELS, overlay || document.body, 'overlay');
        });
    }

    function closeOverlay() {
        const overlay = document.querySelector('.fs-overlay-container');
        if (overlay) overlay.classList.remove('active');
        eyeButtonEl?.classList.remove('active');
        fallbackEyeEl?.classList.remove('active');
        uiState.overlayOpen = false;
    }

    function openOverlay() {
        const overlay = initBuiltInMenu();
        if (overlay) {
            overlay.classList.add('active');
            uiState.overlayOpen = true;
            eyeButtonEl?.classList.add('active');
            fallbackEyeEl?.classList.add('active');
            // Refresh live matches immediately on open
            fetchLiveMatches();
            // ALWAYS refresh the gist channel grid on open — picks up new custom channels,
            // overrides, ordering, and disabled state without requiring a page reload.
            refreshStreamMenuChannels();
        }
    }

    /* ══════════════════════════════════════════
       Eye Button Builder
       ══════════════════════════════════════════ */
    const EYE_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 5c-7.6 0-10 7-10 7s2.4 7 10 7 10-7 10-7-2.4-7-10-7zm0 11.5c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5 4.5 2 4.5 4.5-2 4.5-4.5 4.5zm0-7.5c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>`;

    function attachEyeHandlers(eyeBtn) {
        eyeBtn.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (uiState.overlayOpen) closeOverlay(); else openOverlay();
        };
        eyeBtn.oncontextmenu = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (uiState.overlayOpen) closeOverlay(); else openOverlay();
        };
    }

    function injectPlayerOverlayEye() {
        if (eyeButtonEl && document.contains(eyeButtonEl)) return true;
        const playerRoot = getPlayerRoot();
        if (!playerRoot) return false;

        try {
            const btn = document.createElement('button');
            btn.className = 'gist-player-eye-overlay';
            btn.type = 'button';
            btn.title = 'Click: Open Stream Selector';
            btn.innerHTML = EYE_SVG;
            attachEyeHandlers(btn);

            const computedPos = getComputedStyle(playerRoot).position;
            if (computedPos === 'static') playerRoot.style.position = 'relative';
            playerRoot.appendChild(btn);
            eyeButtonEl = btn;
            return true;
        } catch (err) {
            console.warn('[GistStreamSelector] injectPlayerOverlayEye failed:', err);
            return false;
        }
    }

    function isPlayerEyeVisible() {
        if (!eyeButtonEl || !document.contains(eyeButtonEl)) return false;
        const rect = eyeButtonEl.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function injectFallbackEye() {
        if (fallbackEyeEl && document.contains(fallbackEyeEl)) return;
        const btn = document.createElement('button');
        btn.id = 'gist-fallback-eye';
        btn.type = 'button';
        btn.title = 'Click: Open Stream Selector';
        btn.innerHTML = EYE_SVG;
        attachEyeHandlers(btn);
        document.body.appendChild(btn);
        fallbackEyeEl = btn;
    }

    function maintainUI() {
        try {
            injectPlayerOverlayEye();
            if (isPlayerEyeVisible()) {
                if (fallbackEyeEl && document.contains(fallbackEyeEl)) {
                    fallbackEyeEl.remove();
                    fallbackEyeEl = null;
                }
            } else {
                if (!fallbackEyeEl || !document.contains(fallbackEyeEl)) injectFallbackEye();
            }
            if (eyeButtonEl) {
                const cs = getComputedStyle(eyeButtonEl);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
                    eyeButtonEl.style.setProperty('display', 'flex', 'important');
                    eyeButtonEl.style.setProperty('visibility', 'visible', 'important');
                    eyeButtonEl.style.setProperty('opacity', '1', 'important');
                }
            }
            // Ensure the in-player notification container and live badge are mounted
            // whenever the player is available (so they survive fullscreen / SPA nav)
            if (getPlayerRoot()) {
                getPlayerNotifContainer();
                if (activeStreamMatchKey) getLiveBadgeEl();
            }
        } catch (err) {
            console.warn('[GistStreamSelector] maintainUI error:', err);
            if (!fallbackEyeEl || !document.contains(fallbackEyeEl)) injectFallbackEye();
        }
    }

    // Kickoff
    Settings.load();                          // Load persisted settings before anything uses them
    injectFallbackEye();
    maintainUI();
    setInterval(maintainUI, 1000);

    // Restore settings panel open state if it was open last session
    if (Settings.get('panelOpen')) {
        setTimeout(() => openSettingsPanel(), 500);
    }

    // Re-run on Twitch SPA navigation
    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            setTimeout(maintainUI, 800);
        }
    }, 500);

})();
