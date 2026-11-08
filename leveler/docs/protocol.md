# Leveler serial protocol

115200 baud, 8N1, one line per message, `\r\n` line endings.

## Data line (default 25 Hz)

```
V,<t_ms>,<roll>,<pitch>,<angle>,<level>,<led1>,<led2>,<led3>,<led4>,<led5>
```

| Field | Unit | Meaning |
|-------|------|---------|
| `t_ms` | ms | Time since the Arduino started |
| `roll`, `pitch` | ° | Tilt relative to the saved level reference |
| `angle` | ° | The angle the LEDs show: the selected axis, sign flipped if inverted |
| `level` | 0/1 | 1 when `angle` is within the tolerance |
| `led1`…`led5` | 0–255 | PWM brightness of each LED, left to right (D3, D5, D6, D9, D10) |

Example: `V,48210,2.31,-0.42,2.31,0,0,0,32,182,0`

## Settings line

Sent at startup and after every command that changes a setting:

```
#CFG axis=roll tol=0.5 range=10 invert=0 rate=25
```

## Status lines

Lines starting with `#` are status messages: `#READY`, `#OK`, `#INFO`, `#WARN`, `#ERROR`. Lines starting with `# ` are plain info.

## Commands

Each command is one line ending in a newline. Upper or lower case both work.

| Command | Action | Saved to EEPROM |
|---------|--------|:---:|
| `C` | Recalibrate the gyro (keep still for about 2 s) | |
| `L` | Save the current position as level | ✓ |
| `X` | Clear the level reference | ✓ |
| `A` / `AR` / `AP` | Toggle the axis, or pick roll or pitch | ✓ |
| `I` | Invert the LED direction | ✓ |
| `T<deg>` | Level tolerance, 0.1–5.0 (e.g. `T0.5`) | ✓ |
| `S<deg>` | Full-scale tilt for the outer LEDs, 2–45 (e.g. `S10`) | ✓ |
| `R<hz>` | Output rate, 1–50 | |
| `?` | Print status and settings | |

## LED mapping

| Tilt | LEDs |
|------|------|
| within ± tolerance | green centre LED only |
| tolerance to full scale | a light glides from the centre outward, fading between neighbours |
| past full scale | the outer red LED on that side blinks |
| sensor missing | both red LEDs blink together |
| calibrating | both yellow LEDs on |
