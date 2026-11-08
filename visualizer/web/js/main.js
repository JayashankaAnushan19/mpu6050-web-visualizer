/**
 * App entry point: wires the data source (serial or demo) to the parser,
 * the 3D view, horizon, readouts, charts, recorder and log.
 *
 * Data flow:  source --lines--> parseLine --samples--> state + charts
 * Rendering:  requestAnimationFrame loop reads the latest state, so drawing
 *             is decoupled from the serial data rate.
 */
import { parseLine } from './parser.js';
import { SerialSource, isSerialSupported, describeConnectError } from './serial.js';
import { DemoSource } from './demo.js';
import { BoardScene } from './scene3d.js';
import { Horizon } from './horizon.js';
import { TimeChart } from './charts.js';
import { Recorder } from './recorder.js';

const AXIS_COLORS = ['#ff5c5c', '#4cd97b', '#4da3ff'];
const READOUT_INTERVAL_MS = 100;   // numbers stay readable at 10 updates/s
const CHART_INTERVAL_MS = 33;      // ~30 fps chart redraws
const MAX_LOG_LINES = 300;

const $ = (id) => document.getElementById(id);
const ui = {
  baud: $('baud'), connect: $('btn-connect'), demo: $('demo-toggle'),
  status: $('status'), statusText: $('status-text'), banner: $('unsupported'),
  cal: $('btn-cal'), zero: $('btn-zero'), pause: $('btn-pause'), rec: $('btn-rec'),
  recLabel: $('rec-label'), outRate: $('out-rate'), log: $('log'),
  pausedBadge: $('paused-badge'), rate: $('rate'), temp: $('temp'),
  samples: $('stat-samples'), bad: $('stat-bad'), time: $('stat-time'),
  ov: { roll: $('ov-roll'), pitch: $('ov-pitch'), yaw: $('ov-yaw') },
  values: Object.fromEntries(['ax', 'ay', 'az', 'gx', 'gy', 'gz'].map((k) => [k, $(k)])),
};

const scene = new BoardScene($('scene'));
const horizon = new Horizon($('horizon'));
const accelChart = new TimeChart($('chart-accel'), { colors: AXIS_COLORS, minRange: 1.2, decimals: 3 });
const gyroChart = new TimeChart($('chart-gyro'), { colors: AXIS_COLORS, minRange: 60, decimals: 1 });
const recorder = new Recorder();

const state = {
  source: null,        // SerialSource | DemoSource | null
  status: 'idle',
  paused: false,
  latest: null,        // most recent sample shown
  dirty: false,        // latest changed since last frame
  samples: 0,
  bad: 0,
  lastT: null,
  arrivals: 0,         // samples in the current 1 s window (for Hz display)
};

// --- Status & log ----------------------------------------------------------

function setStatus(kind, text) {
  state.status = kind;
  ui.status.dataset.state = kind;
  ui.statusText.textContent = text;
}

function streamingStatus() {
  if (state.source?.kind === 'demo') setStatus('demo', 'Demo · simulated');
  else setStatus('live', 'Streaming');
}

function log(level, text) {
  const li = document.createElement('li');
  li.className = `lvl-${level === 'ready' ? 'ok' : level}`;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  li.append(time, document.createTextNode(text));
  ui.log.append(li);
  while (ui.log.childElementCount > MAX_LOG_LINES) ui.log.firstElementChild.remove();
  ui.log.scrollTop = ui.log.scrollHeight;
}

// --- Incoming data ---------------------------------------------------------

function handleLine(line) {
  const msg = parseLine(line);
  if (!msg) return;
  if (msg.type === 'data') handleSample(msg);
  else if (msg.type === 'log') handleDeviceLog(msg);
  else state.bad++;
}

function handleDeviceLog({ level, text }) {
  log(level, text);
  if (/^Calibrating/.test(text)) {
    setStatus('busy', 'Calibrating… keep still');
  } else if (level === 'ready') {
    streamingStatus();
    // The Uno resets to 50 Hz on connect; re-apply the chosen rate.
    if (ui.outRate.value !== '50') sendCommand(`R${ui.outRate.value}`, { quiet: true });
  } else if (level === 'error' && /not found|I2C/.test(text)) {
    setStatus('error', 'Sensor not found');
  }
}

function handleSample(s) {
  // Device time jumping backwards means the board restarted.
  if (state.lastT !== null && s.t < state.lastT - 500) {
    accelChart.clear();
    gyroChart.clear();
    log('app', 'Device restarted');
  }
  state.lastT = s.t;
  state.samples++;
  state.arrivals++;
  if (state.status !== 'live' && state.status !== 'demo') streamingStatus();

  recorder.add(s);
  if (state.paused) return;

  state.latest = s;
  state.dirty = true;
  const t = s.t / 1000;
  accelChart.push(t, s.ax, s.ay, s.az);
  gyroChart.push(t, s.gx, s.gy, s.gz);
}

// --- Sources ---------------------------------------------------------------

function resetSession() {
  accelChart.clear();
  gyroChart.clear();
  Object.assign(state, { samples: 0, bad: 0, lastT: null, arrivals: 0, latest: null });
}

async function closeSource() {
  const src = state.source;
  state.source = null;
  if (src) await src.close();
  ui.demo.checked = false;
  setStatus('idle', 'Disconnected');
  refreshControls();
}

async function connectSerial() {
  await closeSource();
  setStatus('busy', 'Choose a port…');

  const src = new SerialSource({ onLine: handleLine, onClose: (info) => onSerialClosed(src, info) });
  try {
    await src.connect(Number(ui.baud.value));
  } catch (err) {
    const reason = describeConnectError(err);
    if (reason) {
      log('error', reason);
      setStatus('error', 'Connection failed');
    } else {
      setStatus('idle', 'Disconnected');
    }
    return;
  }

  state.source = src;
  resetSession();
  setStatus('busy', 'Waiting for device…');
  log('app', `Connected at ${ui.baud.value} baud. The Uno restarts on connect: keep the sensor still while it calibrates.`);
  refreshControls();
}

function onSerialClosed(src, { unexpected, error }) {
  if (state.source !== src) return;            // closed on purpose, already handled
  state.source = null;
  if (unexpected) {
    log('error', `Serial connection lost${error ? ` (${error.message})` : ''}. Check the USB cable, then connect again.`);
    setStatus('error', 'Device disconnected');
  } else {
    setStatus('idle', 'Disconnected');
  }
  refreshControls();
}

async function startDemo() {
  await closeSource();
  const src = new DemoSource({ onLine: handleLine });
  state.source = src;
  resetSession();
  ui.demo.checked = true;
  setStatus('busy', 'Starting demo…');
  log('app', 'Demo mode: simulated sensor data, no hardware needed.');
  refreshControls();
  src.start();
  if (ui.outRate.value !== '50') src.send(`R${ui.outRate.value}`);
}

async function sendCommand(cmd, { quiet = false } = {}) {
  if (!state.source) return;
  if (!quiet) log('app', `> ${cmd}`);
  try {
    await state.source.send(cmd);
  } catch (err) {
    log('error', `Could not send "${cmd}": ${err.message}`);
  }
}

// --- Controls --------------------------------------------------------------

function refreshControls() {
  const isSerial = state.source?.kind === 'serial';
  ui.connect.textContent = isSerial ? 'Disconnect' : 'Connect';
  ui.connect.classList.toggle('connected', isSerial);
  for (const el of document.querySelectorAll('[data-needs-source]')) {
    el.disabled = !state.source && !(el === ui.rec && recorder.active);
  }
}

function togglePause() {
  state.paused = !state.paused;
  ui.pause.classList.toggle('active', state.paused);
  ui.pause.firstChild.textContent = state.paused ? 'Resume ' : 'Pause ';
  ui.pausedBadge.hidden = !state.paused;
  if (!state.paused) {
    accelChart.markGap();
    gyroChart.markGap();
  }
}

function toggleRecording() {
  if (!recorder.active) {
    recorder.start();
    ui.rec.classList.add('recording');
    log('app', 'Recording started');
  } else {
    const n = recorder.stop();
    ui.rec.classList.remove('recording');
    ui.recLabel.textContent = 'Record';
    if (n) {
      recorder.download();
      log('ok', `Saved ${n} samples to CSV`);
    } else {
      log('app', 'Recording stopped: no samples captured');
    }
  }
  refreshControls();
}

function toggleDemo() {
  if (state.source?.kind === 'demo') closeSource();
  else startDemo();
}

ui.connect.addEventListener('click', () => (state.source?.kind === 'serial' ? closeSource() : connectSerial()));
ui.demo.addEventListener('change', () => (ui.demo.checked ? startDemo() : closeSource()));
$('banner-demo').addEventListener('click', startDemo);
ui.cal.addEventListener('click', () => sendCommand('C'));
ui.zero.addEventListener('click', () => sendCommand('Z'));
ui.pause.addEventListener('click', togglePause);
ui.rec.addEventListener('click', toggleRecording);
ui.outRate.addEventListener('change', () => sendCommand(`R${ui.outRate.value}`));
$('btn-clear-log').addEventListener('click', () => ui.log.replaceChildren());

// Keyboard shortcuts (ignored while typing in a form control).
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
  const key = e.key.toLowerCase();
  if (key === ' ') { e.preventDefault(); togglePause(); }
  else if (key === 'c' && state.source) sendCommand('C');
  else if (key === 'z' && state.source) sendCommand('Z');
  else if (key === 'd') toggleDemo();
});

// --- Render loop -----------------------------------------------------------

const fmt = (v, d) => (v >= 0 ? '+' : '') + v.toFixed(d);
let lastReadout = 0;
let lastChart = 0;

function updateReadouts(s) {
  for (const k of ['ax', 'ay', 'az']) ui.values[k].textContent = fmt(s[k], 3);
  for (const k of ['gx', 'gy', 'gz']) ui.values[k].textContent = fmt(s[k], 2);
  ui.ov.roll.textContent = `${fmt(s.roll, 1)}°`;
  ui.ov.pitch.textContent = `${fmt(s.pitch, 1)}°`;
  ui.ov.yaw.textContent = `${fmt(s.yaw, 1)}°`;
  ui.temp.textContent = `${s.temp.toFixed(1)} °C`;
  ui.time.textContent = `${(s.t / 1000).toFixed(1)} s`;
}

function frame(now) {
  const s = state.latest;
  if (state.dirty && s) {
    scene.setAttitude(s.roll, s.pitch, s.yaw);
    horizon.setTarget(s.roll, s.pitch);
    state.dirty = false;
  }
  scene.render();
  horizon.draw();

  if (now - lastReadout >= READOUT_INTERVAL_MS) {
    lastReadout = now;
    if (s) updateReadouts(s);
    ui.samples.textContent = state.samples.toLocaleString();
    ui.bad.textContent = state.bad;
    if (recorder.active) ui.recLabel.textContent = `Stop · ${recorder.count.toLocaleString()}`;
  }
  if (now - lastChart >= CHART_INTERVAL_MS) {
    lastChart = now;
    accelChart.update();
    gyroChart.update();
  }
  requestAnimationFrame(frame);
}

setInterval(() => {
  ui.rate.textContent = `${state.arrivals} Hz`;
  state.arrivals = 0;
}, 1000);

// --- Startup ---------------------------------------------------------------

function init() {
  refreshControls();
  const wantDemo = new URLSearchParams(location.search).has('demo');
  if (!isSerialSupported()) {
    ui.banner.hidden = false;
    ui.connect.disabled = true;
    ui.connect.title = 'Web Serial requires desktop Chrome or Edge';
    log('warn', 'Web Serial is not supported in this browser. Use Chrome or Edge, or Demo mode.');
    startDemo();
  } else if (wantDemo) {
    startDemo();
  } else {
    log('app', 'Ready. Click Connect to pick your Arduino port, or switch on Demo (D).');
  }
  requestAnimationFrame(frame);
}

init();
