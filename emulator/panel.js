// SPDX-License-Identifier: GPL-3.0-only
// The virtual FM-1 in 3D: a rounded body, the front drawn by face.js, the screen as its own pixel-sharp
// part and real knobs. fm1-emu's panel (MIT) is only asked where its controls are (face.js scanControls).
import {scanControls, LAYOUTS, hitTest, drawFace, faceKey} from './face.js';

const UNIT = 12.8 / 1000;               // world units per design pixel (the landscape front is 12.8 wide)
const DEPTH = 0.42, BEVEL = 0.07;
const phoneUpright = () => innerWidth < 700 && innerHeight > innerWidth;

let fontReady;
function loadFont() {
  fontReady ??= (async () => {
    try {
      const face = new FontFace('DotGothic16', `url(${new URL('vendor/fonts/DotGothic16-subset.woff', import.meta.url)})`);
      document.fonts.add(await Promise.race([face.load(), new Promise((_, no) => setTimeout(no, 4000))]));
    } catch { /* the labels fall back to the monospace font */ }
  })();
  return fontReady;
}

export async function createPanel(host, ui, controls, onError) {
  const T = await import('./vendor/three.module.min.js');
  scanControls(ui);                     // the emulator's panel has the FM-1's controls, in order
  await loadFont();
  const renderer = new T.WebGLRenderer({antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const canvas = renderer.domElement;
  canvas.id = 'emu-canvas'; canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D FM-1. Click keys and buttons, drag knobs, or focus here to use arrow keys, Z, X, Shift and Enter.');
  host.replaceChildren(canvas);
  const scene = new T.Scene(), camera = new T.PerspectiveCamera(30, 1, 0.1, 200);
  scene.add(new T.HemisphereLight(0xffffff, 0x2a2830, 2.4));
  const light = new T.DirectionalLight(0xffffff, 3.2);
  light.position.set(-6, 9, 14); scene.add(light);
  const model = new T.Group(); scene.add(model);

  const faceCanvas = document.createElement('canvas'), g = faceCanvas.getContext('2d');
  const faceTexture = new T.CanvasTexture(faceCanvas);
  faceTexture.colorSpace = T.SRGBColorSpace; faceTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const lcdCanvas = document.createElement('canvas'); lcdCanvas.width = lcdCanvas.height = 240;
  const lcdContext = lcdCanvas.getContext('2d'), lcdImage = lcdContext.createImageData(240, 240);
  lcdContext.fillStyle = '#000'; lcdContext.fillRect(0, 0, 240, 240);
  const lcdTexture = new T.CanvasTexture(lcdCanvas);
  lcdTexture.colorSpace = T.SRGBColorSpace; lcdTexture.magFilter = T.NearestFilter; lcdTexture.minFilter = T.LinearFilter;
  lcdTexture.generateMipmaps = false;

  const knobMaterial = new T.MeshStandardMaterial({color: 0x2b2c30, roughness: 0.55, metalness: 0.25});
  const capMaterial = new T.MeshStandardMaterial({color: 0x34363a, roughness: 0.4, metalness: 0.3});
  const bodyMaterial = new T.MeshStandardMaterial({color: 0x585b60, roughness: 0.7, metalness: 0.2});
  let L, kind, face, lcd, knobs = [], scale = 2, last = '', leds = new Float32Array(41), lsdj = true;
  let pressed = new Set(), flat = false, tilt = 24, yaw = -12;

  function roundedShape(w, h, r) {
    const s = new T.Shape(), x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  // A knob: a dark skirt, a ridged grip, a smooth top and a pointer line (white on MASTER).
  function makeKnob(d, control) {
    const r = d / 2 * UNIT, group = new T.Group();
    const skirt = new T.Mesh(new T.CylinderGeometry(r * 1.02, r * 1.1, 0.1, 48), knobMaterial);
    skirt.rotation.x = Math.PI / 2; skirt.position.z = 0.05;
    const grip = new T.CylinderGeometry(r * 0.86, r * 0.9, 0.36, 72, 1);
    const p = grip.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), a = Math.atan2(z, x), len = Math.hypot(x, z);
      if (len > r * 0.5) { const k = 1 + 0.035 * Math.cos(a * 24); p.setX(i, x * k); p.setZ(i, z * k); }
    }
    grip.computeVertexNormals();
    const cap = new T.Mesh(grip, capMaterial);
    cap.rotation.x = Math.PI / 2; cap.position.z = 0.28;
    const line = new T.Mesh(new T.BoxGeometry(r * 0.12, r * 0.5, 0.01),
      new T.MeshBasicMaterial({color: control === 7 ? 0xffffff : 0xc8c9cc}));
    line.position.set(0, r * 0.5, 0.465);
    for (const m of [skirt, cap, line]) { m.userData.control = control; group.add(m); }
    return group;
  }
  function build() {
    kind = phoneUpright() ? 'portrait' : 'landscape'; L = LAYOUTS[kind];
    for (const child of [...model.children]) { model.remove(child); child.traverse(o => o.geometry?.dispose()); }
    const W = L.W * UNIT, H = L.H * UNIT, R = L.R * UNIT;
    const body = new T.Mesh(new T.ExtrudeGeometry(roundedShape(W - 2 * BEVEL, H - 2 * BEVEL, R - BEVEL),
      {depth: DEPTH, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelSegments: 4, curveSegments: 16}), bodyMaterial);
    body.position.z = -DEPTH - BEVEL; model.add(body);
    const faceGeometry = new T.ShapeGeometry(roundedShape(W, H, R), 16), pos = faceGeometry.attributes.position, uv = faceGeometry.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / W + 0.5, pos.getY(i) / H + 0.5);
    scale = kind === 'portrait' ? 2.5 : 2;
    faceCanvas.width = Math.round(L.W * scale); faceCanvas.height = Math.round(L.H * scale);
    face = new T.Mesh(faceGeometry, new T.MeshBasicMaterial({map: faceTexture, toneMapped: false}));
    face.position.z = 0.002; model.add(face);
    const [lx, ly, lw, lh] = L.lcd;
    lcd = new T.Mesh(new T.PlaneGeometry(lw * UNIT, lh * UNIT), new T.MeshBasicMaterial({map: lcdTexture, toneMapped: false}));
    lcd.position.set((lx + lw / 2) * UNIT - W / 2, H / 2 - (ly + lh / 2) * UNIT, 0.004); model.add(lcd);
    knobs = [];
    for (let i = 0; i < 8; i++) {
      const k = L.knobs[i], knob = makeKnob(k.d, i);
      knob.position.set(k.cx * UNIT - W / 2, H / 2 - k.cy * UNIT, 0.003);
      model.add(knob); knobs.push(knob);
    }
    last = ''; paint(); resize();
  }
  function paint() {
    const key = faceKey(leds, pressed, lsdj);
    if (key === last) return;
    last = key;
    drawFace(g, L, scale, {leds, pressed, lsdj});
    faceTexture.needsUpdate = true;
  }
  const render = () => renderer.render(scene, camera);
  function resize() {
    const w = Math.max(240, host.clientWidth), ratio = L.H / L.W;
    const h = Math.round(Math.min(w * ratio * 1.08, Math.max(320, innerHeight - 60)));
    renderer.setSize(w, h); camera.aspect = w / h;
    const half = Math.tan(camera.fov * Math.PI / 360), margin = flat ? 1.04 : 1.14;
    camera.position.set(0, 0, Math.max(L.H * UNIT / 2 / half, L.W * UNIT / 2 / (half * camera.aspect)) * margin + DEPTH);
    camera.updateProjectionMatrix(); render();
  }
  const observer = new ResizeObserver(() => { if ((phoneUpright() ? 'portrait' : 'landscape') !== kind) build(); else resize(); });
  observer.observe(host);
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault(); controls.releaseAll(); onError('The 3D graphics context was lost. Reload the page to restart the emulator.');
  });
  function rotate() {
    model.rotation.set((flat ? 0 : tilt) * Math.PI / 180, (flat ? 0 : yaw) * Math.PI / 180, 0);
    resize();
  }
  const ray = new T.Raycaster(), mouse = new T.Vector2();
  function hit(e) {
    const r = canvas.getBoundingClientRect();
    mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const h = ray.intersectObjects([face, lcd, ...knobs], true)[0];
    if (!h) return -1;
    if (h.object.userData.control !== undefined) return h.object.userData.control;
    if (h.object !== face) return -1;
    return hitTest(L, h.uv.x * L.W, (1 - h.uv.y) * L.H);
  }
  // design pixels per screen pixel, for knob drags
  const perPixel = () => L.W / Math.max(240, canvas.clientWidth) * (camera.aspect > L.W / L.H ? camera.aspect / (L.W / L.H) : 1);
  const pointers = new Map();
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); canvas.focus({preventScroll: true}); canvas.setPointerCapture(e.pointerId);
    const id = hit(e);
    pointers.set(e.pointerId, {id, y: e.clientY, acc: 0});
    if (id >= 100 && id < 141) controls.key(`pointer-${e.pointerId}`, id - 100, true);
  });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const delta = (p.y - e.clientY) * perPixel();
    if (p.id >= 0 && p.id < 7) {
      p.acc += delta;
      const clicks = Math.trunc(p.acc / 10);
      if (clicks) { p.acc -= clicks * 10; controls.turn(p.id, clicks); }
    } else if (p.id === 7) controls.pot(delta * 5);
    p.y = e.clientY;
  });
  function release(e) {
    controls.key(`pointer-${e.pointerId}`, 0, false); pointers.delete(e.pointerId);
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, release);
  canvas.addEventListener('wheel', e => {
    const id = hit(e);
    if (id < 0 || id > 7) return;
    e.preventDefault();
    if (id === 7) controls.pot(-e.deltaY);
    else controls.turn(id, e.deltaY < 0 ? 1 : -1);
  }, {passive: false});
  canvas.addEventListener('keydown', controls.keydown);
  canvas.addEventListener('keyup', controls.keyup);
  canvas.addEventListener('blur', controls.releaseAll);
  build(); rotate();
  return {
    canvas,
    get layout() { return kind; },
    angle(nextTilt, nextYaw) { tilt = nextTilt; yaw = nextYaw; rotate(); },
    front(value) { flat = value; rotate(); },
    lsdj(value) { lsdj = value; paint(); render(); },
    draw(frame, state) {
      if (frame?.lcd) {
        const d = lcdImage.data;
        for (let i = 0; i < frame.lcd.length; i++) {
          const p = frame.lcd[i], at = i * 4;
          d[at] = (p >>> 11) * 255 / 31; d[at + 1] = (p >>> 5 & 63) * 255 / 63; d[at + 2] = (p & 31) * 255 / 31; d[at + 3] = 255;
        }
        lcdContext.putImageData(lcdImage, 0, 0); lcdTexture.needsUpdate = true;
      }
      if (frame === null) { lcdContext.fillStyle = '#000'; lcdContext.fillRect(0, 0, 240, 240); lcdTexture.needsUpdate = true; leds = new Float32Array(41); }
      if (frame?.leds) leds = frame.leds;
      pressed = state.keys;
      for (let i = 0; i < 7; i++) knobs[i].rotation.z = -state.enc[i] * Math.PI / 12;
      knobs[7].rotation.z = (0.5 - state.pot / 1023) * Math.PI * 1.5;
      paint(); render();
    }
  };
}
