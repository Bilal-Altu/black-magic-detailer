// Zeichnet Beitrag, Reel-Bilder und Story aus einem Vorher/Nachher-Paar.
//
// Ein Foto ist { bitmap, w, h } (Arbeitskopie). Eine Szene ist { V, N, T }:
// V = Vorher (Bezug), N = Nachher, T = Ausrichtung aus align.js oder null.
// Ausschnitte (views) sind in normierten Koordinaten des Vorher-Fotos angegeben
// (u = (x - w/2)/w, v = (y - h/2)/w); ohne Ausrichtung hat jedes Foto seinen eigenen.

export const POST = { w: 1080, h: 1440 };
export const REEL = { w: 1080, h: 1920, fps: 30, dur: 7.5 };
export const FONT = 'Michroma';

// Ab diesem Faktor würde ein Foto sichtbar hochgerechnet
export const MAX_UPSCALE = 1.25;

const TAU = Math.PI * 2;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export function gold(ctx, x0, y0, x1, y1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, '#f2dca2');
  g.addColorStop(0.28, '#c69f55');
  g.addColorStop(0.52, '#8e6c2f');
  g.addColorStop(0.76, '#d7b56b');
  g.addColorStop(1, '#f2dca2');
  return g;
}

// ---------- Ausschnitte ----------

function toN(T, u, v) {
  const c = Math.cos(T.r) * T.s, s = Math.sin(T.r) * T.s;
  return [c * u - s * v + T.tx, s * u + c * v + T.ty];
}

function inside(scene, u, v) {
  const { V, N, T } = scene;
  if (Math.abs(u) > 0.5 || Math.abs(v) > V.h / V.w / 2) return false;
  const [un, vn] = toN(T, u, v);
  return Math.abs(un) <= 0.5 && Math.abs(vn) <= N.h / N.w / 2;
}

// Größter Ausschnitt mit Seitenverhältnis aspect (Breite/Höhe), der in beiden Fotos liegt
export function fitView(scene, aspect) {
  const hv = scene.V.h / scene.V.w / 2;
  let su = 0, sv = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    for (let j = 0; j < 40; j++) {
      const u = -0.5 + (i + 0.5) / 40, v = -hv + ((j + 0.5) / 40) * 2 * hv;
      if (inside(scene, u, v)) { su += u; sv += v; n++; }
    }
  }
  if (!n) return null;
  const widest = (cu, cv) => {
    let lo = 0, hi = 1.5;
    for (let k = 0; k < 28; k++) {
      const w = (lo + hi) / 2, h = w / aspect;
      const ok = inside(scene, cu - w / 2, cv - h / 2) && inside(scene, cu + w / 2, cv - h / 2) &&
        inside(scene, cu - w / 2, cv + h / 2) && inside(scene, cu + w / 2, cv + h / 2);
      if (ok) lo = w; else hi = w;
    }
    return lo;
  };
  let cu = su / n, cv = sv / n, best = widest(cu, cv), step = 0.04;
  for (let it = 0; it < 80 && step > 0.0005; it++) {
    let moved = false;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const w = widest(cu + a * step, cv + b * step);
      if (w > best + 1e-7) { best = w; cu += a * step; cv += b * step; moved = true; break; }
    }
    if (!moved) step /= 2;
  }
  return { cu, cv, w: best, h: best / aspect };
}

// Mittiger Ausschnitt eines einzelnen Fotos, der das Seitenverhältnis füllt
export function coverView(photo, aspect) {
  const fh = photo.h / photo.w;
  return 1 / fh > aspect ? { cu: 0, cv: 0, w: fh * aspect, h: fh } : { cu: 0, cv: 0, w: 1, h: 1 / aspect };
}

function zoomView(v, z) {
  return { cu: v.cu, cv: v.cv, w: v.w / z, h: v.h / z };
}

// Wie stark das Foto im Zielrechteck vergrößert wird (1 = Pixel für Pixel)
export function upscale(photo, view, rectW, T) {
  return rectW / view.w / (photo.w * (T ? T.s : 1));
}

// Zeichnet ein Foto so, dass view das Rechteck rect füllt. T nur für das Nachher-Foto einer
// ausgerichteten Szene, weil view dann in Vorher-Koordinaten angegeben ist.
function drawView(ctx, photo, view, rect, T) {
  const k = rect.w / view.w;
  ctx.save();
  ctx.translate(rect.x + (view.w / 2 - view.cu) * k, rect.y + (view.h / 2 - view.cv) * k);
  ctx.scale(k, k);
  if (T) {
    ctx.scale(1 / T.s, 1 / T.s);
    ctx.rotate(-T.r);
    ctx.translate(-T.tx, -T.ty);
  }
  ctx.scale(1 / photo.w, 1 / photo.w);
  ctx.translate(-photo.w / 2, -photo.h / 2);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.bitmap, 0, 0, photo.w, photo.h);
  ctx.restore();
}

function clipPoly(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.clip();
}

// ---------- Marken-Elemente ----------

function spaced(ctx, text, x, y, gap, align = 'left') {
  const chars = [...text];
  const ws = chars.map((c) => ctx.measureText(c).width);
  const total = ws.reduce((a, b) => a + b, 0) + gap * (chars.length - 1);
  let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => { ctx.fillText(c, cx, y); cx += ws[i] + gap; });
  ctx.textAlign = prev;
  return total;
}

function measureSpaced(ctx, text, gap) {
  const chars = [...text];
  return chars.reduce((a, c) => a + ctx.measureText(c).width, 0) + gap * (chars.length - 1);
}

// Rundes Logo mit Goldring. logo: Bild (PNG/JPG) oder null für den Platzhalter.
export function drawBadge(ctx, cx, cy, R, logo, ring = true) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = R * 0.14;
  ctx.shadowOffsetY = R * 0.04;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU);
  ctx.fillStyle = '#060607'; ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
  if (logo) {
    const s = Math.max((2 * R) / logo.width, (2 * R) / logo.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(logo, cx - (logo.width * s) / 2, cy - (logo.height * s) / 2, logo.width * s, logo.height * s);
  } else {
    const g = ctx.createRadialGradient(cx, cy - R * 0.35, R * 0.05, cx, cy, R);
    g.addColorStop(0, '#202024'); g.addColorStop(1, '#050506');
    ctx.fillStyle = g; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${Math.round(R * 0.15)}px ${FONT}, sans-serif`;
    ctx.fillStyle = (() => {
      const t = ctx.createLinearGradient(0, cy - R * 0.1, 0, cy + R * 0.12);
      t.addColorStop(0, '#ffffff'); t.addColorStop(1, '#b9b9bd');
      return t;
    })();
    spaced(ctx, 'BLACK MAGIC', cx, cy + R * 0.06, R * 0.018, 'center');
    ctx.font = `${Math.round(R * 0.068)}px ${FONT}, sans-serif`;
    ctx.fillStyle = '#c9a45c';
    spaced(ctx, 'DETAILER', cx, cy + R * 0.3, R * 0.06, 'center');
    ctx.strokeStyle = gold(ctx, cx - R * 0.5, 0, cx + R * 0.5, 0);
    ctx.lineWidth = Math.max(1, R * 0.012);
    ctx.beginPath(); ctx.moveTo(cx - R * 0.42, cy - R * 0.2); ctx.lineTo(cx + R * 0.42, cy - R * 0.2); ctx.stroke();
  }
  ctx.restore();

  if (ring) {
    const lw = R * 0.05;
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = gold(ctx, cx - R, cy - R, cx + R, cy + R);
    ctx.beginPath(); ctx.arc(cx, cy, R - lw / 2, 0, TAU); ctx.stroke();
    ctx.restore();
  }
}

// Schild „VORHER“ / „NACHHER“: dunkles Feld, feine Goldkante
export function drawTag(ctx, text, x, y, align, size, alpha = 1) {
  if (alpha <= 0.001) return 0;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${size}px ${FONT}, sans-serif`;
  const gap = size * 0.3;
  const tw = measureSpaced(ctx, text, gap);
  const padX = size * 0.85, h = Math.round(size * 2.3), w = Math.round(tw + 2 * padX);
  const left = Math.round(align === 'right' ? x - w : x);
  ctx.fillStyle = 'rgba(7,7,8,0.8)';
  ctx.fillRect(left, y, w, h);
  ctx.strokeStyle = gold(ctx, left, y, left + w, y + h);
  ctx.lineWidth = Math.max(1.5, size * 0.07);
  ctx.strokeRect(left + ctx.lineWidth / 2, y + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  ctx.fillStyle = '#f4f4f4';
  ctx.textBaseline = 'middle';
  spaced(ctx, text, left + padX, y + h / 2 + size * 0.06, gap, 'left');
  ctx.restore();
  return h;
}

export function tagHeight(size) {
  return Math.round(size * 2.3);
}

// Goldene Trennlinie mit dunkler Kante, damit sie auch auf weißem Lack steht
function drawLine(ctx, a, b, width) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  const ex = (dx / len) * 40, ey = (dy / len) * 40;
  const p0 = [a[0] - ex, a[1] - ey], p1 = [b[0] + ex, b[1] + ey];
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(0,0,0,0.38)';
  ctx.lineWidth = width + 5;
  ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.stroke();
  ctx.strokeStyle = gold(ctx, p0[0], p0[1], p1[0], p1[1]);
  ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(...p0); ctx.lineTo(...p1); ctx.stroke();
  ctx.restore();
}

// ---------- Beitrag 3:4 ----------

const POST_LAYOUTS = {
  // Vorher oben, Nachher unten; Trennlinie leicht schräg wie in Tims Collagen
  stacked(W, H) {
    const d = 22, m = H / 2;
    return {
      regions: [[[0, 0], [W, 0], [W, m + d], [0, m - d]], [[0, m - d], [W, m + d], [W, H], [0, H]]],
      boxes: [{ x: 0, y: 0, w: W, h: m + d }, { x: 0, y: m - d, w: W, h: m + d }],
      line: [[0, m - d], [W, m + d]],
      badge: [W / 2, m],
      tags: [[36, 36, 'left'], [36, H - 36, 'left', true]],
      shared: false,
    };
  },
  // Eine Ansicht, schräg geteilt: links vorher, rechts nachher
  diagonal(W, H) {
    const x1 = W * 0.6, x2 = W * 0.4;
    return {
      regions: [[[0, 0], [x1, 0], [x2, H], [0, H]], [[x1, 0], [W, 0], [W, H], [x2, H]]],
      boxes: [{ x: 0, y: 0, w: W, h: H }, { x: 0, y: 0, w: W, h: H }],
      line: [[x1, 0], [x2, H]],
      badge: [W / 2, H / 2],
      tags: [[36, 36, 'left'], [W - 36, H - 36, 'right', true]],
      shared: true,
    };
  },
  // Nebeneinander (Hochformat-Fotos, die nicht deckungsgleich sind)
  side(W, H) {
    const x1 = W / 2 + 18, x2 = W / 2 - 18;
    return {
      regions: [[[0, 0], [x1, 0], [x2, H], [0, H]], [[x1, 0], [W, 0], [W, H], [x2, H]]],
      boxes: [{ x: 0, y: 0, w: x1, h: H }, { x: x2, y: 0, w: W - x2, h: H }],
      line: [[x1, 0], [x2, H]],
      badge: [W / 2, H / 2],
      tags: [[36, 36, 'left'], [W - 36, H - 36, 'right', true]],
      shared: false,
    };
  },
};

// Ausschnitte für ein Layout; bei ausgerichteter Szene zeigen beide Hälften dieselbe Stelle
function postViews(scene, geo) {
  const { V, N, T } = scene;
  if (T) {
    if (geo.shared) {
      const v = fitView(scene, POST.w / POST.h);
      return v && [v, v];
    }
    const v = fitView(scene, geo.boxes[0].w / geo.boxes[0].h);
    return v && [v, v];
  }
  return [coverView(V, geo.boxes[0].w / geo.boxes[0].h), coverView(N, geo.boxes[1].w / geo.boxes[1].h)];
}

// Stärkste Vergrößerung, die ein Layout den Fotos abverlangt
export function postUpscale(scene, layout) {
  const geo = POST_LAYOUTS[layout](POST.w, POST.h);
  const views = postViews(scene, geo);
  if (!views) return Infinity;
  return Math.max(
    upscale(scene.V, views[0], geo.boxes[0].w, null),
    upscale(scene.N, views[1], geo.boxes[1].w, scene.T),
  );
}

// Querformat zeigt übereinander die ganze Szene; Hochformat teilt schräg, wenn deckungsgleich.
// Ein Layout, das die Fotos zu stark vergrößern müsste, wird übersprungen.
export function autoLayout(scene) {
  const land = scene.V.w >= scene.V.h;
  const order = (land ? ['stacked', 'diagonal', 'side'] : ['diagonal', 'side', 'stacked'])
    .filter((l) => l !== 'diagonal' || scene.T);
  const usable = order.filter((l) => postUpscale(scene, l) <= MAX_UPSCALE);
  if (usable.length) return usable[0];
  return order.sort((a, b) => postUpscale(scene, a) - postUpscale(scene, b))[0];
}

// Kantendichte unter einer Kreisfläche – viel Kante heißt: da ist Motiv (z. B. der Schmutz)
function detailUnder(ctx, cx, cy, R) {
  const x0 = Math.round(cx - R), y0 = Math.round(cy - R), size = Math.round(2 * R), st = 4;
  const px = ctx.getImageData(x0, y0, size, size).data;
  const lum = (i) => px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
  let e = 0, n = 0;
  for (let y = 0; y < size - st; y += st) {
    for (let x = 0; x < size - st; x += st) {
      if ((x - R) ** 2 + (y - R) ** 2 > R * R) continue;
      const i = (y * size + x) * 4, l = lum(i);
      e += Math.abs(lum(i + 4 * st) - l) + Math.abs(lum(i + 4 * st * size) - l);
      n++;
    }
  }
  return e / n;
}

// Logo auf der Trennlinie dorthin setzen, wo es am wenigsten vom Motiv verdeckt.
// Die Mitte (Tims übliche Position) gewinnt, solange sie kaum schlechter ist.
function badgeSpot(ctx, geo, R) {
  const { w: W, h: H } = POST;
  const [[ax, ay], [bx, by]] = geo.line;
  const m = 34;
  const spots = [0.5, 0.2, 0.35, 0.65, 0.8].map((f) => [ax + (bx - ax) * f, ay + (by - ay) * f])
    .filter(([x, y]) => x - R >= m && x + R <= W - m && y - R >= m && y + R <= H - m);
  if (spots.length <= 1) return geo.badge;
  const scored = spots.map((p) => ({ p, e: detailUnder(ctx, p[0], p[1], R) }));
  const best = scored.reduce((a, b) => (b.e < a.e ? b : a));
  return scored[0].e <= best.e * 1.12 ? scored[0].p : best.p;
}

export function renderPost(ctx, scene, opts) {
  const { w: W, h: H } = POST;
  const geo = POST_LAYOUTS[opts.layout](W, H);
  const views = postViews(scene, geo);
  const R = 150;
  ctx.save();
  ctx.fillStyle = '#070708';
  ctx.fillRect(0, 0, W, H);
  [scene.V, scene.N].forEach((photo, i) => {
    ctx.save();
    clipPoly(ctx, geo.regions[i]);
    drawView(ctx, photo, views[i], geo.boxes[i], i === 1 ? scene.T : null);
    ctx.restore();
  });
  const spot = badgeSpot(ctx, geo, R);
  drawLine(ctx, geo.line[0], geo.line[1], 7);
  const size = 25, th = tagHeight(size);
  geo.tags.forEach(([x, y, align, bottom], i) => {
    drawTag(ctx, i ? 'NACHHER' : 'VORHER', x, bottom ? y - th : y, align, size);
  });
  drawBadge(ctx, spot[0], spot[1], R, opts.logo, opts.ring);
  ctx.restore();
}

// ---------- Reel 9:16 ----------

// Querformat: Foto als Band in der Mitte, Logo darüber, Fahrzeug darunter.
// Hochformat: Foto füllt das ganze Bild.
export function reelGeometry(scene) {
  const { w: W, h: H } = REEL;
  const land = scene.V.w >= scene.V.h;
  const stage = land ? { x: 0, y: 540, w: W, h: 810 } : { x: 0, y: 0, w: W, h: H };
  const aspect = stage.w / stage.h;
  const views = scene.T ? (() => { const v = fitView(scene, aspect); return v && [v, v]; })()
    : [coverView(scene.V, aspect), coverView(scene.N, aspect)];
  return {
    mode: land ? 'band' : 'full',
    stage,
    views,
    // Instagram zeigt Reels im Raster als 3:4-Ausschnitt (y 240–1680) – das Logo bleibt darin
    badge: land ? [W / 2, 366, 118] : [W / 2, 350, 100],
    upscale: views ? Math.max(upscale(scene.V, views[0], stage.w, null), upscale(scene.N, views[1], stage.w, scene.T)) * 1.04 : Infinity,
  };
}

// Ablauf: vorher stehen lassen → Linie wischt nach links (nachher) → stehen lassen →
// Linie kommt zur Mitte zurück → geteilt stehen lassen
const STEPS = { hold1: 0.8, wipe1: 1.6, hold2: 1.5, wipe2: 1.2 };
export function wipeAt(t) {
  let a = STEPS.hold1;
  if (t < a) return 1;
  if (t < a + STEPS.wipe1) return 1 - ease((t - a) / STEPS.wipe1);
  a += STEPS.wipe1;
  if (t < a + STEPS.hold2) return 0;
  a += STEPS.hold2;
  if (t < a + STEPS.wipe2) return 0.5 * ease((t - a) / STEPS.wipe2);
  return 0.5;
}
export const STORY_TIME = REEL.dur - 0.4;

export function renderReelFrame(ctx, scene, G, t, opts) {
  const { w: W, h: H } = REEL;
  const st = G.stage;
  const p = wipeAt(t);
  const z = 1 + 0.04 * ease(clamp01(t / REEL.dur));
  const vV = zoomView(G.views[0], z), vN = zoomView(G.views[1], z);

  ctx.save();
  ctx.fillStyle = '#070708';
  ctx.fillRect(0, 0, W, H);

  // Linie: 6° schräg; p = 1 ganz rechts draußen, p = 0 ganz links draußen
  const slant = Math.tan((6 * Math.PI) / 180) * st.h;
  const xc = st.x - slant / 2 - 12 + p * (st.w + slant + 24);
  const xt = xc + slant / 2, xb = xc - slant / 2, y0 = st.y, y1 = st.y + st.h;

  ctx.save();
  ctx.beginPath(); ctx.rect(st.x, st.y, st.w, st.h); ctx.clip();
  ctx.save(); clipPoly(ctx, [[st.x - 2, y0], [xt, y0], [xb, y1], [st.x - 2, y1]]);
  drawView(ctx, scene.V, vV, st, null); ctx.restore();
  ctx.save(); clipPoly(ctx, [[xt, y0], [st.x + st.w + 2, y0], [st.x + st.w + 2, y1], [xb, y1]]);
  drawView(ctx, scene.N, vN, st, scene.T); ctx.restore();
  if (p > 0 && p < 1) drawLine(ctx, [xt, y0], [xb, y1], 7);
  ctx.restore();

  const size = 26, th = tagHeight(size);
  const aV = smooth(0.25, 0.45, p), aN = 1 - smooth(0.55, 0.75, p);
  if (G.mode === 'band') {
    drawTag(ctx, 'VORHER', st.x + 32, y1 - 32 - th, 'left', size, aV);
    drawTag(ctx, 'NACHHER', st.x + st.w - 32, y1 - 32 - th, 'right', size, aN);
  } else {
    drawTag(ctx, 'VORHER', 48, 500, 'left', size, aV);
    drawTag(ctx, 'NACHHER', W - 48, 500, 'right', size, aN);
  }

  drawBadge(ctx, G.badge[0], G.badge[1], G.badge[2], opts.logo, opts.ring);
  drawCaption(ctx, G, opts);
  ctx.restore();
}

// Fahrzeug und Leistung unter dem Foto (Band) bzw. unten im Bild (Vollbild)
function drawCaption(ctx, G, opts) {
  const { w: W } = REEL;
  if (G.mode === 'full' && (opts.vehicle || opts.service)) scrim(ctx, 1220, 1600, W, 'mid');
  drawTexts(ctx, G.mode === 'band' ? G.stage.y + G.stage.h + 110 : 1400, opts.vehicle, opts.service, W);
}

// Zwei Zeilen: Fahrzeug (silbern) und darunter Leistung/Bereich (gold)
function drawTexts(ctx, y, top, sub, W) {
  const a = (top || '').trim().toUpperCase(), b = (sub || '').trim().toUpperCase();
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  if (a) {
    ctx.font = `34px ${FONT}, sans-serif`;
    ctx.fillStyle = '#efefef';
    fitSpaced(ctx, a, W / 2, y, 7, W - 140, 34);
    y += 58;
  }
  if (b) {
    ctx.font = `20px ${FONT}, sans-serif`;
    ctx.fillStyle = '#c9a45c';
    fitSpaced(ctx, b, W / 2, y, 7, W - 140, 20);
  }
  ctx.restore();
}

// Abdunklung, damit Schrift auf dem Foto lesbar bleibt ('mid': Band, 'bottom': bis zum Rand)
function scrim(ctx, y0, y1, W, kind) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  if (kind === 'mid') { g.addColorStop(0.5, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)'); }
  else g.addColorStop(1, 'rgba(0,0,0,0.72)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, y0, W, y1 - y0);
  ctx.restore();
}

function fitSpaced(ctx, text, x, y, gap, maxW, size) {
  let s = size;
  while (s > 12 && measureSpaced(ctx, text, gap * s / size) > maxW) {
    s -= 1;
    ctx.font = ctx.font.replace(/^\d+px/, `${s}px`);
  }
  spaced(ctx, text, x, y, gap * s / size, 'center');
}

// ---------- Karussell (mehrere Bilder zum Wischen, 3:4) ----------
//
// Vorher und Nachher eines Paares liegen auf zwei aufeinanderfolgenden Bildern mit exakt
// demselben Ausschnitt – beim Wischen schiebt sich so das saubere Bild über das dreckige.
// Querformat-Fotos stehen als Band in der Mitte (sonst müssten sie hochgerechnet werden),
// Hochformat-Fotos füllen das Bild.

const BG = '#070708';

function slideFrame(land) {
  const { w: W, h: H } = POST;
  return land
    ? { mode: 'band', stage: { x: 0, y: 315, w: W, h: 810 } }
    : { mode: 'full', stage: { x: 0, y: 0, w: W, h: H } };
}

export function pairFrame(scene) {
  const land = scene.V.w >= scene.V.h || scene.N.w >= scene.N.h;
  const G = slideFrame(land);
  const aspect = G.stage.w / G.stage.h;
  const shared = scene.T && fitView(scene, aspect);
  const views = shared ? [shared, shared] : [coverView(scene.V, aspect), coverView(scene.N, aspect)];
  return { ...G, views, T: shared ? scene.T : null };
}

// Rahmen eines Karussellbilds: Logo oben, Schrift unten, Schilder im Foto
function slideChrome(ctx, G, badgeR, top, sub, tags, opts) {
  const { w: W, h: H } = POST;
  const size = 25, th = tagHeight(size);
  if (G.mode === 'band') {
    const y1 = G.stage.y + G.stage.h;
    tags.forEach(([text, align]) => drawTag(ctx, text, align === 'left' ? 32 : W - 32, y1 - 32 - th, align, size));
    drawBadge(ctx, W / 2, G.stage.y / 2, badgeR, opts.logo, opts.ring);
    drawTexts(ctx, y1 + 100, top, sub, W);
  } else {
    const ty = H - 36 - th;
    if (top || sub) scrim(ctx, H - 420, H, W, 'bottom');
    tags.forEach(([text, align]) => drawTag(ctx, text, align === 'left' ? 32 : W - 32, ty, align, size));
    drawBadge(ctx, W / 2, 40 + badgeR, badgeR, opts.logo, opts.ring);
    drawTexts(ctx, ty - 92, top, sub, W);
  }
}

// which: 'V' oder 'N'; opts.hint setzt „WISCHEN ›“ aufs erste Vorher-Bild
export function renderPairSlide(ctx, scene, G, which, opts) {
  const { w: W, h: H } = POST;
  const st = G.stage;
  ctx.save();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath(); ctx.rect(st.x, st.y, st.w, st.h); ctx.clip();
  if (which === 'V') drawView(ctx, scene.V, G.views[0], st, null);
  else drawView(ctx, scene.N, G.views[1], st, G.T);
  ctx.restore();
  const tags = [[which === 'V' ? 'VORHER' : 'NACHHER', 'left']];
  if (which === 'V' && opts.hint) tags.push(['WISCHEN  ›', 'right']);
  slideChrome(ctx, G, G.mode === 'band' ? 92 : 80, opts.vehicle, opts.label || opts.service, tags, opts);
  ctx.restore();
}

// Schlussbild: das fertige Fahrzeug, großes Logo, Aufforderung zum Termin
export function renderEndSlide(ctx, photo, opts) {
  const { w: W, h: H } = POST;
  const G = slideFrame(photo.w >= photo.h);
  const view = coverView(photo, G.stage.w / G.stage.h);
  ctx.save();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath(); ctx.rect(G.stage.x, G.stage.y, G.stage.w, G.stage.h); ctx.clip();
  drawView(ctx, photo, view, G.stage, null);
  ctx.restore();
  slideChrome(ctx, G, G.mode === 'band' ? 110 : 96, opts.vehicle, opts.service, [['TERMIN PER DM', 'right']], opts);
  ctx.restore();
}

export function slideUpscale(scene, G) {
  return Math.max(upscale(scene.V, G.views[0], G.stage.w, null), upscale(scene.N, G.views[1], G.stage.w, G.T));
}

// ---------- Ausrichtung prüfen ----------

// Vorher-Foto ganz, Nachher-Foto halbdurchsichtig darüber
export function renderOverlay(ctx, scene, cw, ch, alpha) {
  const { V, N, T } = scene;
  const fh = V.h / V.w;
  const view = { cu: 0, cv: 0, w: 1, h: fh };
  const rect = { x: 0, y: 0, w: cw, h: cw * fh };
  ctx.save();
  ctx.fillStyle = '#070708';
  ctx.fillRect(0, 0, cw, ch);
  drawView(ctx, V, view, rect, null);
  ctx.globalAlpha = alpha;
  if (T) drawView(ctx, N, view, rect, T);
  else drawView(ctx, N, coverView(N, 1 / fh), rect, null);
  ctx.restore();
  return rect;
}
