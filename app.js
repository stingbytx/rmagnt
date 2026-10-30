/* ============================================================
   REMY AGENT — real-time voice client
   Static, dependency-free. Runs from GitHub Pages as-is.

   Pipeline: getUserMedia -> browser ASR -> your NVIDIA proxy
             -> streamed chat completion -> browser TTS
   ============================================================ */
(function () {
  'use strict';

  /* ---------- constants ---------- */
  const LS_SETTINGS = 'remy.settings.v1';
  const LS_HISTORY = 'remy.history.v1';
  const SS_TOKEN = 'remy.apptoken.v1';
  const MAX_TURNS_CONTEXT = 14;
  const MAX_HISTORY = 40;
  const VAD_THRESHOLD = 0.062;
  const VAD_FRAMES = 3;

  /* Public runtime config (config.js). Committed on purpose: it carries the
     Worker URL only — never the NVIDIA key, which stays in Cloudflare. */
  const CONFIG = (window.REMY_CONFIG && typeof window.REMY_CONFIG === 'object') ? window.REMY_CONFIG : {};
  const CONFIG_PROXY = (function () {
    const raw = String(CONFIG.proxyUrl || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/example\.com|yourdomain\.com/i.test(raw)) return ''; // still the placeholder
    return raw.replace(/\/chat\/completions$/, '').replace(/\/models$/, '');
  })();
  const CONFIG_TOKEN = String(CONFIG.appToken || '').trim();

  /* The deployed Worker. This is the last-resort fallback, so a visitor is
     never asked to configure anything: if config.js is missing or still holds
     the placeholder, requests still go to the right place.
     Change this one line if the Worker moves. */
  const BUILTIN_PROXY = 'https://api.remyagent.cc';

  function normalizeBase(raw) {
    return String(raw || '').trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '')
      .replace(/\/models$/, '');
  }

  /* Owner mode: reveals the Connection card, setup banner and proxy controls.
     Visitors only ever get the voice/chat surface. Enable with ?owner=1
     (persists on this browser), disable with ?owner=0. Local dev is owner. */
  const OWNER_KEY = 'remy.owner.v1';
  function resolveOwner() {
    const params = new URLSearchParams(location.search);
    const flag = params.get('owner');
    try {
      if (flag === '0') { localStorage.removeItem(OWNER_KEY); return false; }
      if (flag === '1') { localStorage.setItem(OWNER_KEY, '1'); return true; }
      if (localStorage.getItem(OWNER_KEY) === '1') return true;
    } catch (e) {}
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || location.protocol === 'file:';
  }
  const IS_OWNER = resolveOwner();

  const STATE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    LISTENING: 'listening',
    PROCESSING: 'processing',
    SPEAKING: 'speaking',
    INTERRUPTED: 'interrupted',
    RECONNECTING: 'reconnecting',
    ERROR: 'error'
  };

  const STATUS = {
    idle: ['Idle — start a conversation', 'Microphone is off.'],
    connecting: ['Connecting', 'Starting the microphone and session.'],
    listening: ['Listening', 'Speak — I will answer out loud.'],
    processing: ['Thinking', 'Working on your last turn.'],
    speaking: ['Speaking', 'Interrupt any time — just start talking.'],
    interrupted: ['Interrupted', 'Go ahead, I am listening.'],
    reconnecting: ['Reconnecting', 'Retrying the model request.'],
    error: ['Connection problem', '']
  };

  const LANGUAGES = [
    ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'],
    ['en-IN', 'English (India)'], ['es-ES', 'Español (España)'], ['es-MX', 'Español (México)'],
    ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['it-IT', 'Italiano'], ['pt-BR', 'Português (Brasil)'],
    ['nl-NL', 'Nederlands'], ['hi-IN', 'हिन्दी'], ['ta-IN', 'தமிழ்'], ['si-LK', 'සිංහල'],
    ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '中文 (简体)'], ['ar-SA', 'العربية'],
    ['ru-RU', 'Русский'], ['tr-TR', 'Türkçe'], ['id-ID', 'Bahasa Indonesia'], ['pl-PL', 'Polski']
  ];

  const DEFAULT_PROMPT =
    'You are {name}, a real-time voice assistant. You speak, and your words are read aloud by a speech engine, so write the way a thoughtful person talks.\n\n' +
    'Rules for every reply:\n' +
    '- Be warm, direct and natural. No filler, no corporate tone.\n' +
    '- Keep it short: one to three spoken sentences unless the user asks for depth.\n' +
    '- Plain prose only. No markdown, no bullet lists, no headings, no emoji, no URLs read aloud unless asked.\n' +
    '- Say numbers, dates and units the way you would say them out loud.\n' +
    '- Ask one clarifying question when the request is ambiguous.\n' +
    '- If you are unsure or lack information, say so plainly and suggest the next step.\n' +
    '- Never claim you performed an action you did not perform.\n' +
    '- Do not repeat a greeting after the first turn, and do not restate what the user just said.';

  /* ---------- helpers ---------- */
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toISOString();
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDate = (d) => {
    const date = new Date(d);
    const today = new Date();
    const same = date.toDateString() === today.toDateString();
    return same ? 'Today ' + fmtTime(d) : date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + fmtTime(d);
  };
  const clampText = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t);

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      toast('This browser refused local storage — settings will not persist.', 'err');
      return false;
    }
  }

  /* ---------- settings ---------- */
  const DEFAULTS = {
    agentName: 'Remy',
    systemPrompt: DEFAULT_PROMPT,
    style: 'concise',
    language: 'en-US',
    model: String(CONFIG.model || 'nvidia/llama-3.1-nemotron-70b-instruct'),
    proxyUrl: '',
    inputDeviceId: '',
    outputVoice: '',
    ttsRate: 1,
    ttsPitch: 1,
    temperature: 0.6,
    maxTokens: 420,
    showTranscript: true,
    storeHistory: true,
    autoSpeak: true,
    bargeIn: true
  };

  let settings = Object.assign({}, DEFAULTS, readJSON(LS_SETTINGS, {}));
  let appToken = '';
  try { appToken = sessionStorage.getItem(SS_TOKEN) || CONFIG_TOKEN; } catch (e) { appToken = CONFIG_TOKEN; }

  function saveSettings() {
    writeJSON(LS_SETTINGS, settings);
    syncRuntimePanel();
  }

  function apiBase() {
    const saved = normalizeBase(settings.proxyUrl);
    if (saved) return saved;
    if (CONFIG_PROXY) return CONFIG_PROXY;
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || location.protocol === 'file:') return '/api';
    return normalizeBase(BUILTIN_PROXY) || '';
  }

  function isConfigured() {
    return !!apiBase();
  }

  function composeSystemPrompt() {
    const style = {
      concise: 'Keep replies to one or two short sentences. This is a voice channel.',
      balanced: 'Use two to four sentences — enough to be useful, still easy to follow by ear.',
      detailed: 'You may explain in a short paragraph, but stay organised and avoid lists.'
    }[settings.style] || '';
    const langLabel = (LANGUAGES.find((l) => l[0] === settings.language) || LANGUAGES[0])[1];
    const base = String(settings.systemPrompt || DEFAULT_PROMPT)
      .split('{name}').join(settings.agentName || 'Remy')
      .split('{{name}}').join(settings.agentName || 'Remy');
    return (
      base + '\n\n' +
      'Your name is ' + (settings.agentName || 'Remy') + '. ' +
      style + ' ' +
      'Reply in ' + langLabel + ' unless the user clearly speaks another language. ' +
      'This is a live spoken conversation, so never mention formatting, markdown, or that you are an AI language model.'
    );
  }

  /* ---------- provider ---------- */
  function ProviderError(message, code, status, detail) {
    const e = new Error(message);
    e.code = code || 'unknown';
    e.status = status || 0;
    e.detail = detail || '';
    return e;
  }

  const ERROR_COPY = {
    auth: ['Authentication failed', 'Your proxy rejected the request. Check the NVIDIA_API_KEY secret on the proxy.'],
    forbidden: ['Access denied', 'This account or model is not enabled for your API key. Try another model ID.'],
    quota: ['Quota exhausted', 'Your NVIDIA credits or free-tier quota are used up for now.'],
    rate: ['Rate limited', 'Too many requests. Wait a moment, then retry.'],
    model: ['Model unavailable', 'That model ID was not found. Fetch the model list and pick another.'],
    upstream: ['Provider error', 'The model endpoint returned an error. Retrying usually works.'],
    network: ['Network unreachable', 'The request did not reach your proxy. Check the URL, CORS, and your connection.'],
    config: ['Not configured', 'Add your proxy URL in Settings first — the API key must stay server-side.'],
    timeout: ['Request timed out', 'The model took too long to answer. Try again.'],
    permission: ['Microphone blocked', 'Allow microphone access for this site in your browser, then retry.'],
    stt: ['Speech recognition unavailable', 'This browser cannot transcribe audio. Use Chrome or Edge, or enable the Web Speech API.'],
    tts: ['Speech synthesis unavailable', 'This browser cannot speak the reply. The transcript still works.'],
    empty: ['No speech detected', 'I did not catch anything. Try again a little closer to the mic.']
  };

  function describeError(err) {
    const copy = ERROR_COPY[err && err.code] || ['Something went wrong', (err && err.message) || 'Unexpected error.'];
    return { title: copy[0], message: copy[1], detail: (err && err.detail) || '' };
  }

  const Provider = {
    headers() {
      const h = { 'Content-Type': 'application/json' };
      if (appToken) h['x-app-token'] = appToken;
      return h;
    },

    async chat({ messages, signal, onDelta, onStatus }) {
      const base = apiBase();
      if (!base) throw ProviderError('No proxy configured', 'config');
      const body = {
        model: settings.model,
        messages,
        temperature: Number(settings.temperature) || 0.6,
        max_tokens: Number(settings.maxTokens) || 420,
        stream: true
      };

      let res;
      try {
        res = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw ProviderError('Network error', 'network', 0, 'Could not reach ' + base);
      }

      if (!res.ok) {
        let detail = '';
        let payload = null;
        try { payload = await res.json(); } catch (e) {}
        if (payload) {
          detail = (payload.error && (payload.error.message || payload.error)) || payload.detail || payload.message || '';
          if (typeof detail !== 'string') detail = JSON.stringify(detail);
        }
        const code =
          res.status === 401 ? 'auth' :
          res.status === 402 ? 'quota' :
          res.status === 403 ? 'forbidden' :
          res.status === 404 ? 'model' :
          res.status === 408 ? 'timeout' :
          res.status === 429 ? 'rate' :
          res.status >= 500 ? 'upstream' : 'upstream';
        throw ProviderError('HTTP ' + res.status, code, res.status, String(detail).slice(0, 400));
      }

      const ctype = res.headers.get('content-type') || '';
      if (ctype.indexOf('text/event-stream') === -1 || !res.body) {
        const data = await res.json().catch(() => null);
        const text = data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content || ''
          : '';
        if (text) onDelta(text, text);
        return text || '';
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let full = '';
      if (onStatus) onStatus('streaming');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.charAt(0) === ':') continue;
          if (trimmed.indexOf('data:') !== 0) continue;
          const chunk = trimmed.slice(5).trim();
          if (!chunk || chunk === '[DONE]') continue;
          try {
            const json = JSON.parse(chunk);
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            const piece = (delta && (delta.content || delta.reasoning_content)) || '';
            if (piece) {
              full += piece;
              onDelta(piece, full);
            }
          } catch (e) {
            /* ignore malformed keep-ascii heartbeats */
          }
        }
      }
      if (!full && buf.trim()) {
        try {
          const json = JSON.parse(buf.replace(/^data:\s*/, ''));
          const piece = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
          if (piece) { full = piece; onDelta(piece, full); }
        } catch (e) {}
      }
      return full;
    },

    async models(signal) {
      const base = apiBase();
      if (!base) throw ProviderError('No proxy configured', 'config');
      let res;
      try {
        res = await fetch(base + '/models', { headers: this.headers(), signal });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw ProviderError('Network error', 'network');
      }
      if (!res.ok) {
        const code = res.status === 401 ? 'auth' : res.status === 403 ? 'forbidden' : 'upstream';
        throw ProviderError('HTTP ' + res.status, code, res.status);
      }
      const json = await res.json();
      const list = (json && json.data) || [];
      return list.map((m) => m.id).filter(Boolean);
    }
  };

  /* ---------- audio input ---------- */
  const AudioIO = {
    ctx: null,
    stream: null,
    analyser: null,
    data: null,
    raf: null,
    level: 0,
    onLevel: null,

    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw ProviderError('getUserMedia unsupported', 'permission');
      }
      const constraints = {
        audio: {
          deviceId: settings.inputDeviceId ? { exact: settings.inputDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
          throw ProviderError('Microphone permission denied', 'permission', 0, e.name);
        }
        if (e && e.name === 'NotFoundError') {
          throw ProviderError('No microphone found', 'permission', 0, 'No input device is connected.');
        }
        if (e && settings.inputDeviceId) {
          settings.inputDeviceId = '';
          saveSettings();
          return this.start();
        }
        throw ProviderError('Microphone unavailable', 'permission', 0, (e && e.name) || '');
      }

      this.stop();
      this.stream = stream;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) {} }
      const src = this.ctx.createMediaStreamSource(stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.7;
      src.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.fftSize);
      this.tick();
    },

    tick() {
      const loop = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(this.data);
        let sum = 0;
        for (let i = 0; i < this.data.length; i++) {
          const v = (this.data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / this.data.length);
        this.level += (rms - this.level) * 0.24;
        if (this.onLevel) this.onLevel(this.level);
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    },

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      if (this.stream) {
        this.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
      }
      this.stream = null;
      if (this.ctx) { try { this.ctx.close(); } catch (e) {} }
      this.ctx = null;
      this.analyser = null;
      this.data = null;
      this.level = 0;
    }
  };

  /* ---------- speech recognition ---------- */
  const STT = {
    rec: null,
    wanted: false,
    active: false,
    pendingFinal: '',
    flushTimer: 0,
    liveEl: null,

    supported() {
      return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    },

    build() {
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.lang = settings.language || 'en-US';

      rec.onstart = () => { this.active = true; };

      rec.onresult = (event) => {
        if (Session.state !== STATE.LISTENING) return;
        let interim = '';
        let finished = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = (result[0] && result[0].transcript) || '';
          if (result.isFinal) finished += text + ' ';
          else interim += text;
        }
        if (interim.trim()) this.showLive(interim.trim());
        if (finished.trim()) {
          this.pendingFinal += finished;
          this.showLive(this.pendingFinal.trim());
          this.scheduleFlush(650);
        }
      };

      rec.onspeechstart = () => {
        if (Session.state === STATE.LISTENING) UI.pulseOrb();
      };

      rec.onerror = (event) => {
        const err = event.error || '';
        if (err === 'no-speech' || err === 'aborted') return;
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          Session.fail(ProviderError('Microphone permission denied', 'permission', 0, err), 'permission');
          return;
        }
        if (err === 'audio-capture') {
          Session.fail(ProviderError('No microphone found', 'permission'), 'permission');
          return;
        }
        if (err === 'network') {
          toast('Speech recognition lost its network connection. Retrying…', 'err');
          return;
        }
        if (err === 'language-not-supported') {
          Session.fail(ProviderError('Language unsupported by this browser', 'stt', 0, settings.language), 'stt');
        }
      };

      rec.onend = () => {
        this.active = false;
        if (this.wanted && Session.state === STATE.LISTENING) {
          setTimeout(() => {
            if (this.wanted && Session.state === STATE.LISTENING && !this.active) {
              try { rec.start(); } catch (e) {}
            }
          }, 260);
        }
      };

      return rec;
    },

    start() {
      if (!this.supported()) {
        Session.fail(ProviderError('Speech recognition unsupported', 'stt'), 'stt');
        return false;
      }
      this.wanted = true;
      if (!this.rec) this.rec = this.build();
      this.rec.lang = settings.language || 'en-US';
      if (!this.active) {
        try { this.rec.start(); } catch (e) { /* already started */ }
      }
      return true;
    },

    stop() {
      this.wanted = false;
      this.pendingFinal = '';
      clearTimeout(this.flushTimer);
      this.hideLive();
      if (this.rec && this.active) {
        try { this.rec.stop(); } catch (e) {}
      }
    },

    abort() {
      this.wanted = false;
      this.pendingFinal = '';
      clearTimeout(this.flushTimer);
      this.hideLive();
      if (this.rec) {
        try { this.rec.abort(); } catch (e) {}
      }
      this.active = false;
    },

    scheduleFlush(delay) {
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), delay);
    },

    flush() {
      const text = (this.pendingFinal || '').trim();
      this.pendingFinal = '';
      this.hideLive();
      if (!text) return;
      if (Session.state !== STATE.LISTENING) return;
      Session.sendTurn(text);
    },

    showLive(text) {
      if (!settings.showTranscript) return;
      if (!this.liveEl) {
        this.liveEl = UI.addMessage('user', text, { live: true, label: 'You · live' });
      } else {
        this.liveEl.setText(text);
      }
      UI.scrollTranscript();
    },

    hideLive() {
      if (this.liveEl) {
        this.liveEl.el.remove();
        this.liveEl = null;
        UI.scrollTranscript();
      }
    }
  };

  /* ---------- speech synthesis ---------- */
  const TTS = {
    voices: [],
    generation: 0,
    speaking: false,

    load() {
      if (!('speechSynthesis' in window)) return;
      const grab = () => {
        this.voices = window.speechSynthesis.getVoices() || [];
        UI.fillVoices();
      };
      grab();
      window.speechSynthesis.addEventListener('voiceschanged', grab);
    },

    pick() {
      const all = this.voices.length ? this.voices : (window.speechSynthesis.getVoices() || []);
      if (!all.length) return null;
      if (settings.outputVoice) {
        const exact = all.find((v) => v.name === settings.outputVoice);
        if (exact) return exact;
      }
      const lang = (settings.language || 'en-US').toLowerCase();
      const sameLang = all.filter((v) => v.lang && v.lang.toLowerCase().replace('_', '-').startsWith(lang.slice(0, 2)));
      const prefer = sameLang.find((v) => /natural|neural|premium|enhanced|google/i.test(v.name)) || sameLang[0];
      return prefer || all.find((v) => v.default) || all[0];
    },

    chunk(text) {
      const parts = String(text)
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?…:])\s+/)
        .filter(Boolean);
      const out = [];
      let buf = '';
      for (const p of parts) {
        if ((buf + ' ' + p).trim().length > 200 && buf) { out.push(buf.trim()); buf = p; }
        else buf = (buf ? buf + ' ' : '') + p;
      }
      if (buf.trim()) out.push(buf.trim());
      return out.length ? out : [String(text)];
    },

    async speak(text, hooks) {
      if (!('speechSynthesis' in window)) throw ProviderError('Speech synthesis unsupported', 'tts');
      const gen = ++this.generation;
      const chunks = this.chunk(text);
      this.speaking = true;
      if (hooks && hooks.onStart) hooks.onStart();

      for (const chunk of chunks) {
        if (gen !== this.generation) break;
        await new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(chunk);
          const voice = this.pick();
          if (voice) { u.voice = voice; u.lang = voice.lang; }
          else u.lang = settings.language || 'en-US';
          u.rate = Number(settings.ttsRate) || 1;
          u.pitch = Number(settings.ttsPitch) || 1;
          u.volume = 1;
          u.onboundary = () => { if (hooks && hooks.onBoundary) hooks.onBoundary(); };
          u.onend = () => resolve();
          u.onerror = (e) => {
            if (e && e.error === 'interrupted') resolve();
            else resolve();
          };
          window.speechSynthesis.speak(u);
          // Safari sometimes never fires onend for very short strings.
          setTimeout(() => { if (!window.speechSynthesis.speaking) resolve(); }, 20000);
        });
        if (gen !== this.generation) break;
      }

      this.speaking = false;
      if (hooks && hooks.onEnd) hooks.onEnd(gen === this.generation);
    },

    cancel() {
      this.generation++;
      this.speaking = false;
      if ('speechSynthesis' in window) {
        try { window.speechSynthesis.cancel(); } catch (e) {}
      }
    }
  };

  /* ---------- UI ---------- */
  const UI = {
    els: {},
    timer: null,
    seconds: 0,
    lastPulse: 0,
    speechEnergy: 0,

    init() {
      this.els = {
        body: document.body,
        orbStage: $('orbStage'),
        wave: $('wave'),
        statusText: $('statusText'),
        statusSub: $('statusSub'),
        chip: $('chipLive'),
        chipText: $('chipText'),
        micBtn: $('micBtn'),
        micLabel: $('micLabel'),
        micNote: $('micNote'),
        alert: $('alertBox'),
        alertTitle: $('alertTitle'),
        alertMsg: $('alertMsg'),
        retryBtn: $('retryBtn'),
        transcriptBody: $('transcriptBody'),
        transcriptEmpty: $('transcriptEmpty'),
        msgCount: $('msgCount'),
        footSession: $('footSession'),
        footTurns: $('footTurns'),
        side: $('transcriptSide'),
        footModel: $('footModel'),
        footAsr: $('footAsr'),
        footTts: $('footTts'),
        stripRoute: $('stripRoute'),
        setup: $('setupBanner'),
        muteBtn: $('muteBtn'),
        speakerBtn: $('speakerBtn'),
        transcriptBtn: $('transcriptBtn'),
        interruptBtn: $('interruptBtn'),
        endBtn: $('endBtn'),
        newBtn: $('newBtn'),
        histList: $('histList'),
        histCount: $('histCount'),
        micMeter: $('micMeter'),
        micTestBadge: $('micTestBadge')
      };

      for (let i = 0; i < 27; i++) {
        const bar = document.createElement('i');
        bar.style.height = '3px';
        this.els.wave.appendChild(bar);
      }
      this.setTranscriptVisible(settings.showTranscript);
      this.setMuted(false);
      this.setSpeakerMuted(false);
      this.waveFrame();
    },

    setState(state, sub) {
      const prev = Session.state;
      Session.state = state;
      const label = STATUS[state] || STATUS.idle;
      const textMode = Session.mode === 'text';
      const textListening = textMode && (state === STATE.LISTENING || state === STATE.INTERRUPTED);
      document.body.dataset.state = state;
      this.els.orbStage.dataset.state = state;
      this.els.statusText.textContent = textListening ? 'Text mode' : label[0];
      this.els.statusSub.textContent = textListening ? 'Type below — replies are still spoken aloud.' : (sub || label[1]);
      this.els.chip.dataset.state = state;
      if (state === STATE.SPEAKING) this.speechEnergy = Math.max(this.speechEnergy, 0.75);
      if (state === STATE.IDLE || state === STATE.ERROR) this.speechEnergy = 0;
      const chipLabels = { idle: 'Offline', connecting: 'Connecting', listening: 'Listening', processing: 'Thinking', speaking: 'Speaking', interrupted: 'Interrupted', reconnecting: 'Reconnecting', error: 'Error' };
      this.els.chipText.textContent = textListening ? 'Chat' : (chipLabels[state] || state);
      this.els.footTurns.textContent = textListening ? 'text' : state;

      const live = state === STATE.LISTENING || state === STATE.SPEAKING || state === STATE.PROCESSING || state === STATE.INTERRUPTED;
      this.els.micBtn.dataset.live = String(live);
      this.els.micLabel.textContent = live ? (textMode ? 'Talk instead' : 'End conversation') : state === STATE.CONNECTING ? 'Connecting…' : 'Start talking';
      this.els.micBtn.setAttribute('aria-label', live ? (textMode ? 'Switch to voice mode' : 'End conversation') : 'Start conversation');
      this.els.micBtn.disabled = state === STATE.CONNECTING;
      this.els.interruptBtn.disabled = !(state === STATE.SPEAKING || state === STATE.PROCESSING);
      this.els.endBtn.disabled = !live;
      this.els.newBtn.disabled = false;

      if (state !== STATE.ERROR) this.clearAlert();

      if (state === STATE.LISTENING && prev !== STATE.LISTENING) this.startTimer();
      if (state === STATE.IDLE) this.stopTimer();
    },

    pulseOrb() {
      if (Session.state === STATE.SPEAKING) {
        this.speechEnergy = Math.min(1, this.speechEnergy + 0.34);
        return;
      }
      const t = Date.now();
      if (t - this.lastPulse < 90) return;
      this.lastPulse = t;
      const bars = this.els.wave.children;
      for (let i = 0; i < bars.length; i++) {
        const h = 4 + Math.abs(Math.sin(i * 1.7 + t / 90)) * 22;
        bars[i].style.height = h.toFixed(1) + 'px';
      }
    },

    waveFrame() {
      const bars = this.els.wave.children;
      const state = Session.state;
      const level = AudioIO.level;
      if (state === STATE.LISTENING) {
        this.els.orbStage.style.setProperty('--level', clamp(level * 5.4, 0, 1).toFixed(3));
        for (let i = 0; i < bars.length; i++) {
          const wobble = 0.55 + 0.45 * Math.sin(i * 0.8 + performance.now() / 260);
          const h = 3 + clamp(level * 9, 0, 1) * 26 * wobble;
          bars[i].style.height = h.toFixed(1) + 'px';
        }
      } else if (state === STATE.SPEAKING) {
        const now = performance.now();
        this.speechEnergy = Math.max(0.16, this.speechEnergy * 0.972);
        const e = this.speechEnergy;
        for (let i = 0; i < bars.length; i++) {
          const shape = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.82 + now / 190));
          bars[i].style.height = (3 + e * 30 * shape).toFixed(1) + 'px';
        }
        this.els.orbStage.style.setProperty('--level', (0.18 + e * 0.5).toFixed(3));
      } else if (state === STATE.PROCESSING) {
        const now = performance.now();
        for (let i = 0; i < bars.length; i++) {
          bars[i].style.height = (3 + 5 * Math.abs(Math.sin(i * 0.5 + now / 320))).toFixed(1) + 'px';
        }
        this.els.orbStage.style.setProperty('--level', '0.14');
      } else if (state === STATE.CONNECTING) {
        for (let i = 0; i < bars.length; i++) {
          bars[i].style.height = (3 + 4 * Math.abs(Math.sin(i * 0.6 + performance.now() / 240))).toFixed(1) + 'px';
        }
      } else {
        for (let i = 0; i < bars.length; i++) bars[i].style.height = '3px';
        this.els.orbStage.style.setProperty('--level', '0');
      }
      requestAnimationFrame(() => this.waveFrame());
    },

    addMessage(role, text, opts) {
      opts = opts || {};
      if (this.els.transcriptEmpty && this.els.transcriptEmpty.parentNode) this.els.transcriptEmpty.remove();
      const wrap = document.createElement('div');
      wrap.className = 'msg msg--' + role;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = opts.label || (role === 'user' ? 'You' : role === 'agent' ? (settings.agentName || 'Remy') : 'System');
      const stamp = document.createElement('span');
      stamp.style.marginLeft = 'auto';
      stamp.textContent = fmtTime(Date.now());
      meta.append(sw, who, stamp);
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = text;
      wrap.append(meta, body);
      this.els.transcriptBody.appendChild(wrap);
      this.updateCount();
      this.scrollTranscript();

      const self = this;
      return {
        el: wrap,
        bodyEl: body,
        setText(t) {
          body.textContent = t;
          self.scrollTranscript();
        },
        setStreaming(on) {
          body.innerHTML = '';
          body.textContent = wrap._text = wrap._text || '';
          if (on) {
            body.appendChild(document.createTextNode(body.textContent));
            const c = document.createElement('span');
            c.className = 'cursor';
            body.appendChild(c);
          }
        }
      };
    },

    updateCount() {
      const n = Session.messages.filter((m) => m.role !== 'system').length;
      this.els.msgCount.textContent = n + (n === 1 ? ' turn' : ' turns');
    },

    clearTranscript(keepEmpty) {
      this.els.transcriptBody.querySelectorAll('.msg').forEach((n) => n.remove());
      if (keepEmpty !== false) {
        const empty = document.createElement('div');
        empty.className = 'transcript-empty';
        empty.id = 'transcriptEmpty';
        empty.innerHTML = '<span class="k">Nothing yet</span>Press start and speak. Your words and the agent\'s reply appear here as they happen.';
        this.els.transcriptBody.appendChild(empty);
        this.els.transcriptEmpty = empty;
      }
      this.updateCount();
    },

    scrollTranscript() {
      const el = this.els.transcriptBody;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    },

    renderTranscript(messages) {
      this.clearTranscript(false);
      if (!messages.length) {
        this.clearTranscript(true);
        return;
      }
      messages.forEach((m) => {
        if (m.role === 'system') return;
        this.addMessage(m.role === 'assistant' ? 'agent' : m.role, m.content);
      });
      setTimeout(() => { this.els.transcriptBody.scrollTop = this.els.transcriptBody.scrollHeight; }, 30);
    },

    setTranscriptVisible(on) {
      settings.showTranscript = !!on;
      this.els.side.hidden = !on;
      this.els.transcriptBtn.setAttribute('aria-pressed', String(!!on));
    },

    setMuted(muted) {
      Session.muted = muted;
      this.els.muteBtn.setAttribute('aria-pressed', String(!!muted));
      this.els.muteBtn.querySelector('.lbl').textContent = muted ? 'Unmuted' : 'Mute mic';
      this.els.muteBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
      this.els.micNote.textContent = muted ? 'Mic muted — recording paused.' : 'Mic opens only during a session.';
    },

    setSpeakerMuted(muted) {
      Session.speakerMuted = muted;
      this.els.speakerBtn.setAttribute('aria-pressed', String(!!muted));
      this.els.speakerBtn.querySelector('.lbl').textContent = muted ? 'Muted' : 'Speaker';
      this.els.speakerBtn.setAttribute('aria-label', muted ? 'Unmute agent voice' : 'Mute agent voice');
    },

    showAlert(title, message) {
      this.els.alert.dataset.open = 'true';
      this.els.alertTitle.textContent = title;
      this.els.alertMsg.textContent = message;
    },

    clearAlert() {
      this.els.alert.dataset.open = 'false';
    },

    startTimer() {
      if (this.timer) return;
      if (!Session.startedAt) Session.startedAt = Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - Session.startedAt) / 1000);
        this.els.footSession.textContent = 'session ' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      };
      tick();
      this.timer = setInterval(tick, 1000);
    },

    stopTimer() {
      clearInterval(this.timer);
      this.timer = null;
      this.els.footSession.textContent = 'session 00:00';
    },

    fillVoices() {
      const sel = $('fOutput');
      if (!sel) return;
      const current = settings.outputVoice;
      sel.innerHTML = '<option value="">System default</option>';
      TTS.voices.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = v.name + ' — ' + v.lang + (v.default ? ' (default)' : '');
        if (v.name === current) opt.selected = true;
        sel.appendChild(opt);
      });
    },

    async fillDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const sel = $('fInput');
        if (!sel) return;
        const current = settings.inputDeviceId;
        sel.innerHTML = '<option value="">System default</option>';
        devices.filter((d) => d.kind === 'audioinput').forEach((d, i) => {
          const opt = document.createElement('option');
          opt.value = d.deviceId;
          opt.textContent = d.label || 'Microphone ' + (i + 1);
          if (d.deviceId === current) opt.selected = true;
          sel.appendChild(opt);
        });
      } catch (e) {}
    },

    renumberCards() {
      let n = 0;
      document.querySelectorAll('#view-settings .card').forEach((card) => {
        if (!IS_OWNER && card.hasAttribute('data-owner-only')) return;
        n += 1;
        const num = card.querySelector('h2 .num');
        if (num) num.textContent = String(n).padStart(2, '0');
      });
    },

    syncSettingsForm() {
      $('fProxy').value = settings.proxyUrl || '';
      $('fProxy').placeholder = CONFIG_PROXY || 'https://api.yourdomain.com';
      const fromConfig = $('proxySource');
      if (fromConfig) fromConfig.textContent = CONFIG_PROXY ? 'config.js → ' + CONFIG_PROXY.replace(/^https?:\/\//, '') : 'not configured';
      $('fToken').value = appToken || '';
      $('fModel').value = settings.model || '';
      $('fName').value = settings.agentName || '';
      $('fPrompt').value = settings.systemPrompt || DEFAULT_PROMPT;
      $('fStyle').value = settings.style;
      $('fLang').value = settings.language;
      $('fRate').value = settings.ttsRate;
      $('fPitch').value = settings.ttsPitch;
      $('rateVal').textContent = Number(settings.ttsRate).toFixed(2).replace(/0$/, '') + '×';
      $('pitchVal').textContent = Number(settings.ttsPitch).toFixed(2).replace(/0$/, '');
      $('fShowTranscript').checked = !!settings.showTranscript;
      $('fStoreHistory').checked = !!settings.storeHistory;
      $('fAutoSpeak').checked = !!settings.autoSpeak;
      $('fBargeIn').checked = !!settings.bargeIn;
      this.els.transcriptBtn.setAttribute('aria-pressed', String(!!settings.showTranscript));
      $('fOutput').value = settings.outputVoice || '';
    },

    toast: null
  };

  function toast(message, kind) {
    const host = $('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'err' ? ' toast--err' : kind === 'ok' ? ' toast--ok' : '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 280);
    }, 4200);
  }

  /* ---------- history ---------- */
  const History = {
    items: readJSON(LS_HISTORY, []),

    all() { return Array.isArray(this.items) ? this.items : []; },

    upsert(session) {
      if (!settings.storeHistory) return;
      const msgs = session.messages.filter((m) => m.role !== 'system');
      if (!msgs.length) return;
      const firstUser = msgs.find((m) => m.role === 'user');
      const title = clampText((firstUser ? firstUser.content : 'Conversation').replace(/\s+/g, ' ').trim(), 64) || 'Conversation';
      const idx = this.items.findIndex((c) => c.id === session.id);
      const record = {
        id: session.id,
        title: session.title || title,
        createdAt: session.createdAt || now(),
        updatedAt: now(),
        messages: msgs.map((m) => ({ role: m.role, content: m.content, ts: m.ts })),
        model: settings.model
      };
      if (idx >= 0) this.items[idx] = record;
      else this.items.unshift(record);
      this.items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      this.items = this.items.slice(0, MAX_HISTORY);
      writeJSON(LS_HISTORY, this.items);
      this.render();
    },

    remove(id) {
      this.items = this.items.filter((c) => c.id !== id);
      writeJSON(LS_HISTORY, this.items);
      this.render();
    },

    clearAll() {
      this.items = [];
      writeJSON(LS_HISTORY, this.items);
      this.render();
    },

    render() {
      const list = $('histList');
      const count = $('histCount');
      if (!list) return;
      const items = this.all();
      if (count) count.textContent = items.length + (items.length === 1 ? ' conversation' : ' conversations');
      const stateBadge = $('histStoreState');
      if (stateBadge) stateBadge.textContent = settings.storeHistory ? 'storage: local' : 'storage: off';
      list.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = settings.storeHistory
          ? 'No conversations saved yet. Start talking and the transcript lands here.'
          : 'History saving is off. Turn it on in Settings to keep transcripts.';
        list.appendChild(empty);
        return;
      }
      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'hist';
        const info = document.createElement('div');
        info.className = 't';
        const b = document.createElement('b');
        b.textContent = item.title;
        const prev = item.messages.filter((m) => m.role !== 'system').slice(-1)[0];
        const span = document.createElement('span');
        span.textContent = prev ? clampText(prev.content.replace(/\s+/g, ' '), 130) : '';
        const em = document.createElement('em');
        em.textContent = (item.messages.length || 0) + ' messages · ' + fmtDate(item.updatedAt || item.createdAt);
        info.append(b, span, em);

        const acts = document.createElement('div');
        acts.className = 'acts';
        const openBtn = document.createElement('button');
        openBtn.className = 'btn btn--sm';
        openBtn.type = 'button';
        openBtn.textContent = 'Open';
        openBtn.addEventListener('click', () => Session.load(item));
        const renBtn = document.createElement('button');
        renBtn.className = 'btn btn--sm btn--ghost';
        renBtn.type = 'button';
        renBtn.textContent = 'Rename';
        renBtn.addEventListener('click', () => {
          const next = window.prompt('Rename conversation', item.title);
          if (next && next.trim()) {
            item.title = next.trim().slice(0, 64);
            writeJSON(LS_HISTORY, this.items);
            this.render();
          }
        });
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn--sm btn--ghost';
        delBtn.type = 'button';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => {
          if (window.confirm('Delete this conversation? This cannot be undone.')) this.remove(item.id);
        });
        acts.append(openBtn, renBtn, delBtn);
        row.append(info, acts);
        list.appendChild(row);
      });
    }
  };

  /* ---------- session / state machine ---------- */
  const Session = {
    state: STATE.IDLE,
    messages: [],
    id: uid(),
    title: '',
    createdAt: null,
    startedAt: null,
    abort: null,
    muted: false,
    speakerMuted: false,
    busy: false,
    vadFrames: 0,
    retries: 0,
    lastUserText: '',
    ignoreBarge: 0,
    mode: 'voice',

    configProblem() {
      if (!isConfigured()) {
        return IS_OWNER
          ? 'No proxy configured yet. Add your Worker URL in config.js or Settings.'
          : 'The assistant is offline at the moment. Please try again shortly.';
      }
      if (!settings.model) {
        return IS_OWNER ? 'No model selected. Add a model ID in Settings.' : 'The assistant is offline at the moment.';
      }
      return '';
    },

    async toggle() {
      // In a typed session the mic button means "switch to voice".
      if (this.mode === 'text' && (this.state === STATE.LISTENING || this.state === STATE.INTERRUPTED)) {
        return this.start();
      }
      if (this.state === STATE.IDLE || this.state === STATE.ERROR) return this.start();
      return this.stop('manual');
    },

    /* Start a typed-text session: no microphone, no permission prompt. */
    startText() {
      const problem = this.configProblem();
      if (problem) {
        UI.setState(STATE.ERROR, problem);
        UI.showAlert(IS_OWNER ? 'Setup required' : 'Assistant offline', problem);
        if (IS_OWNER) toast('Add your proxy URL in Settings to start.', 'err');
        return false;
      }
      if (!this.createdAt) {
        this.createdAt = now();
        this.id = uid();
      }
      this.mode = 'text';
      this.retries = 0;
      this.busy = false;
      UI.clearAlert();
      UI.setState(STATE.LISTENING, 'Text mode — type below, or press the mic to speak.');
      UI.startTimer();
      UI.els.setup.dataset.open = 'false';
      if (!this.messages.some((m) => m.role !== 'system')) {
        UI.addMessage('system', 'Text session open. Type a message — replies are still spoken aloud.');
      }
      return true;
    },

    /* Send a typed message through the same pipeline as a spoken turn. */
    submitText(text) {
      const clean = String(text || '').trim();
      if (!clean) return;
      if (this.state === STATE.PROCESSING || this.state === STATE.SPEAKING) this.interrupt('text');
      if (this.state === STATE.IDLE || this.state === STATE.ERROR) {
        if (!this.startText()) return;
      }
      let tries = 0;
      const go = () => {
        if (this.state === STATE.LISTENING) return this.sendTurn(clean);
        if (this.state === STATE.PROCESSING || this.state === STATE.SPEAKING) return; // already talking
        if (tries++ < 25) setTimeout(go, 80);
      };
      go();
    },

    async start() {
      const problem = this.configProblem();
      if (problem) {
        UI.setState(STATE.ERROR, problem);
        UI.showAlert(IS_OWNER ? 'Setup required' : 'Assistant offline', problem);
        if (IS_OWNER) UI.els.setup.dataset.open = 'true';
        if (IS_OWNER) {
          toast('Add your proxy URL in Settings to start.', 'err');
          location.hash = '#/settings';
        }
        return;
      }
      if (!STT.supported()) {
        toast('Speech recognition is not available here — text chat is ready instead.', 'err');
        return this.startText();
      }
      this.mode = 'voice';
      if (!this.createdAt) {
        this.createdAt = now();
        this.id = uid();
      }
      this.retries = 0;
      this.busy = false;
      UI.setState(STATE.CONNECTING, 'Requesting microphone access…');
      UI.clearAlert();

      try {
        await AudioIO.start();
      } catch (e) {
        this.fail(e, 'permission');
        return;
      }

      AudioIO.onLevel = (level) => this.vad(level);
      this.attachVad();
      UI.setState(STATE.LISTENING, 'Speak — I will answer out loud.');
      UI.startTimer();
      STT.start();
      UI.els.setup.dataset.open = 'false';
      if (!this.messages.length) {
        UI.addMessage('system', 'Session open. Say something like “What can you do?” to begin.');
      }
    },

    attachVad() {
      if (this._vadAttached) return;
      this._vadAttached = true;
      AudioIO.onLevel = (level) => this.vad(level);
    },

    vad(level) {
      if (this.mode !== 'voice' || this.state !== STATE.SPEAKING || !settings.bargeIn || this.muted) { this.vadFrames = 0; return; }
      if (Date.now() < this.ignoreBarge) return;
      if (level > VAD_THRESHOLD) {
        this.vadFrames++;
        if (this.vadFrames >= VAD_FRAMES) {
          this.vadFrames = 0;
          this.interrupt('barge');
        }
      } else {
        this.vadFrames = Math.max(0, this.vadFrames - 1);
      }
    },

    async sendTurn(text) {
      const clean = String(text || '').trim();
      if (!clean || this.busy) return;
      if (this.state !== STATE.LISTENING) return;
      this.busy = true;
      STT.stop();
      STT.hideLive();
      this.lastUserText = clean;
      this.messages.push({ role: 'user', content: clean, ts: now() });
      UI.addMessage('user', clean);
      UI.updateCount();
      History.upsert(this);

      const agent = UI.addMessage('agent', '', {});
      const bodyShell = agent.el.querySelector('.body');
      bodyShell.textContent = '…';

      UI.setState(STATE.PROCESSING, 'Sending your turn to the model…');
      this.abort = new AbortController();
      let acc = '';
      let firstToken = true;

      const call = async () => {
        const context = this.messages
          .filter((m) => m.role !== 'system')
          .slice(-MAX_TURNS_CONTEXT)
          .map((m) => ({ role: m.role === 'agent' ? 'assistant' : m.role, content: m.content }));
        return Provider.chat({
          messages: [{ role: 'system', content: composeSystemPrompt() }].concat(context),
          signal: this.abort.signal,
          onDelta: (piece, full) => {
            acc = full;
            if (firstToken) {
              firstToken = false;
              bodyShell.textContent = '';
              UI.setState(STATE.PROCESSING, settings.autoSpeak ? 'Drafting the spoken reply…' : 'Streaming the reply…');
            }
            bodyShell.textContent = acc;
            UI.scrollTranscript();
          }
        });
      };

      try {
        acc = await call();
      } catch (e) {
        if (e.name === 'AbortError') { this.busy = false; return; }
        if (this.retries < 2 && (e.code === 'network' || e.code === 'upstream' || e.code === 'timeout' || e.code === 'rate')) {
          this.retries++;
          UI.setState(STATE.RECONNECTING, 'Retry ' + this.retries + ' of 2 — ' + (ERROR_COPY[e.code] ? ERROR_COPY[e.code][0] : 'temporary failure'));
          try {
            await sleep(600 * this.retries);
            acc = await call();
          } catch (e2) {
            this.busy = false;
            agent.el.remove();
            this.fail(e2, 'turn');
            return;
          }
        } else {
          this.busy = false;
          agent.el.remove();
          this.fail(e, 'turn');
          return;
        }
      }

      const reply = String(acc || '').trim();
      bodyShell.textContent = reply;

      if (!reply) {
        agent.el.remove();
        this.busy = false;
        UI.setState(STATE.ERROR, 'The model returned an empty reply.');
        UI.showAlert('Empty response', 'The model sent nothing back. Retry, or pick another model ID.');
        return;
      }

      this.messages.push({ role: 'agent', content: reply, ts: now() });
      UI.updateCount();
      this.retries = 0;

      if (settings.autoSpeak && !this.speakerMuted) {
        UI.setState(STATE.SPEAKING, 'Press stop or just start talking to interrupt.');
        this.ignoreBarge = Date.now() + 700;
        if (this.muted) {
          // Mic muted: nothing to barge in with, still play audio.
        }
        try {
          await TTS.speak(reply, {
            onStart: () => { this.ignoreBarge = Date.now() + 700; },
            onBoundary: () => UI.pulseOrb(),
            onEnd: () => {}
          });
        } catch (e) {
          toast(ERROR_COPY.tts[1], 'err');
          UI.setState(STATE.LISTENING, 'Voice output unavailable — reply is in the transcript.');
          this.busy = false;
          this.resumeListening();
          History.upsert(this);
          return;
        }
      }

      this.busy = false;
      History.upsert(this);
      if (this.state === STATE.SPEAKING || this.state === STATE.PROCESSING) {
        UI.setState(STATE.LISTENING, 'Speak — I will answer out loud.');
        this.resumeListening();
      }
    },

    resumeListening() {
      if (!this.micWanted()) return;
      if (!STT.supported()) return;
      STT.start();
    },

    micWanted() {
      return this.mode === 'voice' && this.state === STATE.LISTENING && !this.muted;
    },

    interrupt(source) {
      const wasSpeaking = this.state === STATE.SPEAKING || this.state === STATE.PROCESSING;
      if (!wasSpeaking) return;
      TTS.cancel();
      if (this.abort) {
        try { this.abort.abort(); } catch (e) {}
      }
      this.abort = null;
      this.busy = false;
      UI.setState(STATE.INTERRUPTED, source === 'barge' ? 'You cut in — listening.' : 'Stopped. Listening.');
      this.messages.push({ role: 'system', content: 'Reply interrupted by the user.', ts: now() });
      UI.addMessage('system', 'Reply interrupted.');
      if (!settings.autoSpeak) { /* nothing playing */ }
      setTimeout(() => {
        if (this.state !== STATE.INTERRUPTED) return;
        UI.setState(STATE.LISTENING, 'Go ahead.');
        this.ignoreBarge = Date.now() + 400;
        this.resumeListening();
      }, 520);
    },

    async stop(reason) {
      STT.abort();
      TTS.cancel();
      if (this.abort) { try { this.abort.abort(); } catch (e) {} }
      this.abort = null;
      if (AudioIO.ctx || AudioIO.stream) AudioIO.stop();
      AudioIO.onLevel = null;
      this.busy = false;
      this.retries = 0;

      const hadMessages = this.messages.some((m) => m.role !== 'system');
      if (hadMessages) History.upsert(this);
      UI.setState(STATE.IDLE, reason === 'ended' ? 'Conversation ended.' : 'Microphone released.');
      UI.stopTimer();
      this.startedAt = null;
      this.messages.push({ role: 'system', content: 'Session ended.', ts: now() });
      if (reason !== 'silent') UI.addMessage('system', 'Session ended. Audio devices released.');
      UI.updateCount();
    },

    fail(err, phase) {
      const info = describeError(err);
      STT.stop();
      TTS.cancel();
      if (AudioIO.stream) AudioIO.stop();
      this.busy = false;
      UI.setState(STATE.ERROR, info.message);
      UI.showAlert(info.title, info.message + (info.detail ? ' (' + info.detail + ')' : ''));
      this.errorPhase = phase || 'start';
      if (phase === 'permission' || phase === 'stt') {
        this.messages.push({ role: 'system', content: info.title + ': ' + info.message, ts: now() });
        UI.addMessage('system', info.title + ' — ' + info.message);
      }
    },

    retry() {
      if (this.errorPhase === 'turn' && this.lastUserText) {
        const idx = (() => {
          for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].role === 'user') return i;
          }
          return -1;
        })();
        if (idx >= 0) this.messages.splice(idx, 1);
        UI.clearAlert();
        UI.setState(STATE.LISTENING, 'Retrying…');
        setTimeout(() => this.sendTurn(this.lastUserText), 120);
      } else {
        UI.clearAlert();
        this.start();
      }
    },

    newConversation() {
      const wasActive = this.state !== STATE.IDLE && this.state !== STATE.ERROR;
      const wasText = this.mode === 'text';
      if (this.messages.some((m) => m.role !== 'system')) History.upsert(this);
      TTS.cancel();
      STT.abort();
      if (this.abort) { try { this.abort.abort(); } catch (e) {} }
      this.abort = null;
      this.messages = [];
      this.busy = false;
      this.id = uid();
      this.title = '';
      this.createdAt = null;
      this.startedAt = null;
      UI.clearTranscript(true);
      UI.clearAlert();
      UI.updateCount();
      UI.stopTimer();
      UI.setState(STATE.IDLE, 'New conversation ready.');
      if (wasActive) {
        if (wasText) this.startText(); else this.start();
      }
    },

    load(record) {
      const active = this.state !== STATE.IDLE;
      TTS.cancel();
      STT.abort();
      if (AudioIO.stream) AudioIO.stop();
      this.messages = (record.messages || []).map((m) => ({ role: m.role, content: m.content, ts: m.ts }));
      this.id = record.id;
      this.title = record.title;
      this.createdAt = record.createdAt;
      this.startedAt = null;
      this.busy = false;
      this.state = STATE.IDLE;
      UI.renderTranscript(this.messages);
      UI.setState(STATE.IDLE, 'Loaded “' + clampText(record.title, 40) + '”. Press start to continue.');
      UI.stopTimer();
      location.hash = '#/app';
      toast('Conversation loaded — press start to continue it.', 'ok');
      void active;
    }
  };

  /* ---------- per-view SEO ---------- */
  const SITE_URL = 'https://chat.remyagent.cc/';
  const SEO = {
    app: {
      title: 'Remy Agent – Free Real-Time AI Voice Chat Assistant',
      description: 'Talk naturally with AI using Remy Agent. Experience real-time voice conversations, multilingual support, and multiple AI models in one voice chat assistant.',
      robots: 'index,follow,max-image-preview:large,max-snippet:-1'
    },
    history: {
      title: 'Conversation history – Remy Agent',
      description: 'Reopen, rename or delete the Remy Agent conversations saved in your own browser.',
      robots: 'noindex,follow'
    },
    settings: {
      title: 'Settings – Remy Agent',
      description: 'Set the agent name and system prompt, pick a voice and microphone, and control what Remy Agent stores.',
      robots: 'noindex,follow'
    },
    about: {
      title: 'About Remy Agent – Built by DotcomAI',
      description: 'Discover Remy Agent, a real-time AI voice chat platform by DotcomAI, built to make natural AI conversations accessible through multiple models.',
      robots: 'index,follow,max-image-preview:large'
    }
  };

  function setMeta(selector, value) {
    const el = document.head.querySelector(selector);
    if (el) el.setAttribute('content', value);
  }

  function applySeo(view) {
    const meta = SEO[view] || SEO.app;
    document.title = meta.title;
    setMeta('meta[name="description"]', meta.description);
    setMeta('meta[name="robots"]', meta.robots);
    setMeta('meta[property="og:title"]', meta.title);
    setMeta('meta[property="og:description"]', meta.description);
    setMeta('meta[name="twitter:title"]', meta.title);
    setMeta('meta[name="twitter:description"]', meta.description);
    const canonical = document.head.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute('href', SITE_URL);
  }

  /* ---------- views / router ---------- */
  const Router = {
    views: ['app', 'history', 'settings', 'about'],
    go(name) {
      if (this.views.indexOf(name) === -1) name = 'app';
      this.views.forEach((v) => {
        const el = $('view-' + v);
        if (!el) return;
        el.classList.toggle('is-active', v === name);
        el.hidden = v !== name;
      });
      document.querySelectorAll('[data-nav]').forEach((a) => {
        if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      });
      applySeo(name);
      if (name === 'settings') { UI.syncSettingsForm(); UI.fillDevices(); syncRuntimePanel(); }
      if (name === 'history') History.render();
      window.scrollTo(0, 0);
    },
    parse() {
      const hash = (location.hash || '#/app').replace(/^#\/?/, '');
      const name = hash.split('?')[0] || 'app';
      this.go(name);
    },
    init() {
      window.addEventListener('hashchange', () => this.parse());
      this.parse();
    }
  };

  /* ---------- runtime panel ---------- */
  function syncRuntimePanel() {
    const base = apiBase();
    const hostEl = $('rtHost');
    if (!hostEl) return;
    $('rtHost').textContent = location.hostname || 'local file';
    $('rtProxy').textContent = base || 'not configured';
    const asr = STT.supported() ? 'Browser Web Speech API (' + settings.language + ')' : 'Unsupported in this browser';
    $('rtAsr').textContent = asr;
    $('rtTts').textContent = 'speechSynthesis' in window ? 'Browser speech synthesis' : 'Unsupported';
    $('rtModel').textContent = settings.model || '—';
    $('rtStorage').textContent = settings.storeHistory ? 'localStorage · ' + History.all().length + ' saved' : 'off (ephemeral)';

    const stripRoute = $('stripRoute');
    if (stripRoute) stripRoute.textContent = base ? 'route: ' + base.replace(/^https?:\/\//, '') : 'route: not configured';
    const footModel = $('footModel');
    if (footModel) footModel.textContent = 'model ' + (settings.model ? settings.model.split('/').slice(-1)[0] : '—');
    const footAsr = $('footAsr');
    if (footAsr) footAsr.textContent = 'asr ' + (STT.supported() ? 'browser' : 'unsupported');
    const footTts = $('footTts');
    if (footTts) footTts.textContent = 'tts ' + ('speechSynthesis' in window ? 'browser' : 'unsupported');

    const setup = $('setupBanner');
    if (setup && IS_OWNER) setup.dataset.open = String(!base);
  }


  /* ---------- settings wiring ---------- */
  function bindSettings() {
    const langSel = $('fLang');
    LANGUAGES.forEach(([code, label]) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = label;
      langSel.appendChild(opt);
    });

    const commit = (fn) => {
      fn();
      saveSettings();
      syncRuntimePanel();
      if (STT.rec && Session.state === STATE.LISTENING) {
        STT.stop();
        setTimeout(() => { if (Session.state === STATE.LISTENING) STT.start(); }, 120);
      }
    };

    $('fProxy').addEventListener('change', (e) => commit(() => { settings.proxyUrl = e.target.value.trim(); }));
    $('fToken').addEventListener('change', (e) => {
      appToken = e.target.value.trim();
      try { appToken ? sessionStorage.setItem(SS_TOKEN, appToken) : sessionStorage.removeItem(SS_TOKEN); } catch (err) {}
      toast(appToken ? 'App token saved for this tab only.' : 'App token cleared.', 'ok');
    });
    $('fModel').addEventListener('change', (e) => commit(() => { settings.model = e.target.value.trim(); }));
    $('fName').addEventListener('change', (e) => commit(() => { settings.agentName = e.target.value.trim() || 'Remy'; UI.fillVoices(); }));
    $('fPrompt').addEventListener('change', (e) => commit(() => { settings.systemPrompt = e.target.value; }));
    $('fStyle').addEventListener('change', (e) => commit(() => { settings.style = e.target.value; }));
    $('fLang').addEventListener('change', (e) => commit(() => { settings.language = e.target.value; }));
    $('fInput').addEventListener('change', (e) => commit(() => { settings.inputDeviceId = e.target.value; }));
    $('fOutput').addEventListener('change', (e) => commit(() => { settings.outputVoice = e.target.value; }));
    $('fRate').addEventListener('input', (e) => {
      settings.ttsRate = Number(e.target.value);
      $('rateVal').textContent = settings.ttsRate.toFixed(2).replace(/0$/, '') + '×';
      saveSettings();
    });
    $('fPitch').addEventListener('input', (e) => {
      settings.ttsPitch = Number(e.target.value);
      $('pitchVal').textContent = settings.ttsPitch.toFixed(2).replace(/0$/, '');
      saveSettings();
    });
    $('fShowTranscript').addEventListener('change', (e) => {
      settings.showTranscript = e.target.checked;
      saveSettings();
      UI.setTranscriptVisible(e.target.checked);
    });
    $('fStoreHistory').addEventListener('change', (e) => {
      settings.storeHistory = e.target.checked;
      saveSettings();
      History.render();
    });
    $('fAutoSpeak').addEventListener('change', (e) => commit(() => { settings.autoSpeak = e.target.checked; }));
    $('fBargeIn').addEventListener('change', (e) => commit(() => { settings.bargeIn = e.target.checked; }));

    $('resetPromptBtn').addEventListener('click', () => {
      settings.systemPrompt = DEFAULT_PROMPT;
      $('fPrompt').value = DEFAULT_PROMPT;
      saveSettings();
      toast('System prompt reset to the default.', 'ok');
    });

    $('voiceTestBtn').addEventListener('click', async () => {
      if (!('speechSynthesis' in window)) {
        toast(ERROR_COPY.tts[1], 'err');
        return;
      }
      TTS.cancel();
      await TTS.speak('Hi, I am ' + (settings.agentName || 'Remy') + '. This is how I will sound in a conversation.');
    });

    $('testConnBtn').addEventListener('click', async () => {
      const badge = $('connBadge');
      badge.className = 'badge badge--warn';
      badge.textContent = 'testing…';
      if (!isConfigured()) {
        badge.className = 'badge badge--err';
        badge.textContent = 'no proxy';
        toast('Add your proxy URL first.', 'err');
        return;
      }
      try {
        const list = await Provider.models();
        badge.className = 'badge badge--ok';
        badge.textContent = 'ok · ' + list.length + ' models';
        fillModelList(list);
        toast('Proxy reachable — ' + list.length + ' models available.', 'ok');
      } catch (e) {
        const info = describeError(e);
        badge.className = 'badge badge--err';
        badge.textContent = (e.status ? e.status + ' ' : '') + (e.code || 'error');
        toast(info.title + ': ' + info.message, 'err');
      }
    });

    $('fetchModelsBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const list = await Provider.models();
        fillModelList(list);
        toast(list.length + ' models loaded. Pick one from the field.', 'ok');
      } catch (err) {
        toast(describeError(err).title + ': ' + describeError(err).message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch list';
      }
    });

    $('micTestBtn').addEventListener('click', async () => {
      const badge = $('micTestBadge');
      if (Session.state !== STATE.IDLE) {
        toast('End the live conversation before testing the mic.', 'err');
        return;
      }
      badge.className = 'badge badge--warn';
      badge.textContent = 'listening…';
      try {
        await AudioIO.start();
        UI.fillDevices();
        const meter = $('micMeter');
        AudioIO.onLevel = (level) => { meter.style.width = clamp(level * 320, 0, 100).toFixed(1) + '%'; };
        setTimeout(() => {
          AudioIO.stop();
          AudioIO.onLevel = null;
          meter.style.width = '0%';
          badge.className = 'badge badge--ok';
          badge.textContent = 'captured';
        }, 5000);
      } catch (err) {
        badge.className = 'badge badge--err';
        badge.textContent = 'blocked';
        toast(describeError(err).title + ': ' + describeError(err).message, 'err');
      }
    });

    $('wipeBtn').addEventListener('click', () => {
      if (!window.confirm('Clear saved conversations and reset settings on this device?')) return;
      try {
        localStorage.removeItem(LS_HISTORY);
        localStorage.removeItem(LS_SETTINGS);
      } catch (e) {}
      History.items = [];
      settings = Object.assign({}, DEFAULTS);
      UI.syncSettingsForm();
      History.render();
      syncRuntimePanel();
      toast('Local data cleared.', 'ok');
    });

    $('histClearBtn').addEventListener('click', () => {
      if (!History.all().length) return;
      if (!window.confirm('Delete every saved conversation on this device?')) return;
      History.clearAll();
      toast('History cleared.', 'ok');
    });

  }

  function fillModelList(list) {
    const dl = $('modelList');
    if (!dl) return;
    dl.innerHTML = '';
    list
      .filter((id) => /instruct|chat|nemotron|gpt|mistral|gemma|qwen|llama|deepseek|glm|kimi|phi|granite/i.test(id))
      .slice(0, 120)
      .forEach((id) => {
        const o = document.createElement('option');
        o.value = id;
        dl.appendChild(o);
      });
  }

  /* ---------- main wiring ---------- */
  function bindControls() {
    $('micBtn').addEventListener('click', () => Session.toggle());
    $('launchBtn').addEventListener('click', () => {
      Router.go('app');
      Session.toggle();
    });
    $('endBtn').addEventListener('click', () => Session.stop('ended'));
    $('newBtn').addEventListener('click', () => Session.newConversation());
    $('interruptBtn').addEventListener('click', () => Session.interrupt('button'));
    $('retryBtn').addEventListener('click', () => Session.retry());

    $('muteBtn').addEventListener('click', () => {
      const next = !Session.muted;
      UI.setMuted(next);
      if (next) {
        STT.stop();
      } else if (Session.state === STATE.LISTENING) {
        STT.start();
      }
    });

    $('speakerBtn').addEventListener('click', () => {
      const next = !Session.speakerMuted;
      UI.setSpeakerMuted(next);
      if (next) TTS.cancel();
    });

    $('transcriptBtn').addEventListener('click', () => {
      const next = !settings.showTranscript;
      saveSettings();
      UI.setTranscriptVisible(next);
      UI.syncSettingsForm();
    });

    const composer = $('composer');
    const chatInput = $('chatInput');
    const sendBtn = $('sendBtn');
    if (composer && chatInput) {
      chatInput.addEventListener('input', () => {
        if (sendBtn) sendBtn.disabled = !chatInput.value.trim();
      });
      composer.addEventListener('submit', (e) => {
        e.preventDefault();
        const value = chatInput.value.trim();
        if (!value) return;
        chatInput.value = '';
        if (sendBtn) sendBtn.disabled = true;
        Session.submitText(value);
      });
      if (sendBtn) sendBtn.disabled = true;
    }

    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => { location.hash = '#/' + btn.dataset.goto; });
    });

    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
      if (typing) return;
      if (e.code === 'Space' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        Session.toggle();
      } else if (e.key === 'Escape') {
        if (Session.state !== STATE.IDLE) Session.stop('ended');
      } else if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey) {
        $('muteBtn').click();
      }
    });
  }

  /* ---------- boot ---------- */
  function boot() {
    $('year').textContent = String(new Date().getFullYear());
    UI.init();
    if (IS_OWNER) document.body.classList.add('is-owner');
    UI.renumberCards();
    bindSettings();
    bindControls();
    TTS.load();
    UI.syncSettingsForm();
    History.render();
    Router.init();
    syncRuntimePanel();
    UI.updateCount();
    UI.setState(STATE.IDLE, 'Microphone is off.');
    if (!isConfigured() && IS_OWNER) $('setupBanner').dataset.open = 'true';

    if (!STT.supported()) {
      const note = $('rtNote');
      if (note) note.textContent = 'This browser does not expose the Web Speech API, so speech input will not work. Chrome and Edge support it.';
    }

    // Keep the transcript height honest on resize.
    window.addEventListener('resize', () => {
      if (!settings.showTranscript) UI.els.side.hidden = true;
    });

    window.addEventListener('beforeunload', () => {
      if (Session.messages.some((m) => m.role !== 'system')) History.upsert(Session);
    });

    if (location.protocol === 'file:') {
      toast('Opened from disk — start the local server (npm start) for the proxy to work.', 'err');
    }

    Sound.boot();
  }

  /* ---------- tiny boot chime (opt-in-free, silent) ---------- */
  const Sound = { boot() {} };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__remy = { Session, UI, Provider, AudioIO, STT, TTS, History, settings: () => settings };
})();
