// =====================================================================
//  DANA — ТЕСТ 1: связь по Bluetooth (BLE) между телефоном и ESP32
//  Моторы НЕ включаются. Только проверяем, что команды доходят.
//
//  Как проверить:
//   1. Залейте скетч, откройте Инструменты → Монитор порта, скорость 115200.
//   2. На телефоне откройте страницу v2/ble-test.html (Android — Chrome,
//      iPhone — приложение Bluefy), нажмите «Подключить», выберите DANA-CAR.
//   3. Нажимайте кнопки — в Мониторе порта появится, что пришло,
//      а встроенный светодиод мигнёт.
//   4. Кнопка «Тишина 5 с» — через ~3 с должно появиться «ПУЛЬС ПРОПАЛ».
// =====================================================================

#include <Arduino.h>
#if ESP_ARDUINO_VERSION_MAJOR >= 4
#include <BLE.h>          // пакет esp32 4.x
#else
#include <BLEDevice.h>    // пакет esp32 3.x / 2.x
#include <BLEServer.h>
#include <BLEUtils.h>
#endif

// Эти UUID записаны и в v2/ble.js — менять только вместе
#define SERVICE_UUID "a7d0f001-3c2e-4b8a-9f61-0d4a5c8e7b10"
#define COMMAND_UUID "a7d0f002-3c2e-4b8a-9f61-0d4a5c8e7b10"

const char* DEVICE_NAME = "DANA-CAR";
const int LED_PIN = 2;                       // встроенный светодиод на большинстве плат ESP32
const unsigned long LINK_TIMEOUT_MS = 3000;  // нет команд дольше — связь считается потерянной

unsigned long totalMessages = 0;

// ===================== Bluetooth =====================
// Работает и на пакете esp32 версии 4.x (новая библиотека BLE.h),
// и на старых 3.x / 2.x (библиотека BLEDevice.h) — нужная часть выбирается сама.

volatile bool deviceConnected = false;
volatile char command = 'S';
volatile bool newCommand = false;
volatile unsigned long lastMessageAt = 0;

void handleWrite(const String& value) {
  if (value.length() > 0) {
    command = value[0];
    newCommand = true;
    lastMessageAt = millis();
  }
}

#if ESP_ARDUINO_VERSION_MAJOR >= 4
// ---------- пакет esp32 4.x ----------
static const BLEUUID SVC_UUID(SERVICE_UUID);
static const BLEUUID CMD_UUID(COMMAND_UUID);
BLEServer bleServer;
BLECharacteristic commandChr;

bool setupBluetooth() {
  BTStatus status = BLE.begin(DEVICE_NAME);
  if (!status) {
    Serial.printf("!!! Bluetooth не запустился: %s\n", status.toString());
    return false;
  }
  bleServer = BLE.createServer();
  bleServer.onConnect([](BLEServer server, const BLEConnInfo& conn) {
    deviceConnected = true;
    lastMessageAt = millis();
  });
  bleServer.onDisconnect([](BLEServer server, const BLEConnInfo& conn, uint8_t reason) {
    deviceConnected = false;
    server.startAdvertising();   // снова видна для телефона
  });
  BLEService service = bleServer.createService(SVC_UUID);
  commandChr = service.createCharacteristic(CMD_UUID, BLEProperty::Read | BLEProperty::Write,
                                            BLEPermission::ReadWriteOpen);
  commandChr.setValue("S");
  commandChr.onWrite([](BLECharacteristic c, const BLEConnInfo& conn) {
    handleWrite(String(c.getStringValue().c_str()));
  });
  status = bleServer.start();
  if (!status) {
    Serial.printf("!!! Сервер Bluetooth не запустился: %s\n", status.toString());
    return false;
  }
  BLEAdvertising adv = BLE.getAdvertising();
  adv.addServiceUUID(SVC_UUID);
  status = adv.start();
  if (!status) {
    Serial.printf("!!! Реклама Bluetooth не запустилась: %s\n", status.toString());
    return false;
  }
  return true;
}

void restartAdvertising() {
  // В 4.x реклама перезапускается сама в onDisconnect
}

#else
// ---------- пакет esp32 3.x / 2.x ----------
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    deviceConnected = true;
    lastMessageAt = millis();
  }
  void onDisconnect(BLEServer* server) override {
    deviceConnected = false;
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    handleWrite(String(characteristic->getValue().c_str()));
  }
};

bool setupBluetooth() {
  BLEDevice::init(DEVICE_NAME);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService* service = server->createService(SERVICE_UUID);
  BLECharacteristic* characteristic = service->createCharacteristic(
      COMMAND_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR | BLECharacteristic::PROPERTY_READ);
  characteristic->setCallbacks(new CommandCallbacks());
  characteristic->setValue("S");
  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  return true;
}

void restartAdvertising() {
  delay(300);
  BLEDevice::startAdvertising();
}
#endif
// =====================================================

const char* describe(char cmd) {
  switch (cmd) {
    case 'S': return "стоять (наблюдение не запущено)";
    case '0': return "глаза открыты -> ехать вперёд";
    case '1': return "ТРЕВОГА уровень 1 -> тормозить";
    case '2': return "ТРЕВОГА уровень 2 -> тормозить";
    case '3': return "ТРЕВОГА уровень 3 -> тормозить";
    case '4': return "ТРЕВОГА уровень 4 -> тормозить";
    case '5': return "ТРЕВОГА уровень 5 -> тормозить";
    case 'N': return "лица нет -> сбавить скорость";
    default:  return "неизвестная команда";
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(LED_PIN, OUTPUT);
  Serial.println();
  Serial.println("=== DANA: тест Bluetooth ===");

  if (!setupBluetooth()) {
    Serial.println("Проверьте, что выбрана плата ESP32 с Bluetooth (не ESP32-S2).");
    return;
  }
  Serial.print("Жду подключения телефона. Имя устройства: ");
  Serial.println(DEVICE_NAME);
}

void loop() {
  static bool wasConnected = false;
  static bool pulseLost = false;
  unsigned long now = millis();

  if (deviceConnected && !wasConnected) {
    Serial.println(">>> Телефон ПОДКЛЮЧИЛСЯ");
    wasConnected = true;
    pulseLost = false;
  }
  if (!deviceConnected && wasConnected) {
    Serial.println("<<< Телефон ОТКЛЮЧИЛСЯ. Снова жду подключения…");
    wasConnected = false;
    restartAdvertising();
  }

  if (newCommand) {
    static char printedCommand = 0;
    static unsigned long lastPulsePrint = 0;
    newCommand = false;
    totalMessages++;
    char cmd = command;
    // Новая команда — печатаем сразу; повтор (пульс раз в секунду) — не чаще раза в 5 с
    if (cmd != printedCommand) {
      Serial.printf("[%lu с] Пришло '%c' — %s\n", now / 1000, cmd, describe(cmd));
      printedCommand = cmd;
      lastPulsePrint = now;
    } else if (now - lastPulsePrint > 5000) {
      Serial.printf("[%lu с] пульс в порядке, команда '%c', всего сообщений: %lu\n", now / 1000, cmd, totalMessages);
      lastPulsePrint = now;
    }
    if (pulseLost) {
      Serial.println("    Пульс снова есть");
      pulseLost = false;
    }
    digitalWrite(LED_PIN, HIGH);
    delay(40);
    digitalWrite(LED_PIN, LOW);
  }

  if (deviceConnected && !pulseLost && now - lastMessageAt > LINK_TIMEOUT_MS) {
    pulseLost = true;
    Serial.println("!!! ПУЛЬС ПРОПАЛ: команд нет больше 3 с. В основной программе машинка здесь остановится.");
  }

  // Не подключено — светодиод медленно мигает
  if (!deviceConnected) digitalWrite(LED_PIN, (now / 500) % 2);
  delay(10);
}
