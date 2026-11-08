# Serial protocol

Plain ASCII over USB serial, **115200 baud, 8N1**. Every message is one line ending in `\r\n`.

## Device → browser

### Data line

```
D,<t_ms>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>,<roll>,<pitch>,<yaw>,<tempC>
```

| # | Field   | Unit  | Decimals | Notes |
|---|---------|-------|----------|-------|
| 1 | `D`     |       |          | Line type marker |
| 2 | `t_ms`  | ms    | 0        | `millis()` since boot. Going backwards means the board restarted |
| 3–5 | `ax ay az` | g | 3        | Accelerometer, ±2 g range |
| 6–8 | `gx gy gz` | °/s | 2      | Gyroscope, ±250 °/s range, gyro bias already removed |
| 9 | `roll`  | °     | 2        | Rotation about X, −180…180 |
| 10 | `pitch` | °    | 2        | Rotation about Y, −90…90 |
| 11 | `yaw`   | °    | 2        | Rotation about Z, −180…180, **drifts** (gyro only) |
| 12 | `tempC` | °C   | 1        | Die temperature (reads a few °C above room temperature) |

Example:

```
D,48211,0.012,-0.004,1.003,0.12,-0.05,0.01,-0.23,-0.69,12.40,28.6
```

Default rate is 50 Hz (change with `R<hz>`). A line is about 65–75 bytes, so 100 Hz uses about 60% of the 115200 baud link.

### Status lines

Any line starting with `#` is a human-readable status message. An optional tag follows the `#`:

| Prefix    | Meaning |
|-----------|---------|
| `# ...`   | Information (banner, calibration progress) |
| `#READY`  | Calibration finished, data lines follow |
| `#OK X`   | Command `X` accepted |
| `#INFO`   | Reply to `?` (key=value pairs) |
| `#WARN`   | Something is off but streaming continues |
| `#ERROR`  | Something failed (e.g. sensor not found, bad command) |

A normal startup looks like this:

```
# mpu6050_stream v1.0
# FORMAT D,t_ms,ax_g,ay_g,az_g,gx_dps,gy_dps,gz_dps,roll_deg,pitch_deg,yaw_deg,temp_c
# Commands: C=calibrate Z=zero yaw R<hz>=rate (1-100) ?=status
# MPU6050 found
# Calibrating gyro, keep the sensor still (1/3)
# Calibration done, bias_dps=-2.61,3.08,0.84 noise_dps=0.71
#READY
D,2741,0.034,0.006,1.067,...
```

## Browser → device

Commands are a single line ending in `\n` or `\r`. They are not case sensitive, and spaces are ignored.

| Command  | Action | Reply |
|----------|--------|-------|
| `C`      | Recalibrate the gyro bias (about 2.5 s, keep the board still) | `#READY`, `#OK C` |
| `Z`      | Set yaw to 0 | `#OK Z` |
| `R<hz>`  | Output rate 1–100 Hz, e.g. `R25` | `#OK R25` or `#ERROR ...` |
| `?`      | Print the current settings | `#INFO sensor=ok who_am_i=0x68 rate_hz=50 ...` |

## Parsing rules used by the web app

- Text is split into lines on `\n`. A trailing `\r` is removed. A partial line waits in a buffer for the rest of its text.
- A `D` line must have exactly 12 fields, and every value must be a finite number. Otherwise it is counted as a "bad line" and skipped.
- Lines starting with `#` go to the log console.
- Anything else counts as a bad line. A few appear right after connecting, while the Uno is resetting, and that is normal.
