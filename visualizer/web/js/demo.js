/**
 * Demo mode: a simulated MPU6050 that speaks the same serial protocol as the
 * firmware (same lines, same commands), so the rest of the app cannot tell
 * the difference. Useful for the GitHub Pages demo and for testing.
 */

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;
const CAL_TIME_MS = 1200;
const YAW_DRIFT_DPS = 0.05;   // mimics the real gyro's slow yaw drift

/** Smooth, endlessly varying "hand-held" motion, in degrees. */
function motion(t) {
  return {
    roll:  35 * Math.sin(TWO_PI * 0.11 * t) + 8 * Math.sin(TWO_PI * 0.53 * t + 0.7),
    pitch: 25 * Math.sin(TWO_PI * 0.07 * t + 1) + 5 * Math.sin(TWO_PI * 0.41 * t),
    yaw:   70 * Math.sin(TWO_PI * 0.035 * t) + 25 * Math.sin(TWO_PI * 0.17 * t + 2) + YAW_DRIFT_DPS * t,
  };
}

/** Standard normal noise (Box-Muller). */
function gauss() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(TWO_PI * Math.random());
}

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Build one simulated sample at time t (seconds). */
function simulate(t) {
  const h = 1e-3;
  const a = motion(t);
  const b = motion(t + h);
  const dRoll = (b.roll - a.roll) / h;
  const dPitch = (b.pitch - a.pitch) / h;
  const dYaw = (b.yaw - a.yaw) / h;

  const sr = Math.sin(a.roll * DEG), cr = Math.cos(a.roll * DEG);
  const sp = Math.sin(a.pitch * DEG), cp = Math.cos(a.pitch * DEG);

  return {
    // Gravity seen in the sensor frame (Z up when flat), plus noise.
    ax: -sp + 0.008 * gauss(),
    ay: cp * sr + 0.008 * gauss(),
    az: cp * cr + 0.008 * gauss(),
    // Euler-angle rates converted to body rates (ZYX convention), plus noise.
    gx: dRoll - dYaw * sp + 0.25 * gauss(),
    gy: dPitch * cr + dYaw * cp * sr + 0.25 * gauss(),
    gz: -dPitch * sr + dYaw * cp * cr + 0.25 * gauss(),
    ...a,
    temp: 28.4 + 0.3 * Math.sin(t / 60),
  };
}

export class DemoSource {
  constructor({ onLine }) {
    this.kind = 'demo';
    this.onLine = onLine;
    this.rateHz = 50;
    this.yawOffset = 0;
    this.t0 = performance.now();
    this.timer = null;
    this.timeouts = new Set();
  }

  start() {
    this.#emit('# mpu6050_stream v1.0 (demo: simulated sensor)');
    this.#emit('# FORMAT D,t_ms,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,roll_deg,pitch_deg,yaw_deg,temp_c');
    this.#emit('# Commands: C=calibrate Z=zero yaw R<hz>=rate (1-100) ?=status');
    this.#emit('# MPU6050 found');
    this.#calibrate();
  }

  /** Same commands as the firmware. */
  send(command) {
    const op = command.charAt(0).toUpperCase();
    const arg = command.slice(1);
    if (op === 'C') this.#calibrate(() => this.#emit('#OK C'));
    else if (op === 'Z') this.#zeroYaw();
    else if (op === 'R') this.#setRate(arg);
    else if (op === '?') this.#emit(`#INFO sensor=demo rate_hz=${this.rateHz} filter_hz=200 alpha=0.98`);
    else this.#emit(`#ERROR Unknown command '${command}'. Use C, Z, R<hz> or ?`);
    return Promise.resolve();
  }

  close() {
    clearInterval(this.timer);
    this.timeouts.forEach(clearTimeout);
    this.timeouts.clear();
    return Promise.resolve();
  }

  #now() {
    return performance.now() - this.t0;
  }

  #emit(line) {
    this.onLine(line);
  }

  #later(ms, fn) {
    const id = setTimeout(() => { this.timeouts.delete(id); fn(); }, ms);
    this.timeouts.add(id);
  }

  #calibrate(after) {
    clearInterval(this.timer);
    this.#emit('# Calibrating gyro, keep the sensor still (1/3)');
    this.#later(CAL_TIME_MS, () => {
      this.#emit('# Calibration done, bias_dps=0.00,0.00,0.00 noise_dps=0.25');
      this.#emit('#READY');
      after?.();
      this.#startStream();
    });
  }

  #zeroYaw() {
    this.yawOffset = motion(this.#now() / 1000).yaw;
    this.#emit('#OK Z');
  }

  #setRate(arg) {
    const hz = /^\d+$/.test(arg) ? Number(arg) : NaN;
    if (!(hz >= 1 && hz <= 100)) {
      this.#emit('#ERROR R expects a rate of 1-100 Hz, e.g. R50');
      return;
    }
    this.rateHz = hz;
    this.#startStream();
    this.#emit(`#OK R${hz}`);
  }

  #startStream() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.#tick(), 1000 / this.rateHz);
  }

  #tick() {
    const tMs = this.#now();
    const s = simulate(tMs / 1000);
    const yaw = wrap180(s.yaw - this.yawOffset);
    const f = (v, d) => v.toFixed(d);
    this.#emit(
      `D,${Math.round(tMs)},${f(s.ax, 3)},${f(s.ay, 3)},${f(s.az, 3)},` +
      `${f(s.gx, 2)},${f(s.gy, 2)},${f(s.gz, 2)},` +
      `${f(wrap180(s.roll), 2)},${f(s.pitch, 2)},${f(yaw, 2)},${f(s.temp, 1)}`
    );
  }
}
