/**
 * Web Serial connection to the Arduino.
 * Emits complete text lines via onLine and reports closure via onClose.
 */
import { LineSplitter } from './parser.js';

export const isSerialSupported = () => 'serial' in navigator;

export class SerialSource {
  constructor({ onLine, onClose }) {
    this.kind = 'serial';
    this.onClose = onClose;
    this.splitter = new LineSplitter(onLine);
    this.encoder = new TextEncoder();
    this.port = null;
    this.reader = null;
    this.keepReading = false;
    this.readLoopDone = null;
    this.writeChain = Promise.resolve();
  }

  /** Ask the user for a port and open it. Throws if cancelled or busy. */
  async connect(baudRate) {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate, bufferSize: 4096 });
    this.port = port;
    this.keepReading = true;
    this.readLoopDone = this.#readLoop();
  }

  /** Send a command line (newline appended). Writes are queued in order. */
  send(command) {
    this.writeChain = this.writeChain.then(async () => {
      if (!this.port?.writable) throw new Error('Port is not open');
      const writer = this.port.writable.getWriter();
      try {
        await writer.write(this.encoder.encode(command + '\n'));
      } finally {
        writer.releaseLock();
      }
    });
    return this.writeChain;
  }

  /** Close the port (user-initiated). */
  async close() {
    if (!this.port) return;
    this.keepReading = false;
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    await this.readLoopDone;
  }

  async #readLoop() {
    const decoder = new TextDecoder();
    let lastError = null;

    // port.readable becomes null on a fatal error (e.g. cable unplugged);
    // non-fatal errors (buffer overrun, framing) leave it usable, so retry.
    while (this.port.readable && this.keepReading) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;                       // reader.cancel() from close()
          if (value) this.splitter.push(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        lastError = err;
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }

    const unexpected = this.keepReading;         // still wanted data: we lost the device
    this.keepReading = false;
    try { await this.port.close(); } catch { /* port already gone */ }
    this.port = null;
    this.splitter.reset();
    this.onClose?.({ unexpected, error: lastError });
  }
}

/** Human-readable reason for a failed connect() call, or null if the user cancelled. */
export function describeConnectError(err) {
  if (err?.name === 'NotFoundError') return null;
  if (err?.name === 'InvalidStateError' || err?.name === 'NetworkError') {
    return 'Port is busy. Close the Arduino Serial Monitor/Plotter (or any other app using it) and try again.';
  }
  if (err?.name === 'SecurityError') {
    return 'Serial access blocked. Open the page over https:// or http://localhost.';
  }
  return `Could not open port: ${err?.message ?? err}`;
}
