// ── 組織図の地域シルエットを作り直す（生成スクリプト）─────────────────
//
// 出力: lib/org-map-paths.js（SVG の path 文字列）
//
// 出典: Natural Earth（パブリックドメイン。https://www.naturalearthdata.com/about/terms-of-use/）
//   - 日本の都道府県: ne_10m_admin_1_states_provinces
//   - 国（オーストラリア・マレーシア）: ne_110m_admin_0_countries
//
// ⚠️ 出力は**簡略化した図形**です。位置や距離を正確に示すものではありません。
//    画面にもその旨を出しています（ORG_MAP_NOTE）。
//
// 再実行の手順（このスクリプトは日常のビルドには含みません）:
//   mkdir -p /tmp/nemap && cd /tmp/nemap
//   curl -sSL -o ne1.zip https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip
//   curl -sSL -o ne0.zip https://naciscdn.org/naturalearth/110m/cultural/ne_110m_admin_0_countries.zip
//   unzip -o ne1.zip && unzip -o ne0.zip
//   cd <repo> && npm i --no-save shapefile && node scripts/build-org-map.mjs
//
import * as shapefile from 'shapefile';
import fs from 'node:fs';

const DIR = process.env.NE_DIR || '/tmp/nemap';
const OUT = new URL('../lib/org-map-paths.js', import.meta.url);
const clean = (v) => String(v == null ? '' : v).replace(/\u0000+/g, '').trim();

// 都道府県コード（JP-01〜JP-47）→ 地域。⚠️ 三重は近畿（関西）に入れる一般的な区分に従う。
const PREF_REGION = {
  1: 'hokkaido',
  2: 'tohoku', 3: 'tohoku', 4: 'tohoku', 5: 'tohoku', 6: 'tohoku', 7: 'tohoku',
  8: 'kanto', 9: 'kanto', 10: 'kanto', 11: 'kanto', 12: 'kanto', 13: 'kanto', 14: 'kanto',
  15: 'chubu', 16: 'chubu', 17: 'chubu', 18: 'chubu', 19: 'chubu', 20: 'chubu', 21: 'chubu', 22: 'chubu', 23: 'chubu',
  24: 'kansai', 25: 'kansai', 26: 'kansai', 27: 'kansai', 28: 'kansai', 29: 'kansai', 30: 'kansai',
  31: 'chugoku', 32: 'chugoku', 33: 'chugoku', 34: 'chugoku', 35: 'chugoku',
  36: 'shikoku', 37: 'shikoku', 38: 'shikoku', 39: 'shikoku',
  40: 'kyushu', 41: 'kyushu', 42: 'kyushu', 43: 'kyushu', 44: 'kyushu', 45: 'kyushu', 46: 'kyushu',
  47: 'okinawa',
};

// ── 幾何の小道具 ───────────────────────────────────────
const ringArea = (r) => { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; };

// Douglas-Peucker
function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const sqTol = tol * tol;
  const sqSegDist = (p, a, b) => {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y; return dx * dx + dy * dy;
  };
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) { const d = sqSegDist(pts[i], pts[s], pts[e]); if (d > maxD) { maxD = d; idx = i; } }
    if (maxD > sqTol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * 経緯度のリング群 → 0..100 の viewBox に収めた path。
 * ⚠️ 正距円筒に平均緯度の補正をかけただけの**簡略な投影**。正確な地図ではない。
 */
function toPath(rings, { pad = 6, maxLen = 2600, minAreaRatio = 0.012 } = {}) {
  if (!rings.length) return '';
  let latSum = 0, n = 0;
  for (const r of rings) for (const [, lat] of r) { latSum += lat; n++; }
  const k = Math.cos((latSum / n) * Math.PI / 180);
  let proj = rings.map(r => r.map(([lon, lat]) => [lon * k, -lat]));

  // 小さすぎる島は落とす（いちばん大きい島に対する面積比）
  const areas = proj.map(ringArea);
  const maxArea = Math.max(...areas);
  proj = proj.filter((_, i) => areas[i] >= maxArea * minAreaRatio);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of proj) for (const [x, y] of r) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const w = maxX - minX, h = maxY - minY;
  const span = Math.max(w, h) || 1;
  const s = (100 - pad * 2) / span;
  const ox = pad + ((100 - pad * 2) - w * s) / 2;
  const oy = pad + ((100 - pad * 2) - h * s) / 2;
  const put = ([x, y]) => [ox + (x - minX) * s, oy + (y - minY) * s];

  // 長くなりすぎないところまで単純化を強める（画面では40〜110pxでしか描かない）
  for (let tol = 0.25; tol <= 8; tol *= 1.35) {
    const parts = [];
    for (const r of proj) {
      const sp = simplify(r.map(put), tol);
      if (sp.length < 4) continue;
      parts.push('M' + sp.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L') + 'Z');
    }
    const d = parts.join(' ');
    if (d && d.length <= maxLen) return d;
  }
  return '';
}

const ringsOf = (geom) => {
  if (!geom) return [];
  if (geom.type === 'Polygon') return geom.coordinates.slice(0, 1).concat(geom.coordinates.slice(1, 0));
  if (geom.type === 'MultiPolygon') return geom.coordinates.map(poly => poly[0]);
  return [];
};

// ── 日本の地域 ───────────────────────────────────────
const byRegion = {};
{
  const src = await shapefile.open(`${DIR}/ne_10m_admin_1_states_provinces.shp`, `${DIR}/ne_10m_admin_1_states_provinces.dbf`);
  let r;
  while (!(r = await src.read()).done) {
    const p = r.value.properties;
    if (clean(p.admin) !== 'Japan') continue;
    const m = clean(p.iso_3166_2).match(/^JP-(\d+)$/);
    if (!m) continue;
    const key = PREF_REGION[Number(m[1])];
    if (!key) continue;
    (byRegion[key] = byRegion[key] || []).push(...ringsOf(r.value.geometry));
  }
}

// ── 国 ──────────────────────────────────────────────
{
  const src = await shapefile.open(`${DIR}/ne_110m_admin_0_countries.shp`, `${DIR}/ne_110m_admin_0_countries.dbf`);
  const want = { Australia: 'australia', Malaysia: 'malaysia' };
  let r;
  while (!(r = await src.read()).done) {
    const nm = clean(r.value.properties.NAME || r.value.properties.name || r.value.properties.ADMIN);
    const key = want[nm];
    if (!key) continue;
    byRegion[key] = ringsOf(r.value.geometry);
  }
}

// 沖縄は本島に対して小さな島が多いので、島を残す閾値をゆるめる
const OPTS = { okinawa: { minAreaRatio: 0.02, maxLen: 2200 }, malaysia: { minAreaRatio: 0.05 } };
const out = {};
for (const [key, rings] of Object.entries(byRegion)) {
  const d = toPath(rings, OPTS[key] || {});
  if (!d) { console.warn('  空になりました:', key); continue; }
  out[key] = d;
  console.log(`  ${key.padEnd(10)} リング ${rings.length} → ${d.length} 文字`);
}

// 本部・その他は地図ではないので手描きのまま（建物と丸）
out.hq = 'M14 86 L14 44 L50 22 L86 44 L86 86 Z M40 86 L40 62 L60 62 L60 86 Z M28 56 L40 56 L40 48 L28 48 Z M60 56 L72 56 L72 48 L60 48 Z';
out.other = 'M50 8 C73.2 8 92 26.8 92 50 C92 73.2 73.2 92 50 92 C26.8 92 8 73.2 8 50 C8 26.8 26.8 8 50 8 Z';

const keys = ['hokkaido', 'tohoku', 'kanto', 'chubu', 'kansai', 'chugoku', 'shikoku', 'kyushu', 'okinawa', 'australia', 'malaysia', 'other', 'hq'];
const body = keys.filter(k => out[k]).map(k => `  ${k}: '${out[k]}',`).join('\n');
fs.writeFileSync(OUT, `// ⚠️ このファイルは scripts/build-org-map.mjs が作ります。手で直さないでください。
//
// 出典: Natural Earth（パブリックドメイン）
//   https://www.naturalearthdata.com/about/terms-of-use/
//   - 日本の都道府県: ne_10m_admin_1_states_provinces
//   - 国: ne_110m_admin_0_countries
//
// ⚠️ **簡略化した図形**です。位置や距離を正確に示すものではありません。
//    画面でも 40〜110px でしか描かないため、細かい海岸線は落としています。
//    「本部」と「その他」は地図ではなく、建物と地球の絵です。

export const MAP_PATHS = Object.freeze({
${body}
});
`);
console.log('\n  書き出しました:', OUT.pathname);
