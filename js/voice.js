/*
 * voice.js — Modo 3: control por voz con la Web Speech API (SpeechRecognition).
 *
 * El reconocimiento lo hace el navegador; aquí sólo se mapean las palabras
 * clave reconocidas a comandos del robot.
 *
 * Por qué responde rápido:
 *   - interimResults = true: se actúa sobre los resultados PARCIALES, sin
 *     esperar a que termine la frase (se ahorra ~0.5–1 s por comando).
 *   - Cada resultado recuerda cuántas palabras ya se procesaron, así una
 *     palabra no dispara dos veces cuando el parcial pasa a final.
 *   - continuous = true y reinicio automático en onend: no hay que volver a
 *     pulsar el micrófono entre comandos.
 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Palabra (sin tildes, minúsculas) → acción
export const VOCAB = [
  { action: 'stop', label: 'Detener', words: ['para', 'pare', 'parar', 'alto', 'detente', 'detener', 'stop', 'quieto', 'frena', 'frenar', 'basta'] },
  { action: 'ad', label: 'Adelante', words: ['adelante', 'avanza', 'avanzar', 'avance', 'sigue', 'recto', 'forward'] },
  { action: 'at', label: 'Atrás', words: ['atras', 'retrocede', 'retroceder', 'reversa', 'regresa', 'back', 'backward'] },
  { action: 'gh', label: 'Derecha', words: ['derecha', 'right'] },
  { action: 'ga', label: 'Izquierda', words: ['izquierda', 'left'] },
  { action: 'faster', label: 'Más rápido', words: ['rapido', 'acelera', 'acelerar', 'faster'] },
  { action: 'slower', label: 'Más lento', words: ['lento', 'despacio', 'slower'] },
];

const WORD_TO_ACTION = new Map(VOCAB.flatMap((v) => v.words.map((w) => [w, v.action])));
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const SPEED_STEP = 40;

export function createVoiceMode({ $, drive, getSpeed, setSpeed, toast, isConnected }) {
  const btn = $('voiceToggle');
  const status = $('voiceStatus');
  const transcriptEl = $('voiceTranscript');
  const cmdEl = $('voiceCmd');
  const langEl = $('voiceLang');
  const pulseEl = $('voicePulse');
  const chips = new Map([...document.querySelectorAll('#voiceVocab [data-action]')].map((c) => [c.dataset.action, c]));

  let rec = null;
  let active = false;
  let processed = new Map(); // índice de resultado → palabras ya procesadas
  let pulseTimer = 0;

  if (!SR) {
    btn.disabled = true;
    status.textContent = 'Este navegador no soporta SpeechRecognition. Usa Chrome o Edge.';
    status.dataset.state = 'error';
  }

  function build() {
    const r = new SR();
    r.lang = langEl.value;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onstart = () => setStatus('listening', 'Escuchando… di “adelante”, “derecha”, “para”…');
    r.onresult = onResult;
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('Permiso de micrófono denegado');
        stop();
      } else if (e.error === 'network') {
        setStatus('error', 'Sin conexión: el reconocimiento de Chrome necesita internet.');
      } else {
        setStatus('error', `Error: ${e.error}`);
      }
    };
    // Chrome corta la sesión tras un silencio: se reinicia sola mientras esté activa.
    r.onend = () => {
      if (rec !== r) return; // sesión vieja (p. ej. tras cambiar idioma)
      processed = new Map();
      if (active) {
        try { r.start(); } catch {}
      } else {
        setStatus('idle', 'Micrófono apagado');
      }
    };
    return r;
  }

  function onResult(e) {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = res[0].transcript;
      const tokens = norm(text).split(/[^a-z0-9ñ]+/).filter(Boolean);
      const done = processed.get(i) || 0;
      transcriptEl.textContent = text.trim() || '…';
      transcriptEl.classList.toggle('final', res.isFinal);

      // Sólo las palabras nuevas; la última palabra clave es la que manda.
      let action = null;
      let lastHit = -1;
      for (let k = done; k < tokens.length; k++) {
        const a = WORD_TO_ACTION.get(tokens[k]);
        if (a) { action = a; lastHit = k; }
      }
      // En un parcial la última palabra puede estar incompleta ("ade" → "adelante"):
      // se vuelve a revisar en el siguiente evento, salvo que ya haya sido una palabra clave.
      const last = tokens.length - 1;
      processed.set(i, res.isFinal || lastHit === last ? tokens.length : Math.max(done, last));
      if (action) execute(action);
    }
  }

  let current = null;
  function execute(action) {
    flash(action);
    if (action === 'faster' || action === 'slower') {
      const v = Math.max(60, Math.min(255, getSpeed() + (action === 'faster' ? SPEED_STEP : -SPEED_STEP)));
      setSpeed(v);
      cmdEl.textContent = current ? `${current} ${v}` : `vel ${v}`;
      return;
    }
    current = action === 'stop' ? null : action;
    cmdEl.textContent = current ? `${current} ${getSpeed()}` : 'stop';
    if (!isConnected()) return toast('Conecta el robot primero');
    navigator.vibrate?.(10);
    drive(current);

    // Opcional: moverse sólo un tiempo y detenerse solo.
    clearTimeout(pulseTimer);
    const ms = +pulseEl.value;
    if (current && ms > 0) {
      pulseTimer = setTimeout(() => {
        current = null;
        cmdEl.textContent = 'stop';
        drive(null);
      }, ms);
    }
  }

  function flash(action) {
    const chip = chips.get(action);
    if (!chip) return;
    chip.classList.remove('hit');
    void chip.offsetWidth; // reinicia la animación
    chip.classList.add('hit');
  }

  function setStatus(state, text) {
    status.dataset.state = state;
    status.textContent = text;
  }

  function start() {
    if (!SR) return;
    rec = build();
    active = true;
    processed = new Map();
    try { rec.start(); } catch {}
    btn.classList.add('on');
    btn.querySelector('span').textContent = 'Detener micrófono';
    setStatus('starting', 'Pidiendo micrófono…');
  }

  function stop() {
    const was = active;
    active = false;
    clearTimeout(pulseTimer);
    current = null;
    rec?.abort();
    rec = null;
    btn.classList.remove('on');
    btn.querySelector('span').textContent = 'Activar micrófono';
    cmdEl.textContent = 'stop';
    if (was) setStatus('idle', 'Micrófono apagado');
  }

  btn.addEventListener('click', () => (active ? stop() : start()));
  langEl.addEventListener('change', () => { if (active) { stop(); start(); } });

  return { stop };
}
