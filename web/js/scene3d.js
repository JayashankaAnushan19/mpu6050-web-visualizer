/**
 * Three.js scene: a GY-521 board with body-fixed X/Y/Z arrows that follows
 * the sensor's roll, pitch and yaw.
 *
 * Frames: the sensor uses Z-up; Three.js uses Y-up. Mapping sensor -> scene:
 *   X -> +X,  Y -> -Z,  Z -> +Y   (keeps the frame right-handed)
 * The firmware's attitude is R = Rz(yaw)·Ry(pitch)·Rx(roll). In scene axes
 * that is a rotation about Y (yaw), then -Z (pitch), then X (roll), i.e. a
 * Three.js Euler with order 'YZX' and (x, y, z) = (roll, yaw, -pitch).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEG = Math.PI / 180;
const AXIS_COLORS = { x: 0xff5c5c, y: 0x4cd97b, z: 0x4da3ff };
const BOARD = { w: 3.2, t: 0.12, d: 2.2 };         // scene units
const TEX = { w: 1024, h: 704 };                   // matches the board's aspect
const SMOOTHING = 0.25;                            // slerp factor per frame

export class BoardScene {
  constructor(container) {
    this.container = container;
    this.target = new THREE.Quaternion();
    this.euler = new THREE.Euler(0, 0, 0, 'YZX');

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.camera.position.set(3.6, 2.9, 4.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 16;

    this.#addLights();
    this.#addFloor();
    this.board = this.#buildBoard();
    this.scene.add(this.board);

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
  }

  /** Set the attitude to show, in degrees. The model eases toward it. */
  setAttitude(rollDeg, pitchDeg, yawDeg) {
    this.euler.set(rollDeg * DEG, yawDeg * DEG, -pitchDeg * DEG, 'YZX');
    this.target.setFromEuler(this.euler);
  }

  /** Call once per animation frame. */
  render() {
    this.board.quaternion.slerp(this.target, SMOOTHING);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #addLights() {
    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x10151c, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 8, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 });
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x6aa8ff, 0.6);
    rim.position.set(-5, 2, -4);
    this.scene.add(rim);
  }

  #addFloor() {
    const y = -1.5;
    const grid = new THREE.GridHelper(16, 32, 0x2b3747, 0x18212c);
    grid.position.y = y;
    this.scene.add(grid);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = y + 0.001;
    shadow.receiveShadow = true;
    this.scene.add(shadow);
  }

  #buildBoard() {
    const group = new THREE.Group();
    const { w, t, d } = BOARD;

    // PCB: textured top, plain edges.
    const topTex = makePcbTexture();
    topTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.55, metalness: 0.1 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x163c78, roughness: 0.7 });
    const bottom = new THREE.MeshStandardMaterial({ color: 0x12305f, roughness: 0.8 });
    const pcb = new THREE.Mesh(new THREE.BoxGeometry(w, t, d), [edge, edge, top, bottom, edge, edge]);
    pcb.castShadow = true;
    group.add(pcb);

    // MPU6050 package (QFN, 4x4 mm on a 21x16 mm board).
    const chip = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.1, 0.62),
      new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.35, metalness: 0.2 })
    );
    chip.position.set(0, t / 2 + 0.05, texToZ(336));
    chip.castShadow = true;
    group.add(chip);

    // A few SMD parts for realism.
    const smd = new THREE.MeshStandardMaterial({ color: 0xc9b38a, roughness: 0.5 });
    for (const [x, z, sx, sz] of [[-0.9, -0.15, 0.22, 0.12], [-0.9, 0.15, 0.22, 0.12], [0.85, -0.25, 0.12, 0.22], [0.95, 0.2, 0.3, 0.3]]) {
      const part = new THREE.Mesh(new THREE.BoxGeometry(sx, 0.06, sz), x > 0.9 ? chip.material : smd);
      part.position.set(x, t / 2 + 0.03, z);
      group.add(part);
    }

    group.add(makeHeader(t, d));

    // Body-fixed axis arrows, starting at the chip.
    const origin = new THREE.Vector3(0, t / 2 + 0.1, texToZ(336));
    group.add(makeArrow(new THREE.Vector3(1, 0, 0), origin, 2.3, AXIS_COLORS.x, 'X'));
    group.add(makeArrow(new THREE.Vector3(0, 0, -1), origin, 1.9, AXIS_COLORS.y, 'Y'));
    group.add(makeArrow(new THREE.Vector3(0, 1, 0), origin, 1.6, AXIS_COLORS.z, 'Z'));
    return group;
  }
}

// --- Model helpers ---------------------------------------------------------

/** Texture row (0 = far edge) to scene Z on the board top. */
function texToZ(row) {
  return (row / TEX.h - 0.5) * BOARD.d;
}

/** 8-pin male header under the near edge, matching the pads on the texture. */
function makeHeader(t, d) {
  const group = new THREE.Group();
  const z = texToZ(650);
  const plastic = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD.w * 0.97, 0.22, 0.24),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 })
  );
  plastic.position.set(0, -t / 2 - 0.11, z);
  plastic.castShadow = true;
  group.add(plastic);

  const gold = new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 0.9, roughness: 0.3 });
  const pinGeo = new THREE.BoxGeometry(0.06, 0.75, 0.06);
  for (let i = 0; i < 8; i++) {
    const pin = new THREE.Mesh(pinGeo, gold);
    pin.position.set((i + 0.5) * (BOARD.w / 8) - BOARD.w / 2, -t / 2 - 0.26, z);
    pin.castShadow = true;
    group.add(pin);
  }
  return group;
}

/** Thick arrow (cylinder + cone) with a text label at the tip. */
function makeArrow(dir, origin, length, color, label) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4 });
  const headLen = 0.3;

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, length - headLen, 16), mat);
  shaft.position.y = (length - headLen) / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, headLen, 24), mat);
  head.position.y = length - headLen / 2;
  shaft.castShadow = head.castShadow = true;
  group.add(shaft, head);

  const sprite = makeLabel(label, color);
  sprite.position.y = length + 0.28;
  group.add(sprite);

  group.position.copy(origin);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return group;
}

function makeLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = '700 88px Inter, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#' + color.toString(16).padStart(6, '0');
  g.fillText(text, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(0.45, 0.45, 1);
  return sprite;
}

/** Draws the GY-521 top side: solder mask, silkscreen, pads and labels. */
function makePcbTexture() {
  const c = document.createElement('canvas');
  c.width = TEX.w;
  c.height = TEX.h;
  const g = c.getContext('2d');

  const grad = g.createLinearGradient(0, 0, TEX.w, TEX.h);
  grad.addColorStop(0, '#2160c4');
  grad.addColorStop(1, '#1a4c9e');
  g.fillStyle = grad;
  g.fillRect(0, 0, TEX.w, TEX.h);

  // Traces
  g.strokeStyle = 'rgba(140, 185, 255, 0.22)';
  g.lineWidth = 7;
  g.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    const x = (i + 0.5) * (TEX.w / 8);
    g.beginPath();
    g.moveTo(x, 650);
    g.lineTo(x, 540);
    g.lineTo(512 + (i - 3.5) * 22, 430);
    g.stroke();
  }

  // Silkscreen outline and chip footprint
  g.strokeStyle = 'rgba(255,255,255,0.75)';
  g.lineWidth = 4;
  g.strokeRect(14, 14, TEX.w - 28, TEX.h - 28);
  g.strokeRect(512 - 82, 336 - 82, 164, 164);

  // Mounting holes
  for (const x of [84, TEX.w - 84]) {
    g.fillStyle = '#d4af37';
    g.beginPath(); g.arc(x, 84, 44, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0b0f14';
    g.beginPath(); g.arc(x, 84, 28, 0, Math.PI * 2); g.fill();
  }

  // Text
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.font = '700 64px Inter, system-ui, sans-serif';
  g.fillText('GY-521', 512, 110);
  g.font = '500 30px Inter, system-ui, sans-serif';
  g.fillText('MPU-6050', 512, 152);

  // Pads + pin labels
  const pins = ['VCC', 'GND', 'SCL', 'SDA', 'XDA', 'XCL', 'AD0', 'INT'];
  g.font = '600 28px Inter, system-ui, sans-serif';
  pins.forEach((name, i) => {
    const x = (i + 0.5) * (TEX.w / 8);
    g.fillStyle = '#ffffff';
    g.fillText(name, x, 600);
    g.fillStyle = '#d4af37';
    g.beginPath(); g.arc(x, 650, 26, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#5c4a12';
    g.beginPath(); g.arc(x, 650, 11, 0, Math.PI * 2); g.fill();
  });

  // Axis legend as printed on real boards: X right, Y up (away), Z out of board
  drawSilkAxes(g, 820, 400);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function drawSilkAxes(g, x, y) {
  g.strokeStyle = '#ffffff';
  g.fillStyle = '#ffffff';
  g.lineWidth = 5;
  const arrow = (x2, y2) => {
    g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
    const a = Math.atan2(y2 - y, x2 - x);
    g.beginPath();
    g.moveTo(x2, y2);
    g.lineTo(x2 - 18 * Math.cos(a - 0.45), y2 - 18 * Math.sin(a - 0.45));
    g.lineTo(x2 - 18 * Math.cos(a + 0.45), y2 - 18 * Math.sin(a + 0.45));
    g.fill();
  };
  arrow(x + 110, y);
  arrow(x, y - 110);
  g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
  g.font = '700 32px Inter, system-ui, sans-serif';
  g.fillText('X', x + 135, y + 11);
  g.fillText('Y', x, y - 128);
  g.fillText('Z', x - 30, y + 40);
}
