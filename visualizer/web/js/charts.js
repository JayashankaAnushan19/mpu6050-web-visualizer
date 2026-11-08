/**
 * Rolling time-series chart (uPlot) for one X/Y/Z sensor.
 * Samples are pushed as they arrive; update() redraws at most once per call,
 * so the caller controls the frame rate.
 */
import uPlot from 'uplot';

const PLOT_HEIGHT = 190;
const AXIS = {
  stroke: '#8b98a9',
  font: '11px "JetBrains Mono", monospace',
  grid: { stroke: 'rgba(255,255,255,0.06)', width: 1 },
  ticks: { stroke: 'rgba(255,255,255,0.08)', width: 1 },
};

export class TimeChart {
  /**
   * @param {HTMLElement} el
   * @param {{colors:string[], minRange:number, decimals:number, windowSec?:number}} opts
   *        minRange: smallest +/- y-range, so noise doesn't fill the chart.
   */
  constructor(el, { colors, minRange, decimals, windowSec = 10 }) {
    this.windowSec = windowSec;
    this.data = [[], [], [], []];
    this.dirty = false;
    this.pendingGap = false;

    const value = (u, v) => (v == null ? '–' : v.toFixed(decimals));
    const opts = {
      width: el.clientWidth || 400,
      height: PLOT_HEIGHT,
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      scales: {
        x: {
          time: false,
          range: (u, min, max) => (max == null ? [0, windowSec] : [max - windowSec, max]),
        },
        y: {
          range: (u, min, max) => {
            const lim = Math.max(minRange, Math.abs(min ?? 0), Math.abs(max ?? 0)) * 1.08;
            return [-lim, lim];
          },
        },
      },
      axes: [
        { ...AXIS, values: (u, ticks) => ticks.map((t) => `${t.toFixed(0)}s`) },
        { ...AXIS, size: 54 },
      ],
      series: [
        { label: 'time', value: (u, v) => (v == null ? '–' : `${v.toFixed(2)} s`) },
        ...['X', 'Y', 'Z'].map((label, i) => ({
          label, value, stroke: colors[i], width: 1.6, points: { show: false },
        })),
      ],
    };

    this.plot = new uPlot(opts, this.data, el);
    new ResizeObserver(() => {
      if (el.clientWidth) this.plot.setSize({ width: el.clientWidth, height: PLOT_HEIGHT });
    }).observe(el);
  }

  /** Append one sample; t in seconds. Old points outside the window are dropped. */
  push(t, x, y, z) {
    const [ts, xs, ys, zs] = this.data;
    if (this.pendingGap && ts.length) {
      ts.push(t - 1e-3); xs.push(null); ys.push(null); zs.push(null);   // break the line
    }
    this.pendingGap = false;
    ts.push(t); xs.push(x); ys.push(y); zs.push(z);

    const cutoff = t - this.windowSec - 1;
    let n = 0;
    while (n < ts.length && ts[n] < cutoff) n++;
    if (n) for (const arr of this.data) arr.splice(0, n);
    this.dirty = true;
  }

  /** Don't connect the next point to the previous one (e.g. after a pause). */
  markGap() {
    this.pendingGap = true;
  }

  clear() {
    for (const arr of this.data) arr.length = 0;
    this.dirty = true;
  }

  update() {
    if (!this.dirty) return;
    this.dirty = false;
    this.plot.setData(this.data);
  }
}
