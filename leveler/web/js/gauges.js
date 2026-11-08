/**
 * Canvas gauges: a tube vial (one axis, like the LED row) and a bullseye
 * (both axes). Both ease toward their target so 25 Hz data animates at 60 fps.
 */

const TAU_MS = 70;   // easing time constant

/** Fraction to move toward the target this frame (frame-rate independent). */
let lastFrame = performance.now();
let ease = 0.2;
export function tickEase(now) {
  ease = 1 - Math.exp(-Math.min(500, now - lastFrame) / TAU_MS);
  lastFrame = now;
}
const GREEN = '#34d399';
const AMBER = '#fbbf24';
const RED = '#f87171';

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: canvas.clientWidth, h: canvas.clientHeight };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function bubbleColor(mag, tol, range) {
  if (mag <= tol) return GREEN;
  return mag >= range ? RED : AMBER;
}

export class Vial {
  constructor(canvas) {
    this.canvas = canvas;
    this.target = 0;
    this.shown = 0;
    this.tol = 0.5;
    this.range = 10;
  }

  set(angle, tol, range) {
    this.target = angle;
    this.tol = tol;
    this.range = range;
  }

  draw() {
    this.shown += (this.target - this.shown) * ease;
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);

    const tubeH = Math.min(64, h * 0.5);
    const x0 = 24, x1 = w - 24, cy = h * 0.42;
    const len = x1 - x0, cx = (x0 + x1) / 2;
    const travel = len / 2 - tubeH * 0.75;

    // Tube body (liquid + glass highlight)
    const liquid = ctx.createLinearGradient(0, cy - tubeH / 2, 0, cy + tubeH / 2);
    liquid.addColorStop(0, '#2a3a1d');
    liquid.addColorStop(0.5, '#3d5a22');
    liquid.addColorStop(1, '#22311a');
    roundRect(ctx, x0, cy - tubeH / 2, len, tubeH, tubeH / 2);
    ctx.fillStyle = liquid;
    ctx.fill();
    ctx.strokeStyle = '#4b5d3a';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Scale ticks: every 1/10 of the range, labelled at half and full scale
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    for (let i = -10; i <= 10; i++) {
      const x = cx + (i / 10) * travel;
      const major = i % 5 === 0;
      ctx.strokeStyle = major ? '#94a3b8' : '#4b5768';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, cy + tubeH / 2 + 6);
      ctx.lineTo(x, cy + tubeH / 2 + (major ? 16 : 11));
      ctx.stroke();
      if (major) {
        ctx.fillStyle = '#8b98a9';
        const deg = (i / 10) * this.range;
        ctx.fillText(`${deg > 0 ? '+' : ''}${+deg.toFixed(1)}°`, x, cy + tubeH / 2 + 30);
      }
    }

    // Tolerance window (the two lines on a real vial)
    const tolX = Math.max(3, (this.tol / this.range) * travel);
    const bubbleR = tubeH * 0.38;
    ctx.strokeStyle = 'rgba(230, 237, 243, .55)';
    ctx.lineWidth = 2;
    for (const s of [-1, 1]) {
      const x = cx + s * (tolX + bubbleR);
      ctx.beginPath();
      ctx.moveTo(x, cy - tubeH / 2 + 4);
      ctx.lineTo(x, cy + tubeH / 2 - 4);
      ctx.stroke();
    }

    // Bubble
    const mag = Math.abs(this.shown);
    const bx = cx + clamp(this.shown / this.range, -1, 1) * travel;
    const color = bubbleColor(mag, this.tol, this.range);
    const g = ctx.createRadialGradient(bx - bubbleR * 0.3, cy - bubbleR * 0.35, 2, bx, cy, bubbleR * 1.4);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.ellipse(bx, cy, bubbleR * 1.35, bubbleR, 0, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    // Glass highlight on top
    roundRect(ctx, x0 + tubeH / 2, cy - tubeH / 2 + 5, len - tubeH, tubeH * 0.16, tubeH * 0.08);
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fill();
  }
}

export class Bullseye {
  constructor(canvas) {
    this.canvas = canvas;
    this.target = { x: 0, y: 0 };
    this.shown = { x: 0, y: 0 };
    this.tol = 0.5;
    this.range = 10;
  }

  set(roll, pitch, tol, range) {
    this.target = { x: roll, y: pitch };
    this.tol = tol;
    this.range = range;
  }

  draw() {
    this.shown.x += (this.target.x - this.shown.x) * ease;
    this.shown.y += (this.target.y - this.shown.y) * ease;
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - 10;
    const bubbleR = R * 0.13;
    const travel = R - bubbleR - 4;

    // Face
    const face = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    face.addColorStop(0, '#24341c');
    face.addColorStop(1, '#151f12');
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = face;
    ctx.fill();
    ctx.strokeStyle = '#4b5d3a';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Rings at half and full scale, crosshair
    ctx.strokeStyle = 'rgba(148, 163, 184, .35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, travel * 0.5, 0, Math.PI * 2);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // Tolerance ring
    ctx.strokeStyle = 'rgba(230, 237, 243, .6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, bubbleR + Math.max(2, (this.tol / this.range) * travel), 0, Math.PI * 2);
    ctx.stroke();

    // Bubble: x = roll, y = pitch (pitch up = bubble up), clamped to the rim
    let dx = this.shown.x / this.range;
    let dy = -this.shown.y / this.range;
    const d = Math.hypot(dx, dy);
    if (d > 1) { dx /= d; dy /= d; }
    const bx = cx + dx * travel, by = cy + dy * travel;
    const mag = Math.hypot(this.shown.x, this.shown.y);
    const color = bubbleColor(mag, this.tol, this.range);

    const g = ctx.createRadialGradient(bx - bubbleR * 0.3, by - bubbleR * 0.35, 1, bx, by, bubbleR * 1.3);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(bx, by, bubbleR, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#8b98a9';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('roll →', w - 6, cy - 6);
    ctx.textAlign = 'left';
    ctx.fillText('↑ pitch', cx + 6, 14);
  }
}
