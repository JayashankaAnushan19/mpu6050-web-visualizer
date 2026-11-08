# MPU6050 Projects

Arduino Uno + MPU6050 projects that you can watch live in the browser. Each project streams over USB, and the web page reads it with **Web Serial**, so there is nothing to install. Every page also has a **demo mode**, so you can try it without hardware.

[![Live demos](https://img.shields.io/badge/demos-live-3b82f6)](https://jayashankaanushan19.github.io/mpu6050-web-visualizer/)
![Arduino](https://img.shields.io/badge/Arduino-Uno-00979D?logo=arduino&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

| | Project | What it does | Try it |
|---|---------|--------------|--------|
| 01 | [**Motion Visualizer**](visualizer/README.md) | A 3D board that follows roll, pitch and yaw, with a horizon, live charts and CSV recording | [demo](https://jayashankaanushan19.github.io/mpu6050-web-visualizer/visualizer/web/?demo) |
| 02 | [**Digital Leveler**](leveler/README.md) | A spirit level with 5 LEDs and a web view with a vial and a bullseye | [demo](https://jayashankaanushan19.github.io/mpu6050-web-visualizer/leveler/web/?demo) |

<p>
  <img src="visualizer/docs/screenshot.png" width="49%" alt="Motion Visualizer">
  <img src="leveler/docs/screenshot.png" width="49%" alt="Digital Leveler">
</p>

## Quick start

1. **Wire** the GY-521 to the Uno: VCC→5V, GND→GND, SCL→A5, SDA→A4. The leveler also needs 5 LEDs (see [its wiring](leveler/README.md#wiring)).
2. **Upload** the sketch of the project you want from its `firmware/` folder with the Arduino IDE.
3. **Open the web app.** On Windows, double-click **`start.bat`**. It starts a local server and opens the project list in Chrome or Edge. Pick a project and click **Connect**.

```
start.bat                   project list
start.bat visualizer        open the visualizer
start.bat leveler demo      open the leveler in demo mode
```

On other systems, serve this folder with any static server, e.g. `python -m http.server 8000`, then open `http://localhost:8000`.

> Web Serial needs **desktop Chrome or Edge**, and the page must come from `http://localhost` or `https://`. Opening the HTML file directly won't work.

## Repository layout

```
mpu6050-web-visualizer/
├── index.html          Project list (home page, local and on GitHub Pages)
├── visualizer/         01 Motion Visualizer: firmware, web app, docs
├── leveler/            02 Digital Leveler: firmware, web app, docs
├── start.bat           One-click launcher (Windows)
├── tools/serve.ps1     Tiny local web server used by start.bat
└── .github/workflows/  Publishes the web apps to GitHub Pages
```

Each project is self-contained: its own sketch, web app, `platformio.ini` and README.

## GitHub Pages

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the home page and both web apps on every push to `main`, so the live demo links work. To turn it on once, go to **Settings → Pages → Source: GitHub Actions**.

## Versions

- **v1.0** (git tag): the Motion Visualizer on its own.
- **main**: the multi-project layout, with the Digital Leveler added.

## License

[MIT](LICENSE)
