/**
 * Artificial horizon (attitude indicator) drawn on a 2D canvas.
 *
 * Sign conventions follow the firmware: +roll lifts the board's Y side
 * (banks toward -Y), +pitch tips the X end down. With X treated as "forward",
 * the horizon rotates by -roll and moves up when the nose goes down.
 */
const DEG = Math.PI / 180;
const SMOOTHING = 0.3;
const COLORS = {
  skyTop: '#1d4f91', skyBottom: '#3d7fd0',
  groundTop: '#7a4d22', groundBottom: '#4a2d12',
  line: '#ffffff', aircraft: '#fbbf24', bezel: '#232d3b', text: '#c9d4e0',
};

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export class Horizon {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.roll = 0;
    this.pitch = 0;
    this.targetRoll = 0;
    this.targetPitch = 0;
    this.needsPaint = true;
    new ResizeObserver(() => this.#resize()).observe(canvas);
    this.#resize();
  }

  setTarget(roll, pitch) {
    this.targetRoll = roll;
    this.targetPitch = pitch;
  }

  /** Call once per animation frame; repaints only when something changed. */
  draw() {
    const dRoll = wrap180(this.targetRoll - this.roll);
    const dPitch = this.targetPitch - this.pitch;
    if (!this.needsPaint && Math.abs(dRoll) < 0.01 && Math.abs(dPitch) < 0.01) return;
    this.roll = wrap180(this.roll + dRoll * SMOOTHING);
    this.pitch += dPitch * SMOOTHING;
    this.needsPaint = false;
    this.#paint();
  }

  #resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.needsPaint = true;
  }

  #paint() {
    const { ctx, dpr } = this;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.44;
    const ppd = r / 40;                       // pixels per degree of pitch

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, w, h);

    // Moving part: sky, ground, pitch ladder, roll pointer
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-this.roll * DEG);
    ctx.translate(0, -this.pitch * ppd);
    this.#drawWorld(ctx, r, ppd);
    ctx.restore();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-this.roll * DEG);
    this.#drawRollPointer(ctx, r);
    ctx.restore();

    // Fixed part: bezel, roll scale, aircraft symbol, numbers
    this.#drawBezel(ctx, cx, cy, r);
    this.#drawAircraft(ctx, cx, cy, r);
    this.#drawText(ctx, w, h);
  }

  #drawWorld(ctx, r, ppd) {
    const span = 120 * ppd;
    const sky = ctx.createLinearGradient(0, -span, 0, 0);
    sky.addColorStop(0, COLORS.skyTop);
    sky.addColorStop(1, COLORS.skyBottom);
    ctx.fillStyle = sky;
    ctx.fillRect(-3 * r, -span, 6 * r, span);

    const ground = ctx.createLinearGradient(0, 0, 0, span);
    ground.addColorStop(0, COLORS.groundTop);
    ground.addColorStop(1, COLORS.groundBottom);
    ctx.fillStyle = ground;
    ctx.fillRect(-3 * r, 0, 6 * r, span);

    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-3 * r, 0);
    ctx.lineTo(3 * r, 0);
    ctx.stroke();

    // Pitch ladder: nose-up angles above the horizon line
    ctx.lineWidth = 1.5;
    ctx.fillStyle = COLORS.line;
    ctx.font = `600 ${Math.round(r * 0.09)}px "JetBrains Mono", monospace`;
    ctx.textBaseline = 'middle';
    for (let deg = -80; deg <= 80; deg += 5) {
      if (deg === 0) continue;
      const y = -deg * ppd;
      const half = deg % 10 === 0 ? r * 0.28 : r * 0.12;
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(half, y);
      ctx.stroke();
      if (deg % 10 === 0) {
        ctx.textAlign = 'right';
        ctx.fillText(Math.abs(deg), -half - 6, y);
        ctx.textAlign = 'left';
        ctx.fillText(Math.abs(deg), half + 6, y);
      }
    }
  }

  #drawRollPointer(ctx, r) {
    ctx.fillStyle = COLORS.aircraft;
    ctx.beginPath();
    ctx.moveTo(0, -r + 4);
    ctx.lineTo(-8, -r + 18);
    ctx.lineTo(8, -r + 18);
    ctx.closePath();
    ctx.fill();
  }

  #drawBezel(ctx, cx, cy, r) {
    ctx.strokeStyle = COLORS.bezel;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = COLORS.line;
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const long = a % 30 === 0;
      const rad = a * DEG;
      const r1 = r - (long ? 14 : 8);
      ctx.lineWidth = long ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(rad) * r, cy - Math.cos(rad) * r);
      ctx.lineTo(cx + Math.sin(rad) * r1, cy - Math.cos(rad) * r1);
      ctx.stroke();
    }
  }

  #drawAircraft(ctx, cx, cy, r) {
    ctx.strokeStyle = COLORS.aircraft;
    ctx.fillStyle = COLORS.aircraft;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    const wing = r * 0.42;
    const gap = r * 0.12;
    ctx.beginPath();
    ctx.moveTo(cx - wing, cy); ctx.lineTo(cx - gap, cy); ctx.lineTo(cx - gap * 0.5, cy + gap * 0.6);
    ctx.moveTo(cx + wing, cy); ctx.lineTo(cx + gap, cy); ctx.lineTo(cx + gap * 0.5, cy + gap * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  #drawText(ctx, w, h) {
    ctx.fillStyle = COLORS.text;
    ctx.font = '500 12px "JetBrains Mono", monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(`R ${fmt(this.targetRoll)}°`, 10, h - 10);
    ctx.textAlign = 'right';
    ctx.fillText(`P ${fmt(this.targetPitch)}°`, w - 10, h - 10);
  }
}

const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
