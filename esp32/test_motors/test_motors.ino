// =====================================================================
//  DANA — ТЕСТ 2: направления моторов машинки
//  Bluetooth не нужен.
//
//  ВАЖНО: поставьте машинку на подставку (коробку), чтобы колёса
//  висели в воздухе и она не уехала со стола.
//
//  Что делает: по очереди крутит каждый мотор ВПЕРЁД, потом НАЗАД,
//  потом все четыре вместе. В Мониторе порта (115200) пишет, что сейчас
//  должно происходить. Запишите для каждого мотора:
//    - какое это колесо (переднее левое, заднее правое…);
//    - крутится ли оно ВПЕРЁД, когда написано «ВПЕРЁД».
//  Если наоборот — в основной программе dana_car поставьте для этого
//  мотора INVERT = true (провода перепаивать не нужно).
//
//  Можно управлять из Монитора порта (отправьте символ):
//    1, 2, 3, 4 — проверить только этот мотор
//    f — все вперёд,  b — все назад,  s — стоп,  a — снова автотест по кругу
// =====================================================================

struct Motor {
  const char* name;
  int pinA;   // этот пин получает ШИМ, когда мотор крутится «вперёд»
  int pinB;   // этот пин получает ШИМ, когда мотор крутится «назад»
};

// Пины вашей машинки
Motor motors[4] = {
  {"Мотор 1 (P17, P16)", 17, 16},
  {"Мотор 2 (P18, P19)", 18, 19},
  {"Мотор 3 (P25, P33)", 25, 33},
  {"Мотор 4 (P32, P35)", 32, 35},
};

const int TEST_SPEED = 180;   // 0..255; если колесо не трогается — увеличьте
const int RUN_MS = 2000;      // сколько крутить в каждую сторону
const int PAUSE_MS = 800;     // пауза между шагами

// На обычном ESP32 пины 34, 35, 36, 39 только ВХОДЫ — выдать на них сигнал нельзя
bool canOutput(int pin) {
#if CONFIG_IDF_TARGET_ESP32
  if (pin >= 34 && pin <= 39) return false;
#endif
  return pin >= 0;
}

void writePin(int pin, int value) {
  if (canOutput(pin)) analogWrite(pin, value);
}

// speed: от -255 (назад) до 255 (вперёд), 0 — стоп
void motorSet(const Motor& m, int speed) {
  speed = constrain(speed, -255, 255);
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

void allSet(int speed) {
  for (auto& m : motors) motorSet(m, speed);
}

// Ждём, но если пришла команда из Монитора порта — прерываемся
bool waitOrCommand(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    if (Serial.available()) return true;
    delay(10);
  }
  return false;
}

bool testMotor(int i) {
  Motor& m = motors[i];
  Serial.println();
  Serial.printf(">>> %s: ВПЕРЁД (ШИМ на P%d)\n", m.name, m.pinA);
  if (!canOutput(m.pinA)) Serial.printf("    !!! P%d только вход — этот мотор вперёд крутиться НЕ будет\n", m.pinA);
  motorSet(m, TEST_SPEED);
  if (waitOrCommand(RUN_MS)) { motorSet(m, 0); return true; }

  motorSet(m, 0);
  Serial.println("    стоп");
  if (waitOrCommand(PAUSE_MS)) return true;

  Serial.printf(">>> %s: НАЗАД (ШИМ на P%d)\n", m.name, m.pinB);
  if (!canOutput(m.pinB)) Serial.printf("    !!! P%d только вход — назад этот мотор крутиться НЕ будет\n", m.pinB);
  motorSet(m, -TEST_SPEED);
  if (waitOrCommand(RUN_MS)) { motorSet(m, 0); return true; }

  motorSet(m, 0);
  Serial.println("    стоп");
  return waitOrCommand(PAUSE_MS);
}

bool testAll() {
  Serial.println();
  Serial.println(">>> ВСЕ МОТОРЫ: ВПЕРЁД — машинка должна «ехать» вперёд всеми колёсами");
  allSet(TEST_SPEED);
  if (waitOrCommand(RUN_MS)) { allSet(0); return true; }
  allSet(0);
  if (waitOrCommand(PAUSE_MS)) return true;

  Serial.println(">>> ВСЕ МОТОРЫ: НАЗАД");
  allSet(-TEST_SPEED);
  if (waitOrCommand(RUN_MS)) { allSet(0); return true; }
  allSet(0);
  Serial.println("    стоп. Через 3 с тест начнётся заново.");
  return waitOrCommand(3000);
}

void checkPins() {
  bool ok = true;
  for (auto& m : motors) {
    for (int pin : {m.pinA, m.pinB}) {
      if (!canOutput(pin)) {
        ok = false;
        Serial.printf("!!! ВНИМАНИЕ: %s — пин P%d на ESP32 работает только на ВХОД.\n", m.name, pin);
        Serial.println("    Этим проводом мотор управлять не сможет. Перекиньте провод на свободный");
        Serial.println("    пин-выход, например P26, P27, P23, P13 или P14, и поменяйте номер в скетче.");
      }
    }
  }
  if (ok) Serial.println("Все пины моторов — выходы, всё в порядке.");
}

void setup() {
  Serial.begin(115200);
  delay(500);
  for (auto& m : motors) {
    if (canOutput(m.pinA)) pinMode(m.pinA, OUTPUT);
    if (canOutput(m.pinB)) pinMode(m.pinB, OUTPUT);
  }
  allSet(0);
  Serial.println();
  Serial.println("=== DANA: тест направлений моторов ===");
  checkPins();
  Serial.println("Колёса должны висеть в воздухе! Старт через 3 с…");
  Serial.println("Команды: 1-4 — один мотор, f — все вперёд, b — все назад, s — стоп, a — автотест");
  delay(3000);
}

bool autoMode = true;

void handleCommand(char c) {
  allSet(0);
  if (c >= '1' && c <= '4') {
    autoMode = false;
    testMotor(c - '1');
    Serial.println("Готово. Отправьте следующую команду.");
  } else if (c == 'f') {
    autoMode = false;
    Serial.println(">>> ВСЕ ВПЕРЁД (до команды s)");
    allSet(TEST_SPEED);
  } else if (c == 'b') {
    autoMode = false;
    Serial.println(">>> ВСЕ НАЗАД (до команды s)");
    allSet(-TEST_SPEED);
  } else if (c == 's') {
    autoMode = false;
    Serial.println(">>> СТОП");
  } else if (c == 'a') {
    autoMode = true;
    Serial.println(">>> Автотест по кругу");
  }
}

void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    if (c != '\n' && c != '\r' && c != ' ') handleCommand(c);
    return;
  }
  if (!autoMode) {
    delay(10);
    return;
  }
  for (int i = 0; i < 4; i++) {
    if (testMotor(i)) return;   // пришла команда — выходим и обрабатываем её
  }
  testAll();
}
