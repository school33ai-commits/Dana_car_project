// DANA v2: камера + MediaPipe + звук + связь с машинкой ESP32 по Bluetooth.
import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { DrowsinessMonitor, eyeRatio, LEFT_EYE, RIGHT_EYE, ALARM_LEVELS } from "./monitor.js";
import { EspLink, commandFor } from "./ble.js";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

const $ = (id) => document.getElementById(id);
const video = $("video");
const statusEl = $("status");
const infoEl = $("info");
const startBtn = $("start");
const stopBtn = $("stop");
const driverInput = $("driver");
const logCountEl = $("logCount");
const closedSelect = $("closedSeconds");
const phoneSoundBox = $("phoneSound");
const bleConnectBtn = $("bleConnect");
const bleTestBtn = $("bleTest");
const bleDot = $("bleDot");
const bleText = $("bleText");
const bleHint = $("bleHint");

// ---------- Настройки (запоминаются на телефоне) ----------
const SETTINGS_KEY = "dana_v2_settings";
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch (error) {
    return {};
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      driver: driverInput.value,
      closedSeconds: closedSelect.value,
      phoneSound: phoneSoundBox.checked,
    }));
  } catch (error) { /* память недоступна — не страшно */ }
}
const saved = loadSettings();
if (saved.driver) driverInput.value = saved.driver;
if (saved.closedSeconds) closedSelect.value = saved.closedSeconds;
if (typeof saved.phoneSound === "boolean") phoneSoundBox.checked = saved.phoneSound;
[driverInput, closedSelect, phoneSoundBox].forEach((el) => el.addEventListener("change", saveSettings));

// ---------- Журнал засыпаний ----------
const LOG_KEY = "dana_alarm_log";

function loadLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY)) || [];
  } catch (error) {
    return [];
  }
}

function saveLog(log) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(log));
  } catch (error) { /* память недоступна */ }
  logCountEl.textContent = `Записей о засыпании: ${log.length}`;
}

function onAlarmStart(ear) {
  const log = loadLog();
  log.push({
    start: new Date().toISOString(),
    end: "",
    driver: driverInput.value.trim(),
    eyesClosedSeconds: "",
    ear: ear == null ? "" : ear.toFixed(2),
    car: link.connected ? "да" : "нет",
  });
  saveLog(log);
}

function onAlarmEnd(duration) {
  const log = loadLog();
  const last = log[log.length - 1];
  if (last && !last.end) {
    last.end = new Date().toISOString();
    last.eyesClosedSeconds = duration.toFixed(1);
    saveLog(log);
  }
}

function exportLog() {
  const log = loadLog();
  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  // Первые 5 колонок как в v1 — admin.html открывает и этот файл
  const header = ["начало", "конец", "водитель", "закрыты_сек", "EAR", "машинка"];
  const rows = log.map((r) => [r.start, r.end, r.driver, r.eyesClosedSeconds, r.ear, r.car].map(quote).join(","));
  const csv = "﻿" + [header.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `dana_log_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$("export").addEventListener("click", exportLog);
$("clear").addEventListener("click", () => {
  if (confirm("Очистить журнал на этом телефоне?")) saveLog([]);
});
saveLog(loadLog());

// ---------- Машинка ESP32 по Bluetooth ----------
const link = new EspLink({
  onStatus(kind, text) {
    bleDot.className = "dot " + kind;
    bleText.textContent = text.replace(/^ESP32/, "Машинка");
    bleConnectBtn.textContent = kind === "off" ? "Подключить машинку" : "Отключить";
    bleTestBtn.disabled = kind !== "on" || running;
  },
});

if (!EspLink.supported()) {
  bleHint.hidden = false;
  bleHint.textContent = "Этот браузер не умеет Bluetooth. Android — откройте в Chrome. iPhone — в приложении Bluefy (Safari не поддерживает).";
  bleConnectBtn.disabled = true;
}

bleConnectBtn.addEventListener("click", async () => {
  if (link.device && !link.manualDisconnect) {
    await link.disconnect();
    return;
  }
  try {
    await link.connect();
  } catch (error) {
    link.device = null;
    bleConnectBtn.textContent = "Подключить машинку";
    bleDot.className = "dot";
    bleText.textContent = "Машинка: " + (error.name === "NotFoundError" ? "устройство не выбрано" : error.message);
  }
});

// Тест без камеры: машинка едет 3 секунды и плавно останавливается
let testUntil = 0;
bleTestBtn.addEventListener("click", () => {
  testUntil = Date.now() + 3000;
  link.send("0");
  setTimeout(() => {
    if (!running && Date.now() >= testUntil) link.send("S");
  }, 3100);
});

// ---------- Камера, модель, звук ----------
let audioCtx = null;
let phraseBuffer = null;
let landmarker = null;
let stream = null;
let wakeLock = null;
let monitor = null;
let running = false;
let lastVibrate = 0;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((error) => console.warn("sw.js:", error));
}

function setStatus(result) {
  statusEl.textContent = result.text;
  statusEl.className = result.cls;
  // Вибрация не чаще раза в секунду (в v1 вибрировало на каждом кадре)
  if (result.cls === "danger" && navigator.vibrate && Date.now() - lastVibrate > 1000) {
    navigator.vibrate(200);
    lastVibrate = Date.now();
  }
}

function setLoading(text) {
  statusEl.textContent = text;
  statusEl.className = "calib";
}

function withTimeout(promise, seconds, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${seconds} с`)), seconds * 1000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchWithProgress(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && !running) setLoading(`${label}: ${Math.round((received / total) * 100)}%`);
  }
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

let landmarkerPromise = null;
function preloadLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      setLoading("Загрузка библиотеки…");
      const vision = await withTimeout(FilesetResolver.forVisionTasks(WASM_URL), 60, "библиотека");
      const modelBuffer = await withTimeout(fetchWithProgress(MODEL_URL, "Модель"), 120, "модель");
      setLoading("Готовим распознавание…");
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: modelBuffer, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
      });
    })();
    landmarkerPromise.catch(() => {
      landmarkerPromise = null;
    });
  }
  return landmarkerPromise;
}

async function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  try {
    const response = await fetch("../phrase.wav");
    phraseBuffer = await audioCtx.decodeAudioData(await response.arrayBuffer());
  } catch (error) {
    console.warn("phrase.wav не загрузился, будут только сигналы:", error);
  }
}

// Звук на телефоне: если галочка снята, но машинка не подключена — всё равно звучит
function phoneSoundOn() {
  return phoneSoundBox.checked || !link.connected;
}

function playBeep(level) {
  if (navigator.vibrate) navigator.vibrate(300);
  if (!audioCtx || !phoneSoundOn()) return;
  const [freq, volume] = ALARM_LEVELS[level];
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.linearRampToValueAtTime(freq * 1.4, t + 0.9);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume * 0.5, t + 0.1);
  gain.gain.setValueAtTime(volume * 0.5, t + 0.8);
  gain.gain.linearRampToValueAtTime(0, t + 0.9);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.9);
}

function playPhrase() {
  if (!audioCtx || !phraseBuffer || !phoneSoundOn()) return;
  const src = audioCtx.createBufferSource();
  src.buffer = phraseBuffer;
  src.connect(audioCtx.destination);
  src.start();
}

async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (error) {
    console.warn("Экран не удалось оставить включённым:", error);
  }
}

function tick() {
  if (!running) return;
  if (video.readyState >= 2) {
    const now = performance.now() / 1000;
    const result = landmarker.detectForVideo(video, performance.now());
    const points = result.faceLandmarks && result.faceLandmarks[0];
    let state;
    if (!points) {
      state = monitor.updateNoFace(now);
    } else {
      const w = video.videoWidth;
      const h = video.videoHeight;
      const ear = (eyeRatio(points, LEFT_EYE, w, h) + eyeRatio(points, RIGHT_EYE, w, h)) / 2;
      state = monitor.updateFace(points, ear, now);
      infoEl.textContent = `EAR ${ear.toFixed(2)}  порог ${monitor.threshold ? monitor.threshold.toFixed(2) : "…"}  моргания/мин ${monitor.blinksPerMinute(now)}`;
    }
    setStatus(state);
    link.send(commandFor(state));
  }
  requestAnimationFrame(tick);
}

async function start() {
  startBtn.disabled = true;
  bleTestBtn.disabled = true;
  setLoading("Камера и звук…");
  try {
    await initAudio();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    video.srcObject = stream;
    await video.play();

    landmarker = await preloadLandmarker();
    setLoading("Готово, смотрите в камеру…");

    monitor = new DrowsinessMonitor({
      calibSeconds: 5,
      closedSeconds: Number(closedSelect.value) || 2.0,
      onBeep: playBeep,
      onSpeak: playPhrase,
      onAlarmStart,
      onAlarmEnd,
    });

    await keepScreenOn();
    running = true;
    stopBtn.disabled = false;
    closedSelect.disabled = true;
    requestAnimationFrame(tick);
  } catch (error) {
    statusEl.textContent = "Ошибка: " + error.message;
    statusEl.className = "danger";
    startBtn.disabled = false;
    bleTestBtn.disabled = !link.connected;
  }
}

function stop() {
  running = false;
  if (monitor) monitor.stop(performance.now() / 1000);
  link.send("S");
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
  if (audioCtx) audioCtx.close();
  audioCtx = null;
  stopBtn.disabled = true;
  startBtn.disabled = false;
  closedSelect.disabled = false;
  bleTestBtn.disabled = !link.connected;
  statusEl.textContent = "Остановлено";
  statusEl.className = "calib";
  infoEl.textContent = "";
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);

document.addEventListener("visibilitychange", () => {
  if (!running) return;
  if (document.visibilityState === "visible") {
    keepScreenOn();
  } else {
    // Страница ушла в фон — камера не работает, машинке безопаснее остановиться
    link.send("S");
  }
});

preloadLandmarker()
  .then(() => {
    if (!startBtn.disabled) setLoading("Готово: нажмите «Старт»");
  })
  .catch((error) => {
    statusEl.textContent = "Загрузка не удалась, нажмите «Старт» для повтора: " + error.message;
    statusEl.className = "danger";
  });
