/*
 * mp.js — Utilidades compartidas por los modos de visión (gestos de mano y rostro).
 *
 *   - La librería MediaPipe Tasks Vision se importa UNA sola vez, aunque se
 *     usen dos modelos distintos.
 *   - Cada modelo se crea en GPU (WebGL) con respaldo a CPU, y se "calienta"
 *     con una inferencia de prueba para que el primer cuadro de la cámara no
 *     se congele mientras se compilan los shaders.
 *   - La cámara se procesa con requestVideoFrameCallback: una inferencia por
 *     cuadro nuevo, nunca dos veces el mismo cuadro.
 */

export const MP_VERSION = '1.0.1';
export const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;

let visionPromise = null;
export function loadVision() {
  if (!visionPromise) {
    visionPromise = (async () => {
      const mod = await import(`${MP_URL}/vision_bundle.mjs`);
      const fileset = await mod.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
      return { mod, fileset };
    })();
    visionPromise.catch(() => { visionPromise = null; });
  }
  return visionPromise;
}

/** Crea una tarea (GestureRecognizer, FaceLandmarker…) en GPU o, si falla, en CPU. */
export async function createTask(Task, fileset, options) {
  const withDelegate = (delegate) => ({ ...options, baseOptions: { ...options.baseOptions, delegate } });
  let task;
  try {
    task = await Task.createFromOptions(fileset, withDelegate('GPU'));
  } catch {
    task = await Task.createFromOptions(fileset, withDelegate('CPU'));
  }
  const warm = document.createElement('canvas');
  warm.width = warm.height = 64;
  warm.getContext('2d').fillRect(0, 0, 64, 64);
  task.detectForVideo ? task.detectForVideo(warm, performance.now()) : task.recognizeForVideo(warm, performance.now());
  return task;
}

/** Enciende la cámara frontal y la conecta al <video>. */
export async function openCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function closeCamera(video, stream) {
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

/**
 * Llama a cb(now) una vez por cada cuadro nuevo del video.
 * Devuelve una función para detener el ciclo.
 */
export function eachVideoFrame(video, cb) {
  let running = true;
  let handle = 0;
  let lastTime = -1;
  const rvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const tick = () => {
    if (!running) return;
    if (video.readyState >= 2 && video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      cb(performance.now());
    }
    if (running) handle = rvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  };
  tick();
  return () => {
    running = false;
    if (rvfc) video.cancelVideoFrameCallback(handle);
    else cancelAnimationFrame(handle);
  };
}

/** Contador de fps y tiempo de inferencia (promedio móvil). */
export function perfMeter(el) {
  let frames = 0, t0 = performance.now(), ms = 0;
  return {
    add(inferMs) {
      ms = ms * 0.8 + inferMs * 0.2;
      frames++;
      const now = performance.now();
      if (now - t0 > 500) {
        el.textContent = `${Math.round((frames * 1000) / (now - t0))} fps · ${ms.toFixed(0)} ms`;
        t0 = now;
        frames = 0;
      }
    },
    reset() { el.textContent = ''; frames = 0; t0 = performance.now(); },
  };
}
