// Земля для 3D-сцен: настоящая карта 2ГИС, склеенная из тайлов, с растворёнными краями.
import * as THREE from "three";

// Тайлы 2ГИС в проекции Меркатора.
const tileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const tileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";  // 2ГИС отдаёт тайлы с Access-Control-Allow-Origin: *
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Плоскость с картой 2ГИС на области bounds.
 * proj(lat, lon) -> THREE.Vector3 в метрах сцены; KX, KY — метров в градусе долготы и широты.
 * tint — тонировка карты, base — цвет подложки, в который растворяются края.
 */
export async function mapGround({ bounds, proj, KX, KY, renderer, tint, base, maxTiles = 12, maxZoom = 17, timeoutMs = 8000 }) {
  const { west, east, north, south } = bounds;
  let z = maxZoom, x0, x1, y0, y1;
  for (; z >= 10; z--) {
    x0 = Math.floor(tileX(west, z)); x1 = Math.floor(tileX(east, z));
    y0 = Math.floor(tileY(north, z)); y1 = Math.floor(tileY(south, z));
    if (x1 - x0 + 1 <= maxTiles && y1 - y0 + 1 <= maxTiles) break;
  }
  const canvas = document.createElement("canvas");
  canvas.width = (x1 - x0 + 1) * 256;
  canvas.height = (y1 - y0 + 1) * 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#e9e5dc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const jobs = [];
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      jobs.push(loadImage(`https://tile${(tx + ty) % 4}.maps.2gis.com/tiles?x=${tx}&y=${ty}&z=${z}&v=1`)
        .then((img) => img && ctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256)));
    }
  }
  // Не ждём вечно: что успело загрузиться — то и покажем.
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, timeoutMs))]);

  // Края растворяем в цвет подложки (с поправкой на тонировку), чтобы не было резкой границы.
  const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  const [br, bg, bb] = rgb(base), [tr, tg, tb] = rgb(tint);
  const edge = [br / tr, bg / tg, bb / tb].map((v) => Math.round(Math.min(1, v) * 255)).join(",");
  const fade = (x, y, w, h, gx0, gy0, gx1, gy1) => {
    const gr = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
    gr.addColorStop(0, `rgba(${edge},1)`);
    gr.addColorStop(1, `rgba(${edge},0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(x, y, w, h);
  };
  const W = canvas.width, H = canvas.height, ew = W * 0.16, eh = H * 0.16;
  fade(0, 0, ew, H, 0, 0, ew, 0);
  fade(W - ew, 0, ew, H, W, 0, W - ew, 0);
  fade(0, 0, W, eh, 0, 0, 0, eh);
  fade(0, H - eh, W, eh, 0, H, 0, H - eh);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const mapW = (tileLon(x1 + 1, z) - tileLon(x0, z)) * KX;
  const mapH = (tileLat(y0, z) - tileLat(y1 + 1, z)) * KY;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(mapW, mapH), new THREE.MeshBasicMaterial({ map: tex, color: tint }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.copy(proj((tileLat(y0, z) + tileLat(y1 + 1, z)) / 2, (tileLon(x0, z) + tileLon(x1 + 1, z)) / 2));
  return mesh;
}
