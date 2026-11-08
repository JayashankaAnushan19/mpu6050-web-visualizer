/**
 * Serial protocol parsing (see docs/protocol.md).
 *
 *   D,<t_ms>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>,<roll>,<pitch>,<yaw>,<tempC>
 *   #<TAG> text      TAG = ERROR | WARN | OK | INFO | READY (optional)
 */

/** Field names of a data line, in order, after the leading "D". */
export const FIELDS = ['t', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'roll', 'pitch', 'yaw', 'temp'];

const TAGS = new Set(['ERROR', 'WARN', 'OK', 'INFO', 'READY']);

/**
 * Parse one line of device output.
 * @returns {{type:'data'}|{type:'log', level:string, text:string}|{type:'invalid', line:string}|null}
 *          null for blank lines.
 */
export function parseLine(raw) {
  const line = raw.trim();
  if (!line) return null;
  if (line[0] === '#') return parseStatus(line);
  if (line.startsWith('D,')) return parseData(line);
  return { type: 'invalid', line };
}

function parseData(line) {
  const parts = line.split(',');
  if (parts.length !== FIELDS.length + 1) return { type: 'invalid', line };

  const sample = { type: 'data' };
  for (let i = 0; i < FIELDS.length; i++) {
    const text = parts[i + 1];
    const value = Number(text);
    if (text === '' || !Number.isFinite(value)) return { type: 'invalid', line };
    sample[FIELDS[i]] = value;
  }
  return sample;
}

function parseStatus(line) {
  const body = line.slice(1).trim();
  const tag = body.split(/\s/, 1)[0];
  const level = TAGS.has(tag) ? tag.toLowerCase() : 'msg';
  return { type: 'log', level, text: body };
}

/**
 * Turns a stream of text chunks into complete lines. Partial lines are kept
 * until their newline arrives; a runaway line (no newline) is dropped.
 */
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
