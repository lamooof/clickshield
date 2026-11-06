(() => {
  'use strict';
  try {
    const script = document.currentScript || Array.from(document.scripts).find((s) => /\/tracker\.js(?:\?|$)/.test(s.src));
    if (!script || !script.src) return;
    const scriptURL = new URL(script.src, document.baseURI);
    const key = scriptURL.searchParams.get('key') || script.dataset.projectKey || '';
    if (!key) return;

    const apiBase = scriptURL.origin;
    const eventsURL = `${apiBase}/v1/events?key=${encodeURIComponent(key)}`;
    const finishURL = `${apiBase}/v1/session/finish?key=${encodeURIComponent(key)}`;
    const flushEvery = Math.max(2000, Number(script.dataset.flushMs || 5000));
    const mouseEvery = Math.max(50, Number(script.dataset.mouseSampleMs || 90));
    const yandexCounter = script.dataset.yandexCounter || '';
    const googleMeasurement = script.dataset.googleMeasurement || '';
    const now = Date.now();
    const safeURL = (value) => {
      try {
        if (!value) return "";
        const u = new URL(value, location.href);
        if (!["http:","https:"].includes(u.protocol)) return "";
        const clean = new URLSearchParams();
        ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','yclid','gclid','rb_clickid'].forEach((name) => {
          const v = u.searchParams.get(name); if (v) clean.set(name, v.slice(0, 256));
        });
        u.username = ''; u.password = ''; u.hash = ''; u.search = clean.toString();
        return u.toString().slice(0, 2048);
      } catch (_) { return ''; }
    };
    const local = trackerStorage('localStorage');
    const session = trackerStorage('sessionStorage');
    const uuid = () => {
      const cryptoAPI = window.crypto;
      if (cryptoAPI?.randomUUID) return cryptoAPI.randomUUID();
      const b = new Uint8Array(16);
      if (cryptoAPI?.getRandomValues) cryptoAPI.getRandomValues(b); else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
      b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
      const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
      return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10).join('')}`;
    };

    const visitorKey = `clickshield:visitor:${key}`;
    let visitorID = local.get(visitorKey);
    if (!visitorID || !/^[0-9a-f-]{36}$/i.test(visitorID)) { visitorID = uuid(); local.set(visitorKey, visitorID); }

    const visit = trackerSession(session, key, uuid, safeURL);
    let state = visit.state;
    const attribution = () => {
      const params = new URLSearchParams(new URL(state.landing || location.href).search);
      const utm = {};
      for (const name of ['source','medium','campaign','term','content']) utm[name] = (params.get('utm_' + name) || '').slice(0,256);
      return {utm, yclid:params.get('yclid') || '', gclid:params.get('gclid') || '', rb_clickid:params.get('rb_clickid') || ''};
    };

    const cookie = (name) => { try { return document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) || ''; } catch (_) { return ''; } };
    let yandexClientID = cookie('_ym_uid').replace(/\D/g, '').slice(0, 32);
    let googleClientID = (() => { try { const p = decodeURIComponent(cookie('_ga')).split('.'); return p.length >= 4 ? `${p[p.length-2]}.${p[p.length-1]}` : ''; } catch (_) { return ''; } })();
    try {
      if (yandexCounter && typeof window.ym === 'function') window.ym(Number(yandexCounter), 'getClientID', (id) => { if (id) yandexClientID = String(id).replace(/\D/g, '').slice(0, 32); });
      if (googleMeasurement && typeof window.gtag === 'function') window.gtag('get', googleMeasurement, 'client_id', (id) => { if (id) googleClientID = String(id).slice(0, 65); });
    } catch (_) {}

    const automation = {
      webdriver: navigator.webdriver === true,
      selenium: Boolean(window.document.documentElement.getAttribute('webdriver') || window._Selenium_IDE_Recorder || window.__selenium_unwrapped),
      phantom: Boolean(window.callPhantom || window._phantom),
      playwright: Boolean(window.__playwright__binding__ || window.__pwInitScripts),
      puppeteer: Object.keys(window).some((k) => /^cdc_[a-z0-9]+_/i.test(k))
    };
    const deviceType = /ipad|tablet/i.test(navigator.userAgent) ? 'tablet' : (/mobi|android|iphone|ipod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1) ? 'mobile' : 'desktop';
    const device = {
      type: deviceType,
      platform: String(navigator.userAgentData?.platform || navigator.platform || '').slice(0, 80),
      language: String(navigator.language || '').slice(0, 32),
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } })(),
      screen_width: screen.width || 0, screen_height: screen.height || 0, color_depth: screen.colorDepth || 0,
      hardware_concurrency: navigator.hardwareConcurrency || 0, device_memory: navigator.deviceMemory || 0,
      max_touch_points: navigator.maxTouchPoints || 0
    };

    let fingerprint = '';
    const fpParts = [navigator.userAgent, device.platform, device.language, device.timezone, `${screen.width}x${screen.height}x${screen.colorDepth}`, navigator.hardwareConcurrency, navigator.deviceMemory, navigator.maxTouchPoints].join('|');
    (async () => {
      try {
        const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(fpParts));
        fingerprint = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch (_) {
        let h = 2166136261; for (let i = 0; i < fpParts.length; i++) h = Math.imul(h ^ fpParts.charCodeAt(i), 16777619);
        fingerprint = `fnv-${(h >>> 0).toString(16)}`;
      }
    })();

    let queue = [];
    let lastMouse = 0, lastScroll = 0, lastActivity = now, lastTick = now, activeDelta = 0, idleDelta = 0;
    let paused = false, decision = 'MONITOR';
    const event = (type, data = {}) => {
      if (paused || visit.expired()) return;
      queue.push({ type, ts: Date.now(), page_url: safeURL(location.href), page_index: state.pageIndex, ...data });
      if (queue.length >= 100) flush(false);
    };
    const activity = () => {
      const restarted = paused || visit.expired();
      if (restarted) {
        pauseVisit(); visit.restart(); state = visit.state; paused = false;
        lastTick = Date.now(); activeDelta = idleDelta = 0;
        handleDecision('MONITOR', state.id);
        event('pageview', {extra:{page_url:safeURL(location.href)}}); emitScroll();
        startReplay();
      }
      lastActivity = Date.now(); visit.touch();
      return restarted;
    };
    const heartbeat = () => {
      if (paused) return;
      const t = Math.min(Date.now(), state.last + 30 * 60 * 1000); const delta = Math.min(5000, Math.max(0, t - lastTick));
      if (!document.hidden && t - lastActivity < 5000) activeDelta += delta; else idleDelta += delta;
      lastTick = t;
    };
    setInterval(heartbeat, 1000);

    const emitScroll=()=>{const d=Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0);event('scroll',{scroll_y:scrollY,depth:d>0?Math.min(1,(scrollY+innerHeight)/d):0,vw:innerWidth,vh:innerHeight,document_height:d})};
    event('pageview', { page_index: state.pageIndex, extra: {page_url:safeURL(location.href)} });
    emitScroll();
    addEventListener('resize',emitScroll,{passive:true});
    event('automation', { extra: automation });
    let lastPageURL=location.href;
    addEventListener('clickshield:pageview', () => {
      if(lastPageURL===location.href)return;lastPageURL=location.href;
      if (activity()) { flush(false); return; }
      visit.nextPage();
      event('pageview', { page_index: state.pageIndex, extra: {page_url:safeURL(location.href)} });
      emitScroll();
      flush(false);
    });
    addEventListener('mousemove', (e) => { const t = Date.now(); if (t - lastMouse < mouseEvery) return; lastMouse = t; activity(); event('mousemove', { x: e.clientX, y: e.clientY, vw: innerWidth, vh: innerHeight, pointer: 'mouse' }); }, { passive: true });
    addEventListener('pointerdown', (e) => { activity(); event('click', { x: e.clientX, y: e.clientY, vw: innerWidth, vh: innerHeight, pointer: e.pointerType || '', button: e.button, scroll_y: scrollY, document_height: Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0) }); }, { passive: true, capture: true });
    addEventListener('scroll', () => { const t = Date.now(); if (t - lastScroll < 150) return; lastScroll = t; activity(); const d = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0); const depth = d > 0 ? Math.min(1, (scrollY + innerHeight) / d) : 0; event('scroll', { scroll_y: scrollY, depth, vw: innerWidth, vh: innerHeight, document_height: d }); }, { passive: true });
    addEventListener('touchstart', (e) => { activity(); event('touch', { extra: { touches: Math.min(10, e.touches.length) } }); }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) activity(); heartbeat(); event('visibility', { visible: !document.hidden }); if (document.hidden) flush(false); }, { passive: true });
    ['keydown', 'focus'].forEach((name) => addEventListener(name, activity, { passive: true }));

    const payload = (finish = false) => ({
      session_id: state.id, visitor_id: visitorID, sent_at: Date.now(), finish,
      page_url: safeURL(location.href), landing_url: safeURL(state.landing || location.href),
      referrer: state.referrer || "", yandex_client_id: yandexClientID, google_client_id: googleClientID,
      ...attribution(), fingerprint, device, automation, page_index: state.pageIndex
    });
    const addHeartbeat = () => { heartbeat(); if (activeDelta || idleDelta) { queue.push({ type: 'heartbeat', ts: Date.now(), active_ms: Math.round(activeDelta), idle_ms: Math.round(idleDelta) }); activeDelta = 0; idleDelta = 0; } };
    const handleDecision = (value, sessionID) => {
      if (sessionID !== state.id || !value || value === decision) return; decision = value;
      document.documentElement.dataset.antifraudDecision = value.toLowerCase();
      dispatchEvent(new CustomEvent('antifraud:decision', { detail: { decision: value, sessionId: state.id } }));
    };
    const transport = trackerTransport(eventsURL, uuid, handleDecision);
    function pauseVisit() {
      if (paused) return;
      addHeartbeat(); paused = true;
      window.ClickShieldReplay?.stop();
      transport.enqueue(queue.splice(0), payload(true));
    }
    function flush(beacon = false) {
      if (visit.expired()) pauseVisit();
      if (!paused) {
        addHeartbeat();
        transport.enqueue(queue.splice(0), payload(beacon));
      }
      return transport.flush(beacon);
    }
    setInterval(() => flush(false), flushEvery);
    addEventListener('pagehide', () => {
      flush(true);
      if (!paused) {
        const finish = JSON.stringify({session_id:state.id,visitor_id:visitorID,batch_id:uuid(),reason:'pagehide',sent_at:Date.now()});
        navigator.sendBeacon?.(finishURL, new Blob([finish], {type:'text/plain;charset=UTF-8'}));
      }
    }, {capture:true});
    const track = (name,properties={}) => {
      if(typeof name!=='string'||!name.trim()||[...name.trim()].length>80)throw new TypeError('Event name must contain 1–80 characters');
      if(!properties||typeof properties!=='object'||Array.isArray(properties)||Object.keys(properties).length>32)throw new TypeError('Expected up to 32 scalar properties');
      const clean={};for(const [k,v] of Object.entries(properties)){if(!k.trim()||new TextEncoder().encode(k).length>80||!(v===null||['string','number','boolean'].includes(typeof v))||(typeof v==='number'&&!Number.isFinite(v))||(typeof v==='string'&&new TextEncoder().encode(v).length>1024))throw new TypeError('Invalid event property');Object.defineProperty(clean,k,{value:v,enumerable:true});}
      if(new TextEncoder().encode(JSON.stringify(clean)).length>8192)throw new TypeError('Event properties exceed 8 KiB');
      activity(); event('business',{name:name.trim(),properties:clean});return true;
    };
    document.addEventListener('click',e=>{const el=e.target?.closest?.('[data-cs-event]');if(!el)return;try{const p={};for(const [k,v] of Object.entries(el.dataset))if(k.startsWith('csProp'))p[k.slice(6).replace(/^./,c=>c.toLowerCase())]=v;track(el.dataset.csEvent,p);}catch(_){}},{capture:true});
    window.ClickShield = Object.freeze({ track, get sessionId() { return state.id; }, visitorId: visitorID, pageIndex: () => state.pageIndex, flush: () => flush(false), getDecision: () => decision });
    for(const method of ['pushState','replaceState']){const original=history[method];history[method]=function(...args){const result=original.apply(this,args);dispatchEvent(new Event('clickshield:pageview'));return result}}
    addEventListener('popstate',()=>dispatchEvent(new Event('clickshield:pageview')));
    let replayConfig = null, replayLoader = null;
    async function startReplay() {
      if (!replayConfig?.replay_enabled || paused || visit.expired()) return;
      const current = state;
      if (typeof current.replaySample !== 'number') { current.replaySample = Math.random()*100; visit.save(); }
      if (current.replaySample >= replayConfig.replay_sample_rate) return;
      replayLoader ||= new Promise((resolve, reject) => {
        const loader = document.createElement('script'); loader.src = `${apiBase}/assets/replay-recorder.js`; loader.async = true;
        loader.onload = resolve; loader.onerror = reject; document.head.append(loader);
      });
      try {
        await replayLoader;
        if (state !== current || paused || visit.expired()) return;
        const stop = await window.ClickShieldReplay?.start({apiBase,key,sessionId:current.id,visitorId:visitorID,pageIndex:()=>current.pageIndex,safeURL});
        if (state !== current || paused) stop?.();
      } catch (_) {}
    }
    flush(false);
    fetch(`${apiBase}/v1/tracker/config?key=${encodeURIComponent(key)}`,{mode:'cors',credentials:'omit'})
      .then(r=>r.ok?r.json():null).then(cfg=>{replayConfig=cfg;startReplay()}).catch(()=>{});

  } catch (_) {
    // Tracker failures are intentionally isolated from the host website.
  }
})();
