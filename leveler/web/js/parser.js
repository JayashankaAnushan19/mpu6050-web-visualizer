/**
 * Serial protocol of mpu6050_leveler (see leveler/docs/protocol.md).
 *
 *   V,<t_ms>,<roll>,<pitch>,<angle>,<level>,<led1>,<led2>,<led3>,<led4>,<led5>
 *   #CFG axis=<roll|pitch> tol=<deg> range=<deg> invert=<0|1> rate=<hz>
 *   #<TAG> text      TAG = ERROR | WARN | OK | INFO | READY (optional)
 */

const TAGS = new Set(['ERROR', 'WARN', 'OK', 'INFO', 'READY']);
const DATA_FIELDS = 10;

export function parseLine(raw) {
  const line = raw.trim();
  if (!line) return null;
  if (line.startsWith('#CFG')) return parseConfig(line);
  if (line[0] === '#') return parseStatus(line);
  if (line.startsWith('V,')) return parseData(line);
  return { type: 'invalid', line };
}

function parseData(line) {
  const parts = line.split(',').slice(1);
  if (parts.length !== DATA_FIELDS) return { type: 'invalid', line };
  const n = parts.map(Number);
  if (parts.some((p) => p === '') || !n.every(Number.isFinite)) return { type: 'invalid', line };
  return {
    type: 'data',
    t: n[0], roll: n[1], pitch: n[2], angle: n[3], level: n[4] === 1,
    leds: n.slice(5),
  };
}

function parseConfig(line) {
  const cfg = { type: 'config' };
  for (const [, key, value] of line.matchAll(/(\w+)=(\S+)/g)) {
    cfg[key] = key === 'axis' ? value : Number(value);
  }
  return cfg;
}

function parseStatus(line) {
  const body = line.slice(1).trim();
  const tag = body.split(/\s/, 1)[0];
  return { type: 'log', level: TAGS.has(tag) ? tag.toLowerCase() : 'msg', text: body };
}

/** Turns a stream of text chunks into complete lines. */
export class LineSplitter {
  constructor(onLine, maxLength = 512) {
    this.onLine = onLine;
    this.maxLength = maxLength;
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      this.onLine(line);
    }
    if (this.buffer.length > this.maxLength) this.buffer = '';
  }

  reset() {
    this.buffer = '';
  }
}
