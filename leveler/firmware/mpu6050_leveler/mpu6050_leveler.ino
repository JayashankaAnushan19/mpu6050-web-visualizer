/*
 * mpu6050_leveler.ino
 * -------------------
 * A digital spirit level: an MPU6050 (GY-521) measures tilt and a row of five
 * LEDs shows it like the bubble in a level. The same data streams over USB
 * serial for the web app in leveler/web.
 *
 * Hardware: Arduino Uno + GY-521 (I2C 0x68) + 5 LEDs with 220 ohm resistors
 *   GY-521: VCC -> 5V, GND -> GND, SDA -> A4, SCL -> A5
 *   LEDs (anode -> resistor -> pin, cathode -> GND), left to right:
 *     LED1 red    D3
 *     LED2 yellow D5
 *     LED3 green  D6    <- lit alone when level
 *     LED4 yellow D9
 *     LED5 red    D10
 *   All five are PWM pins, so the "bubble" fades smoothly between LEDs.
 *   See leveler/docs/wiring.svg.
 *
 * Output (115200 baud, default 25 Hz):
 *   V,<t_ms>,<roll>,<pitch>,<angle>,<level>,<led1>,<led2>,<led3>,<led4>,<led5>
 *   roll/pitch/angle in degrees relative to the saved level reference,
 *   level = 1 when within tolerance, led = PWM brightness 0-255.
 *   Settings are reported as: #CFG axis=<roll|pitch> tol=<deg> range=<deg> invert=<0|1> rate=<hz>
 *
 * Commands (newline-terminated):
 *   C        recalibrate gyro (keep still)
 *   L        set the current position as level (saved to EEPROM)
 *   X        clear the level reference (back to the sensor's own zero)
 *   A        switch the measured axis (roll <-> pitch); AR / AP select one
 *   I        invert the LED direction
 *   T<deg>   level tolerance, 0.1-5.0 (e.g. T0.5)
 *   S<deg>   full-scale tilt for the outer LEDs, 2-45 (e.g. S10)
 *   R<hz>    output rate, 1-50
 *   ?        print status and settings
 */

#include <Wire.h>
#include <EEPROM.h>
#include <math.h>

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
static const uint32_t SERIAL_BAUD        = 115200;
static const uint8_t  MPU_ADDR           = 0x68;
static const uint16_t RETRY_INTERVAL_MS  = 2000;

static const uint8_t  NUM_LEDS           = 5;
static const uint8_t  LED_PINS[NUM_LEDS] = {3, 5, 6, 9, 10};   // left -> right, all PWM
static const uint8_t  CENTER             = 2;

static const uint16_t FILTER_INTERVAL_US = 5000;    // 200 Hz
static const float    ALPHA              = 0.98f;
static const float    MAX_DT_S           = 0.05f;

static const uint8_t  RATE_DEFAULT_HZ    = 25;
static const uint8_t  RATE_MAX_HZ        = 50;
static const uint16_t LED_INTERVAL_MS    = 10;      // LED refresh, 100 Hz
static const float    HYSTERESIS         = 1.15f;   // leave "level" at tol * 1.15 (no flicker)

static const uint16_t CAL_SAMPLES        = 400;     // 2 s at 200 Hz
static const uint8_t  CAL_WARMUP_SAMPLES = 20;
static const float    CAL_MAX_STDDEV_DPS = 2.0f;
static const uint8_t  CAL_MAX_ATTEMPTS   = 3;

// ---------------------------------------------------------------------------
// Registers
// ---------------------------------------------------------------------------
static const uint8_t REG_SMPLRT_DIV    = 0x19;
static const uint8_t REG_CONFIG        = 0x1A;
static const uint8_t REG_GYRO_CONFIG   = 0x1B;
static const uint8_t REG_ACCEL_CONFIG  = 0x1C;
static const uint8_t REG_ACCEL_CONFIG2 = 0x1D;   // MPU6500 family only
static const uint8_t REG_ACCEL_XOUT_H  = 0x3B;
static const uint8_t REG_PWR_MGMT_1    = 0x6B;
static const uint8_t REG_WHO_AM_I      = 0x75;
static const uint8_t WHO_AM_I_MPU6050  = 0x68;

static const float ACCEL_LSB_PER_G  = 16384.0f;
static const float GYRO_LSB_PER_DPS = 131.0f;
static const float RAD_TO_DEG_F     = 57.2957795f;

// ---------------------------------------------------------------------------
// Saved settings (EEPROM)
// ---------------------------------------------------------------------------
static const uint16_t SETTINGS_MAGIC = 0x4C56;   // "LV"

struct Settings {
  uint16_t magic;
  uint8_t  axisPitch;    // 0 = roll, 1 = pitch
  uint8_t  invert;       // 1 = swap LED direction
  uint8_t  tolTenths;    // tolerance in 0.1 deg
  uint8_t  rangeDeg;     // full scale in deg
  float    zeroRoll;     // level reference
  float    zeroPitch;
};

static Settings cfg;

static void defaultSettings() {
  cfg.magic     = SETTINGS_MAGIC;
  cfg.axisPitch = 0;
  cfg.invert    = 0;
  cfg.tolTenths = 5;     // 0.5 deg
  cfg.rangeDeg  = 10;
  cfg.zeroRoll  = 0;
  cfg.zeroPitch = 0;
}

static void loadSettings() {
  EEPROM.get(0, cfg);
  bool valid = cfg.magic == SETTINGS_MAGIC
            && cfg.tolTenths >= 1 && cfg.tolTenths <= 50
            && cfg.rangeDeg >= 2 && cfg.rangeDeg <= 45
            && isfinite(cfg.zeroRoll) && isfinite(cfg.zeroPitch);
  if (!valid) defaultSettings();
}

static void saveSettings() { EEPROM.put(0, cfg); }   // put() only writes changed bytes

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
static bool     sensorOk     = false;
static uint8_t  chipId       = 0;
static uint32_t lastRetryMs  = 0;
static uint32_t lastFilterUs = 0;
static uint32_t lastOutputMs = 0;
static uint32_t lastLedMs    = 0;
static uint8_t  outputHz     = RATE_DEFAULT_HZ;
static uint16_t outputIntervalMs = 1000 / RATE_DEFAULT_HZ;

static float    gyroBias[3]  = {0, 0, 0};
static float    roll = 0, pitch = 0;          // filtered, absolute
static bool     isLevel      = false;
static uint8_t  ledLevel[NUM_LEDS];

static char     cmdBuf[12];
static uint8_t  cmdLen       = 0;
static bool     cmdOverflow  = false;

// ---------------------------------------------------------------------------
// LEDs
// ---------------------------------------------------------------------------
static void setLeds(const uint8_t v[NUM_LEDS]) {
  for (uint8_t i = 0; i < NUM_LEDS; i++) {
    ledLevel[i] = v[i];
    analogWrite(LED_PINS[i], v[i]);
  }
}

static void setLedPattern(uint8_t mask) {      // bit i = LED i full on
  uint8_t v[NUM_LEDS];
  for (uint8_t i = 0; i < NUM_LEDS; i++) v[i] = (mask >> i) & 1 ? 255 : 0;
  setLeds(v);
}

// Power-on self test: sweep left to right and back, so wiring faults show.
static void ledSweep() {
  for (int8_t i = 0; i < NUM_LEDS; i++)      { setLedPattern(1 << i); delay(70); }
  for (int8_t i = NUM_LEDS - 2; i >= 0; i--) { setLedPattern(1 << i); delay(70); }
  setLedPattern(0);
}

// ---------------------------------------------------------------------------
// I2C + MPU6050
// ---------------------------------------------------------------------------
static bool writeReg(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

static bool readRegs(uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

static bool mpuProbe() {
  if (!readRegs(REG_WHO_AM_I, &chipId, 1)) {
    Serial.println(F("#ERROR MPU6050 not found at 0x68. Check wiring (SDA->A4, SCL->A5, VCC, GND)."));
    return false;
  }
  if (chipId != WHO_AM_I_MPU6050) {
    Serial.print(F("#WARN WHO_AM_I is 0x"));
    Serial.print(chipId, HEX);
    Serial.println(F(", not 0x68: MPU6500-family clone. Using compatible settings."));
  }
  return true;
}

static bool mpuInit() {
  bool ok = writeReg(REG_PWR_MGMT_1,   0x01)
         && writeReg(REG_CONFIG,       0x03)    // gyro DLPF ~44 Hz
         && writeReg(REG_SMPLRT_DIV,   0x04)    // 200 Hz
         && writeReg(REG_GYRO_CONFIG,  0x00)    // +/-250 deg/s
         && writeReg(REG_ACCEL_CONFIG, 0x00);   // +/-2 g
  if (ok && chipId != WHO_AM_I_MPU6050) ok = writeReg(REG_ACCEL_CONFIG2, 0x03);
  return ok;
}

// Accel in g, gyro in deg/s (bias removed). Temperature is not needed here.
static bool mpuRead(float a[3], float g[3], int16_t rawG[3]) {
  uint8_t b[14];
  if (!readRegs(REG_ACCEL_XOUT_H, b, sizeof(b))) return false;
  for (uint8_t k = 0; k < 3; k++) {
    a[k]    = (int16_t)((b[2 * k] << 8) | b[2 * k + 1]) / ACCEL_LSB_PER_G;
    rawG[k] = (int16_t)((b[8 + 2 * k] << 8) | b[9 + 2 * k]);
    g[k]    = (rawG[k] - gyroBias[k]) / GYRO_LSB_PER_DPS;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Gyro calibration (same method as mpu6050_stream: mean + std-dev check)
// ---------------------------------------------------------------------------
static bool sampleGyroBias(float bias[3], float &noiseDps) {
  int16_t ref[3] = {0, 0, 0};
  float sum[3] = {0, 0, 0}, sumSq[3] = {0, 0, 0};
  uint32_t next = micros();

  for (uint16_t i = 0; i < CAL_WARMUP_SAMPLES + CAL_SAMPLES; i++) {
    while ((int32_t)(micros() - next) < 0) { }
    next += FILTER_INTERVAL_US;

    float a[3], g[3];
    int16_t raw[3];
    if (!mpuRead(a, g, raw)) return false;
    if (i < CAL_WARMUP_SAMPLES) continue;
    for (uint8_t k = 0; k < 3; k++) {
      if (i == CAL_WARMUP_SAMPLES) ref[k] = raw[k];
      float d = raw[k] - ref[k];
      sum[k] += d;
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

static bool calibrateGyro() {
  setLedPattern(0b01010);   // both yellows: "calibrating, keep still"
  float bias[3], noiseDps = 0;
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
  for (uint8_t k = 0; k < 3; k++) gyroBias[k] = bias[k];
  Serial.print(F("# Calibration done, noise_dps="));
  Serial.println(noiseDps, 2);
  return true;
}

// ---------------------------------------------------------------------------
// Tilt filter (complementary, roll + pitch only)
// ---------------------------------------------------------------------------
static float accelRoll(const float a[3])  { return atan2(a[1], a[2]) * RAD_TO_DEG_F; }
static float accelPitch(const float a[3]) { return atan2(-a[0], sqrt(a[1] * a[1] + a[2] * a[2])) * RAD_TO_DEG_F; }

static float wrap180(float x) {
  while (x >= 180.0f) x -= 360.0f;
  while (x < -180.0f) x += 360.0f;
  return x;
}

static bool seedFilter() {
  float a[3], g[3];
  int16_t raw[3];
  if (!mpuRead(a, g, raw)) return false;
  roll  = accelRoll(a);
  pitch = accelPitch(a);
  lastFilterUs = micros();
  lastOutputMs = millis();
  return true;
}

static bool filterStep(uint32_t nowUs) {
  float dt = (nowUs - lastFilterUs) * 1e-6f;
  lastFilterUs = nowUs;
  if (dt > MAX_DT_S) dt = MAX_DT_S;

  float a[3], g[3];
  int16_t raw[3];
  if (!mpuRead(a, g, raw)) return false;
  roll  = wrap180(roll  + g[0] * dt);
  pitch = wrap180(pitch + g[1] * dt);
  roll  = wrap180(roll  + (1.0f - ALPHA) * wrap180(accelRoll(a)  - roll));
  pitch = wrap180(pitch + (1.0f - ALPHA) * wrap180(accelPitch(a) - pitch));
  return true;
}

static float relRoll()  { return wrap180(roll  - cfg.zeroRoll); }
static float relPitch() { return wrap180(pitch - cfg.zeroPitch); }

// The angle shown on the LEDs, with the chosen axis and direction.
static float levelAngle() {
  float a = cfg.axisPitch ? relPitch() : relRoll();
  return cfg.invert ? -a : a;
}

// ---------------------------------------------------------------------------
// Bubble display
//   |angle| <= tol         -> green centre LED only
//   tol < |angle| < range  -> a "bubble" glides from the centre towards the
//                             outer LED, cross-fading between neighbours
//   |angle| >= range       -> outer red LED blinks: "way off"
// ---------------------------------------------------------------------------
static void updateLeds(uint32_t nowMs) {
  float a     = levelAngle();
  float mag   = fabs(a);
  float tol   = cfg.tolTenths / 10.0f;
  float range = cfg.rangeDeg;
  if (range <= tol) range = tol + 1.0f;

  isLevel = isLevel ? mag <= tol * HYSTERESIS : mag <= tol;

  uint8_t v[NUM_LEDS] = {0, 0, 0, 0, 0};
  if (isLevel) {
    v[CENTER] = 255;
  } else if (mag >= range) {
    bool on = (nowMs / 125) & 1;               // 4 Hz blink
    v[a > 0 ? NUM_LEDS - 1 : 0] = on ? 255 : 0;
  } else {
    float m   = (mag - tol) / (range - tol);   // 0..1 between tolerance and full scale
    if (m < 0) m = 0;
    float pos = (a > 0 ? 1 : -1) * (0.5f + 1.5f * m);   // -2..+2, LED index - CENTER
    for (uint8_t i = 0; i < NUM_LEDS; i++) {
      float w = 1.0f - fabs(pos - (int8_t)(i - CENTER));
      if (w > 0) v[i] = (uint8_t)(255.0f * w * w + 0.5f);  // squared: looks linear to the eye
    }
  }
  setLeds(v);
}

// ---------------------------------------------------------------------------
// Sensor lifecycle
// ---------------------------------------------------------------------------
static void sensorLost() {
  Serial.println(F("#ERROR I2C read failed. Sensor disconnected?"));
  sensorOk = false;
  lastRetryMs = millis();
}

static bool calibrateAndStart() {
  if (!calibrateGyro() || !seedFilter()) {
    sensorLost();
    return false;
  }
  Serial.println(F("#READY"));
  return true;
}

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
static void printConfig() {
  Serial.print(F("#CFG axis="));
  Serial.print(cfg.axisPitch ? F("pitch") : F("roll"));
  Serial.print(F(" tol="));
  Serial.print(cfg.tolTenths / 10.0f, 1);
  Serial.print(F(" range="));
  Serial.print(cfg.rangeDeg);
  Serial.print(F(" invert="));
  Serial.print(cfg.invert);
  Serial.print(F(" rate="));
  Serial.println(outputHz);
}

static void printDataLine(uint32_t tMs) {
  Serial.print(F("V,"));
  Serial.print(tMs);
  Serial.print(','); Serial.print(relRoll(), 2);
  Serial.print(','); Serial.print(relPitch(), 2);
  Serial.print(','); Serial.print(levelAngle(), 2);
  Serial.print(','); Serial.print(isLevel ? 1 : 0);
  for (uint8_t i = 0; i < NUM_LEDS; i++) {
    Serial.print(',');
    Serial.print(ledLevel[i]);
  }
  Serial.println();
}

static void printBanner() {
  Serial.println(F("# mpu6050_leveler v1.0"));
  Serial.println(F("# FORMAT V,t_ms,roll_deg,pitch_deg,angle_deg,level,led1,led2,led3,led4,led5"));
  Serial.println(F("# Commands: C=calibrate L=set level X=clear level A=axis I=invert T<deg> S<deg> R<hz> ?"));
}

static void printStatus() {
  Serial.print(F("#INFO sensor="));
  Serial.print(sensorOk ? F("ok") : F("missing"));
  Serial.print(F(" who_am_i=0x"));
  Serial.print(chipId, HEX);
  Serial.print(F(" zero_roll="));
  Serial.print(cfg.zeroRoll, 2);
  Serial.print(F(" zero_pitch="));
  Serial.println(cfg.zeroPitch, 2);
  printConfig();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
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

// "0.5", "2", "1.5", ".5" -> tenths (5, 20, 15, 5). One decimal place at most.
static bool parseTenths(const char *s, uint16_t &out) {
  uint16_t whole = 0, frac = 0;
  bool digits = false;
  for (; *s && *s != '.'; s++) {
    if (*s < '0' || *s > '9') return false;
    whole = whole * 10 + (*s - '0');
    if (whole > 100) return false;
    digits = true;
  }
  if (*s == '.') {
    s++;
    if (*s >= '0' && *s <= '9') { frac = *s - '0'; s++; digits = true; }
    if (*s) return false;
  }
  if (!digits) return false;
  out = whole * 10 + frac;
  return true;
}

static void ok(const __FlashStringHelper *what) {
  Serial.print(F("#OK "));
  Serial.println(what);
  printConfig();
}

static void handleCommand(char *cmd) {
  for (char *p = cmd; *p; p++) if (*p >= 'a' && *p <= 'z') *p -= 'a' - 'A';
  const char op = cmd[0];
  const char *arg = cmd + 1;
  uint16_t n;

  switch (op) {
    case 'C':
      if (!sensorOk) { Serial.println(F("#ERROR No sensor; cannot calibrate.")); break; }
      if (calibrateAndStart()) Serial.println(F("#OK C"));
      break;

    case 'L':
      if (!sensorOk) { Serial.println(F("#ERROR No sensor.")); break; }
      cfg.zeroRoll = roll;
      cfg.zeroPitch = pitch;
      saveSettings();
      ok(F("L level reference saved"));
      break;

    case 'X':
      cfg.zeroRoll = cfg.zeroPitch = 0;
      saveSettings();
      ok(F("X level reference cleared"));
      break;

    case 'A':
      if (*arg == 'R')      cfg.axisPitch = 0;
      else if (*arg == 'P') cfg.axisPitch = 1;
      else if (*arg == '\0') cfg.axisPitch ^= 1;
      else { Serial.println(F("#ERROR A, AR or AP")); break; }
      saveSettings();
      ok(F("A"));
      break;

    case 'I':
      cfg.invert ^= 1;
      saveSettings();
      ok(F("I"));
      break;

    case 'T':
      if (!parseTenths(arg, n) || n < 1 || n > 50) { Serial.println(F("#ERROR T expects 0.1-5.0 deg, e.g. T0.5")); break; }
      cfg.tolTenths = n;
      saveSettings();
      ok(F("T"));
      break;

    case 'S':
      if (!parseUint(arg, n) || n < 2 || n > 45) { Serial.println(F("#ERROR S expects 2-45 deg, e.g. S10")); break; }
      cfg.rangeDeg = n;
      saveSettings();
      ok(F("S"));
      break;

    case 'R':
      if (!parseUint(arg, n) || n < 1 || n > RATE_MAX_HZ) { Serial.println(F("#ERROR R expects 1-50 Hz, e.g. R25")); break; }
      outputHz = n;
      outputIntervalMs = 1000 / n;
      ok(F("R"));
      break;

    case '?':
      printStatus();
      break;

    default:
      Serial.print(F("#ERROR Unknown command '"));
      Serial.print(cmd);
      Serial.println(F("'. Use C, L, X, A, I, T<deg>, S<deg>, R<hz> or ?"));
  }
}

static void pollCommands() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdOverflow) Serial.println(F("#ERROR Command too long"));
      else if (cmdLen > 0) { cmdBuf[cmdLen] = '\0'; handleCommand(cmdBuf); }
      cmdLen = 0;
      cmdOverflow = false;
    } else if (c == ' ') {
      continue;
    } else if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = c;
    } else {
      cmdOverflow = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
void setup() {
  for (uint8_t i = 0; i < NUM_LEDS; i++) pinMode(LED_PINS[i], OUTPUT);
  Serial.begin(SERIAL_BAUD);
  Wire.begin();
  Wire.setClock(400000);
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(3000, true);
#endif

  loadSettings();
  printBanner();
  printConfig();
  ledSweep();
  connectSensor();
}

void loop() {
  pollCommands();
  uint32_t nowMs = millis();

  if (!sensorOk) {
    setLedPattern(((nowMs / 250) & 1) ? 0b10001 : 0);   // outer reds blink: no sensor
    if (nowMs - lastRetryMs >= RETRY_INTERVAL_MS) connectSensor();
    return;
  }

  uint32_t nowUs = micros();
  if (nowUs - lastFilterUs >= FILTER_INTERVAL_US) {
    if (!filterStep(nowUs)) { sensorLost(); return; }
  }

  if (nowMs - lastLedMs >= LED_INTERVAL_MS) {
    lastLedMs = nowMs;
    updateLeds(nowMs);
  }

  if (nowMs - lastOutputMs >= outputIntervalMs) {
    lastOutputMs += outputIntervalMs;
    if (nowMs - lastOutputMs >= outputIntervalMs) lastOutputMs = nowMs;
    printDataLine(nowMs);
  }
}
