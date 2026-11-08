/*
 * mpu6050_stream.ino
 * ------------------
 * Streams motion data from an MPU6050 (GY-521) over USB serial as compact
 * CSV lines, for the mpu6050-web-visualizer web app.
 *
 * Hardware: Arduino Uno + GY-521, I2C address 0x68 (AD0 low)
 *   VCC -> 5V, GND -> GND, SDA -> A4, SCL -> A5, INT -> D2 (unused)
 *   See docs/wiring.svg.
 *
 * Output (115200 baud, one line per sample, default 50 Hz):
 *   D,<t_ms>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>,<roll>,<pitch>,<yaw>,<tempC>
 *   units: g, deg/s, degrees, deg C. Status lines start with '#'.
 *
 * Commands (newline-terminated):
 *   C        recalibrate gyro bias (keep the board still)
 *   Z        zero the yaw angle
 *   R<hz>    set output rate, 1..100 Hz (e.g. R25)
 *   ?        print current settings
 *
 * Orientation: roll/pitch use a complementary filter (gyro short-term,
 * accelerometer long-term). Yaw is integrated gyro only: the MPU6050 has no
 * magnetometer, so yaw has no absolute reference and WILL drift over time.
 *
 * Library choice: the core Wire library is used directly. The MPU6050 needs
 * five register writes to configure and one 14-byte burst read per sample,
 * so a driver library would add flash/RAM and a dependency for no real gain.
 */

#include <Wire.h>
#include <math.h>

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
static const uint32_t SERIAL_BAUD        = 115200;
static const uint8_t  MPU_ADDR           = 0x68;    // AD0 low
static const uint16_t RETRY_INTERVAL_MS  = 2000;    // re-probe a missing sensor

// The filter runs at a fixed rate, independent of the output rate, so
// changing R<hz> never changes the quality of the angle estimate.
static const uint16_t FILTER_INTERVAL_US = 5000;    // 200 Hz (matches sensor rate)
static const float    ALPHA              = 0.98f;   // gyro weight; tau ~0.25 s at 200 Hz
static const float    MAX_DT_S           = 0.05f;   // clamp dt after long stalls

static const uint8_t  RATE_DEFAULT_HZ    = 50;
static const uint8_t  RATE_MIN_HZ        = 1;
static const uint8_t  RATE_MAX_HZ        = 100;     // ~70 B/line keeps 100 Hz well under 115200 baud

static const uint16_t CAL_SAMPLES        = 500;     // 2.5 s at 200 Hz
static const uint8_t  CAL_WARMUP_SAMPLES = 20;      // 100 ms discarded: gyro output settles after wake
static const float    CAL_MAX_STDDEV_DPS = 2.0f;    // noise is ~0.5-1 deg/s; more = board moved
static const uint8_t  CAL_MAX_ATTEMPTS   = 3;

// ---------------------------------------------------------------------------
// MPU6050 register map (only the registers we use)
// ---------------------------------------------------------------------------
static const uint8_t REG_SMPLRT_DIV   = 0x19;
static const uint8_t REG_CONFIG       = 0x1A;
static const uint8_t REG_GYRO_CONFIG  = 0x1B;
static const uint8_t REG_ACCEL_CONFIG = 0x1C;
static const uint8_t REG_ACCEL_CONFIG2 = 0x1D;  // MPU6500 family only: accel DLPF
static const uint8_t REG_ACCEL_XOUT_H = 0x3B;   // start of 14-byte data block
static const uint8_t REG_PWR_MGMT_1   = 0x6B;
static const uint8_t REG_WHO_AM_I     = 0x75;

static const uint8_t WHO_AM_I_MPU6050 = 0x68;

// Full-scale settings: +/-2 g and +/-250 deg/s (best resolution for hand motion)
static const float ACCEL_LSB_PER_G  = 16384.0f;
static const float GYRO_LSB_PER_DPS = 131.0f;
static const float RAD_TO_DEG_F     = 57.2957795f;

// ---------------------------------------------------------------------------
// Types and state
// ---------------------------------------------------------------------------
struct RawSample {            // sensor counts, straight from the registers
  int16_t ax, ay, az;
  int16_t temp;
  int16_t gx, gy, gz;
};

struct Sample {               // physical units, gyro bias removed
  float ax, ay, az;           // g
  float gx, gy, gz;           // deg/s
  float tempC;
};

struct Attitude {             // degrees
  float roll, pitch, yaw;
};

static bool     sensorOk         = false;
static uint8_t  chipId           = 0;       // WHO_AM_I value of the detected chip
static uint32_t lastRetryMs      = 0;
static uint32_t lastFilterUs     = 0;
static uint32_t lastOutputMs     = 0;
static uint16_t outputIntervalMs = 1000 / RATE_DEFAULT_HZ;
static uint8_t  outputHz         = RATE_DEFAULT_HZ;

static float    gyroBias[3]      = {0, 0, 0};   // raw counts
static Sample   latest;
static Attitude att;

// Command input buffer (no String class: fixed buffer, no heap use)
static char     cmdBuf[12];
static uint8_t  cmdLen           = 0;
static bool     cmdOverflow      = false;

// ---------------------------------------------------------------------------
// Low-level I2C helpers
// ---------------------------------------------------------------------------

// Write one byte to a register. Returns true on ACK.
static bool writeReg(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

// Burst-read `len` bytes starting at `reg`. Returns true if all bytes arrived.
static bool readRegs(uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;   // repeated start
  if (Wire.requestFrom(MPU_ADDR, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

// ---------------------------------------------------------------------------
// MPU6050 driver
// ---------------------------------------------------------------------------

// Many GY-521 boards sold today carry an MPU6500-family die (WHO_AM_I 0x70,
// 0x71, 0x73...) instead of a genuine MPU6050. They are register-compatible
// for everything used here except temperature scaling and the accel filter.
static bool isGenuineMpu6050() {
  return chipId == WHO_AM_I_MPU6050;
}

// Check the device answers and identifies itself. Prints a reason on failure.
static bool mpuProbe() {
  if (!readRegs(REG_WHO_AM_I, &chipId, 1)) {
    Serial.println(F("#ERROR MPU6050 not found at 0x68. Check wiring (SDA->A4, SCL->A5, VCC, GND)."));
    return false;
  }
  if (!isGenuineMpu6050()) {
    Serial.print(F("#WARN WHO_AM_I is 0x"));
    Serial.print(chipId, HEX);
    Serial.println(F(", not 0x68: MPU6500-family clone. Using compatible settings."));
  }
  return true;
}

// Wake the sensor and configure ranges and filtering.
static bool mpuInit() {
  bool ok = writeReg(REG_PWR_MGMT_1,   0x01)   // wake up, clock = X-gyro PLL (more stable)
         && writeReg(REG_CONFIG,       0x03)   // gyro DLPF ~44 Hz: removes vibration noise
         && writeReg(REG_SMPLRT_DIV,   0x04)   // 1 kHz / (1 + 4) = 200 Hz internal sample rate
         && writeReg(REG_GYRO_CONFIG,  0x00)   // +/-250 deg/s
         && writeReg(REG_ACCEL_CONFIG, 0x00);  // +/-2 g
  // On the MPU6500 family the accel has its own DLPF, which defaults to
  // ~460 Hz (very noisy). Match the gyro's ~44 Hz. Reserved on a real MPU6050.
  if (ok && !isGenuineMpu6050()) ok = writeReg(REG_ACCEL_CONFIG2, 0x03);
  return ok;
}

// Read accel, temperature and gyro in a single 14-byte burst (big-endian).
static bool mpuReadRaw(RawSample &s) {
  uint8_t b[14];
  if (!readRegs(REG_ACCEL_XOUT_H, b, sizeof(b))) return false;
  s.ax   = (int16_t)((b[0]  << 8) | b[1]);
  s.ay   = (int16_t)((b[2]  << 8) | b[3]);
  s.az   = (int16_t)((b[4]  << 8) | b[5]);
  s.temp = (int16_t)((b[6]  << 8) | b[7]);
  s.gx   = (int16_t)((b[8]  << 8) | b[9]);
  s.gy   = (int16_t)((b[10] << 8) | b[11]);
  s.gz   = (int16_t)((b[12] << 8) | b[13]);
  return true;
}

// Die temperature. The two chip families use different datasheet formulas.
static float rawToTempC(int16_t raw) {
  return isGenuineMpu6050() ? raw / 340.0f + 36.53f    // MPU6050
                            : raw / 333.87f + 21.0f;   // MPU6500 family
}

// Convert counts to physical units and remove the gyro bias.
static void scaleSample(const RawSample &r, Sample &s) {
  s.ax    = r.ax / ACCEL_LSB_PER_G;
  s.ay    = r.ay / ACCEL_LSB_PER_G;
  s.az    = r.az / ACCEL_LSB_PER_G;
  s.gx    = (r.gx - gyroBias[0]) / GYRO_LSB_PER_DPS;
  s.gy    = (r.gy - gyroBias[1]) / GYRO_LSB_PER_DPS;
  s.gz    = (r.gz - gyroBias[2]) / GYRO_LSB_PER_DPS;
  s.tempC = rawToTempC(r.temp);
}

// ---------------------------------------------------------------------------
// Gyro calibration
// ---------------------------------------------------------------------------

// Average CAL_SAMPLES gyro readings (after a short warm-up). Returns false on
// I2C failure. `noiseDps` is the largest per-axis standard deviation; the
// caller treats a high value as "the board moved". Standard deviation is used
// rather than min/max because one noise spike should not fail calibration.
static bool sampleGyroBias(float bias[3], float &noiseDps) {
  // Accumulate deviations from the first sample: keeps the float sums small
  // so the variance stays accurate.
  int16_t ref[3]   = {0, 0, 0};
  float   sum[3]   = {0, 0, 0};
  float   sumSq[3] = {0, 0, 0};
  uint32_t next    = micros();

  for (uint16_t i = 0; i < CAL_WARMUP_SAMPLES + CAL_SAMPLES; i++) {
    while ((int32_t)(micros() - next) < 0) { }   // pace at the sensor's 200 Hz
    next += FILTER_INTERVAL_US;

    RawSample r;
    if (!mpuReadRaw(r)) return false;
    if (i < CAL_WARMUP_SAMPLES) continue;

    const int16_t g[3] = {r.gx, r.gy, r.gz};
    for (uint8_t k = 0; k < 3; k++) {
      if (i == CAL_WARMUP_SAMPLES) ref[k] = g[k];
      float d = g[k] - ref[k];
      sum[k]   += d;
      sumSq[k] += d * d;
    }
  }

  noiseDps = 0;
  for (uint8_t k = 0; k < 3; k++) {
    float mean = sum[k] / CAL_SAMPLES;
    float var  = sumSq[k] / CAL_SAMPLES - mean * mean;
    float sd   = sqrt(var > 0 ? var : 0) / GYRO_LSB_PER_DPS;
    bias[k] = ref[k] + mean;
    if (sd > noiseDps) noiseDps = sd;
  }
  return true;
}

static void printBias() {
  Serial.print(F("bias_dps="));
  for (uint8_t k = 0; k < 3; k++) {
    if (k) Serial.print(',');
    Serial.print(gyroBias[k] / GYRO_LSB_PER_DPS, 2);
  }
}

// Measure gyro bias, retrying if the board was moved. Blocks ~2.5 s per
// attempt; no data is streamed meanwhile. Returns false on I2C failure.
static bool calibrateGyro() {
  float bias[3];
  float noiseDps = 0;
  bool still = false;

  for (uint8_t attempt = 1; attempt <= CAL_MAX_ATTEMPTS && !still; attempt++) {
    Serial.print(F("# Calibrating gyro, keep the sensor still ("));
    Serial.print(attempt);
    Serial.print('/');
    Serial.print(CAL_MAX_ATTEMPTS);
    Serial.println(')');

    if (!sampleGyroBias(bias, noiseDps)) return false;
    still = noiseDps <= CAL_MAX_STDDEV_DPS;
    if (!still) Serial.println(F("#WARN Movement detected during calibration."));
  }
  if (!still) Serial.println(F("#WARN Using calibration anyway; yaw may drift faster. Send C to retry."));

  for (uint8_t k = 0; k < 3; k++) gyroBias[k] = bias[k];
  Serial.print(F("# Calibration done, "));
  printBias();
  Serial.print(F(" noise_dps="));
  Serial.println(noiseDps, 2);
  return true;
}

// ---------------------------------------------------------------------------
// Orientation filter
// ---------------------------------------------------------------------------

// Wrap an angle into [-180, 180).
static float wrap180(float a) {
  while (a >= 180.0f) a -= 360.0f;
  while (a < -180.0f) a += 360.0f;
  return a;
}

// Roll and pitch implied by gravity alone (valid when not accelerating).
static float accelRoll(const Sample &s)  { return atan2(s.ay, s.az) * RAD_TO_DEG_F; }
static float accelPitch(const Sample &s) { return atan2(-s.ax, sqrt(s.ay * s.ay + s.az * s.az)) * RAD_TO_DEG_F; }

// Complementary filter step. Written as "integrate gyro, then nudge toward
// the accelerometer by (1 - ALPHA) of the error", which is the same as
// ALPHA*gyroAngle + (1-ALPHA)*accelAngle but stays correct across the
// +/-180 deg wrap of roll.
static void updateAttitude(const Sample &s, float dt) {
  att.roll  = wrap180(att.roll  + s.gx * dt);
  att.pitch = wrap180(att.pitch + s.gy * dt);
  att.yaw   = wrap180(att.yaw   + s.gz * dt);   // gyro only: drifts

  att.roll  = wrap180(att.roll  + (1.0f - ALPHA) * wrap180(accelRoll(s)  - att.roll));
  att.pitch = wrap180(att.pitch + (1.0f - ALPHA) * wrap180(accelPitch(s) - att.pitch));
}

// Start the filter from the current accelerometer reading, yaw = 0, so the
// angles are right immediately instead of converging over a second.
static bool seedAttitude() {
  RawSample r;
  if (!mpuReadRaw(r)) return false;
  scaleSample(r, latest);
  att.roll  = accelRoll(latest);
  att.pitch = accelPitch(latest);
  att.yaw   = 0.0f;
  lastFilterUs = micros();
  lastOutputMs = millis();
  return true;
}

// Read one sample and advance the filter. Returns false on I2C failure.
static bool filterStep(uint32_t nowUs) {
  float dt = (nowUs - lastFilterUs) * 1e-6f;
  lastFilterUs = nowUs;
  if (dt > MAX_DT_S) dt = MAX_DT_S;   // e.g. after a blocking serial write

  RawSample r;
  if (!mpuReadRaw(r)) return false;
  scaleSample(r, latest);
  updateAttitude(latest, dt);
  return true;
}

// ---------------------------------------------------------------------------
// Sensor lifecycle
// ---------------------------------------------------------------------------

static void sensorLost() {
  Serial.println(F("#ERROR I2C read failed. Sensor disconnected?"));
  sensorOk = false;
  lastRetryMs = millis();
}

// Calibrate and restart the filter. Used at startup and by the C command.
static bool calibrateAndStart() {
  if (!calibrateGyro() || !seedAttitude()) {
    sensorLost();
    return false;
  }
  Serial.println(F("#READY"));
  return true;
}

// Try to bring the sensor online. Safe to call repeatedly.
static void connectSensor() {
  lastRetryMs = millis();
  if (!mpuProbe()) return;
  if (!mpuInit()) {
    Serial.println(F("#ERROR MPU6050 did not accept configuration."));
    return;
  }
  sensorOk = true;
  Serial.println(F("# MPU6050 found"));
  calibrateAndStart();
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

static void printCsvField(float value, uint8_t digits) {
  Serial.print(',');
  Serial.print(value, digits);
}

// D,<t_ms>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>,<roll>,<pitch>,<yaw>,<tempC>
static void printDataLine(uint32_t tMs) {
  Serial.print(F("D,"));
  Serial.print(tMs);
  printCsvField(latest.ax, 3);
  printCsvField(latest.ay, 3);
  printCsvField(latest.az, 3);
  printCsvField(latest.gx, 2);
  printCsvField(latest.gy, 2);
  printCsvField(latest.gz, 2);
  printCsvField(att.roll, 2);
  printCsvField(att.pitch, 2);
  printCsvField(att.yaw, 2);
  printCsvField(latest.tempC, 1);
  Serial.println();
}

static void printBanner() {
  Serial.println(F("# mpu6050_stream v1.0"));
  Serial.println(F("# FORMAT D,t_ms,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,roll_deg,pitch_deg,yaw_deg,temp_c"));
  Serial.println(F("# Commands: C=calibrate Z=zero yaw R<hz>=rate (1-100) ?=status"));
}

static void printStatus() {
  Serial.print(F("#INFO sensor="));
  Serial.print(sensorOk ? F("ok") : F("missing"));
  Serial.print(F(" who_am_i=0x"));
  Serial.print(chipId, HEX);
  Serial.print(F(" rate_hz="));
  Serial.print(outputHz);
  Serial.print(F(" filter_hz="));
  Serial.print(1000000UL / FILTER_INTERVAL_US);
  Serial.print(F(" alpha="));
  Serial.print(ALPHA, 2);
  Serial.print(' ');
  printBias();
  Serial.println();
}

// ---------------------------------------------------------------------------
// Serial commands
// ---------------------------------------------------------------------------

// Parse a whole decimal number. Returns false on empty/non-digit/too large.
static bool parseUint(const char *s, uint16_t &out) {
  if (*s == '\0') return false;
  uint16_t v = 0;
  for (; *s; s++) {
    if (*s < '0' || *s > '9') return false;
    v = v * 10 + (*s - '0');
    if (v > 1000) return false;
  }
  out = v;
  return true;
}

static void cmdSetRate(const char *arg) {
  uint16_t hz;
  if (!parseUint(arg, hz) || hz < RATE_MIN_HZ || hz > RATE_MAX_HZ) {
    Serial.println(F("#ERROR R expects a rate of 1-100 Hz, e.g. R50"));
    return;
  }
  outputHz = (uint8_t)hz;
  outputIntervalMs = 1000 / hz;
  Serial.print(F("#OK R"));
  Serial.println(outputHz);
}

static void cmdCalibrate() {
  if (!sensorOk) {
    Serial.println(F("#ERROR No sensor; cannot calibrate."));
    return;
  }
  if (calibrateAndStart()) Serial.println(F("#OK C"));
}

static void cmdZeroYaw() {
  att.yaw = 0.0f;
  Serial.println(F("#OK Z"));
}

static void handleCommand(char *cmd) {
  char op = cmd[0];
  if (op >= 'a' && op <= 'z') op -= 'a' - 'A';   // accept lower case
  const char *arg = cmd + 1;

  switch (op) {
    case 'C': cmdCalibrate(); break;
    case 'Z': cmdZeroYaw();   break;
    case 'R': cmdSetRate(arg); break;
    case '?': printStatus();  break;
    default:
      Serial.print(F("#ERROR Unknown command '"));
      Serial.print(cmd);
      Serial.println(F("'. Use C, Z, R<hz> or ?"));
  }
}

// Collect characters until CR or LF, then dispatch. Spaces are ignored.
static void pollCommands() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();

    if (c == '\n' || c == '\r') {
      if (cmdOverflow) Serial.println(F("#ERROR Command too long"));
      else if (cmdLen > 0) {
        cmdBuf[cmdLen] = '\0';
        handleCommand(cmdBuf);
      }
      cmdLen = 0;
      cmdOverflow = false;
    } else if (c == ' ') {
      continue;
    } else if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = c;
    } else {
      cmdOverflow = true;   // discard the rest of this line
    }
  }
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(SERIAL_BAUD);
  Wire.begin();
  Wire.setClock(400000);                 // 400 kHz fast mode
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(3000, true);       // never hang forever on a stuck bus
#endif

  printBanner();
  connectSensor();
}

void loop() {
  pollCommands();

  // Sensor missing: retry periodically instead of blocking.
  if (!sensorOk) {
    if (millis() - lastRetryMs >= RETRY_INTERVAL_MS) connectSensor();
    return;
  }

  // 1) Fixed-rate filter update (200 Hz, micros()-timed).
  uint32_t nowUs = micros();
  if (nowUs - lastFilterUs >= FILTER_INTERVAL_US) {
    if (!filterStep(nowUs)) {
      sensorLost();
      return;
    }
  }

  // 2) Fixed-rate output (R<hz>, millis()-timed). Adding the interval rather
  //    than assigning `now` keeps the long-term rate exact; resync if behind.
  uint32_t nowMs = millis();
  if (nowMs - lastOutputMs >= outputIntervalMs) {
    lastOutputMs += outputIntervalMs;
    if (nowMs - lastOutputMs >= outputIntervalMs) lastOutputMs = nowMs;
    printDataLine(nowMs);
  }
}
