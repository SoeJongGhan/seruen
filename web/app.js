"use strict";

/* ---------- Утилиты ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Хранилище браузера может быть недоступно (приватный режим) — всё в try/catch.
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* без сохранения */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const KIND = {
  sight: "достопримечательность", park: "парк", coffee: "кофейня", cafe: "кафе", restaurant: "ресторан", bar: "бар",
  kids: "для детей", museum: "музей", gallery: "галерея", theatre: "театр", cinema: "кинотеатр",
  viewpoint: "смотровая площадка", mall: "торговый центр", anticafe: "антикафе", coworking: "коворкинг",
  quest: "квесты", bowling: "боулинг", karaoke: "караоке", nightclub: "ночной клуб", skating: "каток",
  aquapark: "аквапарк", zoo: "зоопарк", bookstore: "книжный",
};
const STAMPS = [["sight", "Символы города"], ["park", "Парки"], ["museum", "Музеи"], ["viewpoint", "Виды"],
  ["coffee", "Кофейни"], ["cafe", "Кафе"], ["restaurant", "Рестораны"], ["kids", "Детское"], ["theatre", "Театры"], ["bar", "Бары"]];
const COLORS = ["#1663d6", "#7c3ac7", "#d0432a", "#0f8a6a"];
const AVA_COLORS = ["#14704f", "#1663d6", "#7c3ac7", "#d0432a", "#b7791f", "#0f8a6a", "#c2253a", "#3d5a80"];
const MODES = [["walk", "Пешком"], ["transit", "Транспорт"], ["car", "Машина"]];
const BUDGETS = [[null, "Не важно"], [30, "30 мин"], [60, "1 час"], [120, "2 часа"], [180, "3 часа"]];
const NEEDS = [["kids", "С ребёнком"], ["accessible", "Без ступенек"], ["laptop", "Поработать с ноутбуком"]];
const FEED_SORTS = [["new", "Новое"], ["top", "Популярное"], ["near", "Рядом"]];
const WEEK = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const LEVELS = [[0, "Гость столицы"], [200, "Турист со стажем"], [500, "Почти местный"], [1000, "Знаток Астаны"]];
const POINTS_VISIT = 50;
const POINTS_POST = 20;
const CHECKIN_RADIUS_M = 200;
const BADGES = [
  ["first", "Первая отметка", "Отметьтесь в любом месте", (p) => p.visits.length >= 1],
  ["quest", "Квест пройден", "Пройдите квест до конца", (p) => p.quests >= 1],
  ["perfect", "Без ошибок", "Ответьте верно на все вопросы квеста", (p) => p.perfect >= 1],
  ["symbols", "Символы столицы", "Отметьтесь у 5 достопримечательностей", (p) => countCat(p, "sight") >= 5],
  ["coffee", "Кофейный маршрут", "Отметьтесь в 3 разных кофейнях", (p) => countCat(p, "coffee") >= 3],
  ["museum", "Музейный день", "Отметьтесь в 2 музеях", (p) => countCat(p, "museum") >= 2],
  ["night", "Ночной город", "Отметка после 23:00", (p) => p.visits.some((v) => v.hour >= 23 || v.hour < 5)],
  ["frost", "Морж", "Отметка, когда ощущается ниже −15°", (p) => p.visits.some((v) => v.feels != null && v.feels <= -15)],
  ["voice", "Голос города", "Поделитесь местом в ленте", (p) => (p.posts || 0) >= 1],
  ["photo", "Фотоохотник", "Подтвердите фото 3 точки квеста", (p) => (p.photos || 0) >= 3],
];
const POINTS_PHOTO = 30;

const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} м` : `${(m / 1000).toFixed(1).replace(".", ",")} км`);
const fmtMin = (n) => (n < 60 ? `${n} мин` : `${Math.floor(n / 60)} ч${n % 60 ? ` ${n % 60} мин` : ""}`);
const fmtTemp = (t) => `${t > 0 ? "+" : t < 0 ? "−" : ""}${Math.abs(Math.round(t))}°`;
const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const plural = (n, one, few, many) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
function splitName(name) {
  // «Black Duck, ресторан» -> ["Black Duck", "ресторан"], как в карточках 2ГИС.
  const i = name.lastIndexOf(", ");
  if (i > 0 && /^[a-zа-яё]/.test(name.slice(i + 2))) return [name.slice(0, i), name.slice(i + 2)];
  return [name, null];
}
function haversine(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dp = (b.lat - a.lat) * r, dl = (b.lon - a.lon) * r;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function dirUrl(points, mode) {
  const tab = { walk: "pedestrian", car: "car", transit: "bus" }[mode] || "pedestrian";
  const p = points.map((x) => `${x.lon},${x.lat}` + (x.id ? `;${x.id}` : "")).join("|");
  return `https://2gis.kz/astana/directions/tab/${tab}/points/${encodeURIComponent(p)}`;
}
function countCat(p, cat) { return new Set(p.visits.filter((v) => v.cat === cat).map((v) => v.id)).size; }
function avaColor(name) {
  let h = 0;
  for (const ch of name || "?") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVA_COLORS[h % AVA_COLORS.length];
}
function avatar(name, cls = "") {
  const n = name || "?";
  return `<span class="ava ${cls}" style="background:${avaColor(n)}">${esc(n[0].toUpperCase())}</span>`;
}
function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "только что";
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  if (s < 172800) return "вчера";
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
function levelOf(points) {
  const lvl = [...LEVELS].reverse().find(([t]) => points >= t);
  const next = LEVELS.find(([t]) => t > points);
  return { lvl, next, pct: next ? Math.round(((points - lvl[0]) / (next[0] - lvl[0])) * 100) : 100 };
}

let toastTimer;
function toast(msg, ms = 2800) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- Состояние ---------- */
const emptyPassport = () => ({ points: 0, visits: [], quests: 0, perfect: 0, posts: 0, badges: [] });
const S = {
  meta: null, view: "ask",
  origin: { name: "Байтерек", lat: 51.12829, lon: 71.43045 },  // в памяти, не сохраняется
  when: null, weatherPreset: null, weather: null,
  mode: null, budget: null, group: 1, needs: new Set(),
  result: null, busy: false,
  quest: store.get("seruen.quest", null),
  questBudget: 90, questLoading: false, questError: null,
  passport: { ...emptyPassport(), ...store.get("seruen.passport", {}) },
  passportSynced: false,
  demoCheckin: store.get("seruen.demoCheckin", true),
  // Сессия Supabase Auth: access/refresh токены и имя. Токен проверяет сервер на каждом запросе.
  session: store.get("seruen.session", null),
  me: null,
  feedSort: "new", feed: null, feedError: null, feedLoading: false,
};

/* ---------- API и сессия ---------- */
let refreshing = null;
async function refreshSession() {
  if (!S.session) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const r = await fetch("/api/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: S.session.refresh_token }) });
        if (!r.ok) throw new Error();
        setSession(await r.json());
        return true;
      } catch {
        logoutLocal();
        return false;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

async function api(url, body, method) {
  if (S.session && S.session.expires_at * 1000 - Date.now() < 60000) await refreshSession();
  const send = () => {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (S.session) headers.Authorization = `Bearer ${S.session.access_token}`;
    return fetch(url, { method: method || (body !== undefined ? "POST" : "GET"), headers,
      body: body !== undefined ? JSON.stringify(body) : undefined });
  };
  let r = await send();
  if (r.status === 401 && S.session && (await refreshSession())) r = await send();
  if (!r.ok) {
    let msg = "Что-то пошло не так. Попробуйте ещё раз.";
    try { const j = await r.json(); if (typeof j.detail === "string") msg = j.detail; } catch { /* ignore */ }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function setSession(s) {
  S.session = s;
  if (s) store.set("seruen.session", s); else store.del("seruen.session");
  renderNavAuth();
}

function paintAdminNav() {
  $("#navAdmin").hidden = !S.isAdmin;
  $("#popAdmin").hidden = !S.isAdmin;
}

function logoutLocal() {
  setSession(null);
  S.me = null;
  S.isAdmin = false;
  paintAdminNav();
  if (S.passportSynced) {  // паспорт аккаунта лежит на сервере — на устройстве его не оставляем
    S.passport = emptyPassport();
    store.del("seruen.passport");
  }
  S.passportSynced = false;
  updatePointsBadge();
}

async function logout() {
  closePops();
  try { await api("/api/auth/logout", {}); } catch { /* выйдем локально */ }
  logoutLocal();
  toast("Вы вышли из аккаунта");
  refreshView();
}

function requireAuth(reason, then) {
  if (S.session) return then();
  openAuth("login", reason, then);
}

/* Паспорт аккаунта хранится на сервере, локальная копия — кеш. У копии есть владелец (owner)
   и время изменения (ts): так при входе понятно, чья она и какая свежее. */
let pushTimer = null;
function pushPassport() {
  if (!S.session || !S.passportSynced) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    api("/api/me/passport", { passport: S.passport }, "PUT").catch(() => {});
  }, 800);
}
// Страницу закрывают или перезагружают раньше, чем сработал таймер, — отправляем сразу.
function flushPassport() {
  if (!pushTimer || !S.session) return;
  clearTimeout(pushTimer);
  pushTimer = null;
  fetch("/api/me/passport", { method: "PUT", keepalive: true, body: JSON.stringify({ passport: S.passport }),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${S.session.access_token}` } }).catch(() => {});
}
window.addEventListener("pagehide", flushPassport);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPassport(); });

async function loadMe() {
  S.me = await api("/api/me");
  S.isAdmin = !!S.me.is_admin;
  paintAdminNav();
  if (S.session && S.me.name && S.session.user.name !== S.me.name) {
    S.session.user.name = S.me.name;
    setSession(S.session);
  }
  return S.me;
}

async function syncPassport({ mergeGuest }) {
  const me = await loadMe();
  S.passportSynced = !!me.passport_sync;
  if (!S.passportSynced) return;
  const uid = me.id;
  const server = me.passport && me.passport.points != null ? { ...emptyPassport(), ...me.passport } : null;
  const local = S.passport;
  const localMine = local.owner === uid, localGuest = !local.owner;
  let push = false;
  if (!server) {
    S.passport = localMine || localGuest ? local : emptyPassport();
    push = true;
  } else if (localMine && (local.ts || 0) > (server.ts || 0)) {
    S.passport = local;  // изменения не успели уйти на сервер до закрытия страницы
    push = true;
  } else if (mergeGuest && localGuest && (local.points || local.visits.length)) {
    // Прогресс, набранный до входа, прибавляется к аккаунту.
    S.passport = {
      points: server.points + local.points,
      visits: [...local.visits, ...server.visits].slice(0, 200),
      quests: server.quests + (local.quests || 0),
      perfect: server.perfect + (local.perfect || 0),
      posts: server.posts || 0,
      badges: [...new Set([...server.badges, ...local.badges])],
      ts: Date.now(),
    };
    push = true;
  } else {
    S.passport = server;
  }
  S.passport.owner = uid;
  S.passport.posts = Math.max(S.passport.posts || 0, me.stats.posts);
  store.set("seruen.passport", S.passport);
  if (push) pushPassport();
  updatePointsBadge();
}

/* ---------- Карта 2ГИС ---------- */
const TILES = "https://tile{s}.maps.2gis.com/tiles?x={x}&y={y}&z={z}&v=1";
const map = L.map("map", { zoomControl: false }).setView([S.origin.lat, S.origin.lon], 14);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer(TILES, { subdomains: "0123", maxZoom: 18, attribution: "© 2ГИС" }).addTo(map);
const layer = L.layerGroup().addTo(map);
const me = L.marker([S.origin.lat, S.origin.lon], {
  icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
  zIndexOffset: 1000, keyboard: false,
}).addTo(map);

map.on("click", (e) => {
  setOrigin({ name: "Точка на карте", lat: +e.latlng.lat.toFixed(3), lon: +e.latlng.lng.toFixed(3) });
});

function drawPlaces(origin, items, candidates) {
  layer.clearLayers();
  const shown = new Set(items.map((x) => x.id));
  (candidates || []).filter((c) => !shown.has(c.id)).forEach((c) => {
    L.circleMarker([c.lat, c.lon], { radius: 4, color: "#8f928a", weight: 1, fillOpacity: 0.6 })
      .bindTooltip(splitName(c.name)[0]).addTo(layer);
  });
  const pts = [[origin.lat, origin.lon]];
  items.forEach((it, i) => {
    const color = it.done ? "#1a7f37" : COLORS[i % COLORS.length];
    const geo = it.leg && it.leg.geometry;
    if (geo && geo.length > 1) {
      L.polyline(geo, { color, weight: 5, opacity: 0.85, dashArray: it.leg.real ? null : "6 8" }).addTo(layer);
      pts.push(...geo);
    }
    L.marker([it.lat, it.lon], {
      icon: L.divIcon({ className: "", html: `<div class="num-marker" style="background:${color}">${it.done ? "✓" : i + 1}</div>`,
        iconSize: [28, 28], iconAnchor: [14, 14] }),
    }).bindTooltip(splitName(it.name)[0]).on("click", () => highlight(i)).addTo(layer);
    pts.push([it.lat, it.lon]);
  });
  if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
}

function highlight(i) {
  $$(".card").forEach((c, j) => c.classList.toggle("hl", i === j));
  const card = $$(".card")[i];
  if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- Контекст: точка, время, погода ---------- */
function inAstana(lat, lon) { return lat > 50.95 && lat < 51.32 && lon > 71.15 && lon < 71.75; }

function setOrigin(o) {
  S.origin = o;
  $("#placeName").textContent = o.name;
  me.setLatLng([o.lat, o.lon]);
  $("#mapHint").hidden = true;
  closePops();
  if (S.view === "ask" && S.result) { S.result = null; renderResult(); layer.clearLayers(); }
  map.panTo([o.lat, o.lon]);
  if (P.scene) P.scene.setOrigin(o.lat, o.lon);
  refreshWeather();
  if (S.view === "quest") renderQuest();
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("no geo"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }), reject,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
}

async function locate() {
  closePops();
  try {
    const p = await getPosition();
    if (!inAstana(p.lat, p.lon)) return toast("Похоже, вы сейчас не в Астане. Выберите точку на карте.");
    setOrigin({ name: "Вы здесь", lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3) });  // ~100 м — точнее не нужно
  } catch {
    toast("Не получилось определить местоположение. Выберите точку на карте.");
  }
}

function timeLabel() {
  if (!S.when) return "Сейчас";
  const d = new Date(S.when);
  return `${WEEK[d.getDay()]}, ${S.when.slice(11, 16)}`;
}

function setWhen(v) {
  S.when = v || null;
  $("#timeLabel").textContent = timeLabel();
  $("#timeChip").classList.toggle("on", !!S.when);
  closePops();
  refreshWeather();
}

async function refreshWeather() {
  const p = new URLSearchParams({ lat: S.origin.lat, lon: S.origin.lon });
  if (S.when) p.set("when", S.when);
  if (S.weatherPreset) p.set("preset", S.weatherPreset);
  try {
    S.weather = await api(`/api/weather?${p}`);
  } catch { S.weather = null; }
  const w = S.weather;
  $("#weatherLabel").textContent = w ? `${fmtTemp(w.temp)}${w.text ? " " + w.text : ""}` : "Погода";
  $("#weatherChip").title = w ? w.label.replace(/^\S+\s/, "") : "";
  $("#weatherChip").classList.toggle("on", !!S.weatherPreset);
}

/* ---------- Поповеры ---------- */
const POPS = { placeChip: "placePop", timeChip: "timePop", weatherChip: "weatherPop", settingsBtn: "settingsPop", photoBtn: "photoPop" };
function closePops() {
  [...Object.values(POPS), "userPop"].forEach((id) => ($("#" + id).hidden = true));
  $$(".menu").forEach((m) => m.remove());
}
function togglePop(btn, pop) {
  const el = $("#" + pop), wasHidden = el.hidden;
  closePops();
  if (!wasHidden) return;
  if (!el.classList.contains("nav-pop")) el.style.top = `${btn.offsetTop + btn.offsetHeight + 6}px`;
  el.hidden = false;
}
Object.entries(POPS).forEach(([btn, pop]) => {
  $("#" + btn).addEventListener("click", (e) => { e.stopPropagation(); togglePop(e.currentTarget, pop); });
  $("#" + pop).addEventListener("click", (e) => e.stopPropagation());
});
document.addEventListener("click", closePops);

function buildPopovers() {
  $("#landmarkList").innerHTML = S.meta.landmarks.map((l, i) =>
    `<button class="opt" data-lm="${i}">${esc(l.name)}</button>`).join("");
  $$("#landmarkList .opt").forEach((b) => b.addEventListener("click", () => {
    const l = S.meta.landmarks[+b.dataset.lm];
    setOrigin({ name: l.name, lat: l.lat, lon: l.lon });
  }));
  $("#locateOpt").addEventListener("click", locate);
  $("#nowOpt").addEventListener("click", () => setWhen(null));
  $("#whenApply").addEventListener("click", () => setWhen($("#whenInput").value));

  const presets = [[null, "Как на самом деле (прогноз)"], ...S.meta.weather_presets.map((p) => [p, p.replace(/^\S+\s/, "")])];
  $("#weatherList").innerHTML = presets.map(([k, label], i) =>
    `<button class="opt${(S.weatherPreset || null) === k ? " sel" : ""}" data-w="${i}">${esc(label)}</button>`).join("");
  $$("#weatherList .opt").forEach((b) => b.addEventListener("click", () => {
    S.weatherPreset = presets[+b.dataset.w][0];
    $$("#weatherList .opt").forEach((x) => x.classList.toggle("sel", x === b));
    closePops();
    refreshWeather();
  }));

  $("#demoCheckin").checked = S.demoCheckin;
  $("#demoCheckin").addEventListener("change", (e) => { S.demoCheckin = e.target.checked; store.set("seruen.demoCheckin", S.demoCheckin); });
  $("#resetQuest").addEventListener("click", () => {
    if (!confirm("Сбросить текущий квест? Очки в паспорте останутся.")) return;
    S.quest = null; saveQuest(); closePops();
    if (S.view === "quest") { renderQuest(); drawQuest(); }
  });
  $("#logoutBtn").addEventListener("click", logout);
}

/* ---------- Навбар ---------- */
function renderNavAuth() {
  const el = $("#navAuth");
  if (!S.session) {
    el.innerHTML = `<button class="btn" data-auth="login">Войти</button><button class="btn primary" data-auth="register">Регистрация</button>`;
    $$("[data-auth]", el).forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
  } else {
    const u = S.session.user;
    el.innerHTML = `<span class="pts-chip" id="ptsChip" title="Очки в паспорте">★ ${fmtInt(S.passport.points)}</span>
      <button class="avatar-btn" id="avatarBtn" aria-label="Меню профиля">${avatar(u.name, "sm")}<span class="nm">${esc(u.name)}</span></button>`;
    $("#avatarBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const pop = $("#userPop"), wasHidden = pop.hidden;
      closePops();
      pop.hidden = !wasHidden;
    });
  }
  const ca = $("#composerAva");
  if (ca) ca.outerHTML = S.session ? avatar(S.session.user.name).replace('class="ava "', 'class="ava " id="composerAva"')
    : `<span class="ava" id="composerAva" style="background:#b9bcb4">?</span>`;
}

function updatePointsBadge() {
  const chip = $("#ptsChip");
  if (chip) chip.textContent = `★ ${fmtInt(S.passport.points)}`;
}

/* ---------- Навигация ---------- */
const VIEWS = ["ask", "quest", "feed", "pulse", "business", "admin", "profile"];
function go(view, { replace = true } = {}) {
  if (!VIEWS.includes(view)) view = "ask";
  S.view = view;
  closePops();
  $$("[data-go]").forEach((b) => b.classList.toggle("active", b.dataset.go === view && !b.classList.contains("logo")));
  const main = view === "ask" || view === "quest";
  $("#view-main").classList.toggle("active", main);
  $("#view-feed").classList.toggle("active", view === "feed");
  $("#view-pulse").classList.toggle("active", view === "pulse");
  $("#view-business").classList.toggle("active", view === "business");
  $("#view-admin").classList.toggle("active", view === "admin");
  $("#view-profile").classList.toggle("active", view === "profile");
  if (view !== "pulse") pausePulse();
  $("#pane-ask").hidden = view !== "ask";
  $("#pane-quest").hidden = view !== "quest";
  if (main) setTimeout(() => map.invalidateSize(), 0);
  let loading = Promise.resolve();
  if (view === "ask") {
    if (S.result) drawPlaces(S.result.origin, S.result.items, S.result.candidates); else layer.clearLayers();
  } else if (view === "quest") {
    renderQuest(); drawQuest();
  } else if (view === "feed") {
    ensureFeedMap(); loading = loadFeed();
  } else if (view === "pulse") {
    loading = openPulse();
  } else if (view === "business") {
    loading = renderBusiness();
  } else if (view === "admin") {
    loading = renderAdmin();
  } else {
    loading = renderProfile();
  }
  if (replace && location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  if (!main) window.scrollTo(0, 0);
  return loading;
}
function refreshView() { return go(S.view); }
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-go]");
  if (g) { e.preventDefault(); go(g.dataset.go); }
});
window.addEventListener("hashchange", () => go(location.hash.slice(1), { replace: false }));

/* ---------- Уточнения ---------- */
function buildSeg(el, options, get, set, onChange) {
  el.innerHTML = options.map(([, label], i) => `<button type="button" data-i="${i}">${label}</button>`).join("");
  const paint = () => $$("button", el).forEach((b) => b.classList.toggle("on", options[+b.dataset.i][0] === get()));
  $$("button", el).forEach((b) => b.addEventListener("click", () => {
    set(options[+b.dataset.i][0]);
    paint();
    if (onChange) onChange();
  }));
  paint();
}

function buildRefine() {
  buildSeg($("#modeSeg"), MODES, () => S.mode, (v) => (S.mode = S.mode === v ? null : v), refineSummary);
  buildSeg($("#budgetSeg"), BUDGETS, () => S.budget, (v) => (S.budget = S.budget === v ? null : v), refineSummary);
  const groupPaint = () => { $("#groupLabel").textContent = `${S.group} ${plural(S.group, "человек", "человека", "человек")}`; refineSummary(); };
  $("#groupMinus").addEventListener("click", () => { S.group = Math.max(1, S.group - 1); groupPaint(); });
  $("#groupPlus").addEventListener("click", () => { S.group = Math.min(8, S.group + 1); groupPaint(); });
  $("#needToggles").innerHTML = NEEDS.map(([k, label]) => `<button type="button" data-k="${k}">${label}</button>`).join("");
  $$("#needToggles button").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k;
    S.needs.has(k) ? S.needs.delete(k) : S.needs.add(k);
    b.classList.toggle("on", S.needs.has(k));
    refineSummary();
  }));
}
function refineSummary() {
  const n = (S.mode ? 1 : 0) + (S.budget ? 1 : 0) + (S.group > 1 ? 1 : 0) + S.needs.size;
  $("#refineSummary").textContent = n ? `Уточнить · ${n}` : "Уточнить";
}

/* ---------- Подбор мест ---------- */
const LOADING = ["Смотрю, что открыто рядом…", "Выбираю под ваш запрос…", "Прокладываю маршруты в 2ГИС…"];
let loadingTimer;

function showLoading(box, lines = LOADING) {
  let i = 0;
  box.innerHTML = `<div class="loading"><div class="status">${lines[0]}</div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>`;
  clearInterval(loadingTimer);
  loadingTimer = setInterval(() => {
    i = Math.min(i + 1, lines.length - 1);
    const st = $(".status", box);
    if (st) st.textContent = lines[i];
  }, 1700);
}

async function ask(text) {
  text = (text || "").trim();
  if (!text || S.busy) return;
  S.busy = true;
  $("#sendBtn").disabled = true;
  $("#mapHint").hidden = true;
  showLoading($("#results"));
  try {
    S.result = await api("/api/recommend", {
      text, lat: S.origin.lat, lon: S.origin.lon, place: S.origin.name, when: S.when, weather: S.weatherPreset,
      mode: S.mode, budget: S.budget, group: S.group, needs: [...S.needs],
    });
    renderResult();
    if (S.view === "ask") drawPlaces(S.result.origin, S.result.items, S.result.candidates);
  } catch (e) {
    $("#results").innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    clearInterval(loadingTimer);
    S.busy = false;
    $("#sendBtn").disabled = false;
  }
}

function statusHTML(it, nowIso) {
  if (it.outdoor) return `<span>Под открытым небом</span>`;
  if (it.open_now === null) return `<span class="unk">Часы работы неизвестны</span>`;
  if (it.closes_in === null) return `<span class="ok">Круглосуточно</span>`;
  if (it.closes_in < 90) return `<span class="warn">Закроется через ${it.closes_in} мин</span>`;
  const now = +nowIso.slice(11, 13) * 60 + +nowIso.slice(14, 16);
  const t = (now + it.closes_in) % 1440;
  const hh = String(Math.floor(t / 60)).padStart(2, "0"), mm = String(t % 60).padStart(2, "0");
  return `<span class="ok">${t === 0 ? "Открыто до полуночи" : `Открыто до ${hh}:${mm}`}</span>`;
}

function wayText(leg, mode) {
  if (!leg) return "";
  const t = fmtMin(leg.travel_min), d = fmtDist(leg.distance_m);
  if (mode === "transit" && leg.summary && leg.summary !== "пешком быстрее") return `${t} · ${leg.summary}`;
  if (mode === "car") return `${t} на машине · ${d}`;
  return `${t} пешком · ${d}${leg.real ? "" : " (примерно)"}`;
}

function cardHTML(it, i, r) {
  const [title, descr] = splitName(it.name);
  const kind = descr || KIND[it.main_category] || "";
  const rating = it.rating ? ` · <span class="star">★</span> ${String(it.rating).replace(".", ",")} <span>(${fmtInt(it.reviews)})</span>` : "";
  const route = r.intent.route;
  const from = route && i > 0 ? r.items[i - 1] : { ...r.origin, id: null };
  const link = dirUrl([from, it], r.intent.mode);
  const visit = it.visit_min ? `<span class="muted"> · около ${fmtMin(it.visit_min)}</span>` : "";
  const visited = S.passport.visits.some((v) => v.id === it.id && sameDay(v.ts));
  return `<article class="card" data-i="${i}">
    <div class="card-top"><span class="pin" style="--c:${COLORS[i % COLORS.length]}">${i + 1}</span>
      <div><h3>${esc(title)}</h3><div class="kind">${esc(kind)}${rating}</div></div></div>
    <div class="facts">${statusHTML(it, r.now)}<span>${esc(wayText(it.leg, r.intent.mode))}${route && i ? " от предыдущей" : ""}</span>${
      it.community ? `<span class="love">♥ советуют в ленте: ${it.community.posts}</span>` : ""}</div>
    ${it.why ? `<p class="why">${esc(it.why)}</p>` : ""}
    ${it.plan ? `<p class="plan"><b>Что сделать:</b> ${esc(it.plan)}${visit}</p>` : ""}
    ${it.caveat ? `<p class="caveat">${esc(it.caveat)}</p>` : ""}
    ${it.offer ? offerHTML(it.offer) : ""}
    <div class="actions">
      <a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Маршрут в 2ГИС</a>
      <a class="btn" href="${esc(it.url)}" target="_blank" rel="noopener">О месте</a>
      <button class="btn ${visited ? "done" : ""}" data-checkin="${i}" ${visited ? "disabled" : ""}>${visited ? "Отмечено" : "Я здесь"}</button>
      <button class="btn" data-share="${i}">Поделиться</button>
    </div>
  </article>`;
}

function renderResult() {
  const r = S.result, box = $("#results");
  if (!r) { box.innerHTML = ""; return; }
  if (!r.items.length) {
    box.innerHTML = `<div class="empty">Подходящего рядом не нашлось: либо всё закрыто в это время, либо запрос слишком узкий.
      Попробуйте другое время, точку на карте или запрос попроще.</div>`;
    return;
  }
  let html = vibeHTML(r) + funnelHTML(r) + (r.intro ? `<p class="intro">${esc(r.intro)}</p>` : "") +
    `<div class="cards">${r.items.map((it, i) => cardHTML(it, i, r)).join("")}</div>`;
  if (r.intent.route) {
    const total = r.items.reduce((s, it) => s + (it.leg ? it.leg.travel_min : 0) + (it.visit_min || 0), 0);
    const chain = [{ ...r.origin, id: null }, ...r.items];
    html += `<div class="route-sum">Весь маршрут — около ${fmtMin(total)} вместе с остановками.
      <a href="${esc(dirUrl(chain, r.intent.mode))}" target="_blank" rel="noopener">Открыть в 2ГИС</a></div>`;
  }
  if (r.idea && (r.idea.text || r.idea.title)) {
    html += `<div class="tip"><div class="tip-title">Совет${r.idea.title ? ": " + esc(r.idea.title) : ""}</div>
      <p>${esc(r.idea.text || "")}</p><div class="muted small">Это наша идея, а не место из каталога 2ГИС.</div></div>`;
  }
  html += `<div class="after">
      <button class="btn" id="moreBtn">Показать другие</button>
      <button class="btn" id="speakBtn" title="Прочитать вслух">Прочитать вслух</button>
      <button class="btn" id="fly3dBtn" title="Пролететь над маршрутом в 3D">3D-пролёт</button>
      <span class="spacer"></span>
      <button class="linkbtn" id="whyBtn">Почему эти места?</button></div>`;
  box.innerHTML = html;

  countUp(box);
  // Переход из карточки с предложением — засчитываем заведению в статистику.
  $$(".card", box).forEach((c) => {
    const it = r.items[+c.dataset.i];
    if (!it.offer) return;
    $$(".actions a", c).forEach((a) => a.addEventListener("click", () => offerClick(it.offer.id)));
  });
  $$(".card", box).forEach((c) => c.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) return;
    const i = +c.dataset.i;
    highlight(i);
    map.flyTo([r.items[i].lat, r.items[i].lon], Math.max(map.getZoom(), 15), { duration: 0.6 });
  }));
  $$("[data-checkin]", box).forEach((b) => b.addEventListener("click", async () => {
    const it = r.items[+b.dataset.checkin];
    if (await checkIn(it)) {
      addVisit({ id: it.id, name: it.name, cat: it.main_category });
      b.textContent = "Отмечено"; b.classList.add("done"); b.disabled = true;
    }
  }));
  $$("[data-share]", box).forEach((b) => b.addEventListener("click", () => {
    const it = r.items[+b.dataset.share];
    requireAuth("Войдите, чтобы делиться местами в ленте", () =>
      openComposer({ id: it.id, name: it.name, category: it.main_category }));
  }));
  $("#moreBtn").addEventListener("click", showMore);
  $("#speakBtn").addEventListener("click", (e) => speak(e.currentTarget));
  $("#fly3dBtn").addEventListener("click", fly3dResult);
  $("#whyBtn").addEventListener("click", openWhy);
}

/* ---------- 3D-пролёт (three.js, модуль грузится по кнопке) ---------- */
async function open3D(payload) {
  try {
    const m = await import("/static/city3d.js");
    await m.openCity3D(payload);
  } catch (e) {
    console.error(e);
    toast("3D-режим не загрузился — проверьте интернет");
  }
}

function fly3dResult() {
  const r = S.result;
  open3D({
    title: r.intent.route ? `Маршрут из ${r.items.length} ${plural(r.items.length, "места", "мест", "мест")}` : "Места рядом",
    subtitle: `от «${r.origin.name}»`,
    hour: +r.now.slice(11, 13),
    chain: r.intent.route,
    origin: r.origin,
    stops: r.items.map((it, i) => ({
      name: splitName(it.name)[0], kind: splitName(it.name)[1] || KIND[it.main_category] || "",
      sub: wayText(it.leg, r.intent.mode), text: it.why, lat: it.lat, lon: it.lon,
      color: COLORS[i % COLORS.length], leg: it.leg,
    })),
  });
}

function fly3dQuest() {
  const d = S.quest.data;
  open3D({
    title: d.title,
    subtitle: `${d.stops.length} ${plural(d.stops.length, "точка", "точки", "точек")} · около ${fmtMin(d.walk_min)} пешком`,
    hour: S.when ? +S.when.slice(11, 13) : new Date().getHours(),
    chain: true,
    origin: d.origin,
    stops: d.stops.map((s, i) => ({
      name: splitName(s.name)[0], kind: KIND[s.category_key] || "",
      sub: s.leg ? `${fmtMin(s.leg.travel_min)} пешком` : "", text: s.task, lat: s.lat, lon: s.lon,
      color: COLORS[i % COLORS.length], leg: s.leg,
    })),
  });
}

/* ---------- Предложения заведений ---------- */
const DAY_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const hhmm = (m) => (m === 1440 ? "24:00" : `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
function offerWhen(o) {
  const d = [...o.days].sort();
  const days = d.length === 7 ? "каждый день" : d.join() === "0,1,2,3,4" ? "по будням" : d.join() === "5,6" ? "по выходным"
    : d.map((x) => DAY_SHORT[x]).join(", ");
  const hours = o.start_min === 0 && o.end_min === 1440 ? "весь день" : `${hhmm(o.start_min)}–${hhmm(o.end_min)}`;
  const until = o.valid_until ? ` · до ${o.valid_until.split("-").reverse().join(".")}` : "";
  return `${days}, ${hours}${until}`;
}
function offerHTML(o) {
  return `<div class="offer"><span class="ad">Реклама</span><b>${esc(o.kind_label)}: ${esc(o.title)}</b>
    ${o.details ? `<p>${esc(o.details)}</p>` : ""}
    <span class="when">${esc(offerWhen(o))} · предложение заведения, на подбор мест не влияет</span></div>`;
}
function offerClick(id) {
  try { navigator.sendBeacon(`/api/offers/${id}/click`); } catch { /* статистика необязательна */ }
}
/** Действует ли предложение в выбранный день (0 = пн) и минуту. Как на сервере. */
function offerRunsAt(o, day, minute) {
  const s = o.start_min, e = o.end_min;
  if (s < e) return o.days.includes(day) && s <= minute && minute < e;
  return (o.days.includes(day) && minute >= s) || (o.days.includes((day + 6) % 7) && minute < e);
}

/* «Как на фото»: картинка с атмосферой -> запрос -> обычный подбор. */
let vibeImg = null;
function vibeHTML(r) {
  if (!r.vibe) return "";
  return `<div class="vibe-head">${vibeImg ? `<img src="${vibeImg}" alt="">` : ""}<div>
    <b>Похожее по атмосфере: ${esc(r.vibe.vibe)}</b>
    <span class="muted small">Ищу: «${esc(r.vibe.query)}». Подбираю по типу и особенностям мест из каталога 2ГИС —
      фото интерьеров мы не сравниваем.</span></div></div>`;
}

async function vibeSearch(file) {
  if (S.busy) return;
  let shot;
  try { shot = await shrinkImage(file, 768); } catch (e) { return toast(e.message || "Не получилось открыть фото"); }
  vibeImg = shot.url;
  S.busy = true;
  $("#mapHint").hidden = true;
  showLoading($("#results"), ["Смотрю на атмосферу картинки…", "Превращаю её в запрос…", "Подбираю похожие места рядом…"]);
  const fd = new FormData();
  fd.append("image", shot.blob, "vibe.jpg");
  fd.append("lat", S.origin.lat); fd.append("lon", S.origin.lon); fd.append("place", S.origin.name);
  if (S.when) fd.append("when", S.when);
  if (S.weatherPreset) fd.append("weather", S.weatherPreset);
  try {
    const r = await fetch("/api/vibe", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "Не получилось подобрать места по фото");
    S.result = j;
    $("#query").value = j.vibe.query; autosize();
    renderResult();
    drawPlaces(j.origin, j.items, j.candidates);
  } catch (e) {
    $("#results").innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    clearInterval(loadingTimer);
    S.busy = false;
  }
}

/* Воронка: сколько мест отсеял каждый шаг поиска — настоящие числа с сервера. */
function funnelHTML(r) {
  const f = r.funnel;
  if (!f || !f.total) return "";
  const steps = [[f.total, "мест в базе"]];
  if (f.category < f.total) steps.push([f.category, "подходят по типу"]);
  steps.push([f.nearby, `в радиусе ${fmtDist(r.radius_m)}`], [f.open, "открыты и успеете"],
    [f.candidates, "лучших по оценке"], [f.chosen, "выбрано для вас"]);
  const t = r.timings || {}, sec = (v) => String(v ?? 0).replace(".", ",");
  return `<div class="funnel">${steps.map(([n, label], i) =>
    `<div class="f-step${i === steps.length - 1 ? " last" : ""}"><b data-count="${n}">${fmtInt(n)}</b><span>${label}</span></div>`)
    .join('<span class="f-arrow">›</span>')}</div>
    <div class="f-time">Понял запрос за ${sec(t.intent)} с · нашёл за ${sec(t.retrieve)} с · выбрал за ${sec(t.generate)} с · маршруты 2ГИС за ${sec(t.routes)} с</div>`;
}

function countUp(root) {
  $$("[data-count]", root).forEach((el) => {
    const to = +el.dataset.count, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 700), v = Math.round(to * (1 - (1 - k) ** 3));
      el.textContent = fmtInt(v);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

async function showMore() {
  const btn = $("#moreBtn");
  btn.disabled = true;
  btn.textContent = "Ищу другие…";
  try {
    const r = await api("/api/more", { id: S.result.id });
    if (!r.items.length) { toast("Других подходящих мест рядом нет"); btn.textContent = "Других нет"; return; }
    S.result = r;
    renderResult();
    drawPlaces(r.origin, r.items, r.candidates);
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = "Показать другие";
  }
}

let audio;
async function speak(btn) {
  btn.disabled = true;
  try {
    const r = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: S.result.id }) });
    if (!r.ok) throw new Error();
    if (audio) audio.pause();
    audio = new Audio(URL.createObjectURL(await r.blob()));
    await audio.play();
  } catch {
    toast("Прочитать вслух сейчас не получится");
  } finally {
    btn.disabled = false;
  }
}

/* ---------- «Почему эти места?» ---------- */
function openWhy() {
  const r = S.result, i = r.intent, w = r.weather;
  const tags = i.categories.map((c) => KIND[c] || c);
  if (i.time_budget_min) tags.push(`есть ${fmtMin(i.time_budget_min)}`);
  tags.push({ walk: "пешком", transit: "на транспорте", car: "на машине" }[i.mode]);
  if (i.stroll) tags.push("хочется погулять");
  if (i.route) tags.push("маршрут из нескольких мест");
  if (i.group_size > 1) tags.push(`компания из ${i.group_size}`);
  i.needs.forEach((n) => tags.push(S.meta.needs[n] || n));
  const shown = new Set(r.items.map((x) => x.id));
  $("#whySheet").innerHTML = `
    <div class="sheet-head"><h2>Почему эти места</h2>${closeBtn("whyClose")}</div>
    <h3>Как мы поняли запрос</h3><div class="tags">${tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>
    <h3>Где искали</h3>
    <p>В радиусе ${fmtDist(r.radius_m)} от точки «${esc(r.origin.name)}». Учли время — ${esc(r.now.slice(11, 16))}: закрытые места и те,
      что закроются раньше, чем вы успеете дойти и побыть там, убрали. Фонтаны и уличные катки — только в сезон.
      ${w ? `Погода: ${esc(w.label.replace(/^\S+\s/, ""))} — ${esc(w.advice)}.` : ""}</p>
    <h3>Что рассматривали — ${r.candidates.length} ${plural(r.candidates.length, "место", "места", "мест")}</h3>
    <ul class="cand">${r.candidates.map((c) => {
      const open = c.outdoor ? "на улице" : c.open_now === null ? "часы неизвестны" : "открыто";
      return `<li class="${shown.has(c.id) ? "chosen" : ""}"><span class="c-name">${shown.has(c.id) ? "✓ " : ""}${esc(splitName(c.name)[0])}</span>
        <span class="c-meta">${fmtDist(c.distance_m)}${c.rating ? ` · ★ ${String(c.rating).replace(".", ",")}` : ""} · ${open}</span></li>`;
    }).join("")}</ul>
    <h3>Откуда данные</h3>
    <p>Места, часы работы и рейтинги — каталог 2ГИС (${fmtInt(S.meta.total)} мест, обновлён ${esc(S.meta.collected_at.split("-").reverse().join("."))}).
      Маршруты — 2ГИС, погода — Open-Meteo. Тексты пишет языковая модель только по этим данным: если чего-то в данных нет,
      мы так и пишем. Ваша точка округляется примерно до 100 м и нигде не сохраняется.</p>`;
  $("#whyBackdrop").hidden = false;
  $("#whyClose").addEventListener("click", () => ($("#whyBackdrop").hidden = true));
}

function closeBtn(id) {
  return `<button class="icon-btn" id="${id}" aria-label="Закрыть">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
}
["whyBackdrop", "shareBackdrop", "authBackdrop"].forEach((id) =>
  $("#" + id).addEventListener("click", (e) => { if (e.target.id === id) $("#" + id).hidden = true; }));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  ["whyBackdrop", "shareBackdrop", "authBackdrop"].forEach((id) => ($("#" + id).hidden = true));
  closePops();
});

/* ---------- Отметки и паспорт ---------- */
function sameDay(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }
function savePassport() {
  S.passport.ts = Date.now();
  store.set("seruen.passport", S.passport);
  updatePointsBadge();
  pushPassport();
}

async function checkIn(place) {
  if (S.demoCheckin) return true;
  try {
    const pos = await getPosition();
    const d = haversine(pos, place);
    if (d > CHECKIN_RADIUS_M) { toast(`До места ещё ${fmtDist(d)}. Подойдите ближе и попробуйте снова.`); return false; }
    return true;
  } catch {
    toast("Не удалось понять, где вы. Включите геолокацию или демо-режим в настройках.");
    return false;
  }
}

function addPoints(n) { S.passport.points += n; }

function newBadges() {
  const got = BADGES.filter(([id, , , test]) => !S.passport.badges.includes(id) && test(S.passport));
  got.forEach(([id]) => S.passport.badges.push(id));
  return got;
}

function addVisit(v, { points = POINTS_VISIT } = {}) {
  const hour = S.when ? +S.when.slice(11, 13) : new Date().getHours();
  S.passport.visits.unshift({ ...v, ts: Date.now(), hour, feels: S.weather ? S.weather.feels : null });
  S.passport.visits = S.passport.visits.slice(0, 200);
  addPoints(points);
  const badges = newBadges();
  savePassport();
  toast(badges.length ? `+${points} · новый значок «${badges[0][1]}»` : `+${points} · отметка в паспорте`);
}

function passportHTML(p) {
  const { lvl, next, pct } = levelOf(p.points);
  return `
    <div class="level"><div><div class="muted small">Уровень</div><h2>${lvl[1]}</h2></div><div class="pts">${fmtInt(p.points)}</div></div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="qscore"><span>${next ? `До уровня «${next[1]}» — ${fmtInt(next[0] - p.points)} очков` : "Максимальный уровень"}</span>
      <span>${p.quests} ${plural(p.quests, "квест", "квеста", "квестов")}</span></div>
    <div class="section-title">Штампы</div>
    <div class="stamps">${STAMPS.map(([k, label]) => {
      const n = countCat(p, k);
      return `<div class="stamp ${n ? "got" : ""}"><div class="n">${n || "·"}</div>${label}</div>`;
    }).join("")}</div>
    <div class="section-title">Значки</div>
    <div class="badges">${BADGES.map(([id, title, desc]) => `<div class="badge-row ${p.badges.includes(id) ? "got" : ""}">
      <div class="medal">${title[0]}</div><div><div class="t">${title}</div><div class="muted small">${desc}</div></div></div>`).join("")}</div>
    <div class="section-title">Где вы отмечались</div>
    ${p.visits.length ? `<ul class="visits">${p.visits.slice(0, 12).map((v) => `<li><span>${esc(splitName(v.name)[0])}</span>
      <span class="muted">${new Date(v.ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</span></li>`).join("")}</ul>`
      : `<p class="muted">Пока пусто. Нажмите «Я здесь» на карточке места или пройдите квест.</p>`}`;
}

/* ---------- Квест ---------- */
function saveQuest() { store.set("seruen.quest", S.quest); }

async function startQuest() {
  S.questLoading = true; S.questError = null;
  renderQuest();
  try {
    const data = await api("/api/quest", { lat: S.origin.lat, lon: S.origin.lon, place: S.origin.name, when: S.when,
      weather: S.weatherPreset, budget: S.questBudget });
    S.quest = { data, step: 0, checked: [], answers: [], points: 0, finished: false };
    saveQuest();
  } catch (e) {
    S.questError = e.message;
  } finally {
    S.questLoading = false;
    renderQuest();
  }
}

function drawQuest() {
  const q = S.quest;
  if (!q) { layer.clearLayers(); return; }
  const stops = q.data.stops.map((s, i) => ({ ...s, done: !!q.checked[i] && (i < q.step || q.finished) }));
  drawPlaces(q.data.origin, stops, null);
}

function renderQuest() {
  const box = $("#pane-quest");
  if (S.questLoading) {
    showLoading(box, ["Ищу интересные точки рядом…", "Придумываю задания…", "Прокладываю маршрут в 2ГИС…"]);
    return;
  }
  clearInterval(loadingTimer);
  const q = S.quest;
  if (!q) {
    const seg = [[60, "1 час"], [90, "1,5 часа"], [120, "2 часа"]];
    box.innerHTML = `<div class="quest-hero">
        <h2>Квест-прогулка</h2>
        <p>Соберём маршрут из нескольких интересных точек рядом с вами. На каждой — небольшое задание и вопрос
          о месте. Отмечайтесь, отвечайте и собирайте очки в паспорт.</p>
        <div class="field-label">Сколько времени на прогулку</div>
        <div class="seg" id="qBudget">${seg.map(([v, l]) => `<button type="button" data-v="${v}" class="${S.questBudget === v ? "on" : ""}">${l}</button>`).join("")}</div>
        <div style="margin-top:16px"><button class="btn primary big" id="qStart">Собрать квест от «${esc(S.origin.name)}»</button></div>
      </div>
      <ul class="quest-rules">
        <li><b>+50</b>за отметку на каждой точке</li>
        <li><b>+50</b>за верный ответ на вопрос о месте</li>
        <li><b>+100</b>за весь квест</li>
      </ul>
      ${S.questError ? `<div class="error" style="margin-top:14px">${esc(S.questError)}</div>` : ""}
      <p class="muted small" style="margin-top:14px">Вопросы составлены по описаниям мест из 2ГИС — ответ можно найти на месте.
        ${S.session ? "" : "Войдите, чтобы очки сохранились в аккаунте."}</p>`;
    $$("#qBudget button").forEach((b) => b.addEventListener("click", () => { S.questBudget = +b.dataset.v; renderQuest(); }));
    $("#qStart").addEventListener("click", startQuest);
    if (S.view === "quest") layer.clearLayers();
    return;
  }

  const d = q.data, n = d.stops.length;
  const done = q.checked.filter(Boolean).length;
  let html = `<div class="qhead"><h2>${esc(d.title)}</h2>${d.intro ? `<p>${esc(d.intro)}</p>` : ""}
      <div class="qmeta">${n} ${plural(n, "точка", "точки", "точек")} · ${fmtDist(d.walk_distance_m)} · около ${fmtMin(d.walk_min)} пешком</div>
      <div style="margin-top:10px"><button class="btn" id="qFly3d">3D-пролёт по маршруту</button></div></div>
    <div class="progress"><div style="width:${Math.round((q.finished ? 1 : done / n) * 100)}%"></div></div>
    <div class="qscore"><span>Пройдено ${done} из ${n}</span><span>Очки: <b>${q.points}</b> из ${d.points.max}</span></div>
    <ol class="stops">`;
  d.stops.forEach((s, i) => {
    const state = q.finished || i < q.step ? "done" : i === q.step ? "current" : "future";
    const leg = s.leg ? `${fmtMin(s.leg.travel_min)} пешком${i ? " от предыдущей" : ""}` : "";
    html += `<li class="stop ${state}"><div class="stop-head"><span class="pin" style="--c:${COLORS[i % COLORS.length]}">${state === "done" ? "✓" : i + 1}</span>
      <div><div class="stop-name">${esc(splitName(s.name)[0])}</div><div class="stop-sub">${esc(leg)}</div></div></div>`;
    if (state === "current") html += stopBody(s, i);
    html += `</li>`;
  });
  html += `</ol>`;
  if (q.finished) {
    const right = q.answers.filter((a, i) => a !== null && a !== undefined && a === d.stops[i].answer).length;
    const total = d.stops.filter((s) => s.question).length;
    html += `<div class="finish"><h3>Квест пройден</h3><div class="big-num">+${q.points}</div>
      <div class="muted">${total ? `Верных ответов: ${right} из ${total}. ` : ""}Очки уже в паспорте.</div>
      <div style="margin-top:14px"><button class="btn primary" id="qNew">Новый квест</button></div></div>`;
  } else {
    html += `<div class="after"><span class="spacer"></span><button class="linkbtn" id="qQuit">Закончить квест</button></div>`;
  }
  box.innerHTML = html;
  bindStop();
  $("#qFly3d").addEventListener("click", fly3dQuest);
  if ($("#qNew")) $("#qNew").addEventListener("click", () => { S.quest = null; saveQuest(); renderQuest(); });
  if ($("#qQuit")) $("#qQuit").addEventListener("click", () => {
    if (!confirm("Закончить квест? Заработанные очки останутся в паспорте.")) return;
    S.quest = null; saveQuest(); renderQuest();
  });
  if (S.view === "quest") drawQuest();
}

function stopBody(s, i) {
  const q = S.quest;
  const from = i ? q.data.stops[i - 1] : { ...q.data.origin, id: null };
  let h = `<div class="stop-body">
    <div class="task"><b>Задание:</b> ${esc(s.task)}</div>`;
  if (!q.checked[i]) {
    h += `<div class="actions" style="margin:0"><button class="btn primary" id="qCheck">Я на месте</button>
      <button class="btn" id="qPhoto">Отметиться фото · +${POINTS_PHOTO}</button>
      <a class="btn" href="${esc(dirUrl([from, s], "walk"))}" target="_blank" rel="noopener">Маршрут в 2ГИС</a></div>
      <div class="muted small">Фото проверит модель: на снимке должна быть эта точка. Снимок не сохраняется.</div>`;
  } else if (s.question) {
    if (q.photoNote && q.photoNote[i]) h += `<div class="feedback"><b>Фото засчитано.</b> ${esc(q.photoNote[i])}</div>`;
    const a = q.answers[i];
    const answered = a !== null && a !== undefined;
    h += `<div class="question">${esc(s.question)}</div><div class="options">${s.options.map((o, k) => {
      const cls = answered ? (k === s.answer ? "right" : k === a ? "wrong" : "") : "";
      return `<button data-opt="${k}" class="${cls}" ${answered ? "disabled" : ""}>${esc(o)}</button>`;
    }).join("")}</div>`;
    if (answered) {
      h += `<div class="feedback">${a === s.answer ? "<b>Верно.</b> " : `<b>Не совсем.</b> Правильно — «${esc(s.options[s.answer])}». `}${esc(s.fact || "")}</div>`;
      h += nextBtn(i);
    }
  } else {
    h += nextBtn(i);
  }
  return h + `</div>`;
}

let questPhotoStop = null;
$("#questPhotoInput").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  const q = S.quest, i = questPhotoStop;
  if (!f || !q || i == null || q.checked[i]) return;
  const s = q.data.stops[i];
  const btn = $("#qPhoto");
  if (btn) { btn.disabled = true; btn.textContent = "Проверяю фото…"; }
  try {
    const shot = await shrinkImage(f, 768);
    const fd = new FormData();
    fd.append("image", shot.blob, "checkin.jpg");
    fd.append("place_id", s.id);
    const r = await fetch("/api/quest/verify", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "Не получилось проверить фото");
    if (!j.match) {
      toast(`${j.comment || "Не похоже на эту точку"}. Попробуйте ещё раз или отметьтесь кнопкой`, 4500);
    } else {
      q.checked[i] = true;
      q.photoNote = q.photoNote || [];
      q.photoNote[i] = j.comment || "";
      q.points += POINTS_VISIT + POINTS_PHOTO;
      S.passport.photos = (S.passport.photos || 0) + 1;
      addVisit({ id: s.id, name: s.name, cat: s.category_key }, { points: POINTS_VISIT + POINTS_PHOTO });
      saveQuest();
    }
  } catch (err) {
    toast(err.message || "Не получилось проверить фото");
  } finally {
    renderQuest();
  }
});

function nextBtn(i) {
  const last = i === S.quest.data.stops.length - 1;
  return `<div><button class="btn primary" id="qNext">${last ? "Завершить квест" : "Дальше"}</button></div>`;
}

function bindStop() {
  const q = S.quest;
  if (!q || q.finished) return;
  const i = q.step, s = q.data.stops[i];
  const photo = $("#qPhoto");
  if (photo) photo.addEventListener("click", () => { questPhotoStop = i; $("#questPhotoInput").click(); });
  const check = $("#qCheck");
  if (check) check.addEventListener("click", async () => {
    check.disabled = true;
    if (!(await checkIn(s))) { check.disabled = false; return; }
    q.checked[i] = true;
    q.points += POINTS_VISIT;
    addVisit({ id: s.id, name: s.name, cat: s.category_key });
    saveQuest(); renderQuest();
  });
  $$("[data-opt]").forEach((b) => b.addEventListener("click", () => {
    const k = +b.dataset.opt;
    q.answers[i] = k;
    if (k === s.answer) {
      q.points += q.data.points.answer;
      addPoints(q.data.points.answer);
      savePassport();
      toast(`+${q.data.points.answer} · верный ответ`);
    }
    saveQuest(); renderQuest();
  }));
  const next = $("#qNext");
  if (next) next.addEventListener("click", () => {
    if (i < q.data.stops.length - 1) {
      q.step += 1;
    } else {
      q.finished = true;
      q.points += q.data.points.finish;
      addPoints(q.data.points.finish);
      S.passport.quests += 1;
      const withQ = q.data.stops.map((st, j) => [st, j]).filter(([st]) => st.question);
      if (withQ.length && withQ.every(([st, j]) => q.answers[j] === st.answer)) S.passport.perfect += 1;
      const badges = newBadges();
      savePassport();
      toast(badges.length ? `Квест пройден · новый значок «${badges[0][1]}»` : `Квест пройден · +${q.data.points.finish}`);
    }
    saveQuest(); renderQuest();
  });
}

/* ---------- Лента ---------- */
let feedMap, feedLayer;
function ensureFeedMap() {
  if (!feedMap) {
    feedMap = L.map("feedMap", { zoomControl: false }).setView([S.origin.lat, S.origin.lon], 12);
    L.tileLayer(TILES, { subdomains: "0123", maxZoom: 18, attribution: "© 2ГИС" }).addTo(feedMap);
    feedLayer = L.layerGroup().addTo(feedMap);
  }
  setTimeout(() => feedMap.invalidateSize(), 0);
}

async function loadFeed() {
  S.feedLoading = true; S.feedError = null;
  renderFeed();
  const p = new URLSearchParams({ sort: S.feedSort, lat: S.origin.lat, lon: S.origin.lon });
  try {
    S.feed = await api(`/api/feed?${p}`);
  } catch (e) {
    S.feed = null; S.feedError = e.message;
  } finally {
    S.feedLoading = false;
    renderFeed();
  }
}

function postHTML(p, i, { own = false } = {}) {
  const author = (p.author && p.author.name) || "Участник";
  const [title, descr] = splitName(p.place_name);
  const kind = descr || KIND[p.place_category] || "";
  const dist = p.distance_m != null ? fmtDist(p.distance_m) : "";
  const route = dirUrl([{ ...S.origin, id: null }, { lat: p.lat, lon: p.lon, id: p.place_id }], "walk");
  return `<article class="post" data-i="${i}">
    <div class="post-head">${avatar(author)}
      <div class="who"><b>${esc(author)}</b>${p.author && p.author.demo
        ? `<span class="demo-tag" title="Демонстрационный аккаунт: подсказка составлена по данным 2ГИС, а не по личному опыту">демо</span>` : ""}${
        own && p.hidden ? `<span class="hidden-tag">скрыт после жалоб</span>` : ""}
        <div class="muted small">${timeAgo(p.created_at)}</div></div>
      <button class="icon-btn" data-menu="${i}" aria-label="Ещё">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></button></div>
    <p class="post-text">${esc(p.text)}</p>
    <button class="post-place" data-place="${i}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
      <span class="pp"><b>${esc(title)}</b><span class="muted small">${esc(kind)}</span></span><span class="muted small">${dist}</span></button>
    <div class="post-actions">
      <button class="like ${p.liked ? "on" : ""}" data-like="${i}" aria-label="Нравится" ${own ? "disabled" : ""}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20s-7-4.4-9.2-8.6C1.3 8.4 3 5 6.4 5c2 0 3.3 1.1 4 2.2.6-1.1 2-2.2 4-2.2C17.8 5 19.6 8.4 18 11.4 16 15.6 12 20 12 20z"/></svg>
        <span>${p.likes_count}</span></button>
      <a class="btn" href="${esc(route)}" target="_blank" rel="noopener">Маршрут</a>
    </div>
  </article>`;
}

function renderFeed() {
  const box = $("#feedList");
  if (S.feedLoading && !S.feed) {
    box.innerHTML = `<div class="loading" style="margin-top:12px"><div class="skel"></div><div class="skel"></div></div>`;
  } else if (S.feedError) {
    box.innerHTML = `<div class="empty">Лента пока недоступна. ${esc(S.feedError)}</div>`;
  } else if (S.feed && !S.feed.length) {
    box.innerHTML = `<div class="empty">Здесь пока пусто. Расскажите о месте, которое любите, — станете первым.</div>`;
  } else if (S.feed) {
    box.innerHTML = `<div class="posts">${S.feed.map((p, i) => postHTML(p, i)).join("")}</div>`;
  }
  $$("[data-like]", box).forEach((b) => b.addEventListener("click", () =>
    requireAuth("Войдите, чтобы ставить лайки", () => toggleLike(+b.dataset.like))));
  $$("[data-place]", box).forEach((b) => b.addEventListener("click", () => focusPost(+b.dataset.place)));
  $$("[data-menu]", box).forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); openPostMenu(+b.dataset.menu, b); }));
  renderTopPlaces();
  drawFeed();
}

function renderTopPlaces() {
  const el = $("#topPlaces");
  const agg = new Map();
  (S.feed || []).forEach((p, i) => {
    const a = agg.get(p.place_id) || { name: p.place_name, likes: 0, posts: 0, i };
    a.likes += p.likes_count; a.posts += 1;
    agg.set(p.place_id, a);
  });
  const top = [...agg.values()].sort((a, b) => b.likes - a.likes || b.posts - a.posts).slice(0, 5);
  if (!top.length) { el.innerHTML = `<span class="muted small">Пока пусто</span>`; return; }
  el.innerHTML = `<ol class="top-list">${top.map((t) => `<li><button data-top="${t.i}"><span>${esc(splitName(t.name)[0])}</span>
    <span class="love">♥ ${t.likes}</span></button></li>`).join("")}</ol>`;
  $$("[data-top]", el).forEach((b) => b.addEventListener("click", () => focusPost(+b.dataset.top)));
}

function drawFeed() {
  if (!feedLayer) return;
  feedLayer.clearLayers();
  if (!S.feed || !S.feed.length) { feedMap.setView([S.origin.lat, S.origin.lon], 12); return; }
  const pts = [];
  S.feed.forEach((p, i) => {
    L.circleMarker([p.lat, p.lon], { radius: 8, color: "#fff", weight: 2, fillColor: "#c2253a", fillOpacity: 0.9 })
      .bindTooltip(`${splitName(p.place_name)[0]} · ♥ ${p.likes_count}`).on("click", () => focusPost(i, false)).addTo(feedLayer);
    pts.push([p.lat, p.lon]);
  });
  feedMap.fitBounds(pts, { padding: [30, 30], maxZoom: 14 });
}

function focusPost(i, fly = true) {
  const p = S.feed[i];
  $$("#feedList .post").forEach((el, j) => el.classList.toggle("hl", i === j));
  const el = $$("#feedList .post")[i];
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (fly && feedMap) feedMap.flyTo([p.lat, p.lon], 15, { duration: 0.6 });
}

async function toggleLike(i) {
  const p = S.feed[i], btn = $(`#feedList [data-like="${i}"]`);
  if (!p || !btn) return;
  const was = p.liked;
  p.liked = !was;  // сразу отражаем нажатие, потом сверяемся с сервером
  p.likes_count += was ? -1 : 1;
  btn.classList.toggle("on", p.liked);
  $("span", btn).textContent = p.likes_count;
  try {
    const r = await api(`/api/posts/${p.id}/like`, {});
    p.liked = r.liked; p.likes_count = r.likes;
  } catch (e) {
    p.liked = was; p.likes_count += was ? 1 : -1;
    toast(e.message);
  }
  btn.classList.toggle("on", p.liked);
  $("span", btn).textContent = p.likes_count;
}

function openPostMenu(i, anchor, list = S.feed, onDone = loadFeed) {
  $$(".menu").forEach((m) => m.remove());
  const p = list[i];
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML = p.mine ? `<button class="danger" data-act="delete">Удалить отзыв</button>`
    : `<button data-act="report">Пожаловаться</button>`;
  anchor.closest(".post").appendChild(menu);
  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    const act = e.target.dataset.act;
    menu.remove();
    requireAuth("Войдите, чтобы пожаловаться на отзыв", async () => {
      try {
        if (act === "delete") {
          if (!confirm("Удалить отзыв?")) return;
          await api(`/api/posts/${p.id}`, undefined, "DELETE");
          toast("Отзыв удалён");
        } else {
          await api(`/api/posts/${p.id}/report`, {});
          toast("Спасибо, посмотрим");
        }
        onDone();
      } catch (err) { toast(err.message); }
    });
  });
}

/* Окно «Поделиться местом» */
let picked = null, searchTimer;

function openComposer(place) {
  picked = place;
  $("#shareSheet").innerHTML = `
    <div class="sheet-head"><h2>Поделиться местом</h2>${closeBtn("shareClose")}</div>
    <div class="form-grid">
      <div class="field-label">Место</div><div id="placePick"></div>
      <div class="field-label">Что посоветуете</div>
      <textarea class="input" id="postText" maxlength="280" placeholder="Например: лучший вид на город в закат, приходите к семи вечера"></textarea>
      <div class="row-between"><span class="muted small">Публикуете как <b>${esc(S.session.user.name)}</b>. Без телефонов, ссылок и оскорблений — тексты проверяются автоматически.</span>
        <span class="muted small" id="counter">0/280</span></div>
      <div class="error" id="shareErr" hidden></div>
      <div style="margin-top:6px"><button class="btn primary big" id="publishBtn">Опубликовать</button></div>
    </div>`;
  renderPick();
  $("#shareBackdrop").hidden = false;
  $("#shareClose").addEventListener("click", () => ($("#shareBackdrop").hidden = true));
  $("#postText").addEventListener("input", (e) => { $("#counter").textContent = `${e.target.value.length}/280`; });
  $("#publishBtn").addEventListener("click", publish);
  (picked ? $("#postText") : $("#placeQ")).focus();
}

function renderPick() {
  const box = $("#placePick");
  if (picked) {
    const [title, descr] = splitName(picked.name);
    box.innerHTML = `<div class="picked"><div><b>${esc(title)}</b> <span class="muted small">${esc(descr || KIND[picked.category] || "")}</span></div>
      <button class="linkbtn" id="unpick">Изменить</button></div>`;
    $("#unpick").addEventListener("click", () => { picked = null; renderPick(); $("#placeQ").focus(); });
    return;
  }
  box.innerHTML = `<input class="input" id="placeQ" placeholder="Начните вводить название, например «Байтерек»" autocomplete="off">
    <div class="suggest" id="placeSuggest"></div>`;
  $("#placeQ").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(async () => {
      if (q.length < 2) { $("#placeSuggest").innerHTML = ""; return; }
      const p = new URLSearchParams({ q, lat: S.origin.lat, lon: S.origin.lon });
      let rows = [];
      try { rows = await api(`/api/places?${p}`); } catch { /* пусто */ }
      $("#placeSuggest").innerHTML = rows.length ? rows.map((r, i) => {
        const [title, descr] = splitName(r.name);
        return `<button data-pi="${i}"><span><b>${esc(title)}</b> <span class="muted small">${esc(descr || KIND[r.category] || "")}</span></span>
          <span class="muted small">${r.distance_m != null ? fmtDist(r.distance_m) : ""}</span></button>`;
      }).join("") : `<div class="muted small" style="padding:8px 10px">Ничего не нашлось в каталоге</div>`;
      $$("#placeSuggest [data-pi]").forEach((b) => b.addEventListener("click", () => {
        picked = rows[+b.dataset.pi];
        renderPick();
        $("#postText").focus();
      }));
    }, 250);
  });
}

async function publish() {
  const err = $("#shareErr"), btn = $("#publishBtn");
  const text = $("#postText").value.trim();
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  err.hidden = true;
  if (!picked) return fail("Выберите место из каталога.");
  if (text.length < 3) return fail("Напишите пару слов о месте.");
  btn.disabled = true; btn.textContent = "Проверяю и публикую…";
  try {
    await api("/api/posts", { place_id: picked.id, text });
    S.passport.posts = (S.passport.posts || 0) + 1;
    addPoints(POINTS_POST);
    const badges = newBadges();
    savePassport();
    $("#shareBackdrop").hidden = true;
    toast(badges.length ? `Опубликовано · новый значок «${badges[0][1]}»` : `Опубликовано · +${POINTS_POST}`);
    S.feedSort = "new";
    paintFeedSort();
    go("feed");
  } catch (e) {
    if (e.status === 401) { $("#shareBackdrop").hidden = true; return openAuth("login", "Сессия истекла — войдите снова"); }
    fail(e.message);
    btn.disabled = false; btn.textContent = "Опубликовать";
  }
}

let paintFeedSort = () => {};
function buildFeedSort() {
  buildSeg($("#feedSort"), FEED_SORTS, () => S.feedSort, (v) => (S.feedSort = v), loadFeed);
  paintFeedSort = () => $$("#feedSort button").forEach((b) => b.classList.toggle("on", FEED_SORTS[+b.dataset.i][0] === S.feedSort));
  $("#composerBar").addEventListener("click", () =>
    requireAuth("Войдите, чтобы делиться местами", () => openComposer(null)));
}

/* ---------- Вход и регистрация ---------- */
let authMode = "login", afterAuth = null, authReason = "";

function openAuth(mode = "login", reason = "", then = null) {
  authMode = mode; authReason = reason; afterAuth = then;
  closePops();
  renderAuth();
  $("#authBackdrop").hidden = false;
}

function renderAuth() {
  const reg = authMode === "register";
  $("#authSheet").innerHTML = `
    <div class="sheet-head"><h2>${reg ? "Регистрация" : "Вход"}</h2>${closeBtn("authClose")}</div>
    ${authReason ? `<p class="auth-reason">${esc(authReason)}</p>` : ""}
    <div class="auth-tabs"><button type="button" data-m="login" class="${reg ? "" : "on"}">Вход</button>
      <button type="button" data-m="register" class="${reg ? "on" : ""}">Регистрация</button></div>
    <form class="auth-form" id="authForm" novalidate>
      ${reg ? `<label>Имя<input class="input" name="name" maxlength="24" autocomplete="nickname" placeholder="Как подписывать вас в ленте"></label>` : ""}
      <label>Email<input class="input" name="email" type="email" autocomplete="email" placeholder="you@example.com"></label>
      <label>Пароль<span class="pw-wrap"><input class="input" name="password" type="password"
        autocomplete="${reg ? "new-password" : "current-password"}" placeholder="${reg ? "Минимум 8 символов" : ""}">
        <button type="button" id="pwToggle">Показать</button></span></label>
      <div class="error" id="authErr" hidden></div>
      <button class="btn primary big wide" type="submit" id="authSubmit">${reg ? "Создать аккаунт" : "Войти"}</button>
    </form>
    <p class="muted small" style="margin:12px 0 0">${reg
      ? "Имя будет видно в ленте. Пароль хранится в Supabase Auth только в виде хеша — мы его не видим."
      : `Нет аккаунта? <button type="button" class="linkbtn" data-m="register">Зарегистрируйтесь</button> — это минута.`}</p>`;
  $("#authClose").addEventListener("click", () => ($("#authBackdrop").hidden = true));
  $$("#authSheet [data-m]").forEach((b) => b.addEventListener("click", () => { authMode = b.dataset.m; renderAuth(); }));
  $("#pwToggle").addEventListener("click", (e) => {
    const inp = $("#authForm [name=password]");
    inp.type = inp.type === "password" ? "text" : "password";
    e.target.textContent = inp.type === "password" ? "Показать" : "Скрыть";
  });
  $("#authForm").addEventListener("submit", submitAuth);
  $("#authForm input").focus();
}

async function submitAuth(e) {
  e.preventDefault();
  const f = new FormData(e.target), err = $("#authErr"), btn = $("#authSubmit");
  const reg = authMode === "register";
  const body = { email: String(f.get("email") || "").trim(), password: String(f.get("password") || "") };
  if (reg) body.name = String(f.get("name") || "").trim();
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  err.hidden = true;
  if (reg && body.name.length < 2) return fail("Напишите имя — от 2 символов.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(body.email)) return fail("Проверьте email.");
  if (reg && body.password.length < 8) return fail("Пароль — минимум 8 символов.");
  if (!body.password) return fail("Введите пароль.");
  btn.disabled = true; btn.textContent = reg ? "Создаю аккаунт…" : "Вхожу…";
  try {
    const s = await api(`/api/auth/${authMode}`, body);
    setSession(s);
    try { await syncPassport({ mergeGuest: true }); } catch { /* паспорт подтянется позже */ }
    $("#authBackdrop").hidden = true;
    toast(reg ? `Добро пожаловать, ${s.user.name}` : `С возвращением, ${s.user.name}`);
    const then = afterAuth;
    afterAuth = null;
    if (S.isAdmin && !then) { go("admin"); return; }
    await refreshView();  // сначала свежие данные под аккаунтом, потом отложенное действие
    if (then) then();
  } catch (x) {
    fail(x.message);
    btn.disabled = false; btn.textContent = reg ? "Создать аккаунт" : "Войти";
  }
}

/* ---------- Профиль ---------- */
let profileTab = "posts";

async function renderProfile() {
  const root = $("#profileRoot");
  if (!S.session) {
    root.innerHTML = `<div class="guest-hero"><h1>Ваш профиль в Seruen</h1>
        <p>Войдите, чтобы делиться местами в ленте, ставить лайки и не потерять паспорт: очки, штампы и значки будут
          сохраняться в аккаунте и на любом устройстве.</p>
        <div class="actions" style="margin:0"><button class="btn primary big" data-auth="register">Создать аккаунт</button>
          <button class="btn big" data-auth="login">Войти</button></div></div>
      <div class="profile-card" style="margin-top:16px">${passportHTML(S.passport)}
        <div class="note">Сейчас паспорт хранится только в этом браузере. После входа набранные очки перейдут в аккаунт.</div></div>`;
    $$("[data-auth]", root).forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
    return;
  }
  if (!S.me) root.innerHTML = `<div class="loading"><div class="skel"></div><div class="skel"></div></div>`;
  let me;
  try {
    me = await loadMe();
  } catch (e) {
    if (e.status === 401) { logoutLocal(); return renderProfile(); }
    root.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    return;
  }
  const { lvl } = levelOf(S.passport.points);
  const d = me.created_at ? new Date(me.created_at) : null;
  const since = d ? `${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}` : "";
  root.innerHTML = `
    <div class="profile-card">
      <div class="profile-head">${avatar(me.name, "lg")}
        <div class="who"><h1 id="pName">${esc(me.name)}</h1><div class="muted">${esc(me.email)}${since ? ` · в Seruen с ${esc(since)}` : ""}</div></div>
        <div class="actions"><button class="btn" id="renameBtn">Изменить имя</button><button class="btn" id="logoutBtn2">Выйти</button></div>
      </div>
      <div class="stats">
        <div class="stat"><div class="v">${me.stats.posts}</div><div class="l">${plural(me.stats.posts, "отзыв", "отзыва", "отзывов")}</div></div>
        <div class="stat"><div class="v">${me.stats.likes}</div><div class="l">лайков получено</div></div>
        <div class="stat"><div class="v">${fmtInt(S.passport.points)}</div><div class="l">очков</div></div>
        <div class="stat"><div class="v" style="font-size:16px;padding-top:5px">${lvl[1]}</div><div class="l">уровень</div></div>
      </div>
    </div>
    <div class="ptabs"><button data-pt="posts">Мои отзывы</button><button data-pt="passport">Паспорт</button></div>
    <div id="ptab"></div>`;
  $("#logoutBtn2").addEventListener("click", logout);
  $("#renameBtn").addEventListener("click", startRename);
  $$("[data-pt]").forEach((b) => b.addEventListener("click", () => { profileTab = b.dataset.pt; renderProfileTab(me); }));
  renderProfileTab(me);
}

function renderProfileTab(me) {
  $$("[data-pt]").forEach((b) => b.classList.toggle("active", b.dataset.pt === profileTab));
  const box = $("#ptab");
  if (profileTab === "passport") {
    box.innerHTML = `<div class="profile-card">${passportHTML(S.passport)}${me.passport_sync ? ""
      : `<div class="note">Паспорт пока хранится только в этом браузере: в базе не применена миграция db/002_auth.sql.</div>`}</div>`;
    return;
  }
  const posts = me.posts.map((p) => ({ ...p, mine: true }));
  box.innerHTML = posts.length ? `<div class="posts">${posts.map((p, i) => postHTML(p, i, { own: true })).join("")}</div>`
    : `<div class="empty">Вы ещё ничем не поделились. <button class="linkbtn" id="firstPost">Расскажите о месте</button></div>`;
  if ($("#firstPost")) $("#firstPost").addEventListener("click", () => openComposer(null));
  $$("[data-menu]", box).forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    openPostMenu(+b.dataset.menu, b, posts, renderProfile);
  }));
  $$("[data-place]", box).forEach((b) => b.addEventListener("click", () => {
    const p = posts[+b.dataset.place];
    window.open(dirUrl([{ ...S.origin, id: null }, { lat: p.lat, lon: p.lon, id: p.place_id }], "walk"), "_blank", "noopener");
  }));
}

function startRename() {
  const h = $("#pName");
  const old = S.me.name;
  h.outerHTML = `<form id="renameForm" class="row-between" style="gap:8px;align-items:center">
    <input class="input" id="renameInput" maxlength="24" value="${esc(old)}" style="max-width:260px">
    <button class="btn primary" type="submit">Сохранить</button></form>`;
  $("#renameInput").focus();
  $("#renameForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#renameInput").value.trim();
    try {
      await api("/api/me", { name }, "PATCH");
      S.session.user.name = name;
      setSession(S.session);
      toast("Имя обновлено");
    } catch (x) { toast(x.message); }
    renderProfile();
  });
}

/* ---------- «Что это за место?» по фото ---------- */
function shrinkImage(file, max = 1024) {
  // Уменьшаем фото в браузере: быстрее отправка и меньше токенов у модели.
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      c.toBlob((b) => (b ? resolve({ blob: b, url: c.toDataURL("image/jpeg", 0.7) }) : reject(new Error())), "image/jpeg", 0.85);
    };
    img.onerror = () => reject(new Error("Не получилось открыть фото"));
    img.src = URL.createObjectURL(file);
  });
}

async function identifyPhoto(file) {
  const box = $("#results");
  $("#mapHint").hidden = true;
  let shot;
  try { shot = await shrinkImage(file, 768); } catch (e) { return toast(e.message || "Не получилось открыть фото"); }
  box.innerHTML = `<div class="photo-card"><img src="${shot.url}" alt=""><div><div class="muted small">Смотрю на фото…</div>
    <div class="skel" style="height:60px;margin-top:8px"></div></div></div>`;
  const fd = new FormData();
  fd.append("image", shot.blob, "photo.jpg");
  fd.append("lat", S.origin.lat); fd.append("lon", S.origin.lon);
  if (S.when) fd.append("when", S.when);
  try {
    const r = await fetch("/api/identify", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || "Не получилось распознать фото");
    renderIdentified(j, shot.url);
  } catch (e) {
    box.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

function renderIdentified(res, img) {
  const box = $("#results"), p = res.place;
  if (!p) {
    box.innerHTML = `<div class="photo-card"><img src="${img}" alt=""><div><h3>Не узнал это место</h3>
      ${res.seen ? `<div class="muted small">На фото: ${esc(res.seen)}</div>` : ""}
      <p>Я узнаю заметные здания и памятники рядом с точкой «${esc(S.origin.name)}». Снимите здание целиком
        или выберите на карте точку ближе к нему.</p>
      ${(res.alternatives || []).length ? `<div class="muted small">Может быть:
        ${res.alternatives.map((a, i) => `<button class="linkbtn" data-alt="${i}">${esc(splitName(a.name)[0])}</button>`).join(" · ")}</div>` : ""}
      </div></div>`;
    $$("[data-alt]", box).forEach((b) => b.addEventListener("click", () => {
      const alt = res.alternatives[+b.dataset.alt];
      renderIdentified({ ...res, place: alt, picked: true, alternatives: res.alternatives.filter((x) => x !== alt) }, img);
    }));
    return;
  }
  const [title, descr] = splitName(p.name);
  const kind = descr || KIND[p.category] || "";
  const sure = res.confidence >= 0.9 && !res.picked;
  const fact = (p.description || "").split(/(?<=[.!?])\s/).slice(0, 2).join(" ");
  const route = dirUrl([{ ...S.origin, id: null }, p], "walk");
  box.innerHTML = `<div class="photo-card"><img src="${img}" alt="">
    <div><div class="muted small">На фото: ${esc(res.seen || "")}</div>
      <h3>${sure || res.picked ? "" : "Похоже, это "}${esc(title)}${res.picked ? ""
        : `<span class="conf ${sure ? "" : "mid"}">${sure ? "узнал уверенно" : "скорее всего"}</span>`}</h3>
      <div class="kind">${esc(kind)}${p.rating ? ` · <span class="star">★</span> ${String(p.rating).replace(".", ",")}` : ""} · ${fmtDist(p.distance_m)} от точки</div>
      ${fact ? `<p>${esc(fact)}</p>` : ""}
      <div class="actions">
        <button class="btn primary" id="phNear">Что рядом</button>
        <button class="btn" id="phQuest">Квест отсюда</button>
        <a class="btn" href="${esc(route)}" target="_blank" rel="noopener">Маршрут в 2ГИС</a>
        <a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">О месте</a>
      </div>
      ${(res.alternatives || []).length ? `<div class="muted small" style="margin-top:10px">Не то? Может быть:
        ${res.alternatives.map((a, i) => `<button class="linkbtn" data-alt="${i}">${esc(splitName(a.name)[0])}</button>`).join(" · ")}</div>` : ""}
      <div class="muted small" style="margin-top:8px">Фото не сохраняется: его видит только модель распознавания.</div></div></div>`;
  $$("[data-alt]", box).forEach((b) => b.addEventListener("click", () => {
    const alt = res.alternatives[+b.dataset.alt];
    // Человек поправил модель: показываем выбранное место, а прежний ответ уходит в альтернативы.
    renderIdentified({ ...res, place: alt, picked: true,
      alternatives: [p, ...res.alternatives.filter((x) => x !== alt)] }, img);
  }));
  drawPlaces(S.origin, [{ ...p, leg: null }], null);
  const here = () => setOrigin({ name: title, lat: p.lat, lon: p.lon });
  $("#phNear").addEventListener("click", () => {
    here();
    const q = "Что интересного рядом, есть около часа?";
    $("#query").value = q; autosize(); ask(q);
  });
  $("#phQuest").addEventListener("click", () => {
    here();
    S.quest = null; saveQuest();
    go("quest");
    startQuest();
  });
}

let photoMode = "identify";
$$("#photoPop [data-photo]").forEach((b) => b.addEventListener("click", () => {
  photoMode = b.dataset.photo;
  const input = $("#photoInput");
  // Узнать место — сразу камера; найти похожее — галерея (картинка из интернета).
  if (photoMode === "identify") input.setAttribute("capture", "environment"); else input.removeAttribute("capture");
  closePops();
  input.click();
}));
$("#photoInput").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (photoMode === "vibe") vibeSearch(f); else identifyPhoto(f);
});

/* ---------- Пульс города (three.js, грузится при первом открытии) ---------- */
const P = { mod: null, scene: null, data: null, day: 0, minute: 720, groups: null, timer: null, loading: null,
            hourly: [], offers: [], feed: [] };

function astanaNow() {
  // Время Астаны (UTC+5) независимо от часового пояса компьютера.
  const d = new Date(Date.now() + (5 * 60 + new Date().getTimezoneOffset()) * 60000);
  return { day: (d.getDay() + 6) % 7, minute: d.getHours() * 60 + Math.floor(d.getMinutes() / 15) * 15 };
}

/** Прогноз на выбранный в «Пульсе» день недели и час: ближайший такой день, начиная с сегодня. */
function pulseWeather() {
  if (S.weatherPreset && S.weather) return S.weather;  // демо-пресет погоды действует на все часы
  if (!P.hourly.length) return null;
  const now = astanaNow();
  const shift = (P.day - now.day + 7) % 7;
  const astana = new Date(Date.now() + (5 * 60 + new Date().getTimezoneOffset()) * 60000);
  astana.setDate(astana.getDate() + shift);
  astana.setHours(Math.floor(P.minute / 60), 0, 0, 0);
  const utc = new Date(astana.getTime() - 5 * 3600000);
  const key = `${utc.getFullYear()}-${String(utc.getMonth() + 1).padStart(2, "0")}-${String(utc.getDate()).padStart(2, "0")}T${String(utc.getHours()).padStart(2, "0")}:00`;
  return P.hourly.find((h) => h.t === key) || null;
}

function openPulse() {
  if (P.scene) { P.scene.resume(); applyPulse(); return Promise.resolve(); }
  if (P.loading) return P.loading;
  P.loading = (async () => {
    try {
      const [mod, data] = await Promise.all([import("/static/pulse3d.js"), api("/api/pulse")]);
      P.mod = mod; P.data = data;
      P.groups = new Set(Object.keys(mod.GROUPS));
      if (S.when) {
        const d = new Date(S.when);
        P.day = (d.getDay() + 6) % 7; P.minute = d.getHours() * 60 + Math.floor(d.getMinutes() / 15) * 15;
      } else Object.assign(P, astanaNow());
      $("#pulseTotal").textContent = fmtInt(data.total);
      buildPulseControls();
      P.scene = await mod.mountPulse($("#pulseCanvas"), data.pois, { onHover: pulseHover, onPick: pulsePick });
      P.scene.setOrigin(S.origin.lat, S.origin.lon);
      // Слои и прогноз — не критичны: если не загрузились, «Пульс» работает без них.
      const [hourlyW, offers, feed] = await Promise.all([
        api(`/api/weather/hourly`).catch(() => []),
        api("/api/offers/active").catch(() => []),
        api("/api/feed?sort=top").catch(() => []),
      ]);
      P.hourly = hourlyW; P.offers = offers;
      const byPlace = new Map();
      feed.forEach((f) => {
        const a = byPlace.get(f.place_id) || { lat: f.lat, lon: f.lon, name: f.place_name, posts: 0, likes: 0 };
        a.posts += 1; a.likes += f.likes_count;
        byPlace.set(f.place_id, a);
      });
      P.feed = [...byPlace.values()];
      P.scene.setMarkers("feed", P.feed.map((f) => ({ ...f, height: 700 })));
      applyPulse();
      $("#pulseLoading").hidden = true;
      if (S.view !== "pulse") P.scene.pause();
    } catch (e) {
      console.error(e);
      $("#pulseLoading").textContent = "Не удалось загрузить 3D-сцену. Проверьте интернет и обновите страницу.";
    } finally {
      P.loading = null;
    }
  })();
  return P.loading;
}

function pausePulse() {
  stopPulsePlay();
  if (P.scene) P.scene.pause();
}

function buildPulseControls() {
  $("#pulseDays").innerHTML = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d, i) => `<button type="button" data-d="${i}">${d}</button>`).join("");
  $$("#pulseDays button").forEach((b) => b.addEventListener("click", () => { P.day = +b.dataset.d; applyPulse(); }));
  $("#pulseRange").addEventListener("input", (e) => { stopPulsePlay(); P.minute = +e.target.value; applyPulse(); });
  $("#pulsePlay").addEventListener("click", () => (P.timer ? stopPulsePlay() : startPulsePlay()));
  $("#pulseNow").addEventListener("click", () => { stopPulsePlay(); Object.assign(P, astanaNow()); applyPulse(); });
  $("#pulseLegend").innerHTML = Object.entries(P.mod.GROUPS).map(([k, g]) =>
    `<button type="button" data-g="${k}" style="--c:#${g.color.toString(16).padStart(6, "0")}"><i></i>${g.label} <span></span></button>`).join("");
  $$("#pulseLegend button").forEach((b) => b.addEventListener("click", () => {
    const g = b.dataset.g;
    P.groups.has(g) ? P.groups.delete(g) : P.groups.add(g);
    b.classList.toggle("off", !P.groups.has(g));
    showPulseCounts(P.scene.setGroups(P.groups));
  }));
  $("#layerFeed").addEventListener("change", (e) => P.scene && P.scene.showLayer("feed", e.target.checked));
  $("#layerOffers").addEventListener("change", (e) => P.scene && P.scene.showLayer("offers", e.target.checked));
}

function applyPulse() {
  $("#pulseClock").textContent = hhmm(P.minute);
  $("#pulseRange").value = P.minute;
  $$("#pulseDays button").forEach((b) => b.classList.toggle("on", +b.dataset.d === P.day));
  const w = pulseWeather();
  $("#pulseWeather").textContent = w ? `${w.emoji || ""} ${fmtTemp(w.temp)}${w.harsh ? " · непогода" : ""}` : "";
  if (!P.scene) return;
  showPulseCounts(P.scene.setTime(P.day, P.minute, w));
  // Предложения показываем только те, что действуют в выбранный день и час.
  const now = P.offers.filter((o) => offerRunsAt(o, P.day, P.minute));
  P.scene.setMarkers("offers", now.map((o) => ({ ...o, height: 600 })));
  P.scene.showLayer("offers", $("#layerOffers").checked);
  P.scene.showLayer("feed", $("#layerFeed").checked);
  $("#offersNow").textContent = now.length ? `· ${now.length}` : "";
}

function showPulseCounts(c) {
  $("#pulseOpen").textContent = fmtInt(c.open);
  $("#pulseIndex").textContent = `${c.pulse}%`;
  $("#pulseMeter").style.width = `${c.pulse}%`;
  $$("#pulseLegend button").forEach((b) => ($("span", b).textContent = c.byGroup[b.dataset.g]));
  $("#pulseHot").innerHTML = c.hotspots.map((h, i) => `<li><button data-hot="${i}">рядом с ${esc(splitName(h.name)[0])}
    <span>${h.open} ${plural(h.open, "место", "места", "мест")}</span></button></li>`).join("");
  $$("#pulseHot [data-hot]").forEach((b) => b.addEventListener("click", () => {
    const h = c.hotspots[+b.dataset.hot];
    stopPulsePlay();
    P.scene.flyTo(h.lat, h.lon);
  }));
}

function startPulsePlay() {
  $("#pulsePlay").textContent = "⏸ Пауза";
  P.timer = setInterval(() => {
    P.minute += 15;
    if (P.minute >= 1440) { P.minute = 0; P.day = (P.day + 1) % 7; }
    applyPulse();
  }, 90);
}
function stopPulsePlay() {
  clearInterval(P.timer);
  P.timer = null;
  const b = $("#pulsePlay");
  if (b) b.textContent = "▶ Прожить день";
}

function pulseStatus(open, row) {
  if (row[7] === "out") return "под открытым небом";
  if (open === null) return "часы работы неизвестны";
  if (row[7] === "24") return "круглосуточно";
  return open ? "открыто" : "закрыто";
}
function busyLabel(a) { return a >= 0.75 ? "оживлённо" : a >= 0.4 ? "умеренно" : "спокойно"; }

function pulseHover(info, x, y) {
  const tip = $("#pulseTip");
  if (!info) { tip.hidden = true; return; }
  if (info.marker) {
    const m = info.marker;
    tip.innerHTML = m.kind === "offers"
      ? `<b>% ${esc(m.title)}</b>${esc(splitName(m.place_name)[0])} · реклама`
      : `<b>♥ ${m.likes} · ${esc(splitName(m.name)[0])}</b>советуют в ленте: ${m.posts}`;
  } else {
    const [title, descr] = splitName(info.row[1]);
    const st = pulseStatus(info.open, info.row);
    tip.innerHTML = `<b>${esc(title)}</b>${esc(descr || KIND[info.row[4]] || "")} · ${st}${info.open ? ` · ${busyLabel(info.activity)}` : ""}`;
  }
  tip.style.left = `${x + 14}px`; tip.style.top = `${y + 14}px`;
  tip.hidden = false;
}

function pulsePick(info) {
  const card = $("#pulseCard");
  let html, place;
  if (info.marker && info.marker.kind === "offers") {
    const o = info.marker;
    place = { name: splitName(o.place_name)[0], lat: o.lat, lon: o.lon };
    html = `<h3>${esc(place.name)}</h3>${offerHTML(o)}`;
    offerClick(o.id);
  } else if (info.marker) {
    const f = info.marker;
    place = { name: splitName(f.name)[0], lat: f.lat, lon: f.lon };
    html = `<h3>${esc(place.name)}</h3><div class="kind">Советуют в ленте: ${f.posts} · ♥ ${f.likes}</div>`;
  } else {
    const [id, name, lat, lon, cat, , , , kind] = info.row;
    const [title, descr] = splitName(name);
    place = { name: title, lat, lon };
    html = `<h3>${esc(title)}</h3>
      <div class="kind">${esc(descr || KIND[cat] || "")} · ${pulseStatus(info.open, info.row)} в ${hhmm(P.minute)}${
        info.open ? ` · ${busyLabel(info.activity)}` : ""}</div>
      <div class="actions" style="margin-top:8px"><a class="btn" href="https://2gis.kz/astana/${kind}/${id}" target="_blank" rel="noopener">О месте</a></div>`;
  }
  card.innerHTML = `<button class="x" aria-label="Закрыть">✕</button>${html}
    <div class="actions"><button class="btn primary" id="pcNear">Подобрать рядом</button>${
      info.marker && info.marker.kind === "feed" ? `<button class="btn" id="pcFeed">Открыть ленту</button>` : ""}</div>`;
  card.hidden = false;
  $(".x", card).addEventListener("click", () => (card.hidden = true));
  $("#pcNear").addEventListener("click", () => {
    card.hidden = true;
    setOrigin({ name: place.name, lat: place.lat, lon: place.lon });
    go("ask");
    $("#query").focus();
  });
  if ($("#pcFeed")) $("#pcFeed").addEventListener("click", () => { card.hidden = true; go("feed"); });
}

/* ---------- Seruen для бизнеса ---------- */
const KIND_LABEL = { discount: "Скидка", event: "Событие", news: "Новинка" };
let bizPick = null, bizNewKey = null;

const bizHero = () => `<div class="biz-hero"><h1>Seruen для бизнеса</h1>
    <p>Расскажите о скидке, событии или новинке тем, кто рядом и ищет такое место прямо сейчас. Предложение появится
      в карточке вашего заведения, когда Seruen его порекомендует, и в слое «Предложения» в «Пульсе города».</p>
    ${S.session ? "" : `<button class="btn primary big" data-auth="register">Подключить заведение</button>`}</div>
  <div class="biz-steps">
    <div><b>1. Заявка</b>Найдите своё заведение в каталоге и оставьте контакт для проверки.</div>
    <div><b>2. Проверка</b>Команда Seruen подтверждает, что вы представляете заведение.</div>
    <div><b>3. Предложения</b>Скидки, события и новинки с днями и часами — вручную или через API из кассы.</div>
  </div>
  <div class="ethic"><b>Честные правила.</b> Предложения не влияют на подбор и порядок мест: Seruen показывает их
    только в карточке заведения, которое и так подошло человеку, и помечает «Реклама».</div>`;

async function renderBusiness() {
  const root = $("#bizRoot");
  if (!S.session) {
    root.innerHTML = bizHero();
    $$("[data-auth]", root).forEach((b) => b.addEventListener("click", () =>
      openAuth("register", "Создайте аккаунт владельца заведения", () => go("business"))));
    return;
  }
  root.innerHTML = bizHero() + `<div class="biz-card"><div class="skel"></div></div>`;
  let me;
  try { me = await api("/api/business/me"); } catch (e) {
    root.innerHTML = bizHero() + `<div class="biz-card"><div class="error">${esc(e.message)}</div></div>`;
    return;
  }
  const b = me.business;
  let html = bizHero();
  if (!b) {
    html += `<div class="biz-card"><h2>Подключить заведение</h2>
      <p class="muted">Найдите заведение в каталоге 2ГИС — мы уже знаем его адрес, часы работы и рейтинг.</p>
      <div class="form-grid"><div class="field-label">Заведение</div><div id="bizPlace"></div>
        <div class="field-label">Как с вами связаться для проверки</div>
        <input class="input" id="bizContact" maxlength="120" placeholder="Телефон администратора или email заведения">
        <div class="error" id="bizErr" hidden></div>
        <div><button class="btn primary big" id="bizApply">Отправить заявку</button></div></div>
      <div class="note">Заявку проверяет администратор Seruen — обычно в течение дня.</div></div>`;
  } else if (b.status !== "approved") {
    const rejected = b.status === "rejected";
    html += `<div class="biz-card"><h2>${esc(splitName(b.place_name)[0])}</h2>
      <span class="status-tag ${rejected ? "bad" : ""}">${rejected ? "Заявка отклонена" : "Заявка на проверке"}</span>
      <p class="muted" style="margin-top:10px">${rejected ? "Напишите нам, если это ошибка." :
        `Мы свяжемся с вами по контакту «${esc(b.contact)}» и подтвердим, что вы представляете заведение.`}</p></div>`;
  } else {
    html += bizDashboard(b, me.offers || [], me.stats || { views: 0, clicks: 0, by_offer: {} });
  }
  root.innerHTML = html;
  if (!b) bindBizApply();
  if (b && b.status === "approved") bindBizDashboard(b);
}

function bindBizApply() {
  const box = $("#bizPlace");
  const paint = () => {
    if (bizPick) {
      box.innerHTML = `<div class="picked"><div><b>${esc(splitName(bizPick.name)[0])}</b>
        <span class="muted small">${esc(bizPick.address || "")}</span></div><button class="linkbtn" id="bizUnpick">Изменить</button></div>`;
      $("#bizUnpick").addEventListener("click", () => { bizPick = null; paint(); });
      return;
    }
    box.innerHTML = `<input class="input" id="bizQ" placeholder="Название, например «Black Duck»" autocomplete="off"><div class="suggest" id="bizSug"></div>`;
    let t;
    $("#bizQ").addEventListener("input", (e) => {
      clearTimeout(t);
      const q = e.target.value.trim();
      t = setTimeout(async () => {
        if (q.length < 2) { $("#bizSug").innerHTML = ""; return; }
        let rows = [];
        try { rows = await api(`/api/places?${new URLSearchParams({ q })}`); } catch { /* пусто */ }
        $("#bizSug").innerHTML = rows.map((r, i) => `<button data-bp="${i}"><span><b>${esc(splitName(r.name)[0])}</b>
          <span class="muted small">${esc(splitName(r.name)[1] || KIND[r.category] || "")}</span></span>
          <span class="muted small">${esc(r.address || "")}</span></button>`).join("") || `<div class="muted small" style="padding:8px">Ничего не нашлось</div>`;
        $$("#bizSug [data-bp]").forEach((x) => x.addEventListener("click", () => { bizPick = rows[+x.dataset.bp]; paint(); }));
      }, 250);
    });
  };
  paint();
  $("#bizApply").addEventListener("click", async () => {
    const err = $("#bizErr");
    err.hidden = true;
    if (!bizPick) { err.textContent = "Выберите заведение из каталога."; err.hidden = false; return; }
    try {
      await api("/api/business/apply", { place_id: bizPick.id, contact: $("#bizContact").value.trim() });
      bizPick = null;
      toast("Заявка отправлена");
      renderBusiness();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
}

function bizDashboard(b, offers, st) {
  const ctr = st.views ? Math.round((st.clicks / st.views) * 100) : 0;
  const rows = offers.map((o) => {
    const n = st.by_offer[o.id] || { views: 0, clicks: 0 };
    return `<div class="offer-row"><div><b>${esc(KIND_LABEL[o.kind])}: ${esc(o.title)}</b>
        <div class="meta">${esc(offerWhen(o))}${o.active ? "" : " · выключено"}</div></div>
      <div class="nums">${n.views} ${plural(n.views, "показ", "показа", "показов")} · ${n.clicks} ${plural(n.clicks, "переход", "перехода", "переходов")}<div class="actions" style="margin:6px 0 0;justify-content:flex-end">
        <button class="btn" data-toggle="${o.id}" data-on="${o.active ? 1 : 0}">${o.active ? "Выключить" : "Включить"}</button>
        <button class="btn" data-del="${o.id}">Удалить</button></div></div></div>`;
  }).join("");
  const base = location.origin;
  return `<div class="biz-card"><div class="row-between"><div><h2>${esc(splitName(b.place_name)[0])}</h2>
      <span class="status-tag ok">Подключено</span></div></div>
    <div class="stats" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat"><div class="v">${st.views}</div><div class="l">${plural(st.views, "показ", "показа", "показов")} в карточках</div></div>
      <div class="stat"><div class="v">${st.clicks}</div><div class="l">${plural(st.clicks, "переход", "перехода", "переходов")}</div></div>
      <div class="stat"><div class="v">${ctr}%</div><div class="l">конверсия</div></div></div></div>
  <div class="biz-card"><h3>Предложения</h3>${rows || `<p class="muted">Пока нет предложений.</p>`}</div>
  <div class="biz-card"><h3>Новое предложение</h3>
    <div class="offer-form">
      <div class="seg" id="ofKind"><button type="button" data-k="discount" class="on">Скидка</button>
        <button type="button" data-k="event">Событие</button><button type="button" data-k="news">Новинка</button></div>
      <label>Заголовок<input class="input" id="ofTitle" maxlength="80" placeholder="Например: −20% на кофе до полудня"></label>
      <label>Подробности<textarea class="input" id="ofDetails" maxlength="300" placeholder="Что именно, условия"></textarea></label>
      <label>Дни<div class="daypick" id="ofDays">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d, i) =>
        `<button type="button" data-d="${i}" class="on">${d}</button>`).join("")}</div></label>
      <div class="row2"><label>С<input class="input" id="ofFrom" type="time" value="00:00"></label>
        <label>До<input class="input" id="ofTo" type="time" value="23:59"></label></div>
      <label>Действует до (необязательно)<input class="input" id="ofUntil" type="date"></label>
      <div class="error" id="ofErr" hidden></div>
      <div><button class="btn primary big" id="ofSave">Опубликовать</button></div>
      <div class="muted small">Тексты проверяются автоматически, как и отзывы в ленте.</div>
    </div></div>
  <div class="biz-card"><h3>Интеграция с кассой, CRM или сайтом</h3>
    <p class="muted">Публикуйте и выключайте предложения автоматически — например, «счастливые часы», когда зал пустой.</p>
    ${bizNewKey ? `<div class="keybox"><span>${esc(bizNewKey)}</span></div>
      <div class="muted small" style="margin-top:6px">Сохраните ключ — больше мы его не покажем: в базе хранится только хеш.</div>` : ""}
    <div class="actions" style="margin:10px 0 12px"><button class="btn" id="bizKey">${b.has_api_key ? "Выпустить новый ключ (старый перестанет работать)" : "Выпустить ключ API"}</button></div>
    <div class="codebox">curl -X POST ${base}/api/v1/offers \\
  -H "X-Api-Key: srn_ваш_ключ" -H "Content-Type: application/json" \\
  -d '{"kind": "discount", "title": "−20% на кофе до 12:00",
       "days": [0,1,2,3,4], "start_min": 480, "end_min": 720}'

GET    ${base}/api/v1/offers          — ваши предложения
PATCH  ${base}/api/v1/offers/{id}     — {"active": false} выключить
DELETE ${base}/api/v1/offers/{id}     — удалить
GET    ${base}/api/v1/stats           — показы и переходы</div></div>`;
}

function bindBizDashboard() {
  let kind = "discount";
  $$("#ofKind button").forEach((x) => x.addEventListener("click", () => {
    kind = x.dataset.k;
    $$("#ofKind button").forEach((y) => y.classList.toggle("on", y === x));
  }));
  $$("#ofDays button").forEach((x) => x.addEventListener("click", () => x.classList.toggle("on")));
  const toMin = (v, end) => {
    const [h, m] = (v || "00:00").split(":").map(Number);
    const t = h * 60 + m;
    return end && t === 23 * 60 + 59 ? 1440 : t;
  };
  $("#ofSave").addEventListener("click", async () => {
    const err = $("#ofErr");
    err.hidden = true;
    const body = { kind, title: $("#ofTitle").value.trim(), details: $("#ofDetails").value.trim() || null,
      days: $$("#ofDays button.on").map((x) => +x.dataset.d), start_min: toMin($("#ofFrom").value),
      end_min: toMin($("#ofTo").value, true), valid_until: $("#ofUntil").value || null };
    const btn = $("#ofSave");
    btn.disabled = true; btn.textContent = "Проверяю и публикую…";
    try {
      await api("/api/business/offers", body);
      toast("Предложение опубликовано");
      P.offers = await api("/api/offers/active").catch(() => P.offers);
      renderBusiness();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      btn.disabled = false; btn.textContent = "Опубликовать";
    }
  });
  $$("[data-toggle]").forEach((x) => x.addEventListener("click", async () => {
    try { await api(`/api/business/offers/${x.dataset.toggle}`, { active: x.dataset.on !== "1" }, "PATCH"); renderBusiness(); }
    catch (e) { toast(e.message); }
  }));
  $$("[data-del]").forEach((x) => x.addEventListener("click", async () => {
    if (!confirm("Удалить предложение?")) return;
    try { await api(`/api/business/offers/${x.dataset.del}`, undefined, "DELETE"); renderBusiness(); }
    catch (e) { toast(e.message); }
  }));
  $("#bizKey").addEventListener("click", async () => {
    try { bizNewKey = (await api("/api/business/key", {})).api_key; renderBusiness(); }
    catch (e) { toast(e.message); }
  });
}

/* ---------- Панель администратора ---------- */
const ADMIN_TABS = [["apps", "Заявки заведений"], ["moder", "Модерация ленты"], ["offers", "Предложения"],
  ["users", "Пользователи"], ["system", "Система"]];
let adminTab = "apps", moderKind = "reported";

async function renderAdmin() {
  const root = $("#adminRoot");
  if (!S.session) {
    root.innerHTML = `<div class="guest-hero"><h1>Панель администратора</h1><p>Войдите под аккаунтом администратора.</p>
      <button class="btn primary big" id="admLogin">Войти</button></div>`;
    $("#admLogin").addEventListener("click", () => openAuth("login", "Вход для администратора"));
    return;
  }
  if (!S.me) { try { await loadMe(); } catch { /* ниже покажем отказ */ } }
  if (!S.isAdmin) {
    root.innerHTML = `<div class="empty">Эта страница только для администратора Seruen.</div>`;
    return;
  }
  root.innerHTML = `<div class="admin-head"><div><div class="muted small">Seruen · администратор</div>
      <h1>Панель администратора</h1><div class="muted">${esc(S.session.user.email || "")}</div></div>
      <button class="btn" id="admRefresh">Обновить</button></div>
    <div class="stats admin-stats" id="admStats">${'<div class="stat"><div class="skel" style="height:44px"></div></div>'.repeat(5)}</div>
    <div class="ptabs">${ADMIN_TABS.map(([k, l]) => `<button data-at="${k}">${l}<span class="tab-count" id="tc-${k}"></span></button>`).join("")}</div>
    <div id="admBody"></div>`;
  $("#admRefresh").addEventListener("click", renderAdmin);
  $$("[data-at]").forEach((b) => b.addEventListener("click", () => { adminTab = b.dataset.at; renderAdminTab(); }));
  renderAdminTab();
  try {
    const o = await api("/api/admin/overview");
    const stat = (v, l, warn) => `<div class="stat${warn ? " warn" : ""}"><div class="v">${fmtInt(v)}</div><div class="l">${l}</div></div>`;
    $("#admStats").innerHTML = stat(o.users, plural(o.users, "пользователь", "пользователя", "пользователей"))
      + stat(o.posts, `${plural(o.posts, "отзыв", "отзыва", "отзывов")} · скрыто ${o.hidden}`)
      + stat(o.reported, `${plural(o.reported, "отзыв", "отзыва", "отзывов")} с жалобами`, o.reported > 0)
      + stat(o.pending, `${plural(o.pending, "заявка ждёт", "заявки ждут", "заявок ждут")} · всего ${o.businesses}`, o.pending > 0)
      + stat(o.offers_active, plural(o.offers_active, "активное предложение", "активных предложения", "активных предложений"));
    $("#tc-apps").textContent = o.pending ? ` ${o.pending}` : "";
    $("#tc-moder").textContent = o.reported ? ` ${o.reported}` : "";
  } catch (e) {
    $("#admStats").innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

async function renderAdminTab() {
  $$("[data-at]").forEach((b) => b.classList.toggle("active", b.dataset.at === adminTab));
  const box = $("#admBody");
  box.innerHTML = `<div class="biz-card"><div class="skel"></div></div>`;
  try {
    if (adminTab === "apps") await adminApps(box);
    else if (adminTab === "moder") await adminModer(box);
    else if (adminTab === "offers") await adminOffers(box);
    else if (adminTab === "users") await adminUsers(box);
    else await adminSystem(box);
  } catch (e) {
    box.innerHTML = `<div class="biz-card"><div class="error">${esc(e.message)}</div></div>`;
  }
}

const dateRu = (iso) => (iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "—");

async function adminApps(box) {
  const rows = await api("/api/admin/businesses");
  const label = { pending: ["на проверке", ""], approved: ["одобрено", "ok"], rejected: ["отклонено", "bad"] };
  box.innerHTML = `<div class="biz-card"><h3>Заявки заведений</h3>${rows.length ? rows.map((r) => `<div class="offer-row"><div>
      <b>${esc(splitName(r.place_name)[0])}</b> <span class="status-tag ${label[r.status][1]}">${label[r.status][0]}</span>
      <div class="meta">Владелец: ${esc((r.owner && r.owner.name) || "—")} · контакт: ${esc(r.contact)} · ${dateRu(r.created_at)}</div></div>
      <div class="actions" style="margin:0">${r.status !== "approved" ? `<button class="btn primary" data-st="approved" data-id="${r.id}">Одобрить</button>` : ""}
        ${r.status !== "rejected" ? `<button class="btn" data-st="rejected" data-id="${r.id}">Отклонить</button>` : ""}</div></div>`).join("")
    : `<p class="muted">Заявок пока нет.</p>`}
    <div class="note">Прежде чем одобрить, свяжитесь с заведением по указанному контакту и убедитесь, что заявку подал его представитель.</div></div>`;
  $$("[data-st]", box).forEach((x) => x.addEventListener("click", async () => {
    try { await api(`/api/admin/businesses/${x.dataset.id}`, { status: x.dataset.st }); toast("Готово"); renderAdmin(); }
    catch (e) { toast(e.message); }
  }));
}

async function adminModer(box) {
  const rows = await api(`/api/admin/posts?kind=${moderKind}`);
  const kinds = [["reported", "С жалобами"], ["hidden", "Скрытые"], ["all", "Все отзывы"]];
  box.innerHTML = `<div class="biz-card"><div class="row-between" style="align-items:center;margin-bottom:6px"><h3 style="margin:0">Модерация ленты</h3>
      <div class="seg" id="mkSeg">${kinds.map(([k, l]) => `<button type="button" data-mk="${k}" class="${moderKind === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    ${rows.length ? rows.map((p) => `<div class="offer-row"><div>
        <b>${esc(splitName(p.place_name)[0])}</b>
        ${p.hidden ? `<span class="status-tag bad">скрыт</span>` : ""}${p.reports_count ? ` <span class="status-tag">жалоб: ${p.reports_count}</span>` : ""}
        <div style="margin-top:4px">${esc(p.text)}</div>
        <div class="meta">${esc((p.author && p.author.name) || "—")}${p.author && p.author.demo ? " · демо" : ""} · ${timeAgo(p.created_at)} · ♥ ${p.likes_count}</div></div>
      <div class="actions" style="margin:0;flex-wrap:nowrap">
        ${p.hidden ? `<button class="btn" data-unhide="${p.id}">Вернуть</button>` : `<button class="btn" data-hide="${p.id}">Скрыть</button>`}
        <button class="btn" data-pdel="${p.id}">Удалить</button></div></div>`).join("")
      : `<p class="muted">${moderKind === "reported" ? "Жалоб нет — всё спокойно." : "Пусто."}</p>`}
    <div class="note">Отзыв скрывается автоматически после трёх жалоб. «Вернуть» снимает жалобы и показывает отзыв снова.</div></div>`;
  $$("[data-mk]", box).forEach((x) => x.addEventListener("click", () => { moderKind = x.dataset.mk; renderAdminTab(); }));
  const act = async (fn) => { try { await fn(); toast("Готово"); renderAdmin(); } catch (e) { toast(e.message); } };
  $$("[data-hide]", box).forEach((x) => x.addEventListener("click", () => act(() => api(`/api/admin/posts/${x.dataset.hide}`, { hidden: true }))));
  $$("[data-unhide]", box).forEach((x) => x.addEventListener("click", () => act(() => api(`/api/admin/posts/${x.dataset.unhide}`, { hidden: false }))));
  $$("[data-pdel]", box).forEach((x) => x.addEventListener("click", () => {
    if (confirm("Удалить отзыв навсегда?")) act(() => api(`/api/admin/posts/${x.dataset.pdel}`, undefined, "DELETE"));
  }));
}

async function adminOffers(box) {
  const rows = await api("/api/admin/offers");
  box.innerHTML = `<div class="biz-card"><h3>Предложения заведений</h3>${rows.length ? rows.map((o) => `<div class="offer-row"><div>
      <b>${esc(KIND_LABEL[o.kind])}: ${esc(o.title)}</b> ${o.active ? "" : `<span class="status-tag bad">выключено</span>`}
      <div class="meta">${esc(splitName((o.business && o.business.place_name) || "")[0])} · ${esc(offerWhen(o))}</div>
      ${o.details ? `<div class="meta">${esc(o.details)}</div>` : ""}</div>
      <div class="actions" style="margin:0"><button class="btn" data-oa="${o.id}" data-on="${o.active ? 1 : 0}">${o.active ? "Выключить" : "Включить"}</button></div></div>`).join("")
    : `<p class="muted">Предложений пока нет.</p>`}</div>`;
  $$("[data-oa]", box).forEach((x) => x.addEventListener("click", async () => {
    try { await api(`/api/admin/offers/${x.dataset.oa}`, { active: x.dataset.on !== "1" }); toast("Готово"); renderAdminTab(); }
    catch (e) { toast(e.message); }
  }));
}

async function adminUsers(box) {
  const rows = await api("/api/admin/users");
  box.innerHTML = `<div class="biz-card"><h3>Пользователи · ${rows.length}</h3>${rows.map((u) => `<div class="offer-row"><div>
      <b>${esc(u.name)}</b>${u.role === "admin" ? ` <span class="status-tag ok">админ</span>` : ""}${u.demo ? ` <span class="status-tag">демо</span>` : ""}
      <div class="meta">${esc(u.email || "—")} · с ${dateRu(u.created_at)}${u.last_sign_in_at ? ` · последний вход ${dateRu(u.last_sign_in_at)}` : ""}</div></div>
      <div class="nums">${u.posts} ${plural(u.posts, "отзыв", "отзыва", "отзывов")}</div></div>`).join("")}</div>`;
}

async function adminSystem(box) {
  const h = await api("/api/admin/health");
  const yes = (v) => `<span class="status-tag ${v ? "ok" : "bad"}">${v ? "есть" : "нет"}</span>`;
  box.innerHTML = `<div class="biz-card"><h3>Состояние системы</h3>
    <div class="offer-row"><div><b>База Supabase</b><div class="meta">${h.database.ok ? "отвечает" : esc(h.database.error || "")}</div></div>${yes(h.database.ok)}</div>
    <div class="offer-row"><div><b>Каталог мест 2ГИС</b><div class="meta">${fmtInt(h.catalog.total)} мест, собран ${esc(h.catalog.collected_at.split("-").reverse().join("."))}
      · обновить: python -m seruen.collect</div></div></div>
    ${Object.entries(h.keys).map(([k, v]) => `<div class="offer-row"><div><b>Ключ ${esc(k)}</b></div>${yes(v)}</div>`).join("")}
    ${Object.entries(h.models).map(([k, v]) => `<div class="offer-row"><div><b>Модель: ${esc(k)}</b><div class="meta">${esc(v || "не задана")}</div></div></div>`).join("")}
    <div class="offer-row"><div><b>Демо-аккаунты ленты</b><div class="meta">${h.demo_accounts} · удалить перед запуском: python -m seruen.demo_seed --remove</div></div></div></div>`;
}

/* ---------- Голос ---------- */
let rec = null;
async function toggleMic() {
  const btn = $("#micBtn");
  if (rec) { rec.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast("Этот браузер не умеет записывать голос");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast("Нет доступа к микрофону"); }
  const chunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    btn.classList.remove("rec");
    const type = rec.mimeType || "audio/webm";
    rec = null;
    const fd = new FormData();
    fd.append("audio", new Blob(chunks, { type }), type.includes("ogg") ? "query.ogg" : "query.webm");
    const ta = $("#query");
    ta.placeholder = "Распознаю…";
    try {
      const r = await fetch("/api/transcribe", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail);
      ta.value = j.text;
      autosize();
      ask(j.text);
    } catch (e) {
      toast(e.message || "Не получилось распознать, попробуйте ещё раз");
    } finally {
      ta.placeholder = "Что ищем? Например, тихое кафе";
    }
  };
  rec.start();
  btn.classList.add("rec");
  toast("Говорите. Нажмите ещё раз, чтобы закончить", 4000);
}

/* ---------- Запуск ---------- */
function autosize() {
  const ta = $("#query");
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
}
$("#query").addEventListener("input", autosize);
$("#query").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask($("#query").value); }
});
$("#askForm").addEventListener("submit", (e) => { e.preventDefault(); ask($("#query").value); });
$("#micBtn").addEventListener("click", toggleMic);
$("#locateBtn").addEventListener("click", locate);

function runExample(ex) {
  const l = S.meta.landmarks.find((x) => x.name === ex.origin);
  if (l) setOrigin({ name: l.name, lat: l.lat, lon: l.lon });
  setWhen(ex.when);
  $("#whenInput").value = ex.when;
  $("#query").value = ex.text;
  autosize();
  ask(ex.text);
}

async function init() {
  S.meta = await api("/api/meta");
  $("#foot").textContent = `Места, часы работы и рейтинги — 2ГИС (${fmtInt(S.meta.total)} мест, обновлено `
    + `${S.meta.collected_at.split("-").reverse().join(".")}). Маршруты — 2ГИС, погода — Open-Meteo. `
    + `Местоположение округляется примерно до 100 м и не сохраняется.`;
  $("#examples").innerHTML = S.meta.examples.map((ex, i) => `<button type="button" data-ex="${i}">${esc(ex.title)}</button>`).join("");
  $$("#examples button").forEach((b) => b.addEventListener("click", () => runExample(S.meta.examples[+b.dataset.ex])));
  buildPopovers();
  buildRefine();
  buildFeedSort();
  renderNavAuth();

  if (S.session) {
    try { await syncPassport({ mergeGuest: false }); } catch (e) { if (e.status === 401) logoutLocal(); }
  }

  // Параметры адреса — чтобы делиться подборкой и снимать демо: ?q=...&place=...&when=...&quest=1#feed
  const qs = new URLSearchParams(location.search);
  const lm = S.meta.landmarks.find((x) => x.name === qs.get("place"));
  if (lm) setOrigin({ name: lm.name, lat: lm.lat, lon: lm.lon });
  if (qs.get("when")) { setWhen(qs.get("when")); $("#whenInput").value = qs.get("when"); }
  if (qs.get("weather") && S.meta.weather_presets.includes(qs.get("weather"))) S.weatherPreset = qs.get("weather");
  refreshWeather();
  const tabAlias = { passport: "profile" };
  const start = location.hash.slice(1) || tabAlias[qs.get("tab")] || qs.get("tab") || "ask";
  go(start);
  if (qs.get("quest") === "1") { S.quest = null; go("quest"); startQuest(); }
  if (qs.get("q")) { $("#query").value = qs.get("q"); autosize(); ask(qs.get("q")); }
}
init().catch(() => toast("Сервер не отвечает. Запустите python server.py"));
