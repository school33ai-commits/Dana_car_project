// Подключение к камере, MediaPipe, звуку и экрану телефона.
import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
import { DrowsinessMonitor, eyeRatio, LEFT_EYE, RIGHT_EYE, ALARM_LEVELS } from "./monitor.js";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

const video = document.getElementById("video");
const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");

let audioCtx = null;
let phraseBuffer = null;
let landmarker = null;
let stream = null;
let wakeLock = null;
let monitor = null;
let running = false;

function setStatus(result) {
  statusEl.textContent = result.text;
  statusEl.className = result.cls;
  if (result.cls === "danger" && navigator.vibrate) navigator.vibrate(200);
}

async function initAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const response = await fetch("phrase.wav");
  phraseBuffer = await audioCtx.decodeAudioData(await response.arrayBuffer());
}

// Сигнал, который с каждым уровнем выше и громче.
function playBeep(level) {
  if (!audioCtx) return;
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
  if (navigator.vibrate) navigator.vibrate(300);
}

function playPhrase() {
  if (!audioCtx || !phraseBuffer) return;
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

// Ждём не дольше seconds секунд, иначе показываем ошибку вместо вечной загрузки
function withTimeout(promise, seconds, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${seconds} с`)), seconds * 1000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function setLoading(text) {
  statusEl.textContent = text;
  statusEl.className = "calib";
}

async function createLandmarker() {
  setLoading("Шаг 2/3: загрузка распознавания лица…");
  const vision = await withTimeout(FilesetResolver.forVisionTasks(WASM_URL), 60, "загрузка библиотеки");
  setLoading("Шаг 3/3: загрузка модели лица (около 4 МБ)…");
  // Процессор работает на всех телефонах надёжно, GPU на части iPhone зависает
  return await withTimeout(
    FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      runningMode: "VIDEO",
      numFaces: 1,
    }),
    90,
    "загрузка модели"
  );
}

function tick() {
  if (!running) return;
  if (video.readyState >= 2) {
    const now = performance.now() / 1000;
    const result = landmarker.detectForVideo(video, performance.now());
    const points = result.faceLandmarks && result.faceLandmarks[0];
    if (!points) {
      setStatus(monitor.updateNoFace(now));
    } else {
      const w = video.videoWidth;
      const h = video.videoHeight;
      const ear = (eyeRatio(points, LEFT_EYE, w, h) + eyeRatio(points, RIGHT_EYE, w, h)) / 2;
      setStatus(monitor.updateFace(points, ear, now));
      infoEl.textContent = `EAR ${ear.toFixed(2)}  порог ${monitor.threshold ? monitor.threshold.toFixed(2) : "…"}  моргания/мин ${monitor.blinksPerMinute(now)}`;
    }
  }
  requestAnimationFrame(tick);
}

async function start() {
  startBtn.disabled = true;
  setLoading("Шаг 1/3: камера и звук…");
  try {
    // Звук нужно запускать по нажатию (ограничение телефонов)
    await initAudio();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    landmarker = await createLandmarker();
    setLoading("Готово, смотрите в камеру…");

    monitor = new DrowsinessMonitor({
      calibSeconds: 5,
      closedSeconds: 2.0,
      onBeep: playBeep,
      onSpeak: playPhrase,
    });

    await keepScreenOn();
    running = true;
    stopBtn.disabled = false;
    requestAnimationFrame(tick);
  } catch (error) {
    statusEl.textContent = "Ошибка: " + error.message;
    statusEl.className = "danger";
    startBtn.disabled = false;
  }
}

function stop() {
  running = false;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (wakeLock) wakeLock.release();
  if (audioCtx) audioCtx.close();
  stopBtn.disabled = true;
  startBtn.disabled = false;
  statusEl.textContent = "Остановлено";
  statusEl.className = "calib";
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);

// Экран при возврате в приложение: удержать блокировку снова
document.addEventListener("visibilitychange", () => {
  if (running && document.visibilityState === "visible") keepScreenOn();
});
