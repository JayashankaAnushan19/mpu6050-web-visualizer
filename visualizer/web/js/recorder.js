/**
 * Records samples in memory and exports them as a CSV download.
 */
import { FIELDS } from './parser.js';

const HEADER = 't_ms,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,roll_deg,pitch_deg,yaw_deg,temp_c';
const MAX_ROWS = 360_000;   // 1 hour at 100 Hz (~25 MB of CSV)

export class Recorder {
  constructor() {
    this.rows = [];
    this.active = false;
    this.startedAt = null;
  }

  get count() {
    return this.rows.length;
  }

  get full() {
    return this.rows.length >= MAX_ROWS;
  }

  start() {
    this.rows = [];
    this.active = true;
    this.startedAt = new Date();
  }

  add(sample) {
    if (this.active && !this.full) this.rows.push(FIELDS.map((k) => sample[k]));
  }

  /** Stop recording; returns the number of rows captured. */
  stop() {
    this.active = false;
    return this.rows.length;
  }

  /** Trigger a browser download of the recording. */
  download() {
    const csv = HEADER + '\n' + this.rows.map((r) => r.join(',')).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `mpu6050_${timestamp(this.startedAt)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function timestamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
