/**
 * Digital leveler app: connects to the Arduino (or the demo), mirrors the
 * five LEDs and draws the vial and bullseye from the streamed angles.
 */
import { parseLine } from './parser.js';
import { SerialSource, isSerialSupported, describeConnectError } from './serial.js';
import { DemoSource } from './demo.js';
import { Vial, Bullseye, tickEase } from './gauges.js';

const MAX_LOG_LINES = 300;
const $ = (id) => document.getElementById(id);

const ui = {
  baud: $('baud'), connect: $('btn-connect'), demo: $('demo-toggle'),
  status: $('status'), statusText: $('status-text'), banner: $('unsupported'),
  angle: $('angle'), hint: $('angle-hint'), badge: $('level-badge'), axisLabel: $('axis-label'),
  leds: [...document.querySelectorAll('#leds .led')],
  roll: $('roll'), pitch: $('pitch'), rate: $('rate'),
  tol: $('tol'), range: $('range'), axisButtons: [...document.querySelectorAll('[data-axis]')],
  invert: $('btn-invert'), log: $('log'),
};

const vial = new Vial($('vial'));
const bullseye = new Bullseye($('bullseye'));

const state = {
  source: null,
  status: 'idle',
  cfg: { axis: 'roll', tol: 0.5, range: 10, invert: 0, rate: 25 },
  latest: null,
  dirty: false,
  arrivals: 0,
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
  if (msg.type === 'data') {
    state.latest = msg;
    state.dirty = true;
    state.arrivals++;
    if (state.status !== 'live' && state.status !== 'demo') streamingStatus();
  } else if (msg.type === 'config') {
    applyConfig(msg);
  } else if (msg.type === 'log') {
    log(msg.level, msg.text);
    if (/^Calibrating/.test(msg.text)) setStatus('busy', 'Calibrating… keep still');
    else if (msg.level === 'ready') streamingStatus();
    else if (msg.level === 'error' && /not found|I2C/.test(msg.text)) setStatus('error', 'Sensor not found');
  }
}

function applyConfig(c) {
  Object.assign(state.cfg, Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'type')));
  const { axis, tol, range, invert } = state.cfg;
  ui.axisLabel.textContent = `${axis} axis`;
  for (const b of ui.axisButtons) b.classList.toggle('active', b.dataset.axis === axis);
  ui.tol.value = tol.toFixed(1);
  ui.range.value = String(range);
  ui.invert.classList.toggle('active', invert === 1);
  ui.hint.textContent = `Tilt within ±${tol.toFixed(1)}° counts as level · full scale ±${range}°`;
}

// --- Sources ---------------------------------------------------------------

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
    if (reason) { log('error', reason); setStatus('error', 'Connection failed'); }
    else setStatus('idle', 'Disconnected');
    return;
  }
  state.source = src;
  state.latest = null;
  setStatus('busy', 'Waiting for device…');
  log('app', 'Connected. The Uno restarts on connect: the LEDs sweep, then it calibrates (keep still).');
  refreshControls();
}

function onSerialClosed(src, { unexpected, error }) {
  if (state.source !== src) return;
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
  state.latest = null;
  ui.demo.checked = true;
  setStatus('busy', 'Starting demo…');
  log('app', 'Demo mode: simulated sensor and LEDs, no hardware needed.');
  refreshControls();
  src.start();
}

async function send(cmd) {
  if (!state.source) return;
  log('app', `> ${cmd}`);
  try { await state.source.send(cmd); } catch (err) { log('error', `Could not send "${cmd}": ${err.message}`); }
}

// --- Controls --------------------------------------------------------------

function refreshControls() {
  const isSerial = state.source?.kind === 'serial';
  ui.connect.textContent = isSerial ? 'Disconnect' : 'Connect';
  ui.connect.classList.toggle('connected', isSerial);
  for (const el of document.querySelectorAll('[data-needs-source]')) el.disabled = !state.source;
}

ui.connect.addEventListener('click', () => (state.source?.kind === 'serial' ? closeSource() : connectSerial()));
ui.demo.addEventListener('change', () => (ui.demo.checked ? startDemo() : closeSource()));
$('banner-demo').addEventListener('click', startDemo);
$('btn-level').addEventListener('click', () => send('L'));
$('btn-clear').addEventListener('click', () => send('X'));
$('btn-cal').addEventListener('click', () => send('C'));
ui.invert.addEventListener('click', () => send('I'));
for (const b of ui.axisButtons) b.addEventListener('click', () => send(b.dataset.axis === 'pitch' ? 'AP' : 'AR'));
ui.tol.addEventListener('change', () => send(`T${ui.tol.value}`));
ui.range.addEventListener('change', () => send(`S${ui.range.value}`));
$('btn-clear-log').addEventListener('click', () => ui.log.replaceChildren());

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
  const key = e.key.toLowerCase();
  if (key === 'd') { state.source?.kind === 'demo' ? closeSource() : startDemo(); return; }
  if (!state.source) return;
  const cmd = { l: 'L', x: 'X', a: 'A', i: 'I', c: 'C' }[key];
  if (cmd) send(cmd);
});

// --- Render loop -----------------------------------------------------------

const fmt = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}°`;
let lastText = 0;

function frame(now) {
  const s = state.latest;
  if (s && state.dirty) {
    state.dirty = false;
    const { tol, range } = state.cfg;
    vial.set(s.angle, tol, range);
    bullseye.set(s.roll, s.pitch, tol, range);
    s.leds.forEach((v, i) => ui.leds[i].style.setProperty('--b', (v / 255).toFixed(3)));
  }
  if (s && now - lastText >= 100) {
    lastText = now;
    ui.angle.textContent = fmt(s.angle, Math.abs(s.angle) < 10 ? 2 : 1);
    ui.angle.dataset.level = s.level;
    ui.roll.textContent = fmt(s.roll);
    ui.pitch.textContent = fmt(s.pitch);
    ui.badge.textContent = s.level ? 'LEVEL' : s.angle > 0 ? 'TILT →' : '← TILT';
    ui.badge.dataset.level = s.level;
  }
  tickEase(now);
  vial.draw();
  bullseye.draw();
  requestAnimationFrame(frame);
}

setInterval(() => {
  ui.rate.textContent = `${state.arrivals} Hz`;
  state.arrivals = 0;
}, 1000);

// --- Startup ---------------------------------------------------------------

function init() {
  refreshControls();
  applyConfig({});
  if (!isSerialSupported()) {
    ui.banner.hidden = false;
    ui.connect.disabled = true;
    log('warn', 'Web Serial is not supported in this browser. Use Chrome or Edge, or Demo mode.');
    startDemo();
  } else if (new URLSearchParams(location.search).has('demo')) {
    startDemo();
  } else {
    log('app', 'Ready. Click Connect to pick your Arduino port, or switch on Demo (D).');
  }
  requestAnimationFrame(frame);
}

init();
