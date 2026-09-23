/*
 * face.js — Modo 5: control con gestos faciales (MediaPipe Face Landmarker).
 *
 * MediaPipe entrega 478 landmarks de la cara y 52 "blendshapes" (qué tan
 * abierta está la boca, si hay beso, sonrisa, etc., de 0 a 1). Aquí se mapea
 * esa salida a comandos, en dos submodos:
 *
 *   CABEZA        mirar arriba → ad · mirar abajo → at
 *                 girar a tu derecha → gh · a tu izquierda → ga · al frente → stop
 *   EXPRESIONES   boca abierta → ad · beso → at
 *                 guiño derecho → gh · guiño izquierdo → ga · neutra → stop
 *
 * Todo es RELATIVO a una calibración (tu cara neutra mirando al frente), así
 * funciona sin importar a qué altura esté la cámara o la forma de la cara.
 */

import { loadVision, createTask, openCamera, closeCamera, eachVideoFrame, perfMeter } from './mp.js';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const STABLE_FRAMES = 3;   // ~100 ms a 30 fps
const LOST_MS = 400;       // sin cara más de esto → stop
const CALIB_FRAMES = 12;   // cuadros promediados al calibrar

// Índices de la malla facial de MediaPipe (478 puntos).
// "Derecha/izquierda" son de la PERSONA: en la imagen sin espejo, su derecha queda a la izquierda.
const L = {
  nose: 1,
  cheekR: 234, cheekL: 454,
  eyeR: { outer: 33, inner: 133, top: 159, bottom: 145 },
  eyeL: { outer: 263, inner: 362, top: 386, bottom: 374 },
};

// Umbrales base (se multiplican por la sensibilidad elegida)
const YAW_TH = 0.12;       // desplazamiento de la nariz / ancho de la cara
const PITCH_TH = 0.08;     // desplazamiento vertical nariz-ojos / distancia entre ojos
const JAW_TH = 0.45;       // blendshape jawOpen
const PUCKER_TH = 0.55;    // blendshape mouthPucker
const WINK_CLOSED = 0.6;   // ojo cerrado si su apertura < 60 % de la calibrada
const WINK_OPEN = 0.8;     // y el otro sigue > 80 % abierto

export const FACE_MAP = {
  head: [
    { id: 'up', emoji: '⬆️', label: 'Mirar arriba', action: 'ad' },
    { id: 'down', emoji: '⬇️', label: 'Mirar abajo', action: 'at' },
    { id: 'right', emoji: '➡️', label: 'Girar a tu derecha', action: 'gh' },
    { id: 'left', emoji: '⬅️', label: 'Girar a tu izquierda', action: 'ga' },
    { id: 'center', emoji: '⏺️', label: 'Al frente', action: null },
  ],
  expr: [
    { id: 'mouth', emoji: '😮', label: 'Boca abierta', action: 'ad' },
    { id: 'kiss', emoji: '😗', label: 'Beso', action: 'at' },
    { id: 'winkR', emoji: '😉', label: 'Guiño derecho', action: 'gh' },
    { id: 'winkL', emoji: '😜', label: 'Guiño izquierdo', action: 'ga' },
    { id: 'neutral', emoji: '😐', label: 'Neutra', action: null },
  ],
};

let taskPromise = null;
export function preloadFace() {
  if (!taskPromise) {
    taskPromise = (async () => {
      const { mod, fileset } = await loadVision();
      const landmarker = await createTask(mod.FaceLandmarker, fileset, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      return { landmarker, contours: mod.FaceLandmarker.FACE_LANDMARKS_CONTOURS };
    })();
    taskPromise.catch(() => { taskPromise = null; });
  }
  return taskPromise;
}

/**
 * Landmarks + blendshapes → medidas simples.
 * aspect = ancho/alto del video, para medir distancias en píxeles reales.
 */
export function faceMetrics(lm, blendshapes, aspect = 4 / 3) {
  const d = (a, b) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
  const faceW = Math.abs(lm[L.cheekL].x - lm[L.cheekR].x);
  const eyeY = (lm[L.eyeR.outer].y + lm[L.eyeL.outer].y) / 2;
  const eyeDist = d(L.eyeR.outer, L.eyeL.outer);
  const eye = (e) => d(e.top, e.bottom) / d(e.outer, e.inner);
  const b = (name) => blendshapes?.find((c) => c.categoryName === name)?.score ?? 0;
  return {
    // < 0: la nariz se movió a la izquierda de la imagen = giraste hacia TU derecha
    yaw: (lm[L.nose].x - (lm[L.cheekR].x + lm[L.cheekL].x) / 2) / faceW,
    // < 0: la punta de la nariz se acercó a la línea de los ojos = miras hacia arriba.
    // Se mide contra los ojos (no contra el mentón) para que abrir la boca no cuente.
    pitch: (lm[L.nose].y - eyeY) / eyeDist,
    eyeR: eye(L.eyeR),
    eyeL: eye(L.eyeL),
    jaw: b('jawOpen'),
    pucker: b('mouthPucker'),
  };
}

/**
 * Medidas + calibración → id del gesto.
 * prev: gesto anterior (para la histéresis de la cabeza).
 */
export function classifyFace(m, base, { mode, sensitivity = 1, invertY = false, prev = null }) {
  if (mode === 'head') {
    const k = 1 / sensitivity;
    let nx = (m.yaw - base.yaw) / (YAW_TH * k);
    let ny = (m.pitch - base.pitch) / (PITCH_TH * k);
    if (invertY) ny = -ny;
    // Histéresis: para salir de un comando basta bajar al 70 % del umbral.
    const th = prev && prev !== 'center' ? 0.7 : 1;
    if (Math.max(Math.abs(nx), Math.abs(ny)) < th) return 'center';
    if (Math.abs(ny) >= Math.abs(nx)) return ny < 0 ? 'up' : 'down';
    return nx < 0 ? 'right' : 'left';
  }
  // Expresiones (la boca tiene prioridad sobre los guiños)
  const jawTh = JAW_TH / sensitivity;
  if (m.jaw > jawTh) return 'mouth';
  if (m.pucker > PUCKER_TH / sensitivity && m.jaw < jawTh * 0.6) return 'kiss';
  const r = m.eyeR / base.eyeR;
  const l = m.eyeL / base.eyeL;
  if (r < WINK_CLOSED && l > WINK_OPEN) return 'winkR';
  if (l < WINK_CLOSED && r > WINK_OPEN) return 'winkL';
  return 'neutral';
}

export function createFaceMode({ $, drive, getSpeed, toast, isConnected }) {
  const btn = $('faceToggle');
  const calBtn = $('faceCalibrate');
  const video = $('faceVideo');
  const canvas = $('faceCanvas');
  const ctx = canvas.getContext('2d');
  const stage = $('faceStage');
  const status = $('faceStatus');
  const cmdEl = $('faceCmd');
  const labelEl = $('faceLabel');
  const sensEl = $('faceSens');
  const invertEl = $('faceInvert');
  const pad = $('facePad');
  const dot = $('faceDot');
  const meters = {
    jaw: $('mJaw'), pucker: $('mPucker'), eyeR: $('mEyeR'), eyeL: $('mEyeL'),
  };
  const subTabs = [...document.querySelectorAll('#faceSub [data-sub]')];
  const legends = { head: $('faceLegendHead'), expr: $('faceLegendExpr') };
  const perf = perfMeter($('faceFps'));
  const byId = new Map([...FACE_MAP.head, ...FACE_MAP.expr].map((g) => [g.id, g]));

  let mode = 'head';
  let active = false;
  let stream = null;
  let lib = null;
  let stopLoop = null;
  let base = null;
  let calib = [];
  let candidate = null;
  let candidateCount = 0;
  let committed = undefined;
  let lastFaceAt = 0;

  const setStatus = (state, text) => { status.dataset.state = state; status.textContent = text; };

  function setMode(m) {
    mode = m;
    subTabs.forEach((t) => t.setAttribute('aria-pressed', t.dataset.sub === m));
    legends.head.hidden = m !== 'head';
    legends.expr.hidden = m !== 'expr';
    pad.classList.toggle('dim', m !== 'head');
    committed = undefined; // fuerza reenviar el estado actual
    candidate = null;
  }
  subTabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.sub)));

  function recalibrate() {
    base = null;
    calib = [];
    setStatus('starting', 'Calibrando… mira al frente con la cara neutra');
  }
  calBtn.addEventListener('click', recalibrate);

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) return toast('Este navegador no permite usar la cámara');
    active = true;
    btn.disabled = true;
    setStatus('starting', 'Cargando modelo de MediaPipe…');
    try {
      const libP = preloadFace();
      stream = await openCamera(video);
      lib = await libP;
      if (!active) { closeCamera(video, stream); stream = null; return; }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      stage.classList.add('live');
      calBtn.disabled = false;
      btn.querySelector('span').textContent = 'Apagar cámara';
      btn.classList.add('on');
      committed = undefined;
      candidate = null;
      lastFaceAt = performance.now();
      perf.reset();
      recalibrate();
      const aspect = video.videoWidth / video.videoHeight;
      stopLoop = eachVideoFrame(video, (t0) => {
        const res = lib.landmarker.detectForVideo(video, t0);
        perf.add(performance.now() - t0);
        const lm = res.faceLandmarks[0];
        const m = lm && faceMetrics(lm, res.faceBlendshapes[0]?.categories, aspect);
        handle(m, t0);
        draw(lm);
      });
    } catch (err) {
      active = false;
      closeCamera(video, stream);
      stream = null;
      const msg = err.name === 'NotAllowedError' ? 'Permiso de cámara denegado' : `No se pudo iniciar: ${err.message}`;
      setStatus('error', msg);
      toast(msg);
    } finally {
      btn.disabled = false;
    }
  }

  function handle(m, now) {
    if (m) {
      lastFaceAt = now;
      // Calibración: promedio de los primeros cuadros con cara
      if (!base) {
        calib.push(m);
        if (calib.length >= CALIB_FRAMES) {
          const avg = (k) => calib.reduce((s, c) => s + c[k], 0) / calib.length;
          base = { yaw: avg('yaw'), pitch: avg('pitch'), eyeR: avg('eyeR'), eyeL: avg('eyeL') };
          setStatus('listening', mode === 'head' ? 'Listo: mueve la cabeza' : 'Listo: haz una expresión');
        }
        return;
      }
      paint(m);
    } else if (now - lastFaceAt < LOST_MS) {
      return;
    }

    const id = m && base
      ? classifyFace(m, base, { mode, sensitivity: +sensEl.value, invertY: invertEl.checked, prev: committed })
      : null;

    if (id === candidate) candidateCount++;
    else { candidate = id; candidateCount = 1; }
    if (candidateCount < STABLE_FRAMES || id === committed) return;

    committed = id;
    const g = id && byId.get(id);
    const action = g ? g.action : null;
    for (const list of Object.values(legends))
      list.querySelectorAll('[data-f]').forEach((el) => el.classList.toggle('active', el.dataset.f === id));
    pad.dataset.dir = mode === 'head' && action ? action : '';
    labelEl.textContent = g ? `${g.emoji} ${g.label}` : 'Sin rostro';
    cmdEl.textContent = action ? `${action} ${getSpeed()}` : 'stop';
    if (isConnected()) drive(action);
  }

  // Indicadores: punto de la cabeza y barras de expresiones
  function paint(m) {
    const k = 1 / +sensEl.value;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    // El círculo punteado es el umbral (40 % del radio del indicador).
    const nx = clamp((m.yaw - base.yaw) / (YAW_TH * k) * 0.4);
    let ny = clamp((m.pitch - base.pitch) / (PITCH_TH * k) * 0.4);
    if (invertEl.checked) ny = -ny;
    // En pantalla el indicador va en espejo, igual que el video: girar a tu derecha lo mueve a la derecha.
    dot.style.transform = `translate(calc(-50% + ${-nx * 42}cqw), calc(-50% + ${ny * 42}cqw))`;
    const bar = (el, v) => el.style.setProperty('--v', `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`);
    bar(meters.jaw, m.jaw);
    bar(meters.pucker, m.pucker);
    bar(meters.eyeR, 1 - m.eyeR / base.eyeR);
    bar(meters.eyeL, 1 - m.eyeL / base.eyeL);
  }

  function draw(lm) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!lm) return;
    const w = canvas.width, h = canvas.height;
    ctx.lineWidth = Math.max(1.5, w / 320);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    for (const { start, end } of lib.contours) {
      ctx.moveTo(lm[start].x * w, lm[start].y * h);
      ctx.lineTo(lm[end].x * w, lm[end].y * h);
    }
    ctx.stroke();
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff6a2b';
    ctx.beginPath();
    ctx.arc(lm[L.nose].x * w, lm[L.nose].y * h, Math.max(4, w / 90), 0, Math.PI * 2);
    ctx.fill();
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
    calBtn.disabled = true;
    btn.querySelector('span').textContent = 'Activar cámara';
    btn.classList.remove('on');
    cmdEl.textContent = 'stop';
    labelEl.textContent = '—';
    dot.style.transform = '';
    pad.dataset.dir = '';
    Object.values(meters).forEach((el) => el.style.setProperty('--v', '0%'));
    document.querySelectorAll('#panel-face [data-f].active').forEach((el) => el.classList.remove('active'));
    perf.reset();
    committed = undefined;
    if (was) setStatus('idle', 'Cámara apagada');
  }

  btn.addEventListener('click', () => (active ? stop() : start()));
  setMode('head');

  return { stop };
}
