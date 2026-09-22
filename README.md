# Robot FSD · Control por Web Bluetooth

Página para controlar el robot de dos motores (ESP32-C3 Super Mini + driver Mini L298, firmware `PRJ-3-BLE-MOTORS-V1`) desde el navegador por Bluetooth Low Energy.

- **Modo 1: Botones.** D-pad de mantener presionado (o de pulsar y soltar), con teclado `WASD`/flechas y `Espacio` para detener.
- **Modo 2: Acelerómetro.** `DeviceOrientation` (β adelante/atrás, γ izquierda/derecha) convertido a comandos discretos con zona muerta, histéresis y calibración de cero.
- **Telemetría.** Último comando, tiempo de escritura, tiempo de ida y vuelta (hasta el `notify` del robot), log TX/RX y consola de comandos manuales.
- **`minimo.html`**: el código mínimo de conexión (punto 2a).

## Protocolo del firmware

| Elemento | Valor |
|---|---|
| Nombre BLE | `ROBOT-FSD-JSRT` |
| Servicio | `0xFFE0` |
| Característica | `0xFFE1` (READ, WRITE, WRITE_NR, NOTIFY) |
| Comandos | `ad #`, `at #`, `gh #`, `ga #`, `stop` (`#` = 0–255) |

## Las cinco llamadas de Web Bluetooth

1. **`navigator.bluetooth.requestDevice({ filters })`** abre el selector del navegador y filtra por el servicio `FFE0`. Requiere un clic del usuario.
2. **`device.gatt.connect()`** abre la conexión GATT; en el ESP32 se ejecuta `onConnect`.
3. **`server.getPrimaryService(0xFFE0)`** obtiene el servicio del robot.
4. **`service.getCharacteristic(0xFFE1)`** obtiene la característica donde se escriben los comandos.
5. **`characteristic.writeValue(bytes)`** envía el comando como texto UTF-8. El firmware lo recibe en `onWrite` → `procesarComando()`.

## Por qué los comandos van rápido

No usa frameworks: el JavaScript total pesa unos 15 KB sin dependencias, así que carga casi al instante y no hay capas entre el evento y el envío BLE.

- **`writeValueWithoutResponse`**: el firmware acepta `WRITE_NR`, así que no se espera confirmación por cada comando. Se puede desactivar con el interruptor “Escritura rápida” para usar `writeValue`.
- **Cola "último gana"**: sólo hay una escritura GATT en vuelo. Si entran varios comandos mientras tanto, sólo se envía el más reciente. Así se evitan errores `GATT operation already in progress` y el retraso acumulado.
- **Deduplicación**: el acelerómetro evalúa a 60 fps, pero sólo se envía cuando cambia el comando.
- **`pointerdown`** en lugar de `click`: el comando sale al tocar, sin esperar a soltar el dedo.
- **Service worker** con estrategia "red primero": funciona sin internet después de la primera visita.

## Seguridad

Envía `stop` al soltar el botón, al cambiar de modo, al ocultar la pestaña o bloquear la pantalla, y al desconectar. El firmware también se detiene solo si se pierde la conexión. La página intenta reconectar automáticamente hasta 3 veces.

## Uso

Web Bluetooth necesita **HTTPS** (o `localhost`) y **Chrome/Edge** (Android, Windows, macOS, Linux). En iPhone se usa la app **Bluefy**. En Android hay que activar Bluetooth y Ubicación.

### Publicar en GitHub Pages
Settings → Pages → *Deploy from a branch* → `main` / `(root)`. La página queda en
`https://sebasrodrit.github.io/Pagina_FSD_Robot/`.

### Probar en local
```bash
python -m http.server 8000
# abrir http://localhost:8000
```
