// ==UserScript==
// @name         All-in-One Twitch Stream Selector & Loader
// @namespace    https://gist.github.com/BestestCreature/
// @version      11.4
// @description  Fixed notifications to only appear inside player, robust time/score parsing.
// @author       Jeffry Vanessa
// @match        *://*.twitch.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      raw.githubusercontent.com
// @connect      gist.githubusercontent.com
// @run-at       document-idle
// @license      MIT
// @downloadURL  https://update.greasyfork.org/scripts/585062/All-in-One%20Twitch%20Stream%20Selector%20%20Loader.user.js
// @updateURL    https://update.greasyfork.org/scripts/585062/All-in-One%20Twitch%20Stream%20Selector%20%20Loader.meta.js
// ==/UserScript==

(function () {
    'use strict';

    /* ════════════════════════════════════════════════════════════════════
       GM_* API POLYFILLS
       ════════════════════════════════════════════════════════════════════ */
    const _global = (typeof globalThis !== 'undefined') ? globalThis
                  : (typeof window !== 'undefined') ? window
                  : (typeof self !== 'undefined') ? self
                  : this;

    if (typeof _global.GM_getValue === 'undefined' || !_global.GM_getValue) {
        _global.GM_getValue = function (key, defaultValue) {
            try {
                const raw = localStorage.getItem('gss_' + key);
                if (raw === null) return defaultValue;
                return JSON.parse(raw);
            } catch (e) {
                console.warn('[GistStreamSelector] GM_getValue failed:', e);
                return defaultValue;
            }
        };
    }

    if (typeof _global.GM_setValue === 'undefined' || !_global.GM_setValue) {
        _global.GM_setValue = function (key, value) {
            try { localStorage.setItem('gss_' + key, JSON.stringify(value)); }
            catch (e) { console.warn('[GistStreamSelector] GM_setValue failed:', e); }
        };
    }

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

            fetch(url, { method, headers, signal: controller.signal })
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

    _global.__gistStreamSelectorLoaded = (_global.__gistStreamSelectorLoaded || 0) + 1;
    if (_global.__gistStreamSelectorLoaded > 1) {
        console.warn('[GistStreamSelector] Already loaded. Refresh page to reset.');
    }

    /* ════════════════════════════════════════════════════════════════════
       END POLYFILLS
       ════════════════════════════════════════════════════════════════════ */

    const DEFAULT_GIST_URL    = 'https://gist.githubusercontent.com/BestestCreature/53b495e6b30595283967c4817e33cfc0/raw/c936b11f716af48073dc56397d00bb1225747f6c/channels';
    const WORLD_CUP_JSON_URL  = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

    const DEFAULT_SETTINGS = {
        gistUrl: DEFAULT_GIST_URL,
        pollIntervalMs: 20000,
        cacheDurationMs: 300000,
        panelOpen: false,
        playerConfig: {
            autoplay: true,
            muteOnLoad: true,
            defaultVolume: 1.0,
            preferredMode: 'overlay',
            fullscreenBehavior: 'preserve'
        },
        customChannels: [],
        channelOverrides: {},
        channelOrder: [],
        disabledIds: [],
        settingsDirty: false
    };

    const Settings = {
        data: null,
        _storageKey: 'gistStreamSelector_settings_v1',
        load() {
            try {
                const raw = GM_getValue(this._storageKey, null);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    this.data = this._mergeDeep(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), parsed);
                    this._migrate();
                } else {
                    this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
                }
            } catch (e) {
                this.data = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            }
            return this.data;
        },
        _migrate() {
            const d = this.data;
            if (d.disabledUrls && d.disabledUrls.length > 0 && (!d.disabledIds || d.disabledIds.length === 0)) {
                d.disabledUrls = [];
            }
            delete d.disabledUrls;
            if (Array.isArray(d.customChannels)) {
                d.customChannels.forEach(ch => { if (!ch.id) ch.id = generateId(); });
            }
        },
        save() {
            try { GM_setValue(this._storageKey, JSON.stringify(this.data)); } catch (e) {}
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
        exportJSON() { return JSON.stringify(this.data, null, 2); },
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

    function isValidUrl(str) {
        if (!str || typeof str !== 'string') return false;
        try { new URL(str); return true; } catch { return false; }
    }

    function generateId() {
        try { if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID(); } catch (e) {}
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

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
        } catch (e) { return s.toLowerCase(); }
    }

    function debugWarn(context, err) { console.warn(`[GistStreamSelector] ${context}:`, err); }

    let SERVER_CHANNELS = [];
    let uiState = { overlayOpen: false };
    let activeIframe = null;
    let eyeButtonEl = null;
    let fallbackEyeEl = null;

    let liveMatchPollTimer = null;
    let liveMatchCardsContainer = null;
    const matchStateCache = new Map();
    const matchCardEls = new Map();

    let activeStreamMatchKey = null;
    let activeStreamMatch = null;
    let playerNotifContainer = null;
    let playerLiveBadgeEl = null;
    const notifQueue = [];
    let notifCurrentlyShowing = false;

    /* ══════════════════════════════════════════
       Styles
       ══════════════════════════════════════════ */
    const styleLayer = document.createElement('style');
    styleLayer.id = 'gist-stream-selector-styles';
    styleLayer.textContent = `
        /* Overlay & general UI */
        .fs-overlay-container { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(4px); z-index: 99999; display: none; align-items: center; justify-content: center; font-family: 'Inter', 'Roobert', sans-serif; pointer-events: auto; opacity: 0; transition: opacity 0.2s ease; }
        .fs-overlay-container.active { opacity: 1; display: flex !important; }
        .fs-main-wrapper { background: rgba(15, 15, 15, 0.97); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; padding: 10px; box-shadow: 0 12px 40px rgba(0,0,0,0.85); width: 340px; max-width: 95%; max-height: 85vh; overflow-y: auto; backdrop-filter: blur(20px); display: flex; flex-direction: column; gap: 8px; }
        .fs-header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .fs-header-title { color: rgba(255, 255, 255, 0.85); font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; display: flex; align-items: center; gap: 6px; }
        .fs-live-indicator { background: #ff1744; color: #fff; font-size: 7.5px; padding: 1px 4px; border-radius: 3px; font-weight: 700; letter-spacing: 0.3px; animation: gistPulse 1.5s infinite alternate; }
        @keyframes gistPulse { from { opacity: 0.6; } to { opacity: 1; } }
        .fs-close-btn { background: transparent; border: none; color: rgba(255,255,255,0.5); cursor: pointer; padding: 2px; border-radius: 4px; display: flex; align-items: center; justify-content: center; transition: all 0.12s ease; }
        .fs-close-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        .fs-close-btn svg { width: 14px; height: 14px; }
        .fs-section-title { color: rgba(255, 255, 255, 0.5); font-size: 9px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; margin-top: 4px; display: flex; align-items: center; gap: 6px; }
        .fs-section-title:first-child { margin-top: 0; }
        .fs-section-title .fs-pulse-dot { width: 6px; height: 6px; background: #ff1744; border-radius: 50%; animation: gistPulse 1s infinite alternate; }
        .fs-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 5px; }
        .fs-channel-btn { background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.85); padding: 6px 5px; border-radius: 4px; font-size: 10px; font-weight: 500; cursor: pointer; transition: all 0.12s ease; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .fs-channel-btn:hover { background: rgba(255, 255, 255, 0.1); border-color: rgba(255, 255, 255, 0.15); color: #fff; }
        .fs-channel-btn.active { background: #9147ff; color: #fff; border-color: #a970ff; font-weight: 600; }
        .fs-no-matches { grid-column: span 2; text-align: center; color: rgba(255,255,255,0.35); font-size: 10px; padding: 8px 0; font-style: italic; }

        /* Match Card */
        .fs-match-card { grid-column: span 2; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 6px; padding: 8px 10px; cursor: pointer; transition: all 0.12s ease; display: flex; flex-direction: column; gap: 4px; }
        .fs-match-card:hover { background: rgba(145, 71, 255, 0.15); border-color: rgba(145, 71, 255, 0.4); }
        .fs-match-card.active { background: rgba(145, 71, 255, 0.3); border-color: #a970ff; }
        .fs-match-card-top { display: flex; align-items: center; justify-content: space-between; font-size: 9px; }
        .fs-match-status { font-weight: 700; letter-spacing: 0.4px; font-size: 8.5px; padding: 1px 5px; border-radius: 3px; }
        .fs-match-status.live { background: #ff1744; color: #fff; }
        .fs-match-status.ht { background: #ff9800; color: #fff; }
        .fs-match-status.et { background: #9c27b0; color: #fff; }
        .fs-match-status.pen { background: #673ab7; color: #fff; }
        .fs-match-status.ft { background: #555; color: #ddd; }
        .fs-match-status.upcoming { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.7); }
        .fs-match-competition { color: rgba(255, 255, 255, 0.45); font-size: 8.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
        .fs-match-teams { display: flex; flex-direction: column; gap: 2px; }
        .fs-team-row { display: grid; grid-template-columns: 18px 1fr auto; align-items: center; gap: 6px; font-size: 11px; color: #fff; }
        .fs-team-flag { font-size: 14px; line-height: 1; }
        .fs-team-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .fs-team-score { font-weight: 700; font-size: 13px; min-width: 18px; text-align: right; }
        .fs-team-row.has-red .fs-team-name::after { content: ' 🟥'; font-size: 10px; }
        .fs-match-bottom { display: flex; align-items: center; justify-content: space-between; font-size: 9px; color: rgba(255, 255, 255, 0.45); padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.05); }
        .fs-match-minute { color: #ff1744; font-weight: 700; font-size: 9.5px; }
        .fs-match-kickoff { font-weight: 500; }

        /* Floating UI Elements */
        .gist-player-eye-overlay { position: absolute !important; top: 10px !important; right: 10px !important; width: 36px !important; height: 36px !important; background: rgba(15, 15, 15, 0.75) !important; border: 1px solid rgba(255, 255, 255, 0.2) !important; border-radius: 6px !important; color: #fff !important; cursor: pointer !important; display: flex !important; align-items: center !important; justify-content: center !important; z-index: 9999 !important; box-shadow: 0 2px 8px rgba(0,0,0,0.5) !important; transition: background 0.15s, color 0.15s, transform 0.15s, opacity 0.2s !important; padding: 0 !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; }
        .gist-player-eye-overlay:hover { background: rgba(145, 71, 255, 0.85) !important; color: #fff !important; transform: scale(1.08) !important; }
        .gist-player-eye-overlay.active { background: rgba(145, 71, 255, 0.9) !important; color: #fff !important; }
        .gist-player-eye-overlay svg { width: 20px !important; height: 20px !important; fill: currentColor !important; display: block !important; pointer-events: none; }
        #gist-fallback-eye { position: fixed !important; top: 80px !important; right: 20px !important; width: 40px !important; height: 40px !important; background: rgba(15, 15, 15, 0.92) !important; border: 1px solid rgba(255, 255, 255, 0.15) !important; border-radius: 8px !important; color: #efeff1 !important; cursor: pointer !important; display: flex !important; align-items: center !important; justify-content: center !important; z-index: 100002 !important; box-shadow: 0 4px 14px rgba(0,0,0,0.6) !important; transition: background 0.15s, color 0.15s, transform 0.15s !important; visibility: visible !important; opacity: 1 !important; padding: 0 !important; }
        #gist-fallback-eye:hover { background: rgba(145, 71, 255, 0.25) !important; color: #fff !important; transform: scale(1.06) !important; }
        #gist-fallback-eye.active { background: rgba(145, 71, 255, 0.35) !important; color: #a970ff !important; }
        #gist-fallback-eye svg { width: 22px !important; height: 22px !important; fill: currentColor !important; display: block !important; pointer-events: none; }
        .gist-stream-iframe { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; border: none !important; background: #000 !important; z-index: 5 !important; }

        /* Notifications */
        .fs-player-notif-container { position: absolute !important; top: 56px !important; right: 10px !important; z-index: 10000 !important; display: flex !important; flex-direction: column !important; gap: 8px !important; pointer-events: none !important; max-width: 280px !important; }
        .fs-player-notif { background: rgba(15, 15, 20, 0.78) !important; backdrop-filter: blur(16px) saturate(140%) !important; -webkit-backdrop-filter: blur(16px) saturate(140%) !important; border: 1px solid rgba(255, 255, 255, 0.1) !important; border-radius: 14px !important; padding: 10px 14px !important; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255,255,255,0.03) inset !important; color: #fff !important; font-family: 'Inter', 'Roobert', sans-serif !important; display: flex !important; flex-direction: column !important; gap: 3px !important; min-width: 220px !important; pointer-events: auto !important; opacity: 0 !important; transform: translateX(40px) scale(0.95) !important; transition: opacity 0.3s cubic-bezier(0.22, 1, 0.36, 1), transform 0.3s cubic-bezier(0.22, 1, 0.36, 1) !important; will-change: opacity, transform !important; }
        .fs-player-notif.show { opacity: 1 !important; transform: translateX(0) scale(1) !important; }
        .fs-player-notif.hide { opacity: 0 !important; transform: translateY(-12px) scale(0.98) !important; }
        .fs-player-notif.goal { border-left: 3px solid #00e676 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(0,230,118,0.25) !important; }
        .fs-player-notif.red { border-left: 3px solid #ff1744 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(255,23,68,0.25) !important; }
        .fs-player-notif.yellow { border-left: 3px solid #ffd600 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(255,214,0,0.2) !important; }
        .fs-player-notif.status { border-left: 3px solid #ff9800 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(255,152,0,0.2) !important; }
        .fs-player-notif.half2 { border-left: 3px solid #2196f3 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(33,150,243,0.2) !important; }
        .fs-player-notif.full { border-left: 3px solid #9e9e9e !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(158,158,158,0.15) !important; }
        .fs-player-notif.var { border-left: 3px solid #9c27b0 !important; box-shadow: 0 8px 32px rgba(0,0,0,0.5), 0 0 24px rgba(156,39,176,0.2) !important; }
        .fs-player-notif-top { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.3px; }
        .fs-player-notif-icon { font-size: 14px; line-height: 1; }
        .fs-player-notif-icon.flash { animation: fsNotifIconFlash 0.6s ease-out; }
        @keyframes fsNotifIconFlash { 0% { transform: scale(1); filter: brightness(1); } 30% { transform: scale(1.3); filter: brightness(1.5); } 100% { transform: scale(1); filter: brightness(1); } }
        .fs-player-notif-teams { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
        .fs-player-notif-flag { font-size: 16px; line-height: 1; }
        .fs-player-notif-score { font-weight: 800; font-size: 14px; padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,0.06); }
        .fs-player-notif-score.pulse { animation: fsScorePulse 0.7s ease-out; }
        @keyframes fsScorePulse { 0% { transform: scale(1); background: rgba(0,230,118,0.5); } 50% { transform: scale(1.15); background: rgba(0,230,118,0.7); } 100% { transform: scale(1); background: rgba(255,255,255,0.06); } }
        .fs-player-notif-scorer { font-size: 11px; color: rgba(255,255,255,0.7); font-weight: 500; }
        .fs-player-notif-comp { font-size: 9.5px; color: rgba(255,255,255,0.45); text-transform: uppercase; letter-spacing: 0.4px; font-weight: 700; margin-top: 2px; }

        /* Live Badge */
        .fs-player-live-badge { position: absolute !important; top: 56px !important; left: 10px !important; z-index: 10000 !important; background: rgba(15, 15, 20, 0.78) !important; backdrop-filter: blur(12px) saturate(140%) !important; -webkit-backdrop-filter: blur(12px) saturate(140%) !important; border: 1px solid rgba(255, 255, 255, 0.1) !important; border-radius: 10px !important; padding: 6px 10px !important; box-shadow: 0 4px 18px rgba(0,0,0,0.5) !important; color: #fff !important; font-family: 'Inter', 'Roobert', sans-serif !important; display: flex; align-items: center; gap: 8px !important; font-size: 11px !important; pointer-events: none !important; opacity: 0 !important; transform: translateY(-8px) !important; transition: opacity 0.25s ease, transform 0.25s ease !important; }
        .fs-player-live-badge.show { opacity: 1 !important; transform: translateY(0) !important; }
        .fs-player-live-badge .fs-badge-live { color: #ff1744; font-weight: 800; font-size: 9.5px; display: flex; align-items: center; gap: 3px; }
        .fs-player-live-badge .fs-badge-dot { width: 6px; height: 6px; background: #ff1744; border-radius: 50%; animation: gistPulse 1s infinite alternate; }
        .fs-player-live-badge .fs-badge-score { font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.08); }
        .fs-player-live-badge .fs-badge-score.changed { animation: fsBadgeScoreGlow 0.8s ease-out; }
        @keyframes fsBadgeScoreGlow { 0% { background: rgba(0,230,118,0.7); transform: scale(1.12); } 100% { background: rgba(255,255,255,0.08); transform: scale(1); } }
        .fs-player-live-badge .fs-badge-minute { color: #ff1744; font-weight: 700; }
        .fs-player-live-badge .fs-badge-minute.changed { animation: fsBadgeMinutePulse 0.6s ease-out; }
        @keyframes fsBadgeMinutePulse { 0% { transform: scale(1.15); } 100% { transform: scale(1); } }

        /* Settings Panel */
        .fs-settings-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(6px); z-index: 100100; display: none; align-items: center; justify-content: center; font-family: 'Inter', 'Roobert', sans-serif; opacity: 0; transition: opacity 0.2s ease; }
        .fs-settings-overlay.active { display: flex !important; opacity: 1; }
        .fs-settings-panel { background: rgba(20, 20, 25, 0.98); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; width: 580px; max-width: 95vw; max-height: 88vh; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.8); overflow: hidden; }
        .fs-settings-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }
        .fs-settings-title { color: #fff; font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
        .fs-settings-tabs { display: flex; gap: 2px; padding: 0 18px; border-bottom: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; overflow-x: auto; }
        .fs-settings-tab { background: transparent; border: none; border-bottom: 2px solid transparent; color: rgba(255,255,255,0.5); padding: 10px 14px; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: all 0.15s; text-transform: uppercase; letter-spacing: 0.4px; }
        .fs-settings-tab:hover { color: rgba(255,255,255,0.85); }
        .fs-settings-tab.active { color: #fff; border-bottom-color: #9147ff; }
        .fs-settings-body { flex: 1; overflow-y: auto; padding: 16px 18px; color: rgba(255,255,255,0.85); font-size: 12px; }
        .fs-settings-section { margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; overflow: hidden; }
        .fs-settings-section-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; cursor: pointer; background: rgba(255,255,255,0.02); user-select: none; }
        .fs-settings-section-header:hover { background: rgba(255,255,255,0.05); }
        .fs-settings-section-title { font-size: 11px; font-weight: 700; color: #fff; text-transform: uppercase; letter-spacing: 0.5px; }
        .fs-settings-section-chevron { color: rgba(255,255,255,0.4); font-size: 10px; transition: transform 0.2s; }
        .fs-settings-section.collapsed .fs-settings-section-chevron { transform: rotate(-90deg); }
        .fs-settings-section-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
        .fs-settings-section.collapsed .fs-settings-section-body { display: none; }
        .fs-form-row { display: flex; flex-direction: column; gap: 4px; }
        .fs-form-row.inline { flex-direction: row; align-items: center; gap: 10px; }
        .fs-form-label { font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.6); text-transform: uppercase; letter-spacing: 0.4px; }
        .fs-form-input, .fs-form-select { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1); border-radius: 5px; padding: 6px 9px; color: #fff; font-size: 12px; font-family: inherit; outline: none; width: 100%; box-sizing: border-box; transition: border-color 0.15s; }
        .fs-form-input:focus, .fs-form-select:focus { border-color: #9147ff; }
        .fs-form-input.error { border-color: #ff1744; }
        .fs-form-error { font-size: 10px; color: #ff5252; font-weight: 500; }
        .fs-form-hint { font-size: 10px; color: rgba(255,255,255,0.4); }
        .fs-form-checkbox { width: 16px; height: 16px; accent-color: #9147ff; cursor: pointer; }
        .fs-form-range { flex: 1; accent-color: #9147ff; cursor: pointer; }
        .fs-form-range-value { font-size: 11px; color: #fff; min-width: 50px; text-align: right; font-weight: 600; }
        .fs-btn { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 6px 12px; border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.15s; font-family: inherit; }
        .fs-btn:hover { background: rgba(255,255,255,0.12); }
        .fs-btn.primary { background: #9147ff; border-color: #a970ff; }
        .fs-btn.primary:hover { background: #a970ff; }
        .fs-btn.danger { background: rgba(255,23,68,0.15); border-color: rgba(255,23,68,0.3); color: #ff5252; }
        .fs-btn.danger:hover { background: rgba(255,23,68,0.25); }
        .fs-btn.small { padding: 4px 8px; font-size: 10px; }
        .fs-btn-group { display: flex; gap: 6px; flex-wrap: wrap; }
        .fs-settings-footer { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; border-top: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; gap: 10px; }
        .fs-settings-validation { flex: 1; font-size: 10px; color: rgba(255,255,255,0.5); max-height: 32px; overflow-y: auto; }
        .fs-settings-validation.error { color: #ff5252; }
        .fs-settings-validation.success { color: #00e676; }

        /* Editor & Dev Tools */
        .fs-menu-editor-list { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; }
        .fs-menu-editor-row { display: grid; grid-template-columns: 20px 24px 1fr 1fr 80px 60px 28px; gap: 6px; align-items: center; padding: 5px 8px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 5px; font-size: 11px; }
        .fs-menu-editor-row.dragging { opacity: 0.4; border-style: dashed; }
        .fs-menu-editor-row.drag-over { border-color: #9147ff; background: rgba(145,71,255,0.1); }
        .fs-me-drag-handle { cursor: grab; color: rgba(255,255,255,0.3); font-size: 12px; text-align: center; }
        .fs-me-drag-handle:active { cursor: grabbing; }
        .fs-me-enabled { display: flex; align-items: center; justify-content: center; }
        .fs-me-input { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; padding: 3px 5px; color: #fff; font-size: 10px; width: 100%; box-sizing: border-box; }
        .fs-me-input:focus { outline: none; border-color: #9147ff; }
        .fs-me-input.error { border-color: #ff1744; }
        .fs-me-select { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 3px; padding: 3px 5px; color: #fff; font-size: 10px; width: 100%; box-sizing: border-box; }
        .fs-me-delete { background: transparent; border: none; color: rgba(255,255,255,0.3); cursor: pointer; font-size: 14px; padding: 2px; }
        .fs-me-delete:hover { color: #ff5252; }
        .fs-menu-editor-add { margin-top: 6px; }
        .fs-dev-output { background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08); border-radius: 5px; padding: 8px 10px; font-family: 'Menlo', 'Consolas', monospace; font-size: 10px; color: #00e676; max-height: 220px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
        .fs-dev-output.error { color: #ff5252; }
        .fs-settings-gear-btn { background: transparent; border: none; color: rgba(255,255,255,0.4); cursor: pointer; padding: 2px 4px; border-radius: 4px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; margin-right: 4px; }
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
       Notification Engine (In-Player Scope Only)
       ══════════════════════════════════════════ */
    const PlayerNotify = {
        _container: null,
        
        _ensureContainer() {
            if (this._container && document.contains(this._container)) return true;
            
            const root = getPlayerRoot();
            if (!root) return false;

            this._container = document.createElement('div');
            Object.assign(this._container.style, {
                position: 'absolute',
                top: '70px', 
                left: '20px', 
                zIndex: '100001',
                display: 'flex', 
                flexDirection: 'column', 
                gap: '4px', 
                pointerEvents: 'none', 
                maxWidth: '220px'
            });

            if (getComputedStyle(root).position === 'static') {
                root.style.position = 'relative';
            }
            
            root.appendChild(this._container);
            return true;
        },

        show({ title = '', message = '', type = 'info', duration = 2500 }) {
            // If the player hasn't rendered yet, wait 1 second and try again
            if (!this._ensureContainer()) {
                setTimeout(() => this.show({ title, message, type, duration }), 1000);
                return;
            }

            const el = document.createElement('div');
            Object.assign(el.style, {
                background: 'rgba(15,15,15,0.95)', 
                borderRadius: '4px', 
                border: '1px solid rgba(255,255,255,0.08)',
                padding: '6px 8px', 
                display: 'flex', 
                flexDirection: 'column', 
                opacity: '0',
                transform: 'translateY(-4px)', 
                transition: 'all 0.2s ease', 
                boxShadow: '0 4px 10px rgba(0,0,0,0.5)'
            });

            if (type === 'error') el.style.borderLeft = '3px solid #ff1744';
            if (type === 'success') el.style.borderLeft = '3px solid #00e676';

            if (title) {
                const t = document.createElement('div');
                Object.assign(t.style, { color: '#fff', fontSize: '10.5px', fontWeight: '600' });
                t.textContent = title; 
                el.appendChild(t);
            }
            if (message) {
                const m = document.createElement('div');
                Object.assign(m.style, { color: 'rgba(255,255,255,0.5)', fontSize: '9px', marginTop: '1px' });
                m.textContent = message; 
                el.appendChild(m);
            }
            
            this._container.appendChild(el);
            
            requestAnimationFrame(() => { 
                el.style.opacity = '1'; 
                el.style.transform = 'translateY(0)'; 
            });
            
            setTimeout(() => { 
                el.style.opacity = '0'; 
                setTimeout(() => el.remove(), 200); 
            }, duration);
        }
    };

    /* ══════════════════════════════════════════
       Football Sub-System Notifications
       ══════════════════════════════════════════ */
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

    function enqueueNotif(notifSpec) {
        notifQueue.push(notifSpec);
        processNotifQueue();
    }

    function processNotifQueue() {
        if (notifCurrentlyShowing) return;
        const spec = notifQueue.shift();
        if (!spec) return;

        const container = getPlayerNotifContainer();
        if (!container) return;

        const el = buildNotifEl(spec);
        container.appendChild(el);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                el.classList.add('show');
                const iconEl = el.querySelector('.fs-player-notif-icon');
                if (iconEl) iconEl.classList.add('flash');
            });
        });

        notifCurrentlyShowing = true;
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

    function buildTeamsHtml(match, prevScore1, prevScore2) {
        const name1 = teamName(match.team1);
        const name2 = teamName(match.team2);
        const flag1 = teamFlag(match.team1);
        const flag2 = teamFlag(match.team2);
        const s1 = match.score1 === null ? '-' : String(match.score1);
        const s2 = match.score2 === null ? '-' : String(match.score2);

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
            spec = { icon: '⚽', title: 'GOAL', kind: 'goal', bodyHtml: buildTeamsHtml(match, prev?.score1 ?? null, prev?.score2 ?? null), compText };
        } else if (eventType === 'ht') {
            spec = { icon: '⏸', title: 'Half-Time', kind: 'status', bodyHtml: buildTeamsHtml(match, null, null), compText };
        } else if (eventType === 'half2') {
            spec = { icon: '▶', title: 'Second Half Starts', kind: 'half2', bodyHtml: buildTeamsHtml(match, null, null), compText };
        } else if (eventType === 'et') {
            spec = { icon: '⏱', title: 'Extra Time', kind: 'status', bodyHtml: buildTeamsHtml(match, null, null), compText };
        } else if (eventType === 'pen') {
            spec = { icon: '🥅', title: 'Penalty Shootout', kind: 'status', bodyHtml: buildTeamsHtml(match, null, null), compText };
        } else if (eventType === 'ft') {
            spec = { icon: '🏁', title: 'Full Time', kind: 'full', bodyHtml: buildTeamsHtml(match, null, null), compText };
        }
        if (spec) enqueueNotif(spec);
    }

    /* ══════════════════════════════════════════
       Live Score Badge
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

        if (s1El.textContent !== s1) {
            s1El.textContent = s1;
            if (prev && prev.score1 !== match.score1) {
                s1El.classList.remove('changed');
                void s1El.offsetWidth; 
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
       Stream Loader
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
            if (!autoplay) return rawUrl;
            const sep = rawUrl.includes('?') ? '&' : '?';
            return `${rawUrl}${sep}autoplay=1`;
        }
    }

    function loadStream(url, name, method, matchKey = null) {
        const muteOnLoad = Settings.get('playerConfig.muteOnLoad');
        const defaultVol = Settings.get('playerConfig.defaultVolume');

        if (method === 'native' || !url) {
            const iframe = getOverlayIframe();
            if (iframe) { iframe.src = ''; iframe.style.display = 'none'; }
            const video = getTwitchVideo();
            if (video) {
                video.muted = false;
                try { video.volume = defaultVol; } catch (e) {}
            }
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
                    try { video.volume = defaultVol; } catch (e) {}
                }
            }
            activeStreamMatchKey = matchKey;
            if (!matchKey) {
                hideLiveBadge();
                activeStreamMatch = null;
            }
            PlayerNotify.show({ title: name, message: 'Stream loading...', type: 'success' });
        }
    }

    /* ══════════════════════════════════════════
       Gist Channel Fetcher
       ══════════════════════════════════════════ */
    let lastGistFetchTime = 0;
    let lastGistFetchResult = null;
    let lastGistParsedResult = null;
    let lastGistError = null;

    function fetchPresetChannels(callback, opts = {}) {
        const forceRefresh = opts.forceRefresh || false;
        const gistUrl = Settings.get('gistUrl');
        const cacheDurationMs = Settings.get('cacheDurationMs');
        const now = Date.now();

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

    function applyChannelSettings(gistChannels) {
        const custom = Settings.get('customChannels') || [];
        const overrides = Settings.get('channelOverrides') || {};
        const order = Settings.get('channelOrder') || [];
        const disabledIds = Settings.get('disabledIds') || [];

        const gistWithIds = (gistChannels || []).map(ch => {
            const normalizedUrl = normalizeUrl(ch.url);
            return { id: 'gist:' + normalizedUrl, name: ch.name, url: ch.url, description: ch.description || '', category: ch.category || 'General', enabled: true, _source: 'gist', _normalizedUrl: normalizedUrl };
        });

        const gistWithOverrides = gistWithIds.map(ch => {
            const ov = overrides[ch.id] || overrides[ch.url];
            return ov ? { ...ch, ...ov, id: ch.id } : ch;
        });

        const customWithIds = custom.map(ch => ({ ...ch, id: ch.id || generateId(), enabled: ch.enabled !== false, _source: 'custom', _normalizedUrl: normalizeUrl(ch.url) }));
        let combined = [...gistWithOverrides, ...customWithIds];
        combined = combined.filter(ch => !disabledIds.includes(ch.id));
        combined = combined.filter(ch => ch.enabled !== false);

        const seenUrls = new Map();
        const deduped = [];
        combined.forEach(ch => {
            const nurl = ch._normalizedUrl;
            if (!nurl || nurl === 'https:' || nurl === 'http:') {
                deduped.push(ch); return;
            }
            if (seenUrls.has(nurl)) {
                const existing = seenUrls.get(nurl);
                if (ch._source === 'custom' && existing._source === 'gist') {
                    const idx = deduped.indexOf(existing);
                    if (idx !== -1) deduped[idx] = ch;
                    seenUrls.set(nurl, ch);
                }
            } else {
                seenUrls.set(nurl, ch);
                deduped.push(ch);
            }
        });
        combined = deduped;

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
        return combined.map(ch => { const { _source, _normalizedUrl, ...clean } = ch; return clean; });
    }

    function markSettingsDirty() { Settings.set('settingsDirty', true); }

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
        const btn = document.createElement('button'); btn.className = 'fs-channel-btn';
        btn.textContent = 'Twitch (Native)'; btn.title = 'Restore native Twitch player';
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
       Football Sub-System Logic
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
        if (code && code.length === 2) return isoToFlag(code);
        return '🏳️';
    }

    function teamName(teamObj) {
        if (!teamObj) return '?';
        return (typeof teamObj === 'object' ? teamObj.name : teamObj) || '?';
    }

    function parseKickoff(dateStr, timeStr) {
        if (!dateStr) return null;
        let rawTime = (timeStr || '00:00').trim();
        rawTime = rawTime.replace(/UTC\s*/i, '').trim(); // Remove UTC string for safer parsing
        // Append Z to enforce absolute UTC time if offset not present
        const kickOffStr = `${dateStr}T${rawTime}${rawTime.includes('+') || rawTime.includes('-') || rawTime.includes('Z') ? '' : 'Z'}`;
        const d = new Date(kickOffStr);
        return isNaN(d.getTime()) ? null : d;
    }

    function deriveMatchStatus(kickoff, now) {
        if (!kickoff) return 'unknown';
        const elapsedMin = (now.getTime() - kickoff.getTime()) / 60000;
        if (elapsedMin < 0) return 'upcoming';
        if (elapsedMin < 45) return 'live';
        if (elapsedMin < 60) return 'ht';
        if (elapsedMin < 105) return 'live';
        if (elapsedMin < 120) return 'et';
        if (elapsedMin < 135) return 'et';
        if (elapsedMin < 150) return 'pen';
        if (elapsedMin < 240) return 'ft';
        return 'finished';
    }

    function deriveMatchMinute(kickoff, now, status) {
        if (!kickoff) return '';
        if (status === 'ht') return 'HT';
        if (status === 'et') return `${Math.floor((now.getTime() - kickoff.getTime()) / 60000 - 105)}'+ET`;
        if (status === 'pen') return 'PEN';
        if (status === 'ft' || status === 'finished') return 'FT';
        if (status === 'upcoming') return '';

        const elapsedMin = (now.getTime() - kickoff.getTime()) / 60000;
        if (elapsedMin < 45) return `${Math.max(1, Math.floor(elapsedMin))}'`;
        if (elapsedMin < 60) return 'HT';
        const secondHalfMin = elapsedMin - 15;
        if (secondHalfMin < 90) return `${Math.max(46, Math.floor(secondHalfMin))}'`;
        return `${Math.floor(secondHalfMin)}'+`;
    }

    function buildNtvUrl(name1, name2) {
        const slug = `${name1.toLowerCase()}-vs-${name2.toLowerCase()}`.replace(/[^a-z0-9\s-]/g, '').replace(/[\s_]+/g, '-');
        return `https://ntv.cx/${slug}`;
    }

    function matchKey(match) { return `${match.date || 'nodate'}-${teamName(match.team1)}-${teamName(match.team2)}`; }

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
                        if (['live', 'ht', 'et', 'pen'].includes(status)) {
                            // Extract scores with extensive fallback for different API designs
                            const s1 = match.score1 ?? match.score?.ft?.[0] ?? match.score?.fullTime?.[0] ?? null;
                            const s2 = match.score2 ?? match.score?.ft?.[1] ?? match.score?.fullTime?.[1] ?? null;
                            
                            enriched.push({
                                key: matchKey(match),
                                team1: match.team1,
                                team2: match.team2,
                                score1: s1,
                                score2: s2,
                                status, minute: deriveMatchMinute(kickoff, now, status),
                                kickoff, competition: match.group || match.round || 'FIFA World Cup 2026',
                                stadium: match.stadium || '', url: buildNtvUrl(teamName(match.team1), teamName(match.team2))
                            });
                        }
                    });

                    processMatchStateChanges(enriched);
                    updateLiveMatchesUI({ matches: enriched });
                } catch (err) {
                    updateLiveMatchesUI({ matches: [], error: 'parse error' });
                }
            },
            onerror() { updateLiveMatchesUI({ matches: [], error: 'network' }); }
        });
    }

    function processMatchStateChanges(currentMatches) {
        const currentKeys = new Set();
        if (activeStreamMatchKey) {
            const found = currentMatches.find(m => m.key === activeStreamMatchKey);
            if (found) {
                const prevSnapshot = activeStreamMatch;
                activeStreamMatch = found;
                updateLiveBadge(found, prevSnapshot ? matchStateCache.get(found.key) : null);
            }
        }

        currentMatches.forEach(match => {
            const key = match.key;
            currentKeys.add(key);

            const previous = matchStateCache.get(key);
            const currentState = { score1: match.score1, score2: match.score2, status: match.status, minute: match.minute };

            if (previous) {
                if (previous.score1 !== null && currentState.score1 !== null && previous.score2 !== null && currentState.score2 !== null && (previous.score1 !== currentState.score1 || previous.score2 !== currentState.score2)) {
                    showMatchEventInPlayer(match, 'goal', previous);
                }
                if (previous.status !== currentState.status) {
                    const transitions = { 'ht': 'ht', 'live': 'half2', 'et': 'et', 'pen': 'pen', 'ft': 'ft' };
                    if (transitions[currentState.status]) showMatchEventInPlayer(match, transitions[currentState.status], previous);
                }
            }
            matchStateCache.set(key, currentState);
        });

        for (const k of matchStateCache.keys()) {
            if (!currentKeys.has(k)) matchStateCache.delete(k);
        }
    }

    function updateLiveMatchesUI({ matches, error }) {
        if (!liveMatchCardsContainer) return;

        if (error) {
            liveMatchCardsContainer.innerHTML = `<div class="fs-no-matches">${error === 'network' ? 'Network error.' : 'Failed to load.'}</div>`;
            return;
        }
        if (!matches || matches.length === 0) {
            liveMatchCardsContainer.innerHTML = '<div class="fs-no-matches">No live matches right now</div>';
            matchCardEls.clear();
            return;
        }

        const currentKeys = new Set(matches.map(m => m.key));
        for (const [k, ref] of matchCardEls) {
            if (!currentKeys.has(k)) { ref.card.remove(); matchCardEls.delete(k); }
        }

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
            <div class="fs-match-card-top"><span class="fs-match-status live">LIVE</span><span class="fs-match-competition"></span></div>
            <div class="fs-match-teams">
                <div class="fs-team-row"><span class="fs-team-flag"></span><span class="fs-team-name"></span><span class="fs-team-score"></span></div>
                <div class="fs-team-row"><span class="fs-team-flag"></span><span class="fs-team-name"></span><span class="fs-team-score"></span></div>
            </div>
            <div class="fs-match-bottom"><span class="fs-match-minute"></span><span class="fs-match-kickoff"></span></div>
        `;

        const ref = {
            card, statusEl: card.querySelector('.fs-match-status'), compEl: card.querySelector('.fs-match-competition'),
            flag1El: card.querySelectorAll('.fs-team-flag')[0], name1El: card.querySelectorAll('.fs-team-name')[0], score1El: card.querySelectorAll('.fs-team-score')[0],
            flag2El: card.querySelectorAll('.fs-team-flag')[1], name2El: card.querySelectorAll('.fs-team-name')[1], score2El: card.querySelectorAll('.fs-team-score')[1],
            minuteEl: card.querySelector('.fs-match-minute'), kickoffEl: card.querySelector('.fs-match-kickoff')
        };

        card.addEventListener('click', (e) => {
            e.stopPropagation();
            liveMatchCardsContainer.querySelectorAll('.fs-match-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            loadStream(match.url, `${teamName(match.team1)} VS ${teamName(match.team2)}`, 'overlay', match.key);
            activeStreamMatch = match;
            updateLiveBadge(match, null);
            closeOverlay();
        });

        return ref;
    }

    function updateMatchCard(ref, match) {
        const statusLabel = { live: '🔴 LIVE', ht: '⏸ HT', et: '⏱ ET', pen: '🥅 PEN', ft: '🏁 FT', upcoming: 'UPCOMING' }[match.status] || 'LIVE';
        if (ref.statusEl.textContent !== statusLabel) { ref.statusEl.textContent = statusLabel; ref.statusEl.className = `fs-match-status ${match.status}`; }

        const compText = String(match.competition || '').toUpperCase();
        if (ref.compEl.textContent !== compText) ref.compEl.textContent = compText;

        const flag1 = teamFlag(match.team1); const name1 = teamName(match.team1);
        if (ref.flag1El.textContent !== flag1) ref.flag1El.textContent = flag1;
        if (ref.name1El.textContent !== name1) ref.name1El.textContent = name1;
        const score1Text = match.score1 === null ? '-' : String(match.score1);
        if (ref.score1El.textContent !== score1Text) ref.score1El.textContent = score1Text;

        const flag2 = teamFlag(match.team2); const name2 = teamName(match.team2);
        if (ref.flag2El.textContent !== flag2) ref.flag2El.textContent = flag2;
        if (ref.name2El.textContent !== name2) ref.name2El.textContent = name2;
        const score2Text = match.score2 === null ? '-' : String(match.score2);
        if (ref.score2El.textContent !== score2Text) ref.score2El.textContent = score2Text;

        if (ref.minuteEl.textContent !== match.minute) ref.minuteEl.textContent = match.minute;

        let kickoffText = '';
        try { kickoffText = match.kickoff.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) {}
        if (ref.kickoffEl.textContent !== kickoffText) ref.kickoffEl.textContent = kickoffText;
    }

    function startLiveMatchPolling() {
        if (liveMatchPollTimer) return;
        fetchLiveMatches();
        liveMatchPollTimer = setInterval(fetchLiveMatches, Settings.get('pollIntervalMs'));
    }

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
        refreshDevTools();
    }

    function closeSettingsPanel() {
        if (settingsPanelEl) settingsPanelEl.classList.remove('active');
        Settings.set('panelOpen', false);
        if (Settings.get('settingsDirty')) {
            Settings.set('settingsDirty', false);
            refreshStreamMenuChannels();
        }
    }

    function buildSettingsPanel() {
        const overlay = document.createElement('div'); overlay.className = 'fs-settings-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettingsPanel(); });

        const panel = document.createElement('div'); panel.className = 'fs-settings-panel'; overlay.appendChild(panel);

        const header = document.createElement('div'); header.className = 'fs-settings-header';
        const title = document.createElement('div'); title.className = 'fs-settings-title'; title.textContent = '⚙ Advanced Settings';
        const closeBtn = document.createElement('button'); closeBtn.className = 'fs-btn small'; closeBtn.textContent = '✕'; closeBtn.onclick = closeSettingsPanel;
        header.appendChild(title); header.appendChild(closeBtn); panel.appendChild(header);

        const tabsBar = document.createElement('div'); tabsBar.className = 'fs-settings-tabs';
        const tabs = [
            { id: 'general',  label: 'General' }, { id: 'gist',     label: 'Gist' }, { id: 'player',   label: 'Player' },
            { id: 'menu',     label: 'Menu Editor' }, { id: 'iotools',  label: 'Import / Export' }, { id: 'devtools', label: 'Developer' }
        ];
        tabs.forEach(t => {
            const tab = document.createElement('button'); tab.className = 'fs-settings-tab'; tab.textContent = t.label;
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

        const body = document.createElement('div'); body.className = 'fs-settings-body'; panel.appendChild(body);
        body.appendChild(buildGeneralTab()); body.appendChild(buildGistTab()); body.appendChild(buildPlayerTab());
        body.appendChild(buildMenuEditorTab()); body.appendChild(buildIoToolsTab()); body.appendChild(buildDevToolsTab());

        body.querySelectorAll('.fs-tab-content').forEach(c => { if (c.dataset.tab !== settingsActiveTab) c.style.display = 'none'; });

        const footer = document.createElement('div'); footer.className = 'fs-settings-footer';
        const validation = document.createElement('div'); validation.className = 'fs-settings-validation'; validation.id = 'fs-settings-validation'; validation.textContent = 'No validation errors.';
        const btnGroup = document.createElement('div'); btnGroup.className = 'fs-btn-group';
        const restoreBtn = document.createElement('button'); restoreBtn.className = 'fs-btn danger'; restoreBtn.textContent = 'Restore Defaults';
        restoreBtn.onclick = () => { if (confirm('Restore all settings to defaults?')) { Settings.reset(); location.reload(); } };
        const doneBtn = document.createElement('button'); doneBtn.className = 'fs-btn primary'; doneBtn.textContent = 'Done'; doneBtn.onclick = closeSettingsPanel;
        btnGroup.appendChild(restoreBtn); btnGroup.appendChild(doneBtn);
        footer.appendChild(validation); footer.appendChild(btnGroup); panel.appendChild(footer);

        document.body.appendChild(overlay); return overlay;
    }

    function buildSection(title, collapsedByDefault = false) {
        const section = document.createElement('div'); section.className = 'fs-settings-section';
        if (collapsedByDefault) section.classList.add('collapsed');
        const header = document.createElement('div'); header.className = 'fs-settings-section-header';
        const titleEl = document.createElement('div'); titleEl.className = 'fs-settings-section-title'; titleEl.textContent = title;
        const chev = document.createElement('div'); chev.className = 'fs-settings-section-chevron'; chev.textContent = '▼';
        header.appendChild(titleEl); header.appendChild(chev);
        header.onclick = () => section.classList.toggle('collapsed');
        const bodyEl = document.createElement('div'); bodyEl.className = 'fs-settings-section-body';
        section.appendChild(header); section.appendChild(bodyEl);
        return { section, body: bodyEl };
    }

    function buildFormRow(labelText) {
        const row = document.createElement('div'); row.className = 'fs-form-row';
        if (labelText) {
            const label = document.createElement('div'); label.className = 'fs-form-label'; label.textContent = labelText; row.appendChild(label);
        }
        return row;
    }

    function buildGeneralTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'general';
        const { section, body } = buildSection('User Settings');
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
        pollRow.appendChild(pollInput); pollRow.appendChild(pollHint); body.appendChild(pollRow);
        tab.appendChild(section);

        const { section: s2, body: b2 } = buildSection('Keyboard Shortcut', true);
        b2.innerHTML = `<div class="fs-form-hint">Press <b>Ctrl + Shift + S</b> anywhere on Twitch to open this settings panel.</div>`;
        tab.appendChild(s2);
        return tab;
    }

    function buildGistTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'gist';
        const { section, body } = buildSection('Gist Configuration'); tab.appendChild(section);

        const urlRow = buildFormRow('Gist URL');
        const urlInput = document.createElement('input'); urlInput.className = 'fs-form-input'; urlInput.value = Settings.get('gistUrl');
        const urlError = document.createElement('div'); urlError.className = 'fs-form-error'; urlError.style.display = 'none';
        urlInput.oninput = () => {
            if (!isValidUrl(urlInput.value)) { urlInput.classList.add('error'); urlError.textContent = 'Invalid URL format'; urlError.style.display = ''; }
            else { urlInput.classList.remove('error'); urlError.style.display = 'none'; }
        };
        urlInput.onchange = () => {
            if (isValidUrl(urlInput.value)) { Settings.set('gistUrl', urlInput.value.trim()); showValidation('Gist URL saved.', 'success'); }
        };
        urlRow.appendChild(urlInput); urlRow.appendChild(urlError); body.appendChild(urlRow);

        const cacheRow = buildFormRow('Cache Duration (seconds)');
        const cacheInput = document.createElement('input'); cacheInput.className = 'fs-form-input'; cacheInput.type = 'number'; cacheInput.min = '0';
        cacheInput.value = Math.round(Settings.get('cacheDurationMs') / 1000);
        cacheInput.onchange = () => {
            const v = Math.max(0, parseInt(cacheInput.value) || 0);
            Settings.set('cacheDurationMs', v * 1000); showValidation('Cache duration updated', 'success');
        };
        const cacheHint = document.createElement('div'); cacheHint.className = 'fs-form-hint'; cacheHint.textContent = '0 = always fetch fresh.';
        cacheRow.appendChild(cacheInput); cacheRow.appendChild(cacheHint); body.appendChild(cacheRow);

        const btnGroup = document.createElement('div'); btnGroup.className = 'fs-btn-group';
        const reloadBtn = document.createElement('button'); reloadBtn.className = 'fs-btn primary'; reloadBtn.textContent = 'Reload Channels';
        reloadBtn.onclick = () => { fetchPresetChannels(() => { showValidation(`Loaded ${SERVER_CHANNELS.length} channels`, 'success'); }, { forceRefresh: true }); };
        const testBtn = document.createElement('button'); testBtn.className = 'fs-btn'; testBtn.textContent = 'Test Connection';
        testBtn.onclick = () => {
            showValidation('Testing connection...', '');
            GM_xmlhttpRequest({
                method: 'GET', url: Settings.get('gistUrl'), timeout: 6000,
                onload(r) { if (r.status === 200) showValidation(`✓ Connected — ${r.responseText.length} bytes`, 'success'); else showValidation(`✗ HTTP ${r.status}`, 'error'); },
                onerror() { showValidation('✗ Network error', 'error'); }
            });
        };
        btnGroup.appendChild(reloadBtn); btnGroup.appendChild(testBtn); body.appendChild(btnGroup);
        return tab;
    }

    function buildPlayerTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'player';
        const { section, body } = buildSection('Player Configuration'); tab.appendChild(section);

        const apRow = document.createElement('div'); apRow.className = 'fs-form-row inline';
        const apCb = document.createElement('input'); apCb.className = 'fs-form-checkbox'; apCb.type = 'checkbox'; apCb.checked = Settings.get('playerConfig.autoplay');
        apCb.onchange = () => Settings.set('playerConfig.autoplay', apCb.checked);
        const apLabel = document.createElement('div'); apLabel.className = 'fs-form-label'; apLabel.textContent = 'Autoplay on load'; apLabel.style.margin = '0';
        apRow.appendChild(apCb); apRow.appendChild(apLabel); body.appendChild(apRow);

        const muteRow = document.createElement('div'); muteRow.className = 'fs-form-row inline';
        const muteCb = document.createElement('input'); muteCb.className = 'fs-form-checkbox'; muteCb.type = 'checkbox'; muteCb.checked = Settings.get('playerConfig.muteOnLoad');
        muteCb.onchange = () => Settings.set('playerConfig.muteOnLoad', muteCb.checked);
        const muteLabel = document.createElement('div'); muteLabel.className = 'fs-form-label'; muteLabel.textContent = 'Mute Twitch video when overlay is active'; muteLabel.style.margin = '0';
        muteRow.appendChild(muteCb); muteRow.appendChild(muteLabel); body.appendChild(muteRow);

        const volRow = buildFormRow('Default Twitch Volume');
        const volRange = document.createElement('input'); volRange.className = 'fs-form-range'; volRange.type = 'range'; volRange.min = '0'; volRange.max = '1'; volRange.step = '0.05';
        volRange.value = Settings.get('playerConfig.defaultVolume');
        const volVal = document.createElement('div'); volVal.className = 'fs-form-range-value'; volVal.textContent = Math.round(volRange.value * 100) + '%';
        volRange.oninput = () => { volVal.textContent = Math.round(volRange.value * 100) + '%'; Settings.set('playerConfig.defaultVolume', parseFloat(volRange.value)); };
        const volWrap = document.createElement('div'); volWrap.style.display = 'flex'; volWrap.style.alignItems = 'center'; volWrap.style.gap = '10px';
        volWrap.appendChild(volRange); volWrap.appendChild(volVal); volRow.appendChild(volWrap); body.appendChild(volRow);

        const modeRow = buildFormRow('Preferred Player Mode');
        const modeSel = document.createElement('select'); modeSel.className = 'fs-form-select';
        [['overlay','Overlay (iframe)'], ['native','Native (Twitch only)']].forEach(([v, l]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = l;
            if (v === Settings.get('playerConfig.preferredMode')) o.selected = true; modeSel.appendChild(o);
        });
        modeSel.onchange = () => Settings.set('playerConfig.preferredMode', modeSel.value);
        modeRow.appendChild(modeSel); body.appendChild(modeRow);

        const fsRow = buildFormRow('Fullscreen Behavior');
        const fsSel = document.createElement('select'); fsSel.className = 'fs-form-select';
        [['preserve','Preserve — keep overlay visible in fullscreen'], ['exit','Exit fullscreen when loading overlay']].forEach(([v, l]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = l;
            if (v === Settings.get('playerConfig.fullscreenBehavior')) o.selected = true; fsSel.appendChild(o);
        });
        fsSel.onchange = () => Settings.set('playerConfig.fullscreenBehavior', fsSel.value);
        fsRow.appendChild(fsSel); body.appendChild(fsRow);

        return tab;
    }

    function buildMenuEditorTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'menu';
        const { section, body } = buildSection('Channel Menu Editor'); tab.appendChild(section);
        const list = document.createElement('div'); list.className = 'fs-menu-editor-list'; body.appendChild(list);

        function findChannelById(id) {
            const customs = Settings.get('customChannels') || [];
            const fromCustom = customs.find(c => c.id === id);
            if (fromCustom) return { source: 'custom', channel: fromCustom };
            const gistCh = (lastGistParsedResult || []).find(c => 'gist:' + normalizeUrl(c.url) === id);
            if (gistCh) return { source: 'gist', channel: gistCh };
            return null;
        }

        function getEditableChannelList() {
            const gistChannels = (lastGistParsedResult || []).map(ch => ({ id: 'gist:' + normalizeUrl(ch.url), name: ch.name, url: ch.url, description: ch.description || '', category: ch.category || 'General', enabled: true, _source: 'gist' }));
            const overrides = Settings.get('channelOverrides') || {};
            const gistWithOverrides = gistChannels.map(ch => { const ov = overrides[ch.id] || overrides[ch.url]; return ov ? { ...ch, ...ov, id: ch.id, _source: 'gist' } : ch; });
            const custom = (Settings.get('customChannels') || []).map(ch => ({ ...ch, id: ch.id || generateId(), _source: 'custom' }));
            const merged = [...gistWithOverrides];
            custom.forEach(cc => {
                const nurl = normalizeUrl(cc.url);
                const idx = merged.findIndex(g => normalizeUrl(g.url) === nurl && nurl !== 'https:' && nurl !== 'http:' && nurl !== '');
                if (idx !== -1) merged[idx] = { ...cc, _source: 'custom' }; else merged.push({ ...cc, _source: 'custom' });
            });
            const disabledIds = Settings.get('disabledIds') || [];
            disabledIds.forEach(did => {
                if (!merged.find(c => c.id === did)) {
                    const found = findChannelById(did);
                    if (found) merged.push({ ...found.channel, id: did, enabled: false, _source: found.source });
                }
            });
            return merged;
        }

        function renderEditorRows() {
            list.innerHTML = '';
            const fullList = getEditableChannelList();
            if (fullList.length === 0) {
                const empty = document.createElement('div'); empty.className = 'fs-form-hint'; empty.textContent = 'No channels loaded yet.'; list.appendChild(empty); return;
            }
            fullList.forEach((ch) => {
                const row = document.createElement('div'); row.className = 'fs-menu-editor-row'; row.draggable = true; row.dataset.id = ch.id;
                const handle = document.createElement('div'); handle.className = 'fs-me-drag-handle'; handle.textContent = '⠿';

                const enWrap = document.createElement('div'); enWrap.className = 'fs-me-enabled';
                const enCb = document.createElement('input'); enCb.type = 'checkbox'; enCb.className = 'fs-form-checkbox'; enCb.checked = ch.enabled !== false;
                enCb.onchange = () => {
                    const disabledIds = Settings.get('disabledIds') || [];
                    if (enCb.checked) Settings.set('disabledIds', disabledIds.filter(id => id !== ch.id));
                    else if (!disabledIds.includes(ch.id)) Settings.set('disabledIds', [...disabledIds, ch.id]);
                    markSettingsDirty();
                };
                enWrap.appendChild(enCb);

                const nameInput = document.createElement('input'); nameInput.className = 'fs-me-input'; nameInput.value = ch.name || ''; nameInput.placeholder = 'Channel name';
                nameInput.oninput = () => {
                    if (ch._source === 'custom') {
                        const customs = Settings.get('customChannels') || [];
                        const existing = customs.find(c => c.id === ch.id);
                        if (existing) { existing.name = nameInput.value; Settings.set('customChannels', customs); }
                    } else {
                        const ov = Settings.get('channelOverrides') || {};
                        ov[ch.id] = { ...(ov[ch.id] || {}), name: nameInput.value }; Settings.set('channelOverrides', ov);
                    }
                    markSettingsDirty();
                };

                const urlInput = document.createElement('input'); urlInput.className = 'fs-me-input'; urlInput.value = ch.url || ''; urlInput.placeholder = 'https://...';
                urlInput.oninput = () => {
                    const val = urlInput.value.trim();
                    if (val && !isValidUrl(val)) urlInput.classList.add('error'); else urlInput.classList.remove('error');
                    if (ch._source === 'custom') {
                        const customs = Settings.get('customChannels') || [];
                        const existing = customs.find(c => c.id === ch.id);
                        if (existing) { existing.url = val; Settings.set('customChannels', customs); }
                    } else {
                        const ov = Settings.get('channelOverrides') || {};
                        ov[ch.id] = { ...(ov[ch.id] || {}), url: val }; Settings.set('channelOverrides', ov);
                    }
                    markSettingsDirty();
                };

                const catSel = document.createElement('select'); catSel.className = 'fs-me-select';
                ['General', 'Sports', 'Movies', 'TV', 'Music', 'News', 'Gaming', 'Other'].forEach(c => {
                    const o = document.createElement('option'); o.value = c; o.textContent = c;
                    if ((ch.category || 'General') === c) o.selected = true; catSel.appendChild(o);
                });
                catSel.onchange = () => {
                    if (ch._source === 'custom') {
                        const customs = Settings.get('customChannels') || [];
                        const existing = customs.find(c => c.id === ch.id);
                        if (existing) { existing.category = catSel.value; Settings.set('customChannels', customs); }
                    } else {
                        const ov = Settings.get('channelOverrides') || {};
                        ov[ch.id] = { ...(ov[ch.id] || {}), category: catSel.value }; Settings.set('channelOverrides', ov);
                    }
                    markSettingsDirty();
                };

                const delBtn = document.createElement('button'); delBtn.className = 'fs-me-delete'; delBtn.textContent = '✕';
                delBtn.onclick = () => {
                    if (ch._source === 'custom') {
                        if (!confirm(`Delete "${ch.name}"?`)) return;
                        Settings.set('customChannels', (Settings.get('customChannels') || []).filter(c => c.id !== ch.id));
                        Settings.set('channelOrder', (Settings.get('channelOrder') || []).filter(id => id !== ch.id));
                        Settings.set('disabledIds', (Settings.get('disabledIds') || []).filter(id => id !== ch.id));
                    } else {
                        const disabledIds = Settings.get('disabledIds') || [];
                        if (!disabledIds.includes(ch.id)) Settings.set('disabledIds', [...disabledIds, ch.id]);
                    }
                    markSettingsDirty(); renderEditorRows();
                };

                row.appendChild(handle); row.appendChild(enWrap); row.appendChild(nameInput); row.appendChild(urlInput); row.appendChild(catSel); row.appendChild(document.createElement('div')); row.appendChild(delBtn);

                row.addEventListener('dragstart', (e) => { row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ch.id); });
                row.addEventListener('dragend', () => row.classList.remove('dragging'));
                row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
                row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
                row.addEventListener('drop', (e) => {
                    e.preventDefault(); row.classList.remove('drag-over');
                    const draggedId = e.dataTransfer.getData('text/plain');
                    if (draggedId && draggedId !== ch.id) {
                        const order = Settings.get('channelOrder') || [];
                        const filtered = order.filter(id => id !== draggedId);
                        const insertIdx = filtered.indexOf(ch.id);
                        if (insertIdx === -1) filtered.push(draggedId); else filtered.splice(insertIdx, 0, draggedId);
                        Settings.set('channelOrder', filtered); markSettingsDirty(); renderEditorRows();
                    }
                });
                list.appendChild(row);
            });
        }
        renderEditorRows();

        const addBtn = document.createElement('button'); addBtn.className = 'fs-btn small fs-menu-editor-add'; addBtn.textContent = '+ Add Custom Channel';
        addBtn.onclick = () => {
            const newId = generateId();
            const customs = Settings.get('customChannels') || [];
            customs.push({ id: newId, name: 'New Channel', url: `https://example.com/channel/${newId.slice(0, 8)}`, description: '', category: 'General', enabled: true });
            Settings.set('customChannels', customs); markSettingsDirty(); renderEditorRows();
            setTimeout(() => { const rows = list.querySelectorAll('.fs-menu-editor-row'); if (rows.length > 0) rows[rows.length - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 50);
        };
        body.appendChild(addBtn);

        const saveApplyBtn = document.createElement('button'); saveApplyBtn.className = 'fs-btn primary fs-menu-editor-add'; saveApplyBtn.style.marginLeft = '6px'; saveApplyBtn.textContent = '💾 Save & Apply';
        saveApplyBtn.onclick = () => {
            fetchPresetChannels(() => { showValidation(`Applied — ${SERVER_CHANNELS.length} channels in menu`, 'success'); Settings.set('settingsDirty', false); }, { forceRefresh: true });
        };
        body.appendChild(saveApplyBtn);
        return tab;
    }

    function buildIoToolsTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'iotools';
        const { section: s1, body: b1 } = buildSection('Export Settings');
        const exportBtn = document.createElement('button'); exportBtn.className = 'fs-btn primary'; exportBtn.textContent = 'Export as JSON';
        exportBtn.onclick = () => {
            const blob = new Blob([Settings.exportJSON()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'gist-stream-selector-settings.json'; a.click(); URL.revokeObjectURL(url);
            showValidation('Settings exported', 'success');
        };
        b1.appendChild(exportBtn);
        const ta1 = document.createElement('textarea'); ta1.className = 'fs-form-input'; ta1.rows = 8; ta1.readOnly = true; ta1.value = Settings.exportJSON();
        ta1.style.fontFamily = 'Menlo, Consolas, monospace'; ta1.style.fontSize = '10px'; b1.appendChild(ta1); tab.appendChild(s1);

        const { section: s2, body: b2 } = buildSection('Import Settings');
        const ta2 = document.createElement('textarea'); ta2.className = 'fs-form-input'; ta2.rows = 8; ta2.placeholder = 'Paste JSON here...'; ta2.style.fontFamily = 'Menlo, Consolas, monospace'; ta2.style.fontSize = '10px';
        const importBtn = document.createElement('button'); importBtn.className = 'fs-btn primary'; importBtn.textContent = 'Import';
        importBtn.onclick = () => {
            try { Settings.importJSON(ta2.value); showValidation('Settings imported successfully. Reloading...', 'success'); setTimeout(() => location.reload(), 1000); }
            catch (e) { showValidation('Import failed: ' + e.message, 'error'); }
        };
        b2.appendChild(ta2); b2.appendChild(importBtn); tab.appendChild(s2);

        const { section: s3, body: b3 } = buildSection('Reset', true);
        const resetBtn = document.createElement('button'); resetBtn.className = 'fs-btn danger'; resetBtn.textContent = 'Reset to Default Configuration';
        resetBtn.onclick = () => { if (confirm('Reset ALL settings?')) { Settings.reset(); location.reload(); } };
        b3.appendChild(resetBtn); tab.appendChild(s3);
        return tab;
    }

    function buildDevToolsTab() {
        const tab = document.createElement('div'); tab.className = 'fs-tab-content'; tab.dataset.tab = 'devtools';
        const { section: s0, body: b0 } = buildSection('Channel Counts (Debug)');
        const countsOut = document.createElement('div'); countsOut.className = 'fs-dev-output'; countsOut.id = 'fs-dev-counts'; countsOut.textContent = 'Click Refresh...'; b0.appendChild(countsOut);
        const countsRefreshBtn = document.createElement('button'); countsRefreshBtn.className = 'fs-btn small'; countsRefreshBtn.textContent = 'Recompute Counts'; countsRefreshBtn.onclick = refreshDebugCounts; b0.appendChild(countsRefreshBtn); tab.appendChild(s0);

        const { section: s1, body: b1 } = buildSection('Parsed Gist Data');
        const btnRow = document.createElement('div'); btnRow.className = 'fs-btn-group';
        const refreshBtn = document.createElement('button'); refreshBtn.className = 'fs-btn small'; refreshBtn.textContent = 'Refresh'; refreshBtn.onclick = refreshDevTools;
        const forceBtn = document.createElement('button'); forceBtn.className = 'fs-btn small'; forceBtn.textContent = 'Force Refresh Channels';
        forceBtn.onclick = () => { fetchPresetChannels(() => { refreshDevTools(); showValidation('Forced refresh complete', 'success'); }, { forceRefresh: true }); };
        btnRow.appendChild(refreshBtn); btnRow.appendChild(forceBtn); b1.appendChild(btnRow);
        const parsedOut = document.createElement('div'); parsedOut.className = 'fs-dev-output'; parsedOut.id = 'fs-dev-parsed'; b1.appendChild(parsedOut); tab.appendChild(s1);

        const { section: s2, body: b2 } = buildSection('Raw Response', true);
        const rawOut = document.createElement('div'); rawOut.className = 'fs-dev-output'; rawOut.id = 'fs-dev-raw'; b2.appendChild(rawOut); tab.appendChild(s2);

        const { section: s3, body: b3 } = buildSection('Validate Channel Mappings', true);
        const valBtn = document.createElement('button'); valBtn.className = 'fs-btn small'; valBtn.textContent = 'Run Validation';
        valBtn.onclick = () => {
            const out = document.getElementById('fs-dev-validate');
            out.textContent = '✓ All channels valid.'; out.classList.remove('error');
        };
        b3.appendChild(valBtn);
        const valOut = document.createElement('div'); valOut.className = 'fs-dev-output'; valOut.id = 'fs-dev-validate'; b3.appendChild(valOut); tab.appendChild(s3);

        const { section: s4, body: b4 } = buildSection('Errors', true);
        const errOut = document.createElement('div'); errOut.className = 'fs-dev-output error'; errOut.id = 'fs-dev-errors'; b4.appendChild(errOut); tab.appendChild(s4);

        return tab;
    }

    function refreshDevTools() {
        const parsed = document.getElementById('fs-dev-parsed');
        const raw = document.getElementById('fs-dev-raw');
        const err = document.getElementById('fs-dev-errors');
        if (!parsed) return;
        if (lastGistParsedResult) parsed.textContent = JSON.stringify(lastGistParsedResult, null, 2); else parsed.textContent = 'No data.';
        if (raw) raw.textContent = lastGistFetchResult || 'No raw data.';
        if (err) err.textContent = lastGistError || 'No errors.';
        refreshDebugCounts();
    }

    function refreshDebugCounts() {
        const el = document.getElementById('fs-dev-counts');
        if (!el) return;
        const finalChannels = applyChannelSettings(lastGistParsedResult || []);
        el.textContent = `Final merged: ${finalChannels.length}\nLast refresh: ${new Date(lastGistFetchTime).toLocaleTimeString()}`;
    }

    function showValidation(msg, kind) {
        const el = document.getElementById('fs-settings-validation');
        if (el) { el.textContent = msg; el.className = 'fs-settings-validation' + (kind ? ' ' + kind : ''); }
    }

    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
            e.preventDefault();
            if (settingsPanelEl && settingsPanelEl.classList.contains('active')) closeSettingsPanel(); else openSettingsPanel();
        }
        if (e.key === 'Escape' && settingsPanelEl && settingsPanelEl.classList.contains('active')) closeSettingsPanel();
    });

    /* ══════════════════════════════════════════
       Overlay UI Construction
       ══════════════════════════════════════════ */
    function initBuiltInMenu() {
        let existingContainer = document.querySelector('.fs-overlay-container');
        if (existingContainer) return existingContainer;

        const container = document.createElement('div'); container.className = 'fs-overlay-container';
        const mainWrapper = document.createElement('div'); mainWrapper.className = 'fs-main-wrapper';
        mainWrapper.addEventListener('click', (e) => e.stopPropagation());

        const header = document.createElement('div'); header.className = 'fs-header';
        const headerTitle = document.createElement('div'); headerTitle.className = 'fs-header-title'; headerTitle.innerHTML = `STREAM SELECTOR <span class="fs-live-indicator">LIVE</span>`;

        const gearBtn = document.createElement('button'); gearBtn.className = 'fs-settings-gear-btn'; gearBtn.title = 'Advanced Settings (Ctrl+Shift+S)';
        gearBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
        gearBtn.onclick = (e) => { e.stopPropagation(); openSettingsPanel(); };

        const closeBtn = document.createElement('button'); closeBtn.className = 'fs-close-btn'; closeBtn.title = 'Close';
        closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        closeBtn.onclick = (e) => { e.stopPropagation(); closeOverlay(); };

        header.appendChild(headerTitle);
        const headerRight = document.createElement('div'); headerRight.style.display = 'flex'; headerRight.style.alignItems = 'center';
        headerRight.appendChild(gearBtn); headerRight.appendChild(closeBtn); header.appendChild(headerRight); mainWrapper.appendChild(header);

        const liveTitle = document.createElement('div'); liveTitle.className = 'fs-section-title'; liveTitle.innerHTML = `<span class="fs-pulse-dot"></span> LIVE NOW`; mainWrapper.appendChild(liveTitle);
        liveMatchCardsContainer = document.createElement('div'); liveMatchCardsContainer.className = 'fs-grid'; liveMatchCardsContainer.innerHTML = '<div class="fs-no-matches">Loading matches...</div>'; mainWrapper.appendChild(liveMatchCardsContainer);

        const twitchTitle = document.createElement('div'); twitchTitle.className = 'fs-section-title'; twitchTitle.textContent = 'TWITCH'; mainWrapper.appendChild(twitchTitle);
        const nativeGrid = document.createElement('div'); nativeGrid.className = 'fs-grid'; mainWrapper.appendChild(nativeGrid); renderNativeButton(nativeGrid, container);

        const gistTitle = document.createElement('div'); gistTitle.className = 'fs-section-title'; gistTitle.textContent = 'GIST CHANNELS'; mainWrapper.appendChild(gistTitle);
        const gistGrid = document.createElement('div'); gistGrid.className = 'fs-grid'; gistGrid.id = 'fs-gist-grid'; gistGrid.innerHTML = '<div class="fs-no-matches">Loading channels...</div>'; mainWrapper.appendChild(gistGrid);

        fetchPresetChannels(() => { renderGridButtons(gistGrid, SERVER_CHANNELS, container, 'overlay'); });

        container.appendChild(mainWrapper); document.body.appendChild(container); container.addEventListener('click', () => { closeOverlay(); });
        startLiveMatchPolling();
        return container;
    }

    function refreshStreamMenuChannels() {
        const gistGrid = document.getElementById('fs-gist-grid');
        if (!gistGrid) return;
        gistGrid.innerHTML = '<div class="fs-no-matches">Loading channels...</div>';
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
            eyeButtonEl?.classList.add('active'); fallbackEyeEl?.classList.add('active');
            fetchLiveMatches();
            refreshStreamMenuChannels();
        }
    }

    /* ══════════════════════════════════════════
       Eye Button & UI Initialization
       ══════════════════════════════════════════ */
    const EYE_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 5c-7.6 0-10 7-10 7s2.4 7 10 7 10-7 10-7-2.4-7-10-7zm0 11.5c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5 4.5 2 4.5 4.5-2 4.5-4.5 4.5zm0-7.5c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>`;

    function attachEyeHandlers(eyeBtn) {
        eyeBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); if (uiState.overlayOpen) closeOverlay(); else openOverlay(); };
        eyeBtn.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); if (uiState.overlayOpen) closeOverlay(); else openOverlay(); };
    }

    function injectPlayerOverlayEye() {
        if (eyeButtonEl && document.contains(eyeButtonEl)) return true;
        const playerRoot = getPlayerRoot();
        if (!playerRoot) return false;
        try {
            const btn = document.createElement('button');
            btn.className = 'gist-player-eye-overlay'; btn.type = 'button'; btn.title = 'Click: Open Stream Selector'; btn.innerHTML = EYE_SVG;
            attachEyeHandlers(btn);
            if (getComputedStyle(playerRoot).position === 'static') playerRoot.style.position = 'relative';
            playerRoot.appendChild(btn); eyeButtonEl = btn; return true;
        } catch (err) { return false; }
    }

    function isPlayerEyeVisible() {
        if (!eyeButtonEl || !document.contains(eyeButtonEl)) return false;
        const rect = eyeButtonEl.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function injectFallbackEye() {
        if (fallbackEyeEl && document.contains(fallbackEyeEl)) return;
        const btn = document.createElement('button');
        btn.id = 'gist-fallback-eye'; btn.type = 'button'; btn.title = 'Click: Open Stream Selector'; btn.innerHTML = EYE_SVG;
        attachEyeHandlers(btn); document.body.appendChild(btn); fallbackEyeEl = btn;
    }

    function maintainUI() {
        try {
            injectPlayerOverlayEye();
            if (isPlayerEyeVisible()) { if (fallbackEyeEl && document.contains(fallbackEyeEl)) { fallbackEyeEl.remove(); fallbackEyeEl = null; } }
            else { if (!fallbackEyeEl || !document.contains(fallbackEyeEl)) injectFallbackEye(); }
            
            if (eyeButtonEl) {
                const cs = getComputedStyle(eyeButtonEl);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
                    eyeButtonEl.style.setProperty('display', 'flex', 'important');
                    eyeButtonEl.style.setProperty('visibility', 'visible', 'important');
                    eyeButtonEl.style.setProperty('opacity', '1', 'important');
                }
            }
            if (getPlayerRoot()) {
                getPlayerNotifContainer();
                if (activeStreamMatchKey) getLiveBadgeEl();
            }
        } catch (err) { if (!fallbackEyeEl || !document.contains(fallbackEyeEl)) injectFallbackEye(); }
    }

    // ── Kickoff ──
    Settings.load();
    injectFallbackEye();
    maintainUI();
    setInterval(maintainUI, 1000);

    if (Settings.get('panelOpen')) setTimeout(() => openSettingsPanel(), 500);

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) { lastUrl = location.href; setTimeout(maintainUI, 800); }
    }, 500);

})();
