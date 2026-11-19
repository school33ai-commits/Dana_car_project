// =====================================================================
//  DANA — машинка ESP32, которой «управляет» внимание водителя
//
//  Телефон (сайт v2) следит за глазами и раз в секунду шлёт по Bluetooth команду:
//    'S' — стоять (наблюдение не запущено / калибровка)
//    '0' — глаза открыты         -> плавно разгоняемся и едем вперёд
//    '1'..'5' — глаза закрыты    -> МЕДЛЕННО тормозим до полной остановки
//    'N' — лица нет в кадре 3 с  -> тоже МЕДЛЕННО тормозим до остановки
//  Если команды не приходят дольше LINK_TIMEOUT_MS (телефон выключился,
//  связь пропала) — машинка тоже плавно останавливается.
//
//  Сначала проверьте моторы скетчем test_motors и заполните INVERT ниже.
// =====================================================================

#include <Arduino.h>
#if ESP_ARDUINO_VERSION_MAJOR >= 4
#include <BLE.h>          // пакет esp32 4.x
#else
#include <BLEDevice.h>    // пакет esp32 3.x / 2.x
#include <BLEServer.h>
#include <BLEUtils.h>
#endif

// ----------------------- НАСТРОЙКИ -----------------------
#define SERVICE_UUID "a7d0f001-3c2e-4b8a-9f61-0d4a5c8e7b10"   // как в v2/ble.js
#define COMMAND_UUID "a7d0f002-3c2e-4b8a-9f61-0d4a5c8e7b10"
const char* DEVICE_NAME = "DANA-CAR";

struct Motor {
  const char* name;
  int pinA;      // ШИМ сюда = «вперёд» (по тесту test_motors)
  int pinB;      // ШИМ сюда = «назад»
  bool invert;   // true, если в тесте колесо на «ВПЕРЁД» крутилось назад
};

Motor motors[4] = {
  {"Мотор 1", 17, 16, false},   // пины поменяны местами по тесту test_motors
  {"Мотор 2", 18, 19, false},
  {"Мотор 3", 25, 33, false},
  {"Мотор 4", 32, 35, false},   // P35 только вход! См. README — лучше перекинуть на P26/P27
};

const int CRUISE_SPEED = 170;        // скорость езды, 0..255
const int MIN_PWM = 60;              // ниже этого мотор всё равно не крутится — сразу 0
const unsigned long ACCEL_MS = 1500; // за сколько разгоняемся от 0 до CRUISE_SPEED
const unsigned long BRAKE_MS = 3000; // за сколько МЕДЛЕННО тормозим от CRUISE_SPEED до 0
const unsigned long LINK_TIMEOUT_MS = 3000;
const bool RESUME_AFTER_ALARM = true; // глаза снова открыты — ехать дальше (false: стоять до 'S')
const int LED_PIN = 2;
// ---------------------------------------------------------

float currentSpeed = 0;     // плавно меняется
int targetSpeed = 0;
bool lockedAfterAlarm = false;

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

bool canOutput(int pin) {
#if CONFIG_IDF_TARGET_ESP32
  if (pin >= 34 && pin <= 39) return false;
#endif
  return pin >= 0;
}

void writePin(int pin, int value) {
  if (canOutput(pin)) analogWrite(pin, value);
}

// speed: -255..255
void motorSet(const Motor& m, int speed) {
  speed = constrain(speed, -255, 255);
  if (m.invert) speed = -speed;
  if (speed > 0) {
    writePin(m.pinB, 0);
    writePin(m.pinA, speed);
  } else if (speed < 0) {
    writePin(m.pinA, 0);
    writePin(m.pinB, -speed);
  } else {
    writePin(m.pinA, 0);
    writePin(m.pinB, 0);
  }
}

void driveForward(int speed) {
  int pwm = speed < MIN_PWM ? 0 : speed;
  for (auto& m : motors) motorSet(m, pwm);
}

bool isAlarm(char c) { return c >= '1' && c <= '5'; }

const char* describe(char c) {
  if (c == 'S') return "стоять";
  if (c == '0') return "глаза открыты — едем";
  if (isAlarm(c)) return "ГЛАЗА ЗАКРЫТЫ — плавно тормозим";
  if (c == 'N') return "ЛИЦА НЕТ — плавно тормозим";
  return "неизвестно — стоим";
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(LED_PIN, OUTPUT);
  for (auto& m : motors) {
    if (canOutput(m.pinA)) pinMode(m.pinA, OUTPUT);
    if (canOutput(m.pinB)) pinMode(m.pinB, OUTPUT);
  }
  driveForward(0);

  Serial.println();
  Serial.println("=== DANA-CAR ===");
  for (auto& m : motors) {
    if (!canOutput(m.pinA) || !canOutput(m.pinB)) {
      Serial.printf("!!! %s: пин P%d только вход — этот мотор работать не будет. Перекиньте провод.\n",
                    m.name, canOutput(m.pinA) ? m.pinB : m.pinA);
    }
  }

  if (!setupBluetooth()) Serial.println("Проверьте, что выбрана плата ESP32 с Bluetooth (не ESP32-S2).");
  Serial.println("Жду телефон по Bluetooth…");
}

void loop() {
  static bool wasConnected = false;
  static char lastPrinted = 0;
  static bool linkLostPrinted = false;
  static unsigned long lastStep = millis();
  unsigned long now = millis();

  // --- состояние связи ---
  if (deviceConnected && !wasConnected) {
    Serial.println(">>> Телефон подключился");
    wasConnected = true;
  }
  if (!deviceConnected && wasConnected) {
    Serial.println("<<< Телефон отключился — останавливаюсь, жду снова");
    wasConnected = false;
    command = 'S';
    restartAdvertising();
  }
  bool linkOk = deviceConnected && (now - lastMessageAt <= LINK_TIMEOUT_MS);
  if (deviceConnected && !linkOk && !linkLostPrinted) {
    Serial.println("!!! Команды не приходят больше 3 с — плавно останавливаюсь");
    linkLostPrinted = true;
  }
  if (linkOk) linkLostPrinted = false;

  // --- какая скорость нужна ---
  char c = linkOk ? command : 'S';
  if (c != lastPrinted) {
    Serial.printf("[%lu с] '%c' — %s\n", now / 1000, c, describe(c));
    lastPrinted = c;
  }
  if (isAlarm(c) || c == 'N') lockedAfterAlarm = !RESUME_AFTER_ALARM;
  if (c == 'S') lockedAfterAlarm = false;

  if (c == '0' && !lockedAfterAlarm) targetSpeed = CRUISE_SPEED;
  else targetSpeed = 0;   // 'S', тревога, лица нет, нет связи, неизвестная команда

  // --- плавное изменение скорости каждые 20 мс ---
  unsigned long dt = now - lastStep;
  if (dt >= 20) {
    lastStep = now;
    float up = (float)CRUISE_SPEED * dt / ACCEL_MS;
    float down = (float)CRUISE_SPEED * dt / BRAKE_MS;
    if (currentSpeed < targetSpeed) currentSpeed = min((float)targetSpeed, currentSpeed + up);
    else if (currentSpeed > targetSpeed) currentSpeed = max((float)targetSpeed, currentSpeed - down);
    driveForward((int)currentSpeed);
  }

  // --- светодиод: горит — связь есть; часто мигает — тормозим из-за сна; медленно — нет связи ---
  if (!linkOk) digitalWrite(LED_PIN, (now / 500) % 2);
  else if (isAlarm(c) || c == 'N') digitalWrite(LED_PIN, (now / 100) % 2);
  else digitalWrite(LED_PIN, HIGH);

  delay(5);
}
