import { RobotBLE } from './ble.js';
import { createVoiceMode } from './voice.js';
import { createGestureMode, preloadGestures } from './gestures.js';
import { createFaceMode, preloadFace } from './face.js';

const $ = (id) => document.getElementById(id);
const robot = new RobotBLE();

/* ---------------- Estado de conexión ---------------- */
const statusEl = $('status');
const statusText = $('statusText');
const connectBtn = $('connectBtn');
const connectLabel = connectBtn.querySelector('span');

const STATE_TEXT = {
  disconnected: 'Desconectado',
  connecting: 'Conectando…',
  connected: 'Conectado',
};

function setState(state, name) {
  statusEl.dataset.state = state;
  statusText.textContent = state === 'connected' ? name : STATE_TEXT[state];
  connectLabel.textContent = state === 'connected' ? 'Desconectar' : 'Conectar';
  connectBtn.disabled = state === 'connecting';
  document.body.dataset.conn = state;
}

if (!RobotBLE.supported) {
  $('unsupported').hidden = false;
  connectBtn.disabled = true;
}

connectBtn.addEventListener('click', async () => {
  if (robot.connected) {
    robot.stop();
    setTimeout(() => robot.disconnect(), 60);
    return;
  }
  try {
    await robot.connect();
  } catch (err) {
    setState('disconnected');
    if (err.name !== 'NotFoundError') toast(`No se pudo conectar: ${err.message}`);
  }
});

robot.addEventListener('state', async ({ detail }) => {
  setState(detail.state, detail.name);
  if (detail.state === 'connected') {
    log('sys', `Conectado a ${detail.name}`);
    $('lastRx').textContent = 'Listo. Envía un comando.';
    if (tiltOn) tiltAction = undefined; // fuerza reenviar la inclinación actual
  }
  if (detail.state === 'disconnected') {
    resetMotion();
    log('sys', 'Desconectado');
    if (!detail.manual) {
      // Reconexión automática (el firmware vuelve a anunciarse al desconectarse).
      toast('Conexión perdida. Reintentando…');
      for (let i = 0; i < 3 && !robot.connected; i++) {
        try { await robot.reconnect(); } catch { await sleep(700); }
      }
      if (!robot.connected) setState('disconnected');
    }
  }
});

/* ---------------- Telemetría ---------------- */
let txCount = 0;
robot.addEventListener('tx', ({ detail }) => {
  txCount++;
  $('lastCmd').textContent = detail.cmd;
  $('txMs').textContent = `${detail.ms.toFixed(1)} ms`;
  $('txCount').textContent = txCount;
  log('tx', detail.cmd);
});
robot.addEventListener('rx', ({ detail }) => {
  $('lastRx').textContent = detail.text;
  if (detail.rtt != null && detail.rtt < 2000) $('rttMs').textContent = `${detail.rtt.toFixed(0)} ms`;
  log('rx', detail.text);
});
robot.addEventListener('error', ({ detail }) => log('err', `${detail.cmd}: ${detail.error.message}`));

$('fastWrite').addEventListener('change', (e) => { robot.fastWrite = e.target.checked; });

const logEl = $('log');
const MAX_LOG = 80;
function log(kind, text) {
  const li = document.createElement('li');
  li.className = kind;
  const t = new Date();
  li.innerHTML = `<time>${t.toLocaleTimeString('es-CO', { hour12: false })}.${String(t.getMilliseconds()).padStart(3, '0')}</time><i>${
    { tx: '→', rx: '←', sys: '•', err: '!' }[kind]
  }</i>`;
  li.append(text);
  logEl.prepend(li);
  while (logEl.childElementCount > MAX_LOG) logEl.lastElementChild.remove();
}

$('manual').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('manualInput').value.trim().toLowerCase();
  if (!v) return;
  if (!robot.send(v, { force: true })) toast('Conecta el robot primero');
  $('manualInput').value = '';
});

/* ---------------- Velocidad ---------------- */
const speedEl = $('speed');
const speedOut = $('speedOut');
const speed = () => +speedEl.value;
const paintSpeed = () => {
  speedOut.textContent = speedEl.value;
  speedEl.style.setProperty('--p', `${(speed() / 255) * 100}%`);
};
paintSpeed();

// Acción actual (sin velocidad): 'ad' | 'at' | 'gh' | 'ga' | null
let currentAction = null;
let currentScale = 1;

function drive(action, scale = 1) {
  currentAction = action;
  currentScale = scale;
  if (!action) return robot.stop();
  const v = Math.round(speed() * scale);
  robot.send(`${action} ${v}`);
}

function resetMotion() {
  currentAction = null;
  document.querySelectorAll('.pad.active').forEach((b) => b.classList.remove('active'));
}

speedEl.addEventListener('input', () => {
  paintSpeed();
  // Si ya se está moviendo, el cambio de velocidad se aplica al instante.
  if (currentAction) drive(currentAction, currentScale);
});

/* ---------------- Selector de modos ---------------- */
// Cada modo tiene su pestaña, un atajo de teclado (1–5) y un enlace (#voz, #rostro…).
const MODES = [
  { tab: 'tab-buttons', hash: 'botones' },
  { tab: 'tab-tilt', hash: 'acelerometro' },
  { tab: 'tab-voice', hash: 'voz' },
  { tab: 'tab-gesture', hash: 'gestos', preload: () => preloadGestures() },
  { tab: 'tab-face', hash: 'rostro', preload: () => preloadFace() },
];
const tabs = MODES.map((m) => $(m.tab));

function selectMode(i, { updateHash = true } = {}) {
  const tab = tabs[i];
  if (!tab || tab.getAttribute('aria-selected') === 'true') return;
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  });
  // Seguridad: al cambiar de modo se apagan los sensores y el robot se detiene.
  stopAllModes();
  MODES[i].preload?.().catch(() => {}); // adelanta la descarga del modelo
  if (updateHash) history.replaceState(null, '', `#${MODES[i].hash}`);
}

tabs.forEach((tab, i) => {
  tab.tabIndex = i === 0 ? 0 : -1;
  tab.addEventListener('click', () => selectMode(i));
  // Flechas izquierda/derecha entre pestañas (patrón accesible de tabs)
  tab.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const j = (i + d + tabs.length) % tabs.length;
    selectMode(j);
    tabs[j].focus();
  });
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select')) return;
  const n = +e.key;
  if (n >= 1 && n <= MODES.length) selectMode(n - 1);
});

function modeFromHash() {
  const i = MODES.findIndex((m) => `#${m.hash}` === location.hash);
  if (i >= 0) {
    selectMode(i, { updateHash: false });
    $('control').scrollIntoView({ block: 'start' });
  }
}
window.addEventListener('hashchange', modeFromHash);

function stopAllModes() {
  stopTilt();
  voice?.stop();
  gesture?.stop();
  face?.stop();
  resetMotion();
  if (robot.connected) robot.stop();
}

/* ================= MODO 1: BOTONES ================= */
const holdEl = $('holdMode');
const pads = [...document.querySelectorAll('.pad')];

function press(btn) {
  if (!robot.connected) return toast('Conecta el robot primero');
  const cmd = btn.dataset.cmd;
  navigator.vibrate?.(8);
  pads.forEach((b) => b.classList.toggle('active', b === btn && cmd !== 'stop'));
  drive(cmd === 'stop' ? null : cmd);
}

function release(btn) {
  if (!holdEl.checked || btn.dataset.cmd === 'stop') return;
  if (!btn.classList.contains('active')) return;
  btn.classList.remove('active');
  drive(null);
}

for (const btn of pads) {
  // pointerdown responde al instante (click espera a soltar el dedo).
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    press(btn);
  });
  btn.addEventListener('pointerup', () => release(btn));
  btn.addEventListener('pointercancel', () => release(btn));
  btn.addEventListener('lostpointercapture', () => release(btn));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); e.stopPropagation(); press(btn); }
  });
  btn.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); release(btn); }
  });
}

const KEYMAP = {
  ArrowUp: 'ad', w: 'ad', W: 'ad',
  ArrowDown: 'at', s: 'at', S: 'at',
  ArrowLeft: 'ga', a: 'ga', A: 'ga',
  ArrowRight: 'gh', d: 'gh', D: 'gh',
};
const padFor = (cmd) => pads.find((b) => b.dataset.cmd === cmd);

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || $('panel-buttons').hidden) return;
  if (e.key === ' ') { e.preventDefault(); return press(padFor('stop')); }
  const cmd = KEYMAP[e.key];
  if (!cmd || e.repeat) return;
  e.preventDefault();
  press(padFor(cmd));
});
window.addEventListener('keyup', (e) => {
  const cmd = KEYMAP[e.key];
  if (cmd) release(padFor(cmd));
});

/* ================= MODO 2: ACELERÓMETRO ================= */
const tiltBtn = $('tiltToggle');
const calBtn = $('calibrate');
const bubble = $('bubble');
const deadEl = $('dead');
const deadRing = $('deadRing');
const tiltCmdEl = $('tiltCmd');
const LEVEL_RANGE = 45; // grados que corresponden al borde del nivel

let tiltOn = false;
let raw = { beta: 0, gamma: 0 };
let zero = { beta: 0, gamma: 0 };
let hasReading = false;
let rafId = 0;
let tiltAction = null;
let tiltScale = 1;
let wakeLock = null;

const paintDead = () => {
  $('deadOut').textContent = `${deadEl.value}°`;
  deadRing.style.setProperty('--d', `${(deadEl.value / LEVEL_RANGE) * 100}%`);
  deadEl.style.setProperty('--p', `${((deadEl.value - 5) / 30) * 100}%`);
};
deadEl.addEventListener('input', paintDead);
paintDead();

function onOrientation(e) {
  if (e.beta == null) return;
  raw.beta = e.beta;
  raw.gamma = e.gamma;
  if (!hasReading) { hasReading = true; zero = { ...raw }; }
}

tiltBtn.addEventListener('click', () => (tiltOn ? stopTilt(true) : startTilt()));
calBtn.addEventListener('click', () => { zero = { ...raw }; navigator.vibrate?.(15); toast('Cero calibrado'); });

async function startTilt() {
  if (!('DeviceOrientationEvent' in window)) return toast('Este dispositivo no tiene acelerómetro');
  // iOS 13+ exige permiso explícito desde un gesto del usuario.
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return toast('Permiso de movimiento denegado');
    } catch { return toast('Permiso de movimiento denegado'); }
  }
  hasReading = false;
  window.addEventListener('deviceorientation', onOrientation);
  tiltOn = true;
  tiltAction = undefined;
  tiltBtn.textContent = 'Desactivar acelerómetro';
  tiltBtn.classList.add('on');
  calBtn.disabled = false;
  rafId = requestAnimationFrame(tiltLoop);
  // Mantiene la pantalla encendida mientras se conduce (sin bloquear el arranque).
  navigator.wakeLock?.request('screen').then((l) => { if (tiltOn) wakeLock = l; else l.release(); }).catch(() => {});
  setTimeout(() => { if (tiltOn && !hasReading) toast('No llegan datos del sensor. Abre la página en un celular.'); }, 1500);
}

function stopTilt(user = false) {
  if (!tiltOn) return;
  tiltOn = false;
  cancelAnimationFrame(rafId);
  window.removeEventListener('deviceorientation', onOrientation);
  tiltBtn.textContent = 'Activar acelerómetro';
  tiltBtn.classList.remove('on');
  calBtn.disabled = true;
  bubble.style.transform = '';
  $('level').dataset.dir = '';
  $('tiltCmd').textContent = 'stop';
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  tiltAction = null;
  if (user && robot.connected) robot.stop();
}

// Diferencia angular en (-180, 180] para que la calibración no salte en ±180°.
const wrap = (a) => ((a + 540) % 360) - 180;

/*
 * Mapeo inclinación → comando discreto:
 *   - Se toma el eje dominante (el de mayor inclinación).
 *   - Histéresis: para ENTRAR a un comando hay que superar la zona muerta;
 *     para SALIR basta bajar de 70 % de ella. Así no "tiembla" en el borde.
 *   - Opcional: velocidad por 3 niveles (50 %, 75 %, 100 %).
 */
function classify(dy, dx, dead) {
  const exit = dead * 0.7;
  const ay = Math.abs(dy), ax = Math.abs(dx);
  const th = tiltAction ? exit : dead;
  if (Math.max(ay, ax) < th) return { action: null, mag: 0 };
  if (ay >= ax) return { action: dy < 0 ? 'ad' : 'at', mag: ay };
  return { action: dx > 0 ? 'gh' : 'ga', mag: ax };
}

function levelScale(mag, dead) {
  if (!$('proportional').checked) return 1;
  if (mag < dead + 10) return 0.5;
  if (mag < dead + 20) return 0.75;
  return 1;
}

function tiltLoop() {
  if (!tiltOn) return;
  rafId = requestAnimationFrame(tiltLoop);
  if (!hasReading) return;

  let dy = wrap(raw.beta - zero.beta);
  const dx = wrap(raw.gamma - zero.gamma);
  if ($('invertY').checked) dy = -dy;
  const dead = +deadEl.value;

  // Visual del nivel de burbuja (la burbuja "cae" hacia donde se inclina).
  const clamp = (v) => Math.max(-1, Math.min(1, v / LEVEL_RANGE));
  bubble.style.transform = `translate(calc(-50% + ${clamp(dx) * 42}cqw), calc(-50% + ${clamp(dy) * 42}cqw))`;
  $('betaOut').textContent = `${dy.toFixed(0)}°`;
  $('gammaOut').textContent = `${dx.toFixed(0)}°`;

  const { action, mag } = classify(dy, dx, dead);
  const scale = action ? levelScale(mag, dead) : 1;

  const label = action ? `${action} ${Math.round(speed() * scale)}` : 'stop';
  if (tiltCmdEl.textContent !== label) tiltCmdEl.textContent = label;

  if (action !== tiltAction || scale !== tiltScale) {
    tiltAction = action;
    tiltScale = scale;
    $('level').dataset.dir = action || '';
    if (robot.connected) {
      navigator.vibrate?.(6);
      drive(action, scale);
    }
  }
}

/* ---------------- Seguridad ---------------- */
// Si la pestaña se oculta (bloqueo de pantalla, cambio de app) se detiene el robot.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAllModes();
});
window.addEventListener('pagehide', () => robot.connected && robot.stop());

/* ================= MODOS 3 y 4: VOZ Y GESTOS ================= */
const modeCtx = {
  $,
  drive,
  toast,
  getSpeed: speed,
  setSpeed: (v) => { speedEl.value = v; speedEl.dispatchEvent(new Event('input')); },
  isConnected: () => robot.connected,
};
const voice = createVoiceMode(modeCtx);
const gesture = createGestureMode(modeCtx);
const face = createFaceMode(modeCtx);

const faceSens = $('faceSens');
faceSens.addEventListener('input', () => {
  $('faceSensOut').textContent = `${(+faceSens.value).toFixed(1)}×`;
  faceSens.style.setProperty('--p', `${((faceSens.value - 0.6) / 1.2) * 100}%`);
});
faceSens.dispatchEvent(new Event('input'));

modeFromHash();

/* ---------------- Video demo ---------------- */
// Pega el enlace en data-src de #demoVideo (YouTube, Google Drive o un .mp4).
(function embedDemo() {
  const box = $('demoVideo');
  const src = box.dataset.src?.trim();
  if (!src) return;
  let url = src;
  const yt = src.match(/(?:youtu\.be\/|v=|shorts\/)([\w-]{11})/);
  const drive = src.match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (yt) url = `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  else if (drive) url = `https://drive.google.com/file/d/${drive[1]}/preview`;
  box.innerHTML = /\.(mp4|webm)(\?|$)/i.test(src)
    ? `<video src="${url}" controls playsinline preload="metadata"></video>`
    : `<iframe src="${url}" title="Video demo" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
  box.classList.add('has-video');
})();

/* ---------------- Utilidades ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
