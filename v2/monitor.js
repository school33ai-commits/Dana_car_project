// Логика DANA v2 без браузерных API. Работает и в браузере, и в тестах (node).
// Отличия от v1:
//  - если во время тревоги лицо пропало или голова отвернулась/упала, тревога НЕ замолкает;
//  - если глаза закрылись, а потом лицо ушло из кадра, отсчёт продолжается;
//  - каждое обновление возвращает state и level — по ним телефон шлёт команду на ESP32.

export const LEFT_EYE = [362, 385, 387, 263, 373, 380];
export const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
export const NOSE_TIP = 1;
export const FACE_EDGE_A = 234;
export const FACE_EDGE_B = 454;

export const DEFAULT_THRESHOLD = 0.22;
export const CALIBRATION_FACTOR = 0.75;
export const MIN_OPEN_EAR = 0.10;
export const BLINK_WINDOW_SECONDS = 60;
export const SPEECH_PAUSE = 0.4;
export const ALARM_ESCALATE_SECONDS = 4.0;
export const NO_FACE_WARN_SECONDS = 3.0;

// [базовая частота Гц, громкость 0..1, пауза между сигналами с]
export const ALARM_LEVELS = [
  [450, 0.35, 1.6],
  [520, 0.5, 1.4],
  [600, 0.65, 1.2],
  [700, 0.8, 1.0],
  [800, 1.0, 0.9],
];

// Состояния, которые понимает и телефон, и ESP32
export const STATE = {
  CALIB: "calib",       // калибровка
  OK: "ok",             // глаза открыты
  CLOSED: "closed",     // глаза закрыты, но меньше порога
  AWAY: "away",         // смотрит не в камеру
  SEARCH: "search",     // лицо только что пропало
  NOFACE: "noface",     // лица нет дольше NO_FACE_WARN_SECONDS
  ALARM: "alarm",       // засыпание — тревога
};

function distance(p1, p2) {
  return Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
}

// EAR: отношение высоты глаза к его ширине. Около 0 — глаз закрыт.
export function eyeRatio(points, indexes, width, height) {
  const p = indexes.map((i) => [points[i].x * width, points[i].y * height]);
  const horizontal = distance(p[0], p[3]);
  if (horizontal === 0) return 0;
  return (distance(p[1], p[5]) + distance(p[2], p[4])) / (2 * horizontal);
}

// True, если нос близко к центру лица, то есть человек смотрит в камеру.
export function isFacingCamera(points) {
  const left = points[FACE_EDGE_A].x;
  const right = points[FACE_EDGE_B].x;
  const width = right - left;
  if (Math.abs(width) < 1e-6) return false;
  const ratio = (points[NOSE_TIP].x - left) / width;
  return ratio >= 0.3 && ratio <= 0.7;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export class DrowsinessMonitor {
  // options: { threshold, calibSeconds, closedSeconds, onBeep(level), onSpeak(), onAlarmStart(ear|null), onAlarmEnd(duration) }
  constructor(options = {}) {
    this.closedSeconds = options.closedSeconds ?? 2.0;
    this.calibSeconds = options.calibSeconds ?? 5.0;
    this.onBeep = options.onBeep ?? (() => {});
    this.onSpeak = options.onSpeak ?? (() => {});
    this.onAlarmStart = options.onAlarmStart ?? (() => {});
    this.onAlarmEnd = options.onAlarmEnd ?? (() => {});

    this.threshold = options.threshold ?? null;
    this.calibrating = this.threshold === null && this.calibSeconds > 0;
    this.calibStart = null;
    this.calibValues = [];
    if (this.threshold === null && !this.calibrating) this.threshold = DEFAULT_THRESHOLD;

    this.closedStart = null;
    this.noFaceStart = null;
    this.alarmActive = false;
    this.alarmStarted = 0;
    this.lastAlarm = -Infinity;
    this.nextIsSpeech = false;
    this.blinkTimes = [];
  }

  endClosure(now) {
    if (this.closedStart === null) return;
    const duration = now - this.closedStart;
    if (this.alarmActive) {
      this.alarmActive = false;
      this.onAlarmEnd(duration);
    } else if (duration < this.closedSeconds) {
      this.blinkTimes.push(now);
    }
    this.closedStart = null;
  }

  // Вызывается при нажатии «Стоп», чтобы запись в журнале не осталась незаконченной
  stop(now) {
    if (this.alarmActive) this.endClosure(now);
    this.closedStart = null;
  }

  blinksPerMinute(now) {
    this.blinkTimes = this.blinkTimes.filter((t) => now - t <= BLINK_WINDOW_SECONDS);
    return this.blinkTimes.length;
  }

  updateCalibration(ear, now) {
    if (this.calibStart === null) this.calibStart = now;
    if (ear > MIN_OPEN_EAR) this.calibValues.push(ear);
    if (now - this.calibStart >= this.calibSeconds) {
      this.threshold = this.calibValues.length
        ? median(this.calibValues) * CALIBRATION_FACTOR
        : DEFAULT_THRESHOLD;
      this.calibrating = false;
    }
    const remaining = Math.max(0, this.calibSeconds - (now - this.calibStart));
    return {
      text: `Калибровка ${remaining.toFixed(0)}с — смотрите в камеру, глаза открыты`,
      cls: "calib",
      state: STATE.CALIB,
      level: 0,
    };
  }

  // Тревога: запускается один раз, потом каждые 4 с уровень выше
  alarm(now, ear) {
    if (!this.alarmActive) {
      this.alarmActive = true;
      this.alarmStarted = now;
      this.lastAlarm = -Infinity;
      this.nextIsSpeech = false;
      this.onAlarmStart(ear);
    }
    const elapsed = now - this.alarmStarted;
    const level = Math.min(ALARM_LEVELS.length - 1, Math.floor(elapsed / ALARM_ESCALATE_SECONDS));
    const interval = ALARM_LEVELS[level][2];
    if (now - this.lastAlarm >= interval) {
      // Сигнал и фраза чередуются: сигнал, фраза, сигнал, ...
      if (this.nextIsSpeech) {
        this.onSpeak();
        this.lastAlarm = now + SPEECH_PAUSE;
      } else {
        this.onBeep(level);
        this.lastAlarm = now;
      }
      this.nextIsSpeech = !this.nextIsSpeech;
    }
    return { text: "ПРОСНИТЕСЬ!", cls: "danger", state: STATE.ALARM, level };
  }

  // Глаза закрыты (или были закрыты до того, как лицо пропало)
  closed(now, ear) {
    if (this.closedStart === null) this.closedStart = now;
    if (now - this.closedStart < this.closedSeconds) {
      return { text: "ГЛАЗА ЗАКРЫТЫ", cls: "ok", state: STATE.CLOSED, level: 0 };
    }
    return this.alarm(now, ear);
  }

  updateFace(points, ear, now) {
    this.noFaceStart = null;
    if (this.calibrating) return this.updateCalibration(ear, now);

    const facing = isFacingCamera(points);

    if (!facing) {
      // Голова повернулась или упала, когда глаза уже были закрыты — не сбрасываем отсчёт
      if (this.alarmActive || this.closedStart !== null) return this.closed(now, ear);
      return { text: "СМОТРИТЕ НА КАМЕРУ", cls: "calib", state: STATE.AWAY, level: 0 };
    }

    if (ear >= this.threshold) {
      this.endClosure(now);
      return { text: "НАБЛЮДЕНИЕ", cls: "ok", state: STATE.OK, level: 0 };
    }

    return this.closed(now, ear);
  }

  updateNoFace(now) {
    if (this.calibrating) {
      // Калибровка начнётся заново, когда лицо появится
      this.calibStart = null;
      this.calibValues = [];
      return { text: "Калибровка: поставьте телефон так, чтобы лицо было видно", cls: "calib", state: STATE.CALIB, level: 0 };
    }

    // Лицо пропало во время тревоги или когда глаза были закрыты (голова упала) — не замолкаем
    if (this.alarmActive || this.closedStart !== null) return this.closed(now, null);

    if (this.noFaceStart === null) this.noFaceStart = now;
    if (now - this.noFaceStart >= NO_FACE_WARN_SECONDS) {
      return { text: "ЛИЦО НЕ НАЙДЕНО", cls: "danger", state: STATE.NOFACE, level: 0 };
    }
    return { text: "Ищу лицо…", cls: "calib", state: STATE.SEARCH, level: 0 };
  }
}
