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

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

// Эти UUID записаны и в v2/ble.js — менять только вместе
#define SERVICE_UUID "a7d0f001-3c2e-4b8a-9f61-0d4a5c8e7b10"
#define COMMAND_UUID "a7d0f002-3c2e-4b8a-9f61-0d4a5c8e7b10"

const char* DEVICE_NAME = "DANA-CAR";
const int LED_PIN = 2;                       // встроенный светодиод на большинстве плат ESP32
const unsigned long LINK_TIMEOUT_MS = 3000;  // нет команд дольше — связь считается потерянной

volatile bool deviceConnected = false;
volatile char lastCommand = 'S';
volatile bool newCommand = false;
volatile unsigned long lastMessageAt = 0;
unsigned long totalMessages = 0;

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
    // .c_str() — чтобы работало и на ядре ESP32 2.x (std::string), и на 3.x (String)
    String value = characteristic->getValue().c_str();
    if (value.length() > 0) {
      lastCommand = value[0];
      newCommand = true;
      lastMessageAt = millis();
    }
  }
};

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

  BLEDevice::init(DEVICE_NAME);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* service = server->createService(SERVICE_UUID);
  BLECharacteristic* command = service->createCharacteristic(
      COMMAND_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR | BLECharacteristic::PROPERTY_READ);
  command->setCallbacks(new CommandCallbacks());
  command->setValue("S");
  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();

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
    delay(300);
    BLEDevice::startAdvertising();
  }

  if (newCommand) {
    static char printedCommand = 0;
    static unsigned long lastPulsePrint = 0;
    newCommand = false;
    totalMessages++;
    char cmd = lastCommand;
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
