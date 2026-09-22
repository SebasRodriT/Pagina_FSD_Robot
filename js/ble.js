/*
 * ble.js — Conexión Web Bluetooth con el robot (ESP32-C3 + NimBLE).
 *
 * Firmware: PRJ-3-BLE-MOTORS-V1
 *   Servicio        0xFFE0
 *   Característica  0xFFE1  (READ | WRITE | WRITE_NR | NOTIFY)
 *   Comandos        "ad #", "at #", "gh #", "ga #", "stop"   (# = 0..255)
 *
 * Por qué es rápido:
 *   1. writeValueWithoutResponse: el firmware acepta WRITE_NR, así que no se
 *      espera el ACK del robot en cada comando (menos de la mitad de latencia).
 *   2. Cola "último gana": sólo hay UNA escritura GATT en vuelo. Si mientras
 *      tanto llegan 10 comandos nuevos, sólo se envía el más reciente. Esto
 *      evita el error "GATT operation already in progress" y el retraso
 *      acumulado cuando el acelerómetro genera eventos a 60 Hz.
 *   3. Deduplicación: si el comando es igual al último enviado, no se reenvía.
 *   4. Los bytes de cada comando se codifican una sola vez y se reutilizan.
 */

export const SERVICE_UUID = 0xffe0;
export const CHAR_UUID = 0xffe1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encoded = new Map();
const bytesOf = (cmd) => {
  let b = encoded.get(cmd);
  if (!b) encoded.set(cmd, (b = encoder.encode(cmd)));
  return b;
};

export class RobotBLE extends EventTarget {
  device = null;
  server = null;
  characteristic = null;
  fastWrite = true;          // usar writeValueWithoutResponse cuando exista
  #busy = false;
  #pending = null;
  #last = null;
  #lastTxAt = 0;
  #manualDisconnect = false;

  static get supported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  get connected() {
    return !!(this.device && this.device.gatt.connected && this.characteristic);
  }

  get name() {
    return this.device?.name || 'Robot';
  }

  async connect() {
    // 1) requestDevice: abre el selector del navegador y filtra por servicio.
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }, { namePrefix: 'ROBOT' }],
      optionalServices: [SERVICE_UUID],
    });
    this.device.addEventListener('gattserverdisconnected', this.#onDisconnected);
    await this.#open();
  }

  async reconnect() {
    if (!this.device) return this.connect();
    await this.#open();
  }

  async #open() {
    this.#emit('state', { state: 'connecting' });
    this.#manualDisconnect = false;
    // 2) connect: abre el enlace GATT con el ESP32.
    this.server = await this.device.gatt.connect();
    // 3) getPrimaryService: busca el servicio FFE0 (la "oficina").
    const service = await this.server.getPrimaryService(SERVICE_UUID);
    // 4) getCharacteristic: obtiene FFE1 (el "buzón") donde se escriben comandos.
    this.characteristic = await service.getCharacteristic(CHAR_UUID);

    // Respuestas del robot ("Avanzando a velocidad 200", etc.) por NOTIFY.
    if (this.characteristic.properties.notify) {
      this.characteristic.addEventListener('characteristicvaluechanged', this.#onNotify);
      await this.characteristic.startNotifications().catch(() => {});
    }

    this.#last = null;
    this.#emit('state', { state: 'connected', name: this.name });
  }

  disconnect() {
    this.#manualDisconnect = true;
    this.#pending = null;
    if (this.device?.gatt.connected) this.device.gatt.disconnect();
  }

  /**
   * Encola un comando. Nunca bloquea: retorna de inmediato.
   * @param {string} cmd  p. ej. "ad 200" o "stop"
   * @param {{force?: boolean}} opts  force=true reenvía aunque sea repetido
   */
  send(cmd, { force = false } = {}) {
    if (!this.connected) return false;
    if (!force && cmd === this.#last && this.#pending === null) return false;
    this.#pending = cmd;
    this.#pump();
    return true;
  }

  stop() {
    return this.send('stop', { force: true });
  }

  async #pump() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#pending !== null && this.characteristic) {
        const cmd = this.#pending;
        this.#pending = null;
        const t0 = performance.now();
        try {
          await this.#write(bytesOf(cmd));
          this.#last = cmd;
          this.#lastTxAt = t0;
          this.#emit('tx', { cmd, ms: performance.now() - t0 });
        } catch (err) {
          this.#emit('error', { cmd, error: err });
        }
      }
    } finally {
      this.#busy = false;
    }
  }

  #write(bytes) {
    const c = this.characteristic;
    // 5) writeValue: envía los bytes del comando a FFE1.
    //    writeValueWithoutResponse es la variante sin confirmación (más rápida).
    if (this.fastWrite && c.properties.writeWithoutResponse && c.writeValueWithoutResponse) {
      return c.writeValueWithoutResponse(bytes);
    }
    if (c.writeValueWithResponse) return c.writeValueWithResponse(bytes);
    return c.writeValue(bytes);
  }

  #onNotify = (e) => {
    const text = decoder.decode(e.target.value);
    const rtt = this.#lastTxAt ? performance.now() - this.#lastTxAt : null;
    this.#emit('rx', { text, rtt });
  };

  #onDisconnected = () => {
    this.characteristic = null;
    this.#busy = false;
    this.#pending = null;
    this.#emit('state', { state: 'disconnected', manual: this.#manualDisconnect });
  };

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
