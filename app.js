import { align } from './align.js';
import * as R from './render.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const MEDIABUNNY = 'https://cdn.jsdelivr.net/npm/mediabunny@1.60.0/+esm';
const WORK_MAX = 2400; // längste Seite der Arbeitskopie
const GRAY_W = 384; // Breite für die Ausrichtung
const MAX_PAIRS = 9; // 1 Übersicht + 9 × 2 + Schlussbild = 20, Instagrams Obergrenze
const MAX_SLIDES = 20;

const store = {
  get(k, d) { try { const v = localStorage.getItem('bmd.' + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bmd.' + k, v); } catch { /* privater Modus */ } },
};

// Ein Paar: Vorher/Nachher-Foto, Ausrichtung (auto = automatisch, T = gilt gerade), Bereich
const newPair = () => ({ V: null, N: null, auto: null, T: null, useAlign: false, label: '', msg: '', warn: false, busy: false });

const state = {
  pairs: [newPair()],
  cur: 0,
  end: null, // Schlussbild fürs Karussell
  tab: 'post',
  layout: 'auto',
  car: { mode: store.get('carMode', 'swipe'), cover: store.get('carCover', '1') === '1' },
  carReady: null, // Promise mit den fertigen Karussell-Dateien
  logo: null,
  ring: store.get('ring', '1') === '1',
  reel: null, // fertiges MP4
  hook: 0,
  loop: 0,
};
const pair = () => state.pairs[state.cur];
const ready = (p) => !!(p && p.V && p.N && p.auto);

const cv = $('#cv');
const ctx = cv.getContext('2d');

// ---------- Fotos laden ----------

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

async function decode(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function loadPhoto(file) {
  const src = await decode(file);
  const w0 = src.width, h0 = src.height;
  const f = Math.min(1, WORK_MAX / Math.max(w0, h0));
  const w = Math.round(w0 * f), h = Math.round(h0 * f);
  // in Halbschritten verkleinern – ein einziger großer Schritt würde flimmern
  let cur = src, cw = w0, ch = h0;
  while (cw / 2 >= w) {
    const c = canvas(Math.round(cw / 2), Math.round(ch / 2));
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; cw = c.width; ch = c.height;
  }
  if (cw !== w || ch !== h) {
    const c = canvas(w, h);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, w, h);
    cur = c;
  }
  if (cur !== src && src.close) src.close(); // entpacktes Original (bis 100 MB) sofort freigeben
  const gw = GRAY_W, gh = Math.round((h * GRAY_W) / w);
  const g = canvas(gw, gh);
  const gx = g.getContext('2d', { willReadFrequently: true });
  gx.imageSmoothingQuality = 'high';
  gx.drawImage(cur, 0, 0, gw, gh);
  const px = gx.getImageData(0, 0, gw, gh).data;
  const gray = new Float32Array(gw * gh);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
  const bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(cur) : cur;
  return { bitmap, w, h, gray, gw, gh, srcW: w0, srcH: h0, url: URL.createObjectURL(file) };
}

function runAlign(V, N) {
  const msg = { V: { gray: V.gray, gw: V.gw, gh: V.gh }, N: { gray: N.gray, gw: N.gw, gh: N.gh } };
  return new Promise((resolve) => {
    const fallback = () => resolve(align(V.gray, V.gw, V.gh, N.gray, N.gw, N.gh));
    let worker;
    try {
      worker = new Worker(new URL('./align-worker.js', import.meta.url), { type: 'module' });
    } catch {
      fallback();
      return;
    }
    worker.onmessage = (e) => { worker.terminate(); resolve(e.data); };
    worker.onerror = () => { worker.terminate(); fallback(); };
    worker.postMessage(msg);
  });
}

async function setPhoto(k, file) {
  const p = pair();
  const slot = $(`.slot[data-k="${k}"]`);
  slot.classList.add('loading');
  let photo;
  try {
    photo = await loadPhoto(file);
  } catch {
    p.msg = 'Dieses Foto kann der Browser nicht öffnen. Falls es ein HEIC-Foto ist: in der Kamera „JPEG“ einstellen oder das Foto als JPEG teilen.';
    p.warn = true;
    showPair();
    return;
  } finally {
    slot.classList.remove('loading');
  }
  if (p[k]) URL.revokeObjectURL(p[k].url);
  p[k] = photo;
  p.auto = null;
  p.warn = false;
  if (p.V && p.N) {
    await analyse(p);
  } else {
    p.msg = k === 'V' ? 'Jetzt das Nachher-Foto wählen.' : 'Jetzt das Vorher-Foto wählen.';
    showPair();
    draw();
  }
}

async function analyse(p) {
  p.busy = true;
  p.msg = 'Fotos werden ausgerichtet …';
  showPair();
  const res = await runAlign(p.V, p.N);
  p.busy = false;
  p.auto = { s: res.s, r: res.r, tx: res.tx, ty: res.ty };
  p.useAlign = res.matched;
  p.T = res.matched ? { ...p.auto } : null;
  const pct = Math.round(res.score * 100);
  p.msg = res.matched
    ? `Deckungsgleich ausgerichtet (Übereinstimmung ${pct} %). Unter „Ausrichten“ lässt es sich prüfen.`
    : `Die Fotos zeigen die Stelle aus unterschiedlichem Winkel (Übereinstimmung ${pct} %) – sie werden deshalb nicht überblendet.`;
  $('#result').hidden = false;
  showPair();
  invalidate();
}

// ---------- Paare ----------

function showPair() {
  const p = pair();
  const bar = $('#pairs');
  const chips = state.pairs.map((q, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === state.cur ? ' on' : '');
    b.textContent = q.label ? `${i + 1} · ${q.label}` : `Paar ${i + 1}`;
    b.addEventListener('click', () => selectPair(i));
    return b;
  });
  if (state.pairs.length < MAX_PAIRS) {
    const add = document.createElement('button');
    add.className = 'chip add';
    add.textContent = '+ Weiteres Paar';
    add.addEventListener('click', addPair);
    chips.push(add);
  }
  bar.replaceChildren(...chips);
  for (const k of ['V', 'N']) {
    const slot = $(`.slot[data-k="${k}"]`), img = slot.querySelector('img');
    if (p[k]) { img.src = p[k].url; slot.classList.add('filled'); } else { img.removeAttribute('src'); slot.classList.remove('filled'); }
  }
  $('#inV').value = '';
  $('#inN').value = '';
  $('#pairLabel').value = p.label;
  $('#btnRemovePair').hidden = state.pairs.length < 2;
  $('#useAlign').checked = p.useAlign;
  document.body.classList.toggle('busy', p.busy);
  status(p.msg || (state.pairs.length > 1
    ? `Paar ${state.cur + 1}: Vorher- und Nachher-Foto wählen.`
    : 'Zwei Fotos wählen – am besten vom selben Standpunkt aus fotografiert.'), p.warn);
}

function selectPair(i) {
  state.cur = i;
  state.reel = null;
  showPair();
  draw();
}

function addPair() {
  state.pairs.push(newPair());
  selectPair(state.pairs.length - 1);
  $('.photos').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#btnRemovePair').addEventListener('click', () => {
  const [gone] = state.pairs.splice(state.cur, 1);
  for (const k of ['V', 'N']) if (gone[k]) URL.revokeObjectURL(gone[k].url);
  state.cur = Math.max(0, state.cur - 1);
  showPair();
  invalidate();
});

$('#pairLabel').addEventListener('input', (e) => {
  pair().label = e.target.value;
  $$('#pairs .chip:not(.add)')[state.cur].textContent = e.target.value ? `${state.cur + 1} · ${e.target.value}` : `Paar ${state.cur + 1}`;
  invalidate();
});

// ---------- Anzeige ----------

function scene(p = pair()) {
  return { V: p.V, N: p.N, T: p.useAlign ? p.T : null };
}

function opts() {
  return {
    logo: state.logo,
    ring: state.ring,
    vehicle: $('#vehicle').value,
    service: $('#service').value.trim() || pair().label,
  };
}

function currentLayout(sc) {
  if (state.layout === 'diagonal' && !sc.T) return R.autoLayout(sc);
  return state.layout === 'auto' ? R.autoLayout(sc) : state.layout;
}

function status(text, warn = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('warn', warn);
}

function note(text) {
  $('#note').textContent = text || '';
}

function invalidate() {
  state.reel = null;
  state.carReady = null;
  draw();
  updateCaption();
}

function draw() {
  cancelAnimationFrame(state.loop);
  const tab = state.tab, p = pair(), car = tab === 'carousel';
  const has = car ? state.pairs.some(ready) : ready(p);
  $('#optPost').hidden = tab !== 'post' || !has;
  $('#optCheck').hidden = tab !== 'check' || !has;
  $('#optCar').hidden = !car || !has;
  cv.hidden = car || !has;
  $('#strip').hidden = !car || !has;
  $('#btnMake').hidden = tab !== 'reel' || !has || !!state.reel;
  $('#btnSave').hidden = !has || tab === 'check' || (tab === 'reel' && !state.reel);
  $('#btnShare').hidden = $('#btnSave').hidden || !canShareFiles();
  $('#btnSave').classList.toggle('wide', $('#btnShare').hidden);
  $('#btnShare').textContent = car ? 'Alle teilen' : 'Teilen';
  $('#btnSave').textContent = car ? 'Alle speichern' : 'Speichern';
  cv.classList.toggle('grab', tab === 'check' && !!scene().T);
  if (!has) {
    note(p.busy ? '' : car ? 'Erst ein Vorher/Nachher-Paar wählen.' : `Für Paar ${state.cur + 1} fehlen noch Fotos.`);
    return;
  }
  if (car) { drawCarousel(); return; }

  const sc = scene();
  if (tab === 'post') {
    size(R.POST.w, R.POST.h);
    const layout = currentLayout(sc);
    $$('#optPost [data-layout]').forEach((b) => {
      b.classList.toggle('on', b.dataset.layout === state.layout);
      b.disabled = b.dataset.layout === 'diagonal' && !sc.T;
    });
    R.renderPost(ctx, sc, { ...opts(), layout });
    const up = R.postUpscale(sc, layout);
    note(up > R.MAX_UPSCALE ? `Hinweis: Die Fotos sind für diesen Ausschnitt etwas klein (${up.toFixed(1)}-fach vergrößert). Mit den Original-Fotos aus der Galerie wird es schärfer.` : '');
  } else if (tab === 'reel' || tab === 'story') {
    size(R.REEL.w, R.REEL.h);
    const G = R.reelGeometry(sc);
    note(G.upscale > R.MAX_UPSCALE ? `Hinweis: Die Fotos werden ${G.upscale.toFixed(1)}-fach vergrößert. Mit den Original-Fotos wird es schärfer.` : '');
    if (tab === 'story') {
      R.renderReelFrame(ctx, sc, G, R.STORY_TIME, opts());
    } else {
      const t0 = performance.now();
      const o = opts();
      const tick = (now) => {
        R.renderReelFrame(ctx, sc, G, ((now - t0) / 1000) % R.REEL.dur, o);
        state.loop = requestAnimationFrame(tick);
      };
      state.loop = requestAnimationFrame(tick);
    }
  } else {
    const fh = p.V.h / p.V.w;
    size(1080, Math.round(1080 * fh));
    R.renderOverlay(ctx, sc, cv.width, cv.height, $('#alpha').value / 100);
    note(sc.T ? 'Nachher-Foto liegt halbdurchsichtig über dem Vorher-Foto. Mit einem Finger verschieben, mit zwei Fingern zoomen und drehen.' : 'Überblenden ist aus – die Fotos werden getrennt gezeigt.');
  }
}

function size(w, h) {
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  cv.style.aspectRatio = `${w} / ${h}`;
}

// ---------- Karussell ----------

// Reihenfolge: [Übersicht] · Paar 1 vorher · Paar 1 nachher · … · [Schlussbild]
function slides() {
  const pairs = state.pairs.filter(ready);
  const o = opts();
  const list = [];
  if (state.car.mode === 'swipe') {
    if (state.car.cover) {
      const sc = scene(pairs[0]);
      list.push((c) => R.renderPost(c, sc, { ...o, layout: R.autoLayout(sc) }));
    }
    pairs.forEach((p, i) => {
      const sc = scene(p), G = R.pairFrame(sc), po = { ...o, service: $('#service').value, label: p.label };
      list.push((c) => R.renderPairSlide(c, sc, G, 'V', { ...po, hint: i === 0 }));
      list.push((c) => R.renderPairSlide(c, sc, G, 'N', po));
    });
  } else {
    pairs.forEach((p) => {
      const sc = scene(p);
      list.push((c) => R.renderPost(c, sc, { ...o, layout: currentLayout(sc) }));
    });
  }
  if (state.end) list.push((c) => R.renderEndSlide(c, state.end, { ...o, service: $('#service').value }));
  return list.slice(0, MAX_SLIDES);
}

const work = { preview: canvas(R.POST.w, R.POST.h), file: canvas(R.POST.w, R.POST.h) };

function drawCarousel() {
  $$('#optCar [data-car]').forEach((b) => b.classList.toggle('on', b.dataset.car === state.car.mode));
  $('#carCover').checked = state.car.cover;
  $('#carCover').parentElement.hidden = state.car.mode !== 'swipe';
  const list = slides();
  const strip = $('#strip');
  const pctx = work.preview.getContext('2d');
  const old = [...strip.children];
  list.forEach((render, i) => {
    render(pctx);
    let c = old[i];
    if (!c) { c = canvas(720, 960); strip.append(c); }
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(work.preview, 0, 0, c.width, c.height);
  });
  old.slice(list.length).forEach((c) => c.remove());
  const n = list.length;
  note(`${n} Bilder in dieser Reihenfolge – in der Vorschau seitlich wischen.${state.pairs.filter(ready).length < 2 ? ' Mit „+ Weiteres Paar“ oben kommen mehr Stellen dazu.' : ''}`);
  if (!state.carReady) state.carReady = carouselFiles(list);
}

async function carouselFiles(list) {
  const token = (state.carToken = {});
  const fctx = work.file.getContext('2d');
  const files = [];
  for (let i = 0; i < list.length; i++) {
    list[i](fctx);
    const blob = await new Promise((r) => work.file.toBlob(r, 'image/jpeg', 0.93));
    if (state.carToken !== token) return state.carReady;
    files.push(new File([blob], `${fileName('karussell')}-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }));
  }
  return files;
}

$$('#optCar [data-car]').forEach((b) => b.addEventListener('click', () => {
  state.car.mode = b.dataset.car;
  store.set('carMode', state.car.mode);
  invalidate();
}));
$('#carCover').addEventListener('change', (e) => {
  state.car.cover = e.target.checked;
  store.set('carCover', state.car.cover ? '1' : '0');
  invalidate();
});
async function setEnd(file) {
  try {
    const photo = await loadPhoto(file);
    if (state.end) URL.revokeObjectURL(state.end.url);
    state.end = photo;
    $('#endPreview').src = photo.url;
  } catch {
    note('Dieses Foto kann der Browser nicht öffnen.');
  }
  $('#endPreview').hidden = !state.end;
  $('#btnEndRemove').hidden = !state.end;
  invalidate();
}
$('#inEnd').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) setEnd(file);
});
$('#btnEndRemove').addEventListener('click', () => {
  URL.revokeObjectURL(state.end.url);
  state.end = null;
  $('#endPreview').hidden = true;
  $('#btnEndRemove').hidden = true;
  invalidate();
});

// ---------- Von Hand nachjustieren ----------

const rot = (r, u, v) => [Math.cos(r) * u - Math.sin(r) * v, Math.sin(r) * u + Math.cos(r) * v];
function moveT(T, du, dv) {
  const [a, b] = rot(T.r, du, dv);
  return { ...T, tx: T.tx - T.s * a, ty: T.ty - T.s * b };
}
function zoomT(T, f, cu, cv2) {
  const [a, b] = rot(T.r, cu, cv2), k = T.s * (1 - 1 / f);
  return { ...T, s: T.s / f, tx: T.tx + k * a, ty: T.ty + k * b };
}
function turnT(T, phi, cu, cv2) {
  const [a1, b1] = rot(T.r, cu, cv2), [a2, b2] = rot(T.r - phi, cu, cv2);
  return { ...T, r: T.r - phi, tx: T.tx + T.s * (a1 - a2), ty: T.ty + T.s * (b1 - b2) };
}

// Bildschirmpunkt → normierte Koordinaten des Vorher-Fotos
function toNorm(e) {
  const b = cv.getBoundingClientRect();
  const x = ((e.clientX - b.left) / b.width) * cv.width, y = ((e.clientY - b.top) / b.height) * cv.height;
  return [x / cv.width - 0.5, (y - cv.height / 2) / cv.width];
}

const pointers = new Map();
cv.addEventListener('pointerdown', (e) => {
  if (state.tab !== 'check' || !pair().useAlign) return;
  cv.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, toNorm(e));
});
cv.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const p = pair();
  const prev = [...pointers.values()];
  const was = pointers.get(e.pointerId);
  const now = toNorm(e);
  pointers.set(e.pointerId, now);
  if (pointers.size === 1) {
    p.T = moveT(p.T, now[0] - was[0], now[1] - was[1]);
  } else {
    const cur = [...pointers.values()];
    const [a0, b0] = prev, [a1, b1] = cur;
    const c0 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2], c1 = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
    const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]), d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]);
    const w0 = Math.atan2(b0[1] - a0[1], b0[0] - a0[0]), w1 = Math.atan2(b1[1] - a1[1], b1[0] - a1[0]);
    let T = moveT(p.T, c1[0] - c0[0], c1[1] - c0[1]);
    if (d0 > 1e-4) T = zoomT(T, d1 / d0, c1[0], c1[1]);
    p.T = turnT(T, w1 - w0, c1[0], c1[1]);
  }
  state.reel = null;
  state.carReady = null;
  draw();
});
const release = (e) => pointers.delete(e.pointerId);
cv.addEventListener('pointerup', release);
cv.addEventListener('pointercancel', release);
cv.addEventListener('wheel', (e) => {
  if (state.tab !== 'check' || !pair().useAlign) return;
  e.preventDefault();
  const p = pair();
  const [u, v] = toNorm(e);
  p.T = e.shiftKey ? turnT(p.T, e.deltaY * 0.0006, u, v) : zoomT(p.T, Math.exp(-e.deltaY * 0.0012), u, v);
  state.reel = null;
  state.carReady = null;
  draw();
}, { passive: false });

// ---------- Ausgeben ----------

function canShareFiles() {
  try {
    return !!navigator.canShare && navigator.canShare({ files: [new File([new Blob()], 'x.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
}

function fileName(kind) {
  const base = ($('#vehicle').value.trim() || 'vorher-nachher').toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[c]))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${base}-${kind}`;
}

function stillBlob() {
  return new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.93));
}

async function currentFiles() {
  if (state.tab === 'carousel') return state.carReady || [];
  if (state.tab === 'reel') return [new File([state.reel], fileName('reel') + '.mp4', { type: 'video/mp4' })];
  draw();
  const blob = await stillBlob();
  return [new File([blob], fileName(state.tab === 'story' ? 'story' : 'beitrag') + '.jpg', { type: 'image/jpeg' })];
}

$('#btnShare').addEventListener('click', async () => {
  const files = await currentFiles();
  try {
    if (!navigator.canShare({ files })) throw new Error('multi');
    await navigator.share({ files });
  } catch (e) {
    if (e.name !== 'AbortError') {
      note('Teilen hat nicht geklappt – die Bilder werden stattdessen gespeichert. In Instagram dann „Mehrere auswählen“.');
      downloadAll(files);
    }
  }
});
$('#btnSave').addEventListener('click', async () => downloadAll(await currentFiles()));

async function downloadAll(files) {
  for (const file of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    if (files.length > 1) await new Promise((r) => setTimeout(r, 350)); // sonst verwirft der Browser Dateien
  }
}

export async function makeReel(onProgress = () => {}) {
  const mb = await import(MEDIABUNNY);
  const quality = new mb.Quality({ bitrate: 12e6 });
  const ok = await mb.canEncodeVideo('avc', { width: R.REEL.w, height: R.REEL.h, quality, frameRate: R.REEL.fps });
  if (!ok) throw new Error('avc');
  const c = canvas(R.REEL.w, R.REEL.h);
  const x = c.getContext('2d');
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
  const source = new mb.CanvasSource(c, { codec: 'avc', quality, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: R.REEL.fps });
  await output.start();
  const sc = scene(), G = R.reelGeometry(sc), o = opts();
  const n = Math.round(R.REEL.dur * R.REEL.fps);
  for (let i = 0; i < n; i++) {
    const t = i / R.REEL.fps;
    R.renderReelFrame(x, sc, G, t, o);
    await source.add(t, 1 / R.REEL.fps);
    onProgress((i + 1) / n);
  }
  await output.finalize();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

$('#btnMake').addEventListener('click', async () => {
  const btn = $('#btnMake'), bar = $('#progress');
  btn.disabled = true;
  bar.hidden = false;
  try {
    state.reel = await makeReel((f) => { bar.firstElementChild.style.width = `${Math.round(f * 100)}%`; });
    note('Reel ist fertig (MP4, 1080 × 1920, 7,5 s). Musik kommt in Instagram dazu.');
  } catch (e) {
    console.error(e);
    note('Dieser Browser kann kein MP4 erzeugen. Bitte ein aktuelles Chrome (Android) oder Safari (iPhone) nehmen.');
  } finally {
    btn.disabled = false;
    bar.hidden = true;
    bar.firstElementChild.style.width = '0';
    const msg = $('#note').textContent;
    draw();
    note(msg);
  }
});

// ---------- Beitragstext ----------

const HOOKS = [
  'Vorher. Nachher. Mehr muss man dazu nicht sagen.',
  'Perfektion bis ins kleinste Detail.',
  'Genau da, wo sonst keiner hinschaut.',
  'Der Unterschied liegt im Detail.',
  'So sieht es aus, wenn man sich Zeit nimmt.',
];

const BRANDS = {
  mercedes: ['mercedes', 'mercedesbenz'], benz: [], bmw: ['bmw'], audi: ['audi'], vw: ['vw', 'volkswagen'],
  volkswagen: ['vw', 'volkswagen'], porsche: ['porsche'], opel: ['opel'], ford: ['ford'], skoda: ['skoda'],
  seat: ['seat'], cupra: ['cupra'], toyota: ['toyota'], tesla: ['tesla'], hyundai: ['hyundai'], kia: ['kia'],
  mini: ['mini'], volvo: ['volvo'], mazda: ['mazda'], fiat: ['fiat'], renault: ['renault'], peugeot: ['peugeot'],
  landrover: ['landrover'], range: ['rangerover'], jaguar: ['jaguar'], lexus: ['lexus'], nissan: ['nissan'],
};

const SERVICES = [
  [/innen|fußraum|sitz|polster/i, ['innenraumaufbereitung', 'innenraumreinigung']],
  [/polit|lack/i, ['lackpolitur', 'polieren']],
  [/keramik|ceramic/i, ['keramikversiegelung']],
  [/leder/i, ['lederpflege']],
  [/felge/i, ['felgenreinigung']],
  [/motor/i, ['motorwäsche']],
  [/wäsche|wasch/i, ['handwäsche']],
  [/scheinwerfer/i, ['scheinwerferaufbereitung']],
];

function areas() {
  return state.pairs.filter(ready).map((p) => p.label.trim()).filter(Boolean);
}

function hashtags(vehicle, service) {
  const tags = ['blackmagicdetailer', 'detailing', 'cardetailing', 'autoaufbereitung', 'fahrzeugaufbereitung', 'vorhernachher', 'beforeandafter'];
  const words = vehicle.toLowerCase().replace(/[^a-z0-9äöü]+/g, ' ').trim().split(' ').filter(Boolean);
  words.forEach((w, i) => {
    if (BRANDS[w]) tags.push(...BRANDS[w]);
    if (/\d/.test(w) && w.length >= 2) {
      const next = words[i + 1];
      tags.push(next && next.length === 1 && /[a-z]/.test(next) ? w + next : w);
    }
  });
  SERVICES.forEach(([re, t]) => { if (re.test(service)) tags.push(...t); });
  // „Mannheim | Rhein-Neckar“ → #mannheim #rheinneckar
  store.get('place', 'Mannheim | Rhein-Neckar').toLowerCase().split(/[|,/]+/)
    .map((w) => w.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 2).forEach((w) => tags.push(w));
  store.get('tags', '').split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean).forEach((t) => tags.push(t));
  return [...new Set(tags)].slice(0, 20).map((t) => '#' + t);
}

function updateCaption() {
  const vehicle = $('#vehicle').value.trim();
  const service = $('#service').value.trim() || areas().join(', ');
  const place = store.get('place', 'Mannheim | Rhein-Neckar');
  const lines = [HOOKS[state.hook % HOOKS.length], ''];
  if (vehicle || service) lines.push([vehicle, service].filter(Boolean).join(' – '), '');
  lines.push(`📍 ${place}`, 'Termin per DM', '', hashtags(vehicle, service).join(' '));
  $('#caption').value = lines.join('\n');
}

function aiPrompt() {
  const vehicle = $('#vehicle').value.trim() || '[Fahrzeug]';
  const service = $('#service').value.trim() || areas().join(', ') || '[Leistung]';
  const place = store.get('place', 'Mannheim | Rhein-Neckar');
  return `Du schreibst Instagram-Texte für „Black Magic Detailer“ (Tim Rupprecht, Premium-Fahrzeugaufbereitung, ${place}).
Schreib zu meinem Vorher/Nachher-Beitrag einen kurzen Text auf Deutsch:
– Fahrzeug: ${vehicle}
– Gemacht: ${service}
Aufbau: eine starke erste Zeile, dann 2–3 kurze Sätze, was gemacht wurde und warum es sich lohnt. Sachlich und selbstbewusst, keine Übertreibungen wie „atemberaubend“, höchstens zwei Emojis. Schluss: „📍 ${place}“ und „Termin per DM“. Danach 12–15 passende Hashtags (Detailing, Fahrzeug, Region).`;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = $('#caption');
    t.value = text; t.select(); document.execCommand('copy');
  }
  const old = btn.textContent;
  btn.textContent = 'Kopiert ✓';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

$('#btnCopy').addEventListener('click', (e) => copy($('#caption').value, e.currentTarget));
$('#btnVariant').addEventListener('click', () => { state.hook++; updateCaption(); });
$('#btnPrompt').addEventListener('click', (e) => copy(aiPrompt(), e.currentTarget));

// ---------- Bedienelemente ----------

$('#inV').addEventListener('change', (e) => e.target.files[0] && setPhoto('V', e.target.files[0]));
$('#inN').addEventListener('change', (e) => e.target.files[0] && setPhoto('N', e.target.files[0]));

$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab;
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  draw();
}));

$$('#optPost [data-layout]').forEach((b) => b.addEventListener('click', () => {
  state.layout = b.dataset.layout;
  state.carReady = null;
  draw();
}));

$('#useAlign').addEventListener('change', (e) => {
  const p = pair();
  p.useAlign = e.target.checked;
  if (p.useAlign && !p.T) p.T = { ...p.auto };
  invalidate();
});
$('#alpha').addEventListener('input', draw);
$('#btnAuto').addEventListener('click', () => {
  const p = pair();
  p.T = { ...p.auto };
  p.useAlign = true;
  $('#useAlign').checked = true;
  invalidate();
});

['#vehicle', '#service'].forEach((s) => $(s).addEventListener('input', () => {
  state.reel = null;
  state.carReady = null;
  if (state.tab !== 'reel') draw(); else $('#btnMake').hidden = false;
  updateCaption();
}));

$('#place').value = store.get('place', 'Mannheim | Rhein-Neckar');
$('#tags').value = store.get('tags', '');
$('#ring').checked = state.ring;
$('#place').addEventListener('input', (e) => { store.set('place', e.target.value); updateCaption(); });
$('#tags').addEventListener('input', (e) => { store.set('tags', e.target.value); updateCaption(); });
$('#ring').addEventListener('change', (e) => { state.ring = e.target.checked; store.set('ring', state.ring ? '1' : '0'); invalidate(); });

async function useLogo(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  state.logo = img;
  $('#logoPreview').src = src;
  $('#logoPreview').hidden = false;
}

$('#inLogo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const bmp = await decode(file);
  const f = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
  const c = canvas(Math.round(bmp.width * f), Math.round(bmp.height * f));
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/png');
  store.set('logo', url);
  await useLogo(url);
  invalidate();
});

// ---------- Start ----------

showPair();
(async () => {
  const saved = store.get('logo', '');
  if (saved) await useLogo(saved).catch(() => {});
  try {
    await Promise.race([document.fonts.load(`30px ${R.FONT}`), new Promise((r) => setTimeout(r, 2500))]);
  } catch { /* Ersatzschrift */ }
  updateCaption();
})();

// für automatische Tests
window.bmd = {
  setPhoto, addPair, selectPair, state, makeReel, stillBlob, draw,
  setTab: (t) => $(`.tabs [data-tab="${t}"]`).click(),
  setEnd,
  carousel: () => state.carReady,
};
