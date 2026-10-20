// «Пульс города»: все места каталога столбиками над картой 2ГИС.
// Высота = популярность × оживлённость в этот час (оценка по типу места, дню недели и погоде).
// Закрытые в выбранное время гаснут и опускаются.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mapGround } from "./ground3d.js";

export const GROUPS = {
  food: { color: 0xf59e0b, label: "Еда и кофе" },
  night: { color: 0xec4899, label: "Ночная жизнь" },
  culture: { color: 0x8b5cf6, label: "Культура" },
  city: { color: 0x10b981, label: "Город и парки" },
  fun: { color: 0x3b82f6, label: "Развлечения" },
  other: { color: 0xeab308, label: "ТРЦ и другое" },
};
const KY = 110574;
const CLOSED = new THREE.Color(0x3a4256), UNKNOWN = new THREE.Color(0x6b7280);

// Типичная оживлённость по часам (0..1) — оценка по типу места, а не реальная загрузка.
// Опорные точки [час, значение], между ними — плавно.
const CURVES = {
  coffee: [[0, .1], [7, .4], [9, 1], [11, .6], [13, .75], [16, .85], [19, .5], [22, .25]],
  cafe: [[0, .15], [9, .35], [13, .9], [15, .55], [19, .95], [22, .5]],
  restaurant: [[0, .2], [11, .3], [13, .8], [16, .4], [20, 1], [23, .55]],
  night: [[0, 1], [2, .8], [4, .3], [7, .05], [17, .2], [20, .6], [22, .95]],
  culture: [[0, 0], [10, .4], [14, 1], [17, .75], [20, .45], [22, .1]],
  show: [[0, .1], [12, .3], [16, .5], [19, 1], [22, .6]],
  outdoor: [[0, .05], [6, .1], [9, .4], [13, .7], [17, 1], [20, .65], [23, .15]],
  family: [[0, 0], [10, .5], [13, .9], [17, 1], [20, .5], [22, .1]],
  mall: [[0, .05], [10, .4], [14, .8], [18, 1], [21, .7], [23, .2]],
  work: [[0, .05], [9, .6], [12, .9], [16, .8], [19, .45], [22, .15]],
};
const CURVE_OF = {
  coffee: "coffee", cafe: "cafe", restaurant: "restaurant", bar: "night", nightclub: "night", karaoke: "night",
  museum: "culture", gallery: "culture", theatre: "show", cinema: "show",
  sight: "outdoor", viewpoint: "outdoor", park: "outdoor",
  kids: "family", aquapark: "family", zoo: "family", skating: "family", bowling: "family", quest: "family",
  mall: "mall", anticafe: "work", coworking: "work", bookstore: "work",
};
const OUTDOOR = new Set(["sight", "viewpoint", "park"]);

function curveAt(points, h) {
  const pts = [...points, [points[0][0] + 24, points[0][1]]];  // по кругу через полночь
  for (let i = 0; i < pts.length - 1; i++) {
    const [h0, v0] = pts[i], [h1, v1] = pts[i + 1];
    if (h >= h0 && h <= h1) {
      const k = (h - h0) / (h1 - h0), s = k * k * (3 - 2 * k);
      return v0 + (v1 - v0) * s;
    }
  }
  return points[0][1];
}

/** Оживлённость места 0..1: тип места, час, день недели (0 = пн) и погода. */
export function activity(cat, day, minute, weather) {
  const kind = CURVE_OF[cat] || "cafe";
  let a = curveAt(CURVES[kind], minute / 60);
  const weekend = day >= 5, fridayNight = day === 4 && minute >= 18 * 60;
  if (kind === "night" && (fridayNight || (day === 5 && minute >= 18 * 60))) a *= 1.25;
  if ((kind === "family" || kind === "outdoor" || kind === "mall") && weekend && minute > 10 * 60) a *= 1.2;
  if (kind === "work" && weekend) a *= 0.6;
  if (weather && OUTDOOR.has(cat)) a *= weather.harsh ? 0.3 : weather.pleasant ? 1.25 : 1;
  if (weather && weather.harsh && (kind === "mall" || kind === "culture" || kind === "cafe")) a *= 1.15;  // в непогоду — под крышу
  return Math.min(1, a);
}

/** Открыто ли место: true / false / null (часы неизвестны). day: 0 = пн. Логика как на сервере. */
export function isOpen(sched, day, minute) {
  if (sched === null) return null;
  if (sched === "out" || sched === "24") return true;
  for (const [s, e0] of sched[day]) {
    const e = e0 <= s ? e0 + 1440 : e0;  // смена через полночь
    if (s <= minute && minute < e) return true;
  }
  for (const [s, e] of sched[(day + 6) % 7]) {
    if (e <= s && minute < e) return true;  // хвост вчерашней ночной смены
  }
  return false;
}

function iconTexture(symbol, bg) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = bg;
  g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.fill();
  g.lineWidth = 8; g.strokeStyle = "#fff"; g.stroke();
  g.fillStyle = "#fff"; g.font = "bold 64px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(symbol, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Монтирует сцену в container. pois — строки из /api/pulse:
 * [id, name, lat, lon, cat, group, popularity, schedule, kind].
 * onHover(info|null, x, y), onPick(info) — колбэки интерфейса; info = {row, open, activity} или {marker}.
 */
export async function mountPulse(container, pois, { onHover, onPick } = {}) {
  const W = () => container.clientWidth, H = () => container.clientHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W(), H());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0x0b1124);
  scene.background = sky;
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(0.6, 1, 0.35);
  scene.add(sun);

  // Проекция: метры от центра города.
  const lats = pois.map((p) => p[2]), lons = pois.map((p) => p[3]);
  let south = Math.min(...lats), north = Math.max(...lats), west = Math.min(...lons), east = Math.max(...lons);
  const lat0 = (south + north) / 2, lon0 = (west + east) / 2;
  const KX = KY * Math.cos((lat0 * Math.PI) / 180);
  const pad = 1500;
  south -= pad / KY; north += pad / KY; west -= pad / KX; east += pad / KX;
  const proj = (lat, lon, y = 0) => new THREE.Vector3((lon - lon0) * KX, y, (lat0 - lat) * KY);
  const extent = Math.max((north - south) * KY, (east - west) * KX);
  // Камера смотрит на центр скопления мест, а не на центр рамки (рамку растягивает аэропорт).
  const focus = proj(lats.reduce((a, b) => a + b, 0) / lats.length, lons.reduce((a, b) => a + b, 0) / lons.length);
  scene.fog = new THREE.Fog(sky, extent * 0.9, extent * 2.2);

  const base = new THREE.Mesh(new THREE.PlaneGeometry(extent * 8, extent * 8), new THREE.MeshBasicMaterial({ color: 0x0d1530 }));
  base.rotation.x = -Math.PI / 2;
  base.position.y = -30;  // ниже карты с запасом: иначе плоскости мерцают друг через друга
  scene.add(base);
  const ground = await mapGround({ bounds: { west, east, north, south }, proj: (lat, lon) => proj(lat, lon),
    KX, KY, renderer, tint: 0x46527c, base: 0x0d1530, maxZoom: 15 });
  scene.add(ground);

  // Столбики: один InstancedMesh на все места — одна отрисовка вместо 1634.
  const n = pois.length;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const bars = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), n);
  bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(bars);
  const pos = pois.map((p) => proj(p[2], p[3]));
  const cur = new Float32Array(n).fill(1), target = new Float32Array(n).fill(1);
  const curCol = pois.map(() => new THREE.Color(CLOSED)), targetCol = pois.map(() => new THREE.Color(CLOSED));
  const status = new Array(n).fill(null), act = new Float32Array(n);
  const FOOT = 110;  // ширина столбика, м
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  for (let i = 0; i < n; i++) bars.setColorAt(i, curCol[i]);

  let groups = new Set(Object.keys(GROUPS));
  let state = { day: 0, minute: 720, weather: null };

  // Самые живые районы: сетка 1 км, вес = оживлённость × популярность открытых мест.
  function hotspots() {
    const cells = new Map();
    for (let i = 0; i < n; i++) {
      if (status[i] !== true || !groups.has(pois[i][5])) continue;
      const key = `${Math.floor(pos[i].x / 1000)}:${Math.floor(pos[i].z / 1000)}`;
      const c = cells.get(key) || { score: 0, count: 0, best: i };
      c.score += act[i] * (0.5 + pois[i][6]);
      c.count += 1;
      if (pois[i][6] > pois[c.best][6]) c.best = i;
      cells.set(key, c);
    }
    const top = [];
    for (const c of [...cells.values()].sort((a, b) => b.score - a.score)) {
      if (top.every((t) => pos[t.best].distanceTo(pos[c.best]) > 1800)) top.push(c);
      if (top.length === 3) break;
    }
    return top.map((c) => ({ name: pois[c.best][1], lat: pois[c.best][2], lon: pois[c.best][3], open: c.count }));
  }

  function recompute() {
    const counts = { open: 0, closed: 0, unknown: 0, byGroup: {}, pulse: 0 };
    Object.keys(GROUPS).forEach((g) => (counts.byGroup[g] = 0));
    let actSum = 0, actW = 0;
    for (let i = 0; i < n; i++) {
      const p = pois[i];
      const open = isOpen(p[7], state.day, state.minute);
      status[i] = open;
      const visible = groups.has(p[5]);
      act[i] = open === false ? 0 : activity(p[4], state.day, state.minute, state.weather);
      if (open === true) {
        counts.open += 1; counts.byGroup[p[5]] += 1;
        target[i] = visible ? (50 + p[6] * 280) * (0.2 + 0.8 * act[i]) : 0;
        targetCol[i].setHex(GROUPS[p[5]].color).multiplyScalar(0.55 + 0.45 * act[i]);
        actSum += act[i] * (1 + p[6]); actW += 1 + p[6];
      } else if (open === false) {
        counts.closed += 1;
        target[i] = visible ? 10 : 0;
        targetCol[i].copy(CLOSED);
      } else {
        counts.unknown += 1;
        target[i] = visible ? 18 : 0;
        targetCol[i].copy(UNKNOWN);
      }
    }
    counts.pulse = actW ? Math.round((actSum / actW) * 100) : 0;
    counts.hotspots = hotspots();
    return counts;
  }

  // Небо и тонировка карты: днём светлее, ночью темнее.
  function lightFor(minute) {
    const dark = (Math.cos(((minute / 60 - 13) / 24) * Math.PI * 2) * -0.5 + 0.5);  // 0 в 13:00, 1 в 01:00
    sky.setHex(0x0b1124).lerp(new THREE.Color(0x2a3a5e), 1 - dark);
    scene.fog.color.copy(sky);
    ground.material.color.setHex(0x46527c).lerp(new THREE.Color(0x9fadc8), 1 - dark);
  }

  // --- Слои: ♥ из ленты, % предложения заведений, «Вы здесь» ---
  const layers = {};
  const textures = { feed: iconTexture("♥", "#e11d48"), offers: iconTexture("%", "#d97706") };
  function setMarkers(kind, items) {
    if (layers[kind]) { scene.remove(layers[kind]); layers[kind].children.forEach((s) => s.material.dispose()); }
    const grp = new THREE.Group();
    items.forEach((it) => {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: textures[kind], depthTest: false, transparent: true }));
      sp.position.copy(proj(it.lat, it.lon, it.height || 520));
      sp.scale.set(260, 260, 1);
      sp.renderOrder = 10;
      sp.userData = { marker: { kind, ...it } };
      grp.add(sp);
    });
    layers[kind] = grp;
    scene.add(grp);
  }
  function showLayer(kind, on) { if (layers[kind]) layers[kind].visible = on; }

  let me = null;
  function setOrigin(lat, lon) {
    if (me) scene.remove(me);
    me = new THREE.Group();
    const v = proj(lat, lon);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 900, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    beam.position.set(v.x, 450, v.z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(120, 180, 48),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(v.x, 6, v.z);
    me.add(beam, ring);
    scene.add(me);
  }

  const camera = new THREE.PerspectiveCamera(45, W() / H(), 300, extent * 4);
  camera.position.copy(focus).add(new THREE.Vector3(0, extent * 0.3, extent * 0.36));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(focus);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
  controls.maxPolarAngle = Math.PI * 0.44;
  controls.minDistance = 1500;
  controls.maxDistance = extent * 1.6;

  let tween = null;
  controls.addEventListener("start", () => { controls.autoRotate = false; tween = null; });
  function flyTo(lat, lon) {
    const t = proj(lat, lon);
    controls.autoRotate = false;
    tween = { k: 0, from: camera.position.clone(), to: t.clone().add(new THREE.Vector3(1800, 3200, 3800)),
              tf: controls.target.clone(), tt: t };
  }

  // Наведение и клик: маркеры слоёв важнее столбиков.
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let hover = -1, downAt = null;
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const visibleLayers = Object.values(layers).filter((g) => g.visible);
    const mk = visibleLayers.length ? ray.intersectObjects(visibleLayers, true)[0] : null;
    if (mk) return { marker: mk.object.userData.marker };
    const hit = ray.intersectObject(bars)[0];
    return hit && cur[hit.instanceId] > 1 ? { i: hit.instanceId } : null;
  }
  const info = (h) => (h.marker ? { marker: h.marker } : { row: pois[h.i], open: status[h.i], activity: act[h.i] });
  renderer.domElement.addEventListener("pointermove", (e) => {
    const h = pick(e);
    hover = h && h.i != null ? h.i : -1;
    renderer.domElement.style.cursor = h ? "pointer" : "";
    if (onHover) onHover(h ? info(h) : null, e.clientX, e.clientY);
  });
  renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;  // это было вращение
    const h = pick(e);
    if (h && onPick) onPick(info(h));
  });

  const hl = new THREE.Color(0xffffff);
  let raf, last = performance.now(), clock = 0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    const k = 1 - Math.exp(-dt * 7);
    for (let i = 0; i < n; i++) {
      cur[i] += (target[i] - cur[i]) * k;
      curCol[i].lerp(targetCol[i], k);
      const h = Math.max(cur[i], 0.001);
      const w = target[i] === 0 && cur[i] < 1 ? 0.001 : FOOT;
      m.compose(pos[i], q, sc.set(w, h, w));
      bars.setMatrixAt(i, m);
      bars.setColorAt(i, i === hover ? hl : curCol[i]);
    }
    bars.instanceMatrix.needsUpdate = true;
    bars.instanceColor.needsUpdate = true;
    Object.values(layers).forEach((g) => g.children.forEach((s, j) => {
      const b = 1 + 0.08 * Math.sin(clock * 3 + j);
      s.scale.set(260 * b, 260 * b, 1);
    }));
    if (tween) {
      tween.k = Math.min(1, tween.k + dt / 1.6);
      const e = tween.k < 0.5 ? 2 * tween.k * tween.k : 1 - (-2 * tween.k + 2) ** 2 / 2;
      camera.position.lerpVectors(tween.from, tween.to, e);
      controls.target.lerpVectors(tween.tf, tween.tt, e);
      if (tween.k >= 1) tween = null;
    }
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  function onResize() {
    if (!W() || !H()) return;
    camera.aspect = W() / H();
    camera.updateProjectionMatrix();
    renderer.setSize(W(), H());
  }
  window.addEventListener("resize", onResize);

  return {
    setTime(day, minute, weather) {
      state = { day, minute, weather };
      lightFor(minute);
      return recompute();
    },
    setGroups(set) {
      groups = new Set(set);
      return recompute();
    },
    setMarkers, showLayer, setOrigin, flyTo,
    resize: onResize,
    // Пока страница скрыта, сцену не рисуем — не греем видеокарту.
    pause() { cancelAnimationFrame(raf); raf = null; },
    resume() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } onResize(); },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
