// Связь телефона с ESP32 по Bluetooth Low Energy (Web Bluetooth).
// Телефон пишет в характеристику ESP32 одну букву-команду:
//   'S' — стоять (наблюдение не запущено или идёт калибровка)
//   '0' — водитель смотрит, глаза открыты: ехать вперёд
//   '1'..'5' — глаза закрыты, тревога уровня 1…5: плавно тормозить
//   'N' — лица нет в кадре дольше 3 с: тоже плавно тормозить
// Команда повторяется раз в секунду («пульс»). Если ESP32 долго не получает пульс,
// он сам понимает, что связь пропала, и плавно останавливается.

// Эти же UUID записаны в скетче esp32/dana_esp32/dana_esp32.ino — менять только вместе
export const SERVICE_UUID = "a7d0f001-3c2e-4b8a-9f61-0d4a5c8e7b10";
export const COMMAND_UUID = "a7d0f002-3c2e-4b8a-9f61-0d4a5c8e7b10";
export const DEVICE_NAME_PREFIX = "DANA";

const HEARTBEAT_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 5000;

export class EspLink {
  // onStatus(kind, text): kind = "off" | "connecting" | "on" | "lost"
  constructor({ onStatus } = {}) {
    this.onStatus = onStatus ?? (() => {});
    this.device = null;
    this.characteristic = null;
    this.connected = false;
    this.manualDisconnect = false;
    this.busy = false;
    this.desired = "S";
    this.lastSent = null;
    this.lastSentAt = 0;
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  static supported() {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  // Вызывать только по нажатию кнопки — так требует браузер
  async connect() {
    if (!EspLink.supported()) {
      throw new Error("браузер не поддерживает Bluetooth (Android: Chrome; iPhone: приложение Bluefy)");
    }
    this.manualDisconnect = false;
    this.onStatus("connecting", "ESP32: выберите устройство…");
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }, { namePrefix: DEVICE_NAME_PREFIX }],
      optionalServices: [SERVICE_UUID],
    });
    this.device.addEventListener("gattserverdisconnected", () => this.handleDisconnect());
    await this.connectGatt();
  }

  async connectGatt() {
    this.onStatus("connecting", `ESP32: подключаюсь к ${this.device.name || "устройству"}…`);
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.characteristic = await service.getCharacteristic(COMMAND_UUID);
    this.connected = true;
    this.reconnectDelay = 1000;
    this.lastSent = null;
    this.onStatus("on", `ESP32: подключено (${this.device.name || "DANA"})`);
    if (!this.heartbeatTimer) this.heartbeatTimer = setInterval(() => this.flush(), 250);
    this.flush();
  }

  handleDisconnect() {
    this.connected = false;
    this.characteristic = null;
    if (this.manualDisconnect || !this.device) {
      this.onStatus("off", "ESP32: не подключено");
      return;
    }
    this.onStatus("lost", "ESP32: связь потеряна, переподключаюсь…");
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectGatt();
      } catch (error) {
        console.warn("Переподключение не удалось:", error);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        this.handleDisconnect();
      }
    }, this.reconnectDelay);
  }

  async disconnect() {
    this.manualDisconnect = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.connected) {
      this.desired = "S";
      await this.write("S").catch(() => {});
    }
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    this.connected = false;
    this.onStatus("off", "ESP32: не подключено");
  }

  // Можно вызывать на каждом кадре: реально отправляется только при смене команды и раз в секунду
  send(code) {
    this.desired = code;
    this.flush();
  }

  async flush() {
    if (!this.connected || !this.characteristic || this.busy) return;
    const code = this.desired;
    const changed = code !== this.lastSent;
    if (!changed && Date.now() - this.lastSentAt < HEARTBEAT_MS) return;
    try {
      await this.write(code);
      this.lastSent = code;
      this.lastSentAt = Date.now();
    } catch (error) {
      console.warn("Не удалось отправить на ESP32:", error);
    }
    // Пока писали, команда могла смениться — отправим новую сразу
    if (this.desired !== this.lastSent) this.flush();
  }

  async write(code) {
    this.busy = true;
    try {
      const data = new TextEncoder().encode(code);
      if (this.characteristic.writeValueWithResponse) {
        await this.characteristic.writeValueWithResponse(data);
      } else {
        await this.characteristic.writeValue(data);
      }
    } finally {
      this.busy = false;
    }
  }
}

// Какую команду слать на ESP32 для результата монитора
export function commandFor(result) {
  if (!result || result.state === "calib") return "S";
  if (result.state === "alarm") return String(Math.min(5, (result.level ?? 0) + 1));
  if (result.state === "noface") return "N";
  return "0";
}
