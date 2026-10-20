// 3D-пролёт по маршруту: настоящая карта 2ГИС как земля, светящийся маршрут, столбы света
// над точками и камера, которая облетает каждую остановку. Загружается только по кнопке.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { mapGround } from "./ground3d.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KY = 110574;  // метров в градусе широты

// Освещение по времени суток: в демо меняется вместе с «Когда» в контексте.
const PHASES = {
  day: { bg: 0xdfe8ef, tint: 0xffffff, base: 0xe9e5dc, beam: 0.30, glow: THREE.NormalBlending, label: "День" },
  dusk: { bg: 0xe6bf9c, tint: 0xead2bf, base: 0xd9c3ae, beam: 0.42, glow: THREE.NormalBlending, label: "Вечер" },
  night: { bg: 0x0a1124, tint: 0x46527c, base: 0x0d1530, beam: 0.60, glow: THREE.AdditiveBlending, label: "Ночь" },
};
function phaseOf(hour) {
  if (hour >= 8 && hour < 17) return "day";
  if ((hour >= 17 && hour < 20) || (hour >= 6 && hour < 8)) return "dusk";
  return "night";
}

/**
 * opts: { title, subtitle, hour, chain,
 *         origin: {name, lat, lon},
 *         stops: [{name, kind, sub, text, lat, lon, color, leg: {geometry: [[lat, lon], ...], real}}] }
 */
export async function openCity3D(opts) {
  const phase = PHASES[phaseOf(opts.hour)];
  const root = document.createElement("div");
  root.className = "c3d";
  root.innerHTML = `
    <div class="c3d-top">
      <div><div class="c3d-title">${esc(opts.title)}</div><div class="c3d-sub">${esc(opts.subtitle || "")} · ${phase.label}</div></div>
      <button class="c3d-close" aria-label="Закрыть">✕</button>
    </div>
    <div class="c3d-loading">Загружаю карту 2ГИС…</div>
    <div class="c3d-card" hidden></div>
    <div class="c3d-controls">
      <button class="c3d-btn" data-act="play">Пауза</button>
      <button class="c3d-btn" data-act="overview">Обзор</button>
    </div>
    <div class="c3d-attr">© 2ГИС · three.js</div>`;
  document.body.appendChild(root);

  const W = () => root.clientWidth, H = () => root.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W(), H());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  root.prepend(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(W(), H());
  labels.domElement.className = "c3d-labels";
  root.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(phase.bg);
  const camera = new THREE.PerspectiveCamera(50, W() / H(), 5, 40000);
  const controls = new OrbitControls(camera, labels.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.minDistance = 120;
  controls.maxDistance = 9000;

  // --- Проекция: метры от центра сцены (x — восток, z — юг) ---
  const pts = [opts.origin, ...opts.stops];
  opts.stops.forEach((s) => (s.leg?.geometry || []).forEach(([lat, lon]) => pts.push({ lat, lon })));
  let south = Math.min(...pts.map((p) => p.lat)), north = Math.max(...pts.map((p) => p.lat));
  let west = Math.min(...pts.map((p) => p.lon)), east = Math.max(...pts.map((p) => p.lon));
  const lat0 = (south + north) / 2, lon0 = (west + east) / 2;
  const KX = KY * Math.cos((lat0 * Math.PI) / 180);
  const span = Math.max(400, (north - south) * KY, (east - west) * KX);  // размер самого маршрута, м
  const pad = 700;
  south -= pad / KY; north += pad / KY; west -= pad / KX; east += pad / KX;
  const toV = (lat, lon, y = 0) => new THREE.Vector3((lon - lon0) * KX, y, (lat0 - lat) * KY);
  const extent = Math.max((north - south) * KY, (east - west) * KX);

  // Дымка прячет край карты, но не трогает сам маршрут.
  scene.fog = new THREE.Fog(phase.bg, span * 1.6 + 900, span * 2.6 + 2600);

  // --- Земля: подложка и настоящая карта 2ГИС ---
  const base = new THREE.Mesh(new THREE.PlaneGeometry(extent * 12, extent * 12), new THREE.MeshBasicMaterial({ color: phase.base }));
  base.rotation.x = -Math.PI / 2;
  base.position.y = -1;
  scene.add(base);

  const ground = await mapGround({ bounds: { west, east, north, south }, proj: (lat, lon) => toV(lat, lon),
    KX, KY, renderer, tint: phase.tint, base: phase.base });
  scene.add(ground);
  root.querySelector(".c3d-loading").remove();

  if (phaseOf(opts.hour) === "night") {
    const n = 1400, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = 0.12 + Math.random() * 0.9, r = extent * 3.2;
      pos.set([Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false })));
  }

  // --- Маршрут: светящиеся трубки, прорисовываются на старте ---
  const tubes = [];
  const thin = (arr, minGap) => arr.filter((v, i) => i === 0 || i === arr.length - 1 || v.distanceTo(arr[i - 1]) > minGap);
  opts.stops.forEach((s) => {
    const geo = s.leg?.geometry || [];
    if (geo.length < 2) return;
    const path = thin(geo.map(([lat, lon]) => toV(lat, lon, 3)), 4);
    if (path.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(path, false, "centripetal");
    const segs = Math.min(800, path.length * 4);
    const core = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 4, 8, false), new THREE.MeshBasicMaterial({ color: s.color }));
    const glow = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, 11, 8, false),
      new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.22, blending: phase.glow, depthWrite: false }));
    [core, glow].forEach((m) => { m.geometry.setDrawRange(0, 0); scene.add(m); });
    tubes.push({ core, glow, total: core.geometry.index.count, totalGlow: glow.geometry.index.count });
  });

  // --- Столбы света, кольца и подписи над точками ---
  // Прозрачность столба тает кверху — получается луч, а не колонна.
  const fade = (() => {
    const c = document.createElement("canvas");
    c.width = 2; c.height = 128;
    const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, "#000"); gr.addColorStop(1, "#fff");
    g.fillStyle = gr; g.fillRect(0, 0, 2, 128);
    return new THREE.CanvasTexture(c);
  })();
  const beamMat = (color, opacity, alphaMap = null) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, alphaMap,
    blending: phase.glow, depthWrite: false, side: THREE.DoubleSide });
  const rings = [];
  function marker(p, color, label, height, i) {
    const v = toV(p.lat, p.lon);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, height, 24, 1, true), beamMat(color, phase.beam + 0.25, fade));
    beam.position.set(v.x, height / 2, v.z);
    scene.add(beam);
    const ring = new THREE.Mesh(new THREE.RingGeometry(14, 22, 48), beamMat(color, 0.9));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(v.x, 2, v.z);
    scene.add(ring);
    rings.push(ring);
    const tag = document.createElement("button");
    tag.className = "c3d-tag";
    tag.style.setProperty("--c", `#${new THREE.Color(color).getHexString()}`);
    tag.innerHTML = label;
    if (i != null) tag.addEventListener("click", () => focusStop(i));
    const obj = new CSS2DObject(tag);
    obj.position.set(v.x, height + 16, v.z);
    scene.add(obj);
    return v;
  }
  const originV = marker(opts.origin, 0x1663d6, `<b>●</b>${esc(opts.origin.name)}`, 90, null);
  const stopV = opts.stops.map((s, i) => marker(s, s.color, `<b>${i + 1}</b>${esc(s.name)}`, 240, i));

  // --- Траектория полёта: старт -> 1 -> 2 -> 3 (для маршрута — по реальным улицам) ---
  const flight = [originV.clone().setY(0)];
  opts.stops.forEach((s, i) => {
    const geo = opts.chain ? s.leg?.geometry || [] : [];
    if (geo.length >= 2) geo.forEach(([lat, lon]) => flight.push(toV(lat, lon)));
    else flight.push(stopV[i].clone().setY(0));
  });
  const flightPts = thin(flight, 30);
  if (flightPts.length < 2) flightPts.push(flightPts[0].clone().add(new THREE.Vector3(1, 0, 1)));
  const route = new THREE.CatmullRomCurve3(flightPts, false, "centripetal");
  const L = route.getLength();
  const samples = route.getSpacedPoints(600);
  const stopT = stopV.map((v) => {
    let best = 0, bd = Infinity;
    samples.forEach((p, k) => { const d = p.distanceToSquared(v.clone().setY(0)); if (d < bd) { bd = d; best = k; } });
    return best / 600;
  });
  // Остановки по порядку: параметр каждой не меньше предыдущей.
  for (let i = 1; i < stopT.length; i++) stopT[i] = Math.max(stopT[i], stopT[i - 1]);
  const travelSec = Math.min(30, Math.max(10, L / 110));

  // --- Камера ---
  const center = new THREE.Vector3(((east + west) / 2 - lon0) * KX, 0, (lat0 - (north + south) / 2) * KY);
  const overviewPos = center.clone().add(new THREE.Vector3(0, span * 0.9 + 450, span * 0.8 + 450));
  camera.position.copy(overviewPos.clone().multiplyScalar(1.6));
  const look = center.clone();
  camera.lookAt(look);
  controls.target.copy(center);

  const card = root.querySelector(".c3d-card");
  function showCard(i) {
    const s = opts.stops[i];
    card.style.setProperty("--c", `#${new THREE.Color(s.color).getHexString()}`);
    card.innerHTML = `<span class="c3d-num">${i + 1}</span><div><b>${esc(s.name)}</b>
      <div class="c3d-kind">${esc([s.kind, s.sub].filter(Boolean).join(" · "))}</div>${s.text ? `<p>${esc(s.text)}</p>` : ""}</div>`;
    card.hidden = false;
  }

  let mode = "intro", clockT = 0, t = 0, next = 0, hold = 0, holdAngle = 0, outroT = 0, intro = 0;
  const playBtn = root.querySelector('[data-act="play"]');
  const setPlay = (label) => (playBtn.textContent = label);
  function toFree() {
    mode = "free";
    controls.target.copy(look);
    setPlay(next >= opts.stops.length ? "Ещё раз" : "Продолжить");
  }
  function focusStop(i) {
    toFree();
    showCard(i);
    const v = stopV[i];
    flyTo(v.clone().add(new THREE.Vector3(260, 300, 360)), v.clone().setY(40));
  }
  let tween = null;
  function flyTo(pos, target, dur = 1.4) {
    tween = { from: camera.position.clone(), to: pos, tf: controls.target.clone(), tt: target, k: 0, dur };
  }
  labels.domElement.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".c3d-tag")) return;
    if (mode !== "free") toFree();
    tween = null;
  });
  playBtn.addEventListener("click", () => {
    if (mode !== "free") { toFree(); return; }
    if (next >= opts.stops.length) { t = 0; next = 0; card.hidden = true; }
    mode = "travel";
    setPlay("Пауза");
  });
  root.querySelector('[data-act="overview"]').addEventListener("click", () => {
    toFree();
    card.hidden = true;
    flyTo(overviewPos.clone(), center.clone());
  });

  const desired = new THREE.Vector3(), wantLook = new THREE.Vector3();
  function chase(param, dt) {
    const p = route.getPointAt(Math.min(param, 1)), tan = route.getTangentAt(Math.min(param, 0.999));
    desired.copy(p).addScaledVector(tan, -260).add(new THREE.Vector3(0, 210, 0));
    wantLook.copy(p).addScaledVector(tan, 90);
    const k = 1 - Math.exp(-dt * 2.5);
    camera.position.lerp(desired, k);
    look.lerp(wantLook, k);
    camera.lookAt(look);
  }

  let raf, last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clockT += dt;
    rings.forEach((r, i) => { const s = 1 + 0.25 * Math.sin(clockT * 3 + i); r.scale.set(s, s, s); });

    // Маршрут прорисовывается за первые 2,5 секунды.
    const draw = Math.min(1, clockT / 2.5);
    tubes.forEach((tb, i) => {
      const k = Math.min(1, Math.max(0, draw * 1.4 - i * 0.15));
      tb.core.geometry.setDrawRange(0, Math.floor((tb.total * k) / 48) * 48);
      tb.glow.geometry.setDrawRange(0, Math.floor((tb.totalGlow * k) / 48) * 48);
    });

    if (mode === "intro") {
      intro += dt / 3;
      const k = 1 - Math.exp(-dt * 1.6);
      if (intro < 1) {
        camera.position.lerp(overviewPos, k);
        look.lerp(center, k);
        camera.lookAt(look);
      } else { mode = "travel"; }
    } else if (mode === "travel") {
      t += dt / travelSec;
      if (next < stopT.length && t >= stopT[next]) {
        t = stopT[next]; mode = "hold"; hold = 0; showCard(next);
        const off = camera.position.clone().sub(stopV[next]);
        holdAngle = Math.atan2(off.z, off.x);
      }
      if (t >= 1 && next >= stopT.length) { mode = "outro"; outroT = 0; }
      chase(t, dt);
    } else if (mode === "hold") {
      hold += dt;
      const v = stopV[next];
      const a = holdAngle + hold * 0.45;
      desired.set(v.x + Math.cos(a) * 520, 340, v.z + Math.sin(a) * 520);
      const k = 1 - Math.exp(-dt * 2);
      camera.position.lerp(desired, k);
      look.lerp(v.clone().setY(30), k);
      camera.lookAt(look);
      if (hold > 3.2) { next += 1; mode = next >= stopT.length && t >= 0.98 ? "outro" : "travel"; outroT = 0; }
    } else if (mode === "outro") {
      outroT += dt;
      const k = 1 - Math.exp(-dt * 1.5);
      camera.position.lerp(overviewPos, k);
      look.lerp(center, k);
      camera.lookAt(look);
      if (outroT > 2.5) { toFree(); setPlay("Ещё раз"); }
    } else {
      if (tween) {
        tween.k = Math.min(1, tween.k + dt / tween.dur);
        const e = tween.k < 0.5 ? 2 * tween.k * tween.k : 1 - (-2 * tween.k + 2) ** 2 / 2;
        camera.position.lerpVectors(tween.from, tween.to, e);
        controls.target.lerpVectors(tween.tf, tween.tt, e);
        if (tween.k >= 1) tween = null;
      }
      controls.update();
      look.copy(controls.target);
    }
    renderer.render(scene, camera);
    labels.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  function onResize() {
    camera.aspect = W() / H();
    camera.updateProjectionMatrix();
    renderer.setSize(W(), H());
    labels.setSize(W(), H());
  }
  window.addEventListener("resize", onResize);
  function close() {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKey);
    controls.dispose();
    renderer.dispose();
    scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); });
    root.remove();
  }
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  root.querySelector(".c3d-close").addEventListener("click", close);
  return close;
}
