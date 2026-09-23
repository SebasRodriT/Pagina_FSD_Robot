/*
 * gestures.js — Modo 4: control con gestos de mano (MediaPipe Gesture Recognizer).
 *
 * MediaPipe detecta la mano en la webcam y entrega:
 *   - 21 landmarks (puntos) de la mano, y
 *   - un gesto clasificado (Open_Palm, Closed_Fist, Thumb_Up, Thumb_Down, …).
 * Aquí se mapea esa salida a los comandos del robot.
 *
 * Por qué es rápido:
 *   - La librería (~150 KB) y el modelo (~8 MB) se descargan sólo al abrir la
 *     pestaña, y quedan en caché para las siguientes visitas.
 *   - GPU, calentamiento y una inferencia por cuadro nuevo: ver mp.js.
 *   - Filtro de estabilidad: el gesto debe mantenerse 3 cuadros (~100 ms)
 *     antes de enviarse, para no mandar comandos por detecciones sueltas.
 */

import { loadVision, createTask, openCamera, closeCamera, eachVideoFrame, perfMeter } from './mp.js';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

const STABLE_FRAMES = 3;
const LOST_MS = 350;

// Landmarks (ver https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
const WRIST = 0;
const FINGERS = { index: [5, 6, 8], middle: [9, 10, 12], ring: [13, 14, 16], pinky: [17, 18, 20] };

export const GESTURES = [
  { id: 'palm', emoji: '✋', label: 'Palma abierta', action: null },
  { id: 'fist', emoji: '✊', label: 'Puño', action: null },
  { id: 'up', emoji: '☝️', label: 'Índice arriba', action: 'ad' },
  { id: 'down', emoji: '👇', label: 'Índice abajo', action: 'at' },
  { id: 'right', emoji: '👉', label: 'Índice a tu derecha', action: 'gh' },
  { id: 'left', emoji: '👈', label: 'Índice a tu izquierda', action: 'ga' },
  { id: 'thumbUp', emoji: '👍', label: 'Pulgar arriba', action: 'ad' },
  { id: 'thumbDown', emoji: '👎', label: 'Pulgar abajo', action: 'at' },
];
const BY_ID = new Map(GESTURES.map((g) => [g.id, g]));

let libPromise = null;
/** Carga la librería y el modelo una sola vez (se puede llamar de antemano). */
export function preloadGestures() {
  if (!libPromise) {
    libPromise = (async () => {
      const { mod, fileset } = await loadVision();
      const recognizer = await createTask(mod.GestureRecognizer, fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
      return { recognizer, connections: mod.GestureRecognizer.HAND_CONNECTIONS };
    })();
    libPromise.catch(() => { libPromise = null; });
  }
  return libPromise;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const extended = (lm, [mcp, pip, tip]) => dist(lm[tip], lm[WRIST]) > dist(lm[pip], lm[WRIST]) * 1.1 && dist(lm[tip], lm[mcp]) > dist(lm[pip], lm[mcp]) * 1.3;

/** Salida de MediaPipe → id de gesto (o null si no hay nada reconocible). */
export function classifyHand(lm, category) {
  if (!lm) return null;
  const name = category && category.score >= 0.55 ? category.categoryName : 'None';
  if (name === 'Open_Palm') return 'palm';

  // Índice extendido y los otros tres doblados → dirección del dedo.
  const pointing =
    extended(lm, FINGERS.index) &&
    !extended(lm, FINGERS.middle) &&
    !extended(lm, FINGERS.ring) &&
    !extended(lm, FINGERS.pinky);
  if (pointing) {
    const dx = lm[8].x - lm[5].x;
    const dy = lm[8].y - lm[5].y;
    if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? 'up' : 'down';
    // La cámara frontal NO viene en espejo: tu derecha es la izquierda de la imagen.
    return dx < 0 ? 'right' : 'left';
  }

  if (name === 'Thumb_Up') return 'thumbUp';
  if (name === 'Thumb_Down') return 'thumbDown';
  if (name === 'Closed_Fist') return 'fist';
  return null;
}

export function createGestureMode({ $, drive, getSpeed, toast, isConnected }) {
  const btn = $('gestureToggle');
  const video = $('gestureVideo');
  const canvas = $('gestureCanvas');
  const ctx = canvas.getContext('2d');
  const status = $('gestureStatus');
  const cmdEl = $('gestureCmd');
  const labelEl = $('gestureLabel');
  const fpsEl = $('gestureFps');
  const stage = $('gestureStage');
  const items = new Map([...document.querySelectorAll('#gestureLegend [data-g]')].map((el) => [el.dataset.g, el]));

  const perf = perfMeter(fpsEl);

  let active = false;
  let stream = null;
  let lib = null;
  let stopLoop = null;
  let candidate = null;
  let candidateCount = 0;
  let committed = undefined;
  let lastHandAt = 0;

  const setStatus = (state, text) => { status.dataset.state = state; status.textContent = text; };

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) return toast('Este navegador no permite usar la cámara');
    active = true;
    btn.disabled = true;
    setStatus('starting', 'Cargando modelo de MediaPipe…');
    try {
      const libP = preloadGestures(); // modelo y cámara arrancan en paralelo
      stream = await openCamera(video);
      lib = await libP;
      if (!active) { closeCamera(video, stream); stream = null; return; }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      stage.classList.add('live');
      committed = undefined;
      candidate = null;
      lastHandAt = performance.now();
      perf.reset();
      setStatus('listening', 'Muestra la mano a la cámara');
      btn.querySelector('span').textContent = 'Apagar cámara';
      btn.classList.add('on');
      stopLoop = eachVideoFrame(video, (t0) => {
        const res = lib.recognizer.recognizeForVideo(video, t0);
        perf.add(performance.now() - t0);
        handle(res, t0);
        draw(res);
      });
    } catch (err) {
      active = false;
      closeCamera(video, stream);
      const msg = err.name === 'NotAllowedError' ? 'Permiso de cámara denegado' : `No se pudo iniciar: ${err.message}`;
      setStatus('error', msg);
      toast(msg);
    } finally {
      btn.disabled = false;
    }
  }

  function handle(res, now) {
    const lm = res.landmarks[0];
    let id = null;
    if (lm) {
      lastHandAt = now;
      id = classifyHand(lm, res.gestures[0]?.[0]);
    } else if (now - lastHandAt < LOST_MS) {
      return; // la mano desapareció un instante: no cambiar todavía
    }

    // Filtro de estabilidad
    if (id === candidate) candidateCount++;
    else { candidate = id; candidateCount = 1; }
    if (candidateCount < STABLE_FRAMES || id === committed) return;

    committed = id;
    const g = id && BY_ID.get(id);
    const action = g ? g.action : null;
    items.forEach((el, k) => el.classList.toggle('active', k === id));
    labelEl.textContent = g ? `${g.emoji} ${g.label}` : lm ? 'Gesto no reconocido' : 'Sin mano';
    cmdEl.textContent = action ? `${action} ${getSpeed()}` : 'stop';
    if (isConnected()) drive(action);
  }

  function draw(res) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const lm = res.landmarks[0];
    if (!lm) return;
    const w = canvas.width, h = canvas.height;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff6a2b';
    ctx.lineWidth = Math.max(2, w / 180);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    for (const { start, end } of lib.connections) {
      ctx.moveTo(lm[start].x * w, lm[start].y * h);
      ctx.lineTo(lm[end].x * w, lm[end].y * h);
    }
    ctx.stroke();
    ctx.fillStyle = accent;
    const r = Math.max(3, w / 120);
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function stop() {
    const was = active;
    active = false;
    stopLoop?.();
    stopLoop = null;
    closeCamera(video, stream);
    stream = null;
    stage.classList.remove('live');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    items.forEach((el) => el.classList.remove('active'));
    btn.querySelector('span').textContent = 'Activar cámara';
    btn.classList.remove('on');
    cmdEl.textContent = 'stop';
    labelEl.textContent = '—';
    perf.reset();
    committed = undefined;
    if (was) setStatus('idle', 'Cámara apagada');
  }

  btn.addEventListener('click', () => (active ? stop() : start()));

  return { stop };
}
