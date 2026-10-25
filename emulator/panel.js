// SPDX-License-Identifier: GPL-3.0-only
// The live front-panel texture and hit testing come from fm1-emu's MIT-licensed panel.
export async function createPanel(host, ui, controls, onError) {
  const T = await import('./vendor/three.module.min.js');
  ui.panel_board(0);
  const width = ui.panel_width(), height = ui.panel_height();
  const source = document.createElement('canvas');
  source.width = width; source.height = height;
  const context = source.getContext('2d');
  const renderer = new T.WebGLRenderer({antialias: true, alpha: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const canvas = renderer.domElement;
  canvas.id = 'emu-canvas'; canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D FM-1. Click keys, drag knobs, or focus here to use arrow keys, Z, X, Shift and Enter.');
  host.replaceChildren(canvas);
  const scene = new T.Scene(), camera = new T.PerspectiveCamera(36, 1, 0.1, 100);
  camera.position.set(0, 0, 21);
  scene.add(new T.HemisphereLight(0xffffff, 0x26232c, 3));
  const light = new T.DirectionalLight(0xffffff, 4);
  light.position.set(-5, 8, 12); scene.add(light);
  const model = new T.Group(); scene.add(model);
  const body = new T.Mesh(new T.BoxGeometry(12.8, 8.2, 0.6),
    new T.MeshStandardMaterial({color: 0x34383e, roughness: 0.65, metalness: 0.35}));
  model.add(body);
  const texture = new T.CanvasTexture(source);
  texture.colorSpace = T.SRGBColorSpace;
  const face = new T.Mesh(new T.PlaneGeometry(12.8, 8.2),
    new T.MeshBasicMaterial({map: texture, toneMapped: false}));
  face.position.z = 0.305; model.add(face);
  const knobs = [];
  // Same centers as upstream crates/fm1-live/src/panel.rs.
  const centers = [[250,135,44], [110,295,44], [250,295,44], [935,120,36],
    [1027,120,36], [1119,120,36], [1211,120,36], [110,135,44]];
  centers.forEach(([x, y, radius], control) => {
    const group = new T.Group();
    group.position.set(x / 100 - 6.4, 4.1 - y / 100, 0.31);
    const knob = new T.Mesh(new T.CylinderGeometry(radius / 110, radius / 100, 0.32, 24),
      new T.MeshStandardMaterial({color: 0x34363b, roughness: 0.45, metalness: 0.3}));
    knob.rotation.x = Math.PI / 2; knob.position.z = 0.16; knob.userData.control = control;
    const line = new T.Mesh(new T.BoxGeometry(0.045, radius / 140, 0.02),
      new T.MeshBasicMaterial({color: 0xf3c685}));
    line.position.set(0, radius / 220, 0.33); line.userData.control = control;
    group.add(knob, line); model.add(group); knobs.push(group);
  });
  const ray = new T.Raycaster(), mouse = new T.Vector2();
  let flat = false, tilt = 24, yaw = -12;
  const render = () => renderer.render(scene, camera);
  function resize() {
    const w = Math.max(240, host.clientWidth), h = Math.round(w * 0.72);
    renderer.setSize(w, h); camera.aspect = w / h;
    camera.updateProjectionMatrix(); render();
  }
  const observer = new ResizeObserver(resize); observer.observe(host);
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault(); controls.releaseAll(); onError('The 3D graphics context was lost. Reload the page to restart the emulator.');
  });
  function rotate() {
    model.rotation.set((flat ? 0 : tilt) * Math.PI / 180, (flat ? 0 : yaw) * Math.PI / 180, 0);
    render();
  }
  function hit(e) {
    const r = canvas.getBoundingClientRect();
    mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects([face, ...knobs], true);
    const h = hits[0];
    if (!h) return -1;
    if (h.object.userData.control !== undefined) return h.object.userData.control;
    return ui.panel_hit(h.uv.x * width, (1 - h.uv.y) * height);
  }
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
    const delta = (p.y - e.clientY) * width / Math.max(240, canvas.clientWidth);
    if (p.id >= 0 && p.id < 7) {
      p.acc += delta;
      const clicks = Math.trunc(p.acc / 12);
      if (clicks) { p.acc -= clicks * 12; controls.turn(p.id, clicks); }
    } else if (p.id === 7) controls.pot(delta * 4);
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
  rotate(); resize();
  return {
    canvas,
    angle(nextTilt, nextYaw) { tilt = nextTilt; yaw = nextYaw; rotate(); },
    front(value) { flat = value; rotate(); },
    draw(frame, state) {
      const memory = ui.memory.buffer;
      if (frame?.lcd) new Uint16Array(memory, ui.panel_lcd(), 240 * 240).set(frame.lcd);
      if (frame?.leds) new Float32Array(memory, ui.panel_leds(), 41).set(frame.leds);
      for (let i = 0; i < 41; i++) ui.panel_set(0, i, state.keys.has(i) ? 1 : 0);
      for (let i = 0; i < 7; i++) {
        ui.panel_set(1, i, state.enc[i]); knobs[i].rotation.z = -state.enc[i] * Math.PI / 12;
      }
      ui.panel_set(2, 0, state.pot);
      knobs[7].rotation.z = (0.5 - state.pot / 1023) * Math.PI * 1.5;
      const ptr = ui.panel_draw();
      context.putImageData(new ImageData(new Uint8ClampedArray(ui.memory.buffer, ptr, width * height * 4), width, height), 0, 0);
      texture.needsUpdate = true; render();
    }
  };
}
