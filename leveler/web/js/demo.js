/**
 * Demo mode: a simulated leveler that speaks the same protocol and accepts
 * the same commands as the firmware, including the LED "bubble" logic.
 */

const TWO_PI = 2 * Math.PI;
const HYSTERESIS = 1.15;

/** Someone slowly adjusting a shelf: drifts through level and pauses near it. */
function motion(t) {
  const settle = Math.sin(TWO_PI * 0.045 * t);
  return {
    roll:  7 * settle * Math.abs(settle) + 1.2 * Math.sin(TWO_PI * 0.23 * t) + 0.04 * gauss(),
    pitch: 3.5 * Math.sin(TWO_PI * 0.03 * t + 1.3) + 0.6 * Math.sin(TWO_PI * 0.17 * t) + 0.04 * gauss(),
  };
}

function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(TWO_PI * Math.random());
}

/** Same LED mapping as updateLeds() in the firmware. */
export function bubbleLeds(angle, tol, range, wasLevel, nowMs) {
  const mag = Math.abs(angle);
  if (range <= tol) range = tol + 1;
  const level = wasLevel ? mag <= tol * HYSTERESIS : mag <= tol;
  const v = [0, 0, 0, 0, 0];
  if (level) {
    v[2] = 255;
  } else if (mag >= range) {
    v[angle > 0 ? 4 : 0] = Math.floor(nowMs / 125) % 2 ? 255 : 0;
  } else {
    const m = Math.max(0, (mag - tol) / (range - tol));
    const pos = Math.sign(angle) * (0.5 + 1.5 * m);
    for (let i = 0; i < 5; i++) {
      const w = 1 - Math.abs(pos - (i - 2));
      if (w > 0) v[i] = Math.round(255 * w * w);
    }
  }
  return { level, leds: v };
}

export class DemoSource {
  constructor({ onLine }) {
    this.kind = 'demo';
    this.onLine = onLine;
    this.cfg = { axis: 'roll', tol: 0.5, range: 10, invert: 0, rate: 25 };
    this.zero = { roll: 0, pitch: 0 };
    this.level = false;
    this.t0 = performance.now();
    this.timer = null;
    this.timeouts = new Set();
  }

  start() {
    this.#emit('# mpu6050_leveler v1.0 (demo: simulated sensor)');
    this.#emit('# FORMAT V,t_ms,roll_deg,pitch_deg,angle_deg,level,led1,led2,led3,led4,led5');
    this.#config();
    this.#emit('# MPU6050 found');
    this.#calibrate();
  }

  send(command) {
    const cmd = command.trim().toUpperCase();
    const op = cmd.charAt(0);
    const arg = cmd.slice(1);
    const raw = motion(this.#now() / 1000);

    if (op === 'C') this.#calibrate(() => this.#emit('#OK C'));
    else if (op === 'L') { this.zero = raw; this.#ok('L level reference saved'); }
    else if (op === 'X') { this.zero = { roll: 0, pitch: 0 }; this.#ok('X level reference cleared'); }
    else if (op === 'A') {
      if (arg === 'R') this.cfg.axis = 'roll';
      else if (arg === 'P') this.cfg.axis = 'pitch';
      else if (arg === '') this.cfg.axis = this.cfg.axis === 'roll' ? 'pitch' : 'roll';
      else return this.#err('A, AR or AP');
      this.#ok('A');
    } else if (op === 'I') { this.cfg.invert ^= 1; this.#ok('I'); }
    else if (op === 'T') {
      const v = Number(arg);
      if (!/^\d*\.?\d?$/.test(arg) || !(v >= 0.1 && v <= 5)) return this.#err('T expects 0.1-5.0 deg, e.g. T0.5');
      this.cfg.tol = Math.round(v * 10) / 10;
      this.#ok('T');
    } else if (op === 'S') {
      const v = /^\d+$/.test(arg) ? Number(arg) : NaN;
      if (!(v >= 2 && v <= 45)) return this.#err('S expects 2-45 deg, e.g. S10');
      this.cfg.range = v;
      this.#ok('S');
    } else if (op === 'R') {
      const v = /^\d+$/.test(arg) ? Number(arg) : NaN;
      if (!(v >= 1 && v <= 50)) return this.#err('R expects 1-50 Hz, e.g. R25');
      this.cfg.rate = v;
      this.#startStream();
      this.#ok('R');
    } else if (op === '?') {
      this.#emit(`#INFO sensor=demo zero_roll=${this.zero.roll.toFixed(2)} zero_pitch=${this.zero.pitch.toFixed(2)}`);
      this.#config();
    } else {
      this.#err(`Unknown command '${command}'. Use C, L, X, A, I, T<deg>, S<deg>, R<hz> or ?`);
    }
    return Promise.resolve();
  }

  close() {
    clearInterval(this.timer);
    this.timeouts.forEach(clearTimeout);
    this.timeouts.clear();
    return Promise.resolve();
  }

  #now() { return performance.now() - this.t0; }
  #emit(line) { this.onLine(line); }
  #err(text) { this.#emit(`#ERROR ${text}`); return Promise.resolve(); }
  #ok(what) { this.#emit(`#OK ${what}`); this.#config(); }

  #config() {
    const c = this.cfg;
    this.#emit(`#CFG axis=${c.axis} tol=${c.tol.toFixed(1)} range=${c.range} invert=${c.invert} rate=${c.rate}`);
  }

  #calibrate(after) {
    clearInterval(this.timer);
    this.#emit('# Calibrating gyro, keep the sensor still (1/3)');
    const id = setTimeout(() => {
      this.timeouts.delete(id);
      this.#emit('# Calibration done, noise_dps=0.21');
      this.#emit('#READY');
      after?.();
      this.#startStream();
    }, 1000);
    this.timeouts.add(id);
  }

  #startStream() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.#tick(), 1000 / this.cfg.rate);
  }

  #tick() {
    const tMs = this.#now();
    const m = motion(tMs / 1000);
    const roll = m.roll - this.zero.roll;
    const pitch = m.pitch - this.zero.pitch;
    let angle = this.cfg.axis === 'pitch' ? pitch : roll;
    if (this.cfg.invert) angle = -angle;

    const { level, leds } = bubbleLeds(angle, this.cfg.tol, this.cfg.range, this.level, tMs);
    this.level = level;
    this.#emit(`V,${Math.round(tMs)},${roll.toFixed(2)},${pitch.toFixed(2)},${angle.toFixed(2)},${level ? 1 : 0},${leds.join(',')}`);
  }
}
