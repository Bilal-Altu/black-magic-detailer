// Automatische Ausrichtung zweier Fotos (Vorher = Bezug, Nachher = wird angepasst).
//
// Gesucht ist die Ähnlichkeitstransformation (Maßstab, Drehung, Verschiebung), die jeden
// Punkt des Vorher-Fotos auf dieselbe Stelle im Nachher-Foto abbildet. Verglichen werden
// nicht Helligkeiten – Schmutz, Nässe und anderes Licht ändern die ja gerade –, sondern
// normierte Kantenrichtungen (Normalized Gradient Fields). Die Konturen von Tankdeckel,
// Lüftungsgitter oder Sitznähten bleiben vorher wie nachher dieselben.
//
// Koordinaten sind auf die Bildbreite normiert und auf die Bildmitte bezogen:
//   u = (x - w/2) / w,  v = (y - h/2) / w
// Ergebnis { s, r, tx, ty } bedeutet:
//   uN = s·(cos r·uV − sin r·vV) + tx,  vN = s·(sin r·uV + cos r·vV) + ty

const LEVEL_WIDTHS = [48, 96, 192, 384];

function blur(src, w, h) {
  // zweimal [1 2 1]/4 in jede Richtung, entspricht etwa Gauß mit Sigma 1
  let a = src, b = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const l = x > 0 ? a[o + x - 1] : a[o + x];
        const r = x < w - 1 ? a[o + x + 1] : a[o + x];
        b[o + x] = (l + 2 * a[o + x] + r) * 0.25;
      }
    }
    const c = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w, up = y > 0 ? o - w : o, dn = y < h - 1 ? o + w : o;
      for (let x = 0; x < w; x++) c[o + x] = (b[up + x] + 2 * b[o + x] + b[dn + x]) * 0.25;
    }
    a = c;
  }
  return a;
}

function resample(src, w, h, w2, h2) {
  // Flächenmittel – beim Verkleinern um beliebige Faktoren ohne Treppen
  const out = new Float32Array(w2 * h2);
  const fx = w / w2, fy = h / h2;
  for (let y = 0; y < h2; y++) {
    const y0 = y * fy, y1 = y0 + fy;
    for (let x = 0; x < w2; x++) {
      const x0 = x * fx, x1 = x0 + fx;
      let sum = 0, area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0 || yy >= h) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0 || xx >= w) continue;
          sum += src[yy * w + xx] * wx * wy;
          area += wx * wy;
        }
      }
      out[y * w2 + x] = sum / area;
    }
  }
  return out;
}

function gradientField(img, w, h) {
  const nx = new Float32Array(w * h), ny = new Float32Array(w * h);
  let sum = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const dx = (img[i + 1] - img[i - 1]) * 0.5;
      const dy = (img[i + w] - img[i - w]) * 0.5;
      nx[i] = dx; ny[i] = dy;
      sum += Math.sqrt(dx * dx + dy * dy); n++;
    }
  }
  // Rauschschwelle: schwächere Kanten als der Durchschnitt zählen kaum
  const e2 = (sum / n) ** 2 + 1e-6;
  for (let i = 0; i < w * h; i++) {
    const m = Math.sqrt(nx[i] * nx[i] + ny[i] * ny[i] + e2);
    nx[i] /= m; ny[i] /= m;
  }
  return { nx, ny };
}

export function buildPyramid(gray, w, h) {
  return LEVEL_WIDTHS.filter((lw) => lw <= w).map((lw) => {
    const lh = Math.max(8, Math.round(h * lw / w));
    const img = blur(resample(gray, w, h, lw, lh), lw, lh);
    return { w: lw, h: lh, ...gradientField(img, lw, lh) };
  });
}

// Übereinstimmung 0…1 (1 = gleiche Konturen an gleicher Stelle)
export function score(B, A, p, step = 1) {
  const c = Math.cos(p.r) * p.s, sn = Math.sin(p.r) * p.s, k = A.w / B.w;
  const a11 = c * k, a12 = -sn * k, a21 = sn * k, a22 = c * k;
  const bx = -a11 * B.w / 2 - a12 * B.h / 2 + p.tx * A.w + A.w / 2;
  const by = -a21 * B.w / 2 - a22 * B.h / 2 + p.ty * A.w + A.h / 2;
  const Aw = A.w, Anx = A.nx, Any = A.ny;
  let sd = 0, sb = 0, sa = 0, valid = 0, total = 0;
  for (let y = 1; y < B.h - 1; y += step) {
    for (let x = 1; x < B.w - 1; x += step) {
      total++;
      const xa = a11 * x + a12 * y + bx, ya = a21 * x + a22 * y + by;
      if (xa < 1 || ya < 1 || xa >= Aw - 2 || ya >= A.h - 2) continue;
      const x0 = xa | 0, y0 = ya | 0, fx = xa - x0, fy = ya - y0;
      const i = y0 * Aw + x0;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const ax = Anx[i] * w00 + Anx[i + 1] * w10 + Anx[i + Aw] * w01 + Anx[i + Aw + 1] * w11;
      const ay = Any[i] * w00 + Any[i + 1] * w10 + Any[i + Aw] * w01 + Any[i + Aw + 1] * w11;
      const j = y * B.w + x;
      const vx = B.nx[j], vy = B.ny[j];
      const d = vx * ax + vy * ay, b2 = vx * vx + vy * vy, a2 = ax * ax + ay * ay;
      sd += d * d; sb += b2 * b2; sa += a2 * a2; valid++;
    }
  }
  if (valid < total * 0.35 || sb === 0 || sa === 0) return 0;
  return (sd / Math.sqrt(sb * sa)) * Math.sqrt(valid / total);
}

function refine(B, A, p, stepPx, minPx) {
  const px = 1 / B.w;
  let st = { tx: stepPx * px, ty: stepPx * px, ls: 0.03 * stepPx / 2, r: 0.012 * stepPx / 2 };
  let cur = { ...p }, best = score(B, A, cur);
  for (let iter = 0; iter < 200; iter++) {
    let moved = false;
    for (const key of ['tx', 'ty', 'ls', 'r']) {
      for (const dir of [1, -1]) {
        const q = { ...cur };
        if (key === 'ls') q.s = cur.s * Math.exp(dir * st.ls);
        else q[key] = cur[key] + dir * st[key];
        const sc = score(B, A, q);
        if (sc > best) { best = sc; cur = q; moved = true; }
      }
    }
    if (!moved) {
      for (const key in st) st[key] /= 2;
      if (st.tx < minPx * px) break;
    }
  }
  return { p: cur, sc: best };
}

function search(PV, PN) {
  const L0V = PV[0], L0N = PN[0];

  // 1. Grobe Rastersuche auf 48 px Breite
  const top = [];
  const keep = (c) => {
    top.push(c); top.sort((a, b) => b.sc - a.sc);
    if (top.length > 10) top.pop();
  };
  for (let ls = -0.45; ls <= 0.451; ls += 0.05) {
    for (let rd = -8; rd <= 8; rd += 4) {
      for (let tx = -0.28; tx <= 0.281; tx += 0.04) {
        for (let ty = -0.28; ty <= 0.281; ty += 0.04) {
          const p = { s: Math.exp(ls), r: rd * Math.PI / 180, tx, ty };
          const sc = score(L0V, L0N, p);
          if (top.length < 10 || sc > top[top.length - 1].sc) keep({ p, sc });
        }
      }
    }
  }

  // 2. Die besten Kandidaten Stufe für Stufe verfeinern
  let cands = top.map((c) => refine(L0V, L0N, c.p, 2, 0.25));
  for (let L = 1; L < PV.length; L++) {
    cands.sort((a, b) => b.sc - a.sc);
    cands = cands.slice(0, L === 1 ? 5 : 2).map((c) => refine(PV[L], PN[L], c.p, 2, 0.25));
  }
  cands.sort((a, b) => b.sc - a.sc);
  return cands[0];
}

function invert(p) {
  const s = 1 / p.s, c = Math.cos(-p.r), sn = Math.sin(-p.r);
  return { s, r: -p.r, tx: -s * (c * p.tx - sn * p.ty), ty: -s * (sn * p.tx + c * p.ty) };
}

// Ab diesem Wert zeigen beide Fotos dieselbe Stelle aus ähnlichem Blickwinkel, sodass sich
// eine Überblendung lohnt. Gemessen an Tims Fotos: echtes Paar 0,57 · gleicher Tankdeckel,
// aber frontal statt schräg 0,44 (Überlagerung sichtbar doppelt) · verschiedene Motive 0,30–0,39.
export const MATCH_THRESHOLD = 0.5;

// Stelle mit der größten Veränderung (meist der Schmutz), in normierten Vorher-Koordinaten.
// Beide Fotos werden vorher auf gleiche Helligkeit und gleichen Kontrast gebracht, damit
// anderes Licht nicht als Veränderung zählt. win = Fensterbreite als Anteil der Bildbreite.
export function hotSpot(grayV, wV, hV, grayN, wN, hN, T, win = 0.3) {
  const c = Math.cos(T.r) * T.s, sn = Math.sin(T.r) * T.s, n = wV * hV;
  const a = new Float32Array(n), b = new Float32Array(n), ok = new Float32Array(n);
  let sa = 0, sb = 0, qa = 0, qb = 0, cnt = 0;
  for (let y = 0; y < hV; y++) {
    for (let x = 0; x < wV; x++) {
      const u = (x - wV / 2) / wV, v = (y - hV / 2) / wV;
      const xn = (c * u - sn * v + T.tx) * wN + wN / 2, yn = (sn * u + c * v + T.ty) * wN + hN / 2;
      if (xn < 0 || yn < 0 || xn >= wN - 1 || yn >= hN - 1) continue;
      const x0 = xn | 0, y0 = yn | 0, fx = xn - x0, fy = yn - y0, j = y0 * wN + x0;
      const val = grayN[j] * (1 - fx) * (1 - fy) + grayN[j + 1] * fx * (1 - fy) +
        grayN[j + wN] * (1 - fx) * fy + grayN[j + wN + 1] * fx * fy;
      const i = y * wV + x;
      a[i] = grayV[i]; b[i] = val; ok[i] = 1;
      sa += a[i]; sb += val; qa += a[i] * a[i]; qb += val * val; cnt++;
    }
  }
  if (cnt < n * 0.3) return null;
  const ma = sa / cnt, mb = sb / cnt;
  const da = Math.sqrt(qa / cnt - ma * ma) || 1, db = Math.sqrt(qb / cnt - mb * mb) || 1;
  // Summenbilder für Unterschied und gültige Fläche
  const W1 = wV + 1, S = new Float64Array(W1 * (hV + 1)), O = new Float64Array(W1 * (hV + 1));
  for (let y = 0; y < hV; y++) {
    let rs = 0, ro = 0;
    for (let x = 0; x < wV; x++) {
      const i = y * wV + x;
      rs += ok[i] ? Math.abs((a[i] - ma) / da - (b[i] - mb) / db) : 0;
      ro += ok[i];
      S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + rs;
      O[(y + 1) * W1 + x + 1] = O[y * W1 + x + 1] + ro;
    }
  }
  const k = Math.max(4, Math.round(win * wV));
  const box = (A, x, y) => A[(y + k) * W1 + x + k] - A[y * W1 + x + k] - A[(y + k) * W1 + x] + A[y * W1 + x];
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y + k <= hV; y += 2) {
    for (let x = 0; x + k <= wV; x += 2) {
      if (box(O, x, y) < k * k * 0.97) continue;
      const s = box(S, x, y);
      if (s > best) { best = s; bx = x; by = y; }
    }
  }
  if (best < 0) return null;
  return { u: (bx + k / 2 - wV / 2) / wV, v: (by + k / 2 - hV / 2) / wV, w: k / wV };
}

// grayV/grayN: Graustufen als Float32Array, am besten 384 px breit.
// Gesucht wird in beide Richtungen: Bezug muss das Foto mit dem engeren Ausschnitt sein,
// sonst ragt das andere über den Rand und die Suche weicht auf einen falschen Maßstab aus.
export function align(grayV, wV, hV, grayN, wN, hN) {
  const PV = buildPyramid(grayV, wV, hV), PN = buildPyramid(grayN, wN, hN);
  const fwd = search(PV, PN);
  const bwd = search(PN, PV);
  const best = fwd.sc >= bwd.sc ? fwd.p : invert(bwd.p);
  const sc = Math.max(fwd.sc, bwd.sc);
  return { ...best, score: sc, matched: sc >= MATCH_THRESHOLD };
}
