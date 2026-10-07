// Optimize tab: load every .glb/.gltf/.fbx in a folder, shrink textures and simplify meshes, write the results as .glb.
// Everything runs in the browser; the server only lists/reads the folder and writes the output files.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'https://cdn.jsdelivr.net/npm/meshoptimizer@0.22.0/+esm';
import { exportGlb, originalImage, parseGlb } from './glb.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(2)} MB`);
const pct = (after, before) => (before ? `${after <= before ? '−' : '+'}${Math.abs(Math.round((1 - after / before) * 100))}%` : '');
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

const S = {
  token: null,
  dir: '',
  files: [], // { path, size, backup, checked, info, result }
  selected: -1,
  busy: false,
  previewSeq: 0,
  view: null,
};

const loader = new GLTFLoader()
  .setDRACOLoader(new DRACOLoader().setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/'))
  .setMeshoptDecoder(MeshoptDecoder);

const isFbx = (f) => /\.fbx$/i.test(f.path);

// Always read from the backup when there is one, so re-running never optimizes an already-optimized file.
const inputPath = (f) => (f.backup ? `${S.backupDir}/${f.path}` : f.path);
const localUrl = (rel) => `/local/${S.token}/` + rel.split('/').map(encodeURIComponent).join('/');

// ---------- Settings ----------

const SETTING_IDS = ['o-tex-size', 'o-tex-format', 'o-quality', 'o-simplify', 'o-error', 'o-lock-border', 'o-fbx-scale', 'o-recursive'];

function readConfig() {
  return {
    texSize: Number($('o-tex-size').value),
    texFormat: $('o-tex-format').value,
    quality: Number($('o-quality').value) / 100,
    simplify: Number($('o-simplify').value) / 100,
    error: Number($('o-error').value) / 100,
    lockBorder: $('o-lock-border').checked,
    fbxScale: $('o-fbx-scale').value,
    mode: document.querySelector('input[name="o-mode"]:checked').value,
  };
}

function showSettingValues() {
  $('o-quality-val').textContent = $('o-tex-format').value === 'png' ? '(lossless)' : `${$('o-quality').value}%`;
  $('o-quality').disabled = $('o-tex-format').value === 'png';
  $('o-simplify-val').textContent = $('o-simplify').value === '100' ? '100% (off)' : `${$('o-simplify').value}%`;
  $('o-error-val').textContent = `${$('o-error').value}%`;
  $('o-error').disabled = $('o-simplify').value === '100';
}

function saveSettings() {
  const s = {};
  for (const id of SETTING_IDS) s[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value;
  s.mode = readConfig().mode;
  store.set('optimizeSettings', s);
}

function restoreSettings() {
  const s = store.get('optimizeSettings', {});
  for (const id of SETTING_IDS) {
    if (!(id in s)) continue;
    if ($(id).type === 'checkbox') $(id).checked = !!s[id];
    else $(id).value = s[id];
  }
  const mode = document.querySelector(`input[name="o-mode"][value="${s.mode}"]`);
  if (mode) mode.checked = true;
  showSettingValues();
}

// ---------- Mesh simplification ----------

// Copy only the vertices the index still uses (the exporter writes every vertex in the buffers).
function compact(geometry) {
  const idx = geometry.index.array;
  const count = geometry.attributes.position.count;
  const remap = new Int32Array(count).fill(-1);
  let n = 0;
  const newIdx = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (remap[v] < 0) remap[v] = n++;
    newIdx[i] = remap[v];
  }
  const copyAttr = (a) => {
    const size = a.itemSize;
    const src = a.isInterleavedBufferAttribute ? a.data.array : a.array;
    const stride = a.isInterleavedBufferAttribute ? a.data.stride : size;
    const offset = a.isInterleavedBufferAttribute ? a.offset : 0;
    const out = new src.constructor(n * size);
    for (let v = 0; v < count; v++) {
      const r = remap[v];
      if (r < 0) continue;
      for (let k = 0; k < size; k++) out[r * size + k] = src[v * stride + offset + k];
    }
    return new THREE.BufferAttribute(out, size, a.normalized);
  };
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geometry.attributes)) g.setAttribute(name, copyAttr(a));
  g.setIndex(new THREE.BufferAttribute(n < 65536 ? new Uint16Array(newIdx) : newIdx, 1));
  g.name = geometry.name;
  g.userData = geometry.userData;
  return g;
}

function simplifyGeometry(geometry, cfg, notes) {
  if (geometry.groups.length > 1) {
    notes.add('A multi-material mesh was left unsimplified.');
    return geometry;
  }
  if (Object.keys(geometry.morphAttributes).length) {
    notes.add('A mesh with morph targets (blend shapes) was left unsimplified.');
    return geometry;
  }
  const g = geometry.index ? geometry : mergeVertices(geometry);
  const pos = g.attributes.position;
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    positions[i * 3] = pos.getX(i);
    positions[i * 3 + 1] = pos.getY(i);
    positions[i * 3 + 2] = pos.getZ(i);
  }
  const indices = Uint32Array.from(g.index.array);
  const target = Math.max(3, Math.floor((indices.length * cfg.simplify) / 3) * 3);
  const [out] = MeshoptSimplifier.simplify(indices, positions, 3, target, cfg.error, cfg.lockBorder ? ['LockBorder'] : []);
  if (out.length >= indices.length) return geometry;
  const simplified = g.clone();
  simplified.setIndex(new THREE.BufferAttribute(out, 1));
  return compact(simplified);
}

// ---------- Textures ----------

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

// Halve repeatedly before the final resize: a single big drawImage step aliases badly.
// flip: FBX textures use flipY (glTF's don't), so their pixels are written upside down to match glTF UVs.
function resizeImage(img, w, h, flip) {
  let src = img;
  let sw = img.width;
  let sh = img.height;
  while (sw / 2 >= w && sh / 2 >= h) {
    const c = makeCanvas(Math.round(sw / 2), Math.round(sh / 2));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    src = c;
    sw = c.width;
    sh = c.height;
  }
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  if (flip) {
    ctx.translate(0, h);
    ctx.scale(1, -1);
  }
  ctx.drawImage(src, 0, 0, w, h);
  return out;
}

function hasTransparency(canvas) {
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

async function encode(canvas, type, quality) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type, quality }) : await new Promise((r) => canvas.toBlob(r, type, quality));
  if (!blob || blob.type !== type) throw new Error(`This browser can't encode ${type}`);
  return new Uint8Array(await blob.arrayBuffer());
}

async function processTexture(tex, source, cfg, notes) {
  const img = tex.image;
  if (!img?.width) return null;
  // Raw pixel data (e.g. TGA): leave it to the exporter, which writes it as PNG at full size.
  if (img.data) {
    notes.add('TGA textures were converted to PNG but not resized.');
    return null;
  }
  const orig = await originalImage(source, tex);
  const max = cfg.texSize || Infinity;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const resized = w !== img.width || h !== img.height;

  const guessed = /\.jpe?g(\?|#|$)/i.test(img.src || '') ? 'image/jpeg' : 'image/png';
  let type = cfg.texFormat === 'keep' ? orig?.mimeType || guessed : `image/${cfg.texFormat}`;
  if (!resized && orig && orig.mimeType === type) return orig;

  const canvas = resizeImage(img, w, h, tex.flipY);
  if (type === 'image/jpeg' && hasTransparency(canvas)) {
    type = 'image/png';
    notes.add('Textures with transparency were kept as PNG (JPEG has no alpha).');
  }
  const bytes = await encode(canvas, type, cfg.quality);
  // Re-encoding at the same size can come out bigger (e.g. an already well-compressed PNG); keep the original then.
  if (!resized && orig && bytes.length >= orig.bytes.length) return orig;
  return { bytes, mimeType: type };
}

// ---------- Pipeline ----------

function disposeScene(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat().filter(Boolean)) {
      for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

// FBXLoader makes Phong/Lambert materials; glTF only has PBR, and the exporter would write them half-metallic.
function toStandard(m) {
  if (!m.isMeshPhongMaterial && !m.isMeshLambertMaterial) return m;
  const keys = ['name', 'color', 'map', 'normalMap', 'normalScale', 'emissive', 'emissiveMap', 'emissiveIntensity', 'aoMap', 'alphaMap', 'transparent', 'opacity', 'alphaTest', 'side', 'vertexColors', 'flatShading'];
  // FBX shininess is rarely meaningful (exporters write a default), so use a matte look.
  const s = new THREE.MeshStandardMaterial({ metalness: 0, roughness: m.isMeshPhongMaterial ? 0.8 : 1 });
  for (const k of keys) if (m[k] !== undefined) s[k] = m[k]?.isColor || m[k]?.isVector2 ? m[k].clone() : m[k];
  m.dispose();
  return s;
}

// glTF uses metres; plain FBX exports are usually centimetres. "auto" guesses from the size.
function fbxScale(root, setting, notes) {
  if (setting !== 'auto') return Number(setting) || 1;
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  if (Math.max(size.x, size.y, size.z) <= 50) return 1;
  notes?.add('FBX scaled ×0.01 because it looked like centimetres (change under FBX → Scale).');
  return 0.01;
}

// → { scene, animations, source } for .glb/.gltf/.fbx alike. FBX content goes under a wrapper group so
// exporting scene.children keeps the FBX root (and the unit scale applied to it).
async function loadModel(file, cfg, notes) {
  const url = localUrl(inputPath(file));
  if (!isFbx(file)) {
    const gltf = await loader.loadAsync(url);
    return { scene: gltf.scene, animations: gltf.animations, source: { parser: gltf.parser, url: new URL(url, location.href).href } };
  }
  // FBXLoader returns before its textures have loaded; the manager's onLoad fires once they all have (or failed).
  const manager = new THREE.LoadingManager();
  const settled = new Promise((resolve) => (manager.onLoad = resolve));
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  const root = await new FBXLoader(manager).loadAsync(url);
  await settled;
  root.traverse((o) => {
    for (const m of [o.material].flat().filter(Boolean)) {
      for (const [k, v] of Object.entries(m)) {
        if (!v?.isTexture || v.image?.width) continue;
        m[k] = null;
        notes?.add(`Skipped a texture that couldn't be found (${v.name || k}).`);
      }
    }
  });
  const converted = new Map();
  const convert = (m) => converted.get(m) || converted.set(m, toStandard(m)).get(m);
  root.traverse((o) => {
    if (o.material) o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
  });
  root.scale.multiplyScalar(fbxScale(root, cfg.fbxScale, notes));
  const scene = new THREE.Group();
  scene.add(root);
  return { scene, animations: root.animations || [], source: null };
}

async function optimizeFile(file, cfg) {
  const notes = new Set();
  const gltf = await loadModel(file, cfg, notes);
  const source = gltf.source;
  try {
    if (cfg.simplify < 1) {
      await MeshoptSimplifier.ready;
      const done = new Map();
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        if (!done.has(o.geometry)) done.set(o.geometry, simplifyGeometry(o.geometry, cfg, notes));
        o.geometry = done.get(o.geometry);
      });
    }

    const images = new Map();
    const textures = new Set();
    gltf.scene.traverse((o) => {
      for (const m of [o.material].flat().filter(Boolean)) for (const v of Object.values(m)) if (v?.isTexture) textures.add(v);
    });
    for (const tex of textures) {
      const img = await processTexture(tex, source, cfg, notes);
      if (img) images.set(tex, img);
    }
    if (cfg.texFormat === 'webp' && images.size) notes.add('WebP textures need EXT_texture_webp support in your engine (three.js, Babylon, Godot 4: yes).');

    const glb = await exportGlb(gltf.scene.children, images, { animations: gltf.animations });
    return { glb, notes: [...notes] };
  } finally {
    disposeScene(gltf.scene);
  }
}

// ---------- File info (read from the GLB without loading it) ----------

function imageSize(bytes, mime) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length > 24) return [dv.getUint32(16), dv.getUint32(20)];
  if (mime === 'image/jpeg') {
    for (let i = 2; i + 9 < bytes.length; ) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [dv.getUint16(i + 7), dv.getUint16(i + 5)];
      i += 2 + dv.getUint16(i + 2);
    }
  }
  if (mime === 'image/webp' && bytes.length > 30) {
    const fourcc = String.fromCharCode(...bytes.subarray(12, 16));
    if (fourcc === 'VP8 ') return [dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff];
    if (fourcc === 'VP8L') {
      const b = dv.getUint32(21, true);
      return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1];
    }
    if (fourcc === 'VP8X') return [1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))];
  }
  return null;
}

function glbInfo(glb) {
  const { json, bin } = parseGlb(glb);
  let tris = 0;
  for (const m of json.meshes || []) {
    for (const p of m.primitives) {
      if (p.mode !== undefined && p.mode !== 4) continue;
      const a = p.indices != null ? json.accessors[p.indices] : json.accessors[p.attributes.POSITION];
      tris += a.count / 3;
    }
  }
  const textures = (json.images || []).map((img) => {
    const bv = json.bufferViews?.[img.bufferView];
    if (!bv) return { mime: img.mimeType || '', bytes: 0, size: null };
    const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    return { mime: img.mimeType || '', bytes: bv.byteLength, size: imageSize(bytes, img.mimeType) };
  });
  return { tris: Math.round(tris), textures, bytes: glb.length };
}

// FBX has no cheap header to read, so load it and count from the scene.
async function fbxInfo(file) {
  const { scene } = await loadModel(file, readConfig());
  try {
    let tris = 0;
    const textures = new Set();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      for (const m of [o.material].flat().filter(Boolean)) for (const v of Object.values(m)) if (v?.isTexture) textures.add(v);
    });
    // Embedded textures have blob: URLs, so fall back to the texture's name; '' when neither says.
    const ext = (t) => {
      const m = [t.image?.src, t.name].map((s) => /\.(png|jpe?g|tga|webp)$/i.exec((s || '').split(/[?#]/)[0])).find(Boolean);
      return m ? m[1].toLowerCase().replace('jpg', 'jpeg') : '';
    };
    return {
      tris: Math.round(tris),
      textures: [...textures].map((t) => ({ mime: ext(t), bytes: 0, size: t.image?.width ? [t.image.width, t.image.height] : null })),
      bytes: file.size,
    };
  } finally {
    disposeScene(scene);
  }
}

async function fetchInfo(file) {
  if (isFbx(file)) return fbxInfo(file);
  const res = await fetch(localUrl(inputPath(file)));
  if (!res.ok) throw new Error(`Couldn't read file (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (/\.glb$/i.test(file.path)) return glbInfo(buf);
  // .gltf: count from JSON; textures are separate files.
  const json = JSON.parse(new TextDecoder().decode(buf));
  let tris = 0;
  for (const m of json.meshes || []) for (const p of m.primitives) tris += json.accessors[p.indices ?? p.attributes.POSITION].count / 3;
  return { tris: Math.round(tris), textures: (json.images || []).map((i) => ({ mime: i.mimeType || i.uri?.split('.').pop() || '', bytes: 0, size: null })), bytes: buf.length };
}

const texLabel = (t) => `${t.size ? t.size.join('×') : '?'} ${t.mime.replace('image/', '')}${t.bytes ? ` ${formatSize(t.bytes)}` : ''}`;
const texSummary = (textures) => (textures.length ? textures.map(texLabel).join(', ') : 'none');

// ---------- Folder & table ----------

function setStatus(text, kind = '') {
  $('o-status').textContent = text;
  $('o-status').className = 'x-status ' + kind;
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function applyRecent(data) {
  if (!data) return;
  if (data.optimizeDir && !$('o-dir').value.trim()) $('o-dir').value = data.optimizeDir;
  $('o-recent').replaceChildren(...(data.recentOptimizeDirs || []).map((d) => Object.assign(el('option'), { value: d })));
}

async function browse() {
  $('o-browse').disabled = true;
  try {
    const data = await postJson('/api/pick-folder', { start: $('o-dir').value.trim(), purpose: 'optimize' });
    if (data.cancelled) return;
    $('o-dir').value = data.dest;
    applyRecent(data);
    await loadFolder();
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    $('o-browse').disabled = false;
  }
}

async function loadFolder() {
  const dir = $('o-dir').value.trim();
  if (!dir) return browse();
  setStatus('Loading…');
  try {
    const data = await postJson('/api/folder/open', { dir, recursive: $('o-recursive').checked });
    Object.assign(S, { token: data.token, dir: data.dir, backupDir: data.backupDir, outputDir: data.outputDir, selected: -1 });
    S.files = data.files.map((f) => ({ ...f, checked: true, info: null, result: null }));
    $('o-dir').value = data.dir;
    applyRecent(data);
    setStatus(S.files.length ? '' : 'No .glb, .gltf or .fbx files in this folder.');
    renderTable();
    clearPreview();
    for (const f of S.files) {
      try {
        f.info = await fetchInfo(f);
      } catch (err) {
        f.info = { error: err.message };
      }
      renderRow(f);
    }
    renderSummary();
    if (S.files.length && S.selected < 0) select(0);
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

function renderTable() {
  $('o-rows').replaceChildren(...S.files.map((f, i) => Object.assign(el('tr'), { id: `o-row-${i}` })));
  S.files.forEach(renderRow);
  renderSummary();
}

function renderRow(f) {
  const i = S.files.indexOf(f);
  const tr = $(`o-row-${i}`);
  if (!tr) return;
  tr.className = i === S.selected ? 'selected' : '';
  const box = el('input');
  box.type = 'checkbox';
  box.checked = f.checked;
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => {
    f.checked = box.checked;
    renderSummary();
  });
  const cells = [el('td'), el('td', 'file', f.path), el('td', 'num', formatSize(f.size)), el('td', 'num'), el('td', 'tex'), el('td', 'num')];
  cells[0].append(box);
  if (f.backup) cells[1].append(el('div', 'tex', 'optimized in place — reading the backup'));
  if (isFbx(f)) cells[1].append(el('div', 'tex', 'FBX → .glb'));
  if (f.info?.error) cells[4].append(el('span', 'err', f.info.error));
  else if (f.info) {
    cells[3].textContent = f.info.tris.toLocaleString();
    cells[4].textContent = texSummary(f.info.textures);
  } else cells[3].textContent = '…';
  if (f.result?.error) cells[5].append(el('span', 'err', f.result.error));
  else if (f.result) {
    cells[5].append(el('div', null, formatSize(f.result.size)), el('div', 'saved', pct(f.result.size, f.size)));
  }
  tr.replaceChildren(...cells);
  tr.onclick = () => select(i);
}

function renderSummary() {
  const checked = S.files.filter((f) => f.checked);
  const total = checked.reduce((n, f) => n + f.size, 0);
  const done = checked.filter((f) => f.result && !f.result.error);
  let text = S.files.length ? `${checked.length} of ${S.files.length} files · ${formatSize(total)}` : 'Choose a folder and click “Load models”.';
  if (done.length) {
    const before = done.reduce((n, f) => n + f.size, 0);
    const after = done.reduce((n, f) => n + f.result.size, 0);
    text += ` · optimized ${done.length}: ${formatSize(before)} → ${formatSize(after)} (${pct(after, before)})`;
  }
  $('o-summary').textContent = text;
  $('o-check-all').checked = S.files.length > 0 && checked.length === S.files.length;
  $('o-run').disabled = S.busy || !checked.length;
  $('o-run').textContent = S.busy ? 'Optimizing…' : `Optimize ${checked.length || ''} file${checked.length === 1 ? '' : 's'}`.replace('  ', ' ');
}

async function runAll() {
  if (S.busy) return;
  const cfg = readConfig();
  const files = S.files.filter((f) => f.checked);
  if (cfg.mode === 'replace' && !confirm(`Replace ${files.length} file(s) in\n${S.dir}\n\nwith optimized versions? Originals are backed up to ${S.backupDir}/ the first time.`)) return;
  S.busy = true;
  renderSummary();
  const notes = new Set();
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setStatus(`Optimizing ${i + 1} of ${files.length}: ${f.path}…`);
    try {
      const { glb, notes: n } = await optimizeFile(f, cfg);
      n.forEach((x) => notes.add(x));
      const q = `token=${S.token}&path=${encodeURIComponent(f.path)}&mode=${cfg.mode}`;
      const res = await fetch(`/api/folder/write?${q}`, { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: glb });
      const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
      if (!res.ok) throw new Error(data.error || res.statusText);
      f.result = { size: data.size, out: data.out };
      if (data.backup) f.backup = true;
    } catch (err) {
      console.error(err);
      f.result = { error: err.message || String(err) };
      failed++;
    }
    renderRow(f);
    renderSummary();
  }
  S.busy = false;
  renderSummary();
  const where = cfg.mode === 'replace' ? `in place (originals in ${S.backupDir}/)` : `to ${S.outputDir}/`;
  if (cfg.mode === 'replace' && files.some((f) => !/\.glb$/i.test(f.path))) notes.add(`.gltf/.fbx files can't be replaced by a .glb, so they were saved to ${S.outputDir}/.`);
  setStatus(`${failed ? `⚠ ${failed} failed. ` : '✓ '}Saved ${files.length - failed} file${files.length - failed === 1 ? '' : 's'} ${where}` + (notes.size ? `\n${[...notes].map((n) => 'ℹ ' + n).join('\n')}` : ''), failed ? 'err' : 'ok');
}

// ---------- Preview ----------

function initView() {
  if (S.view) return S.view;
  const stage = $('o-stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  stage.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const grid = new THREE.GridHelper(1, 10, 0x888888, 0x888888);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(stage);
  resize();
  S.view = { renderer, scene, camera, controls, grid, orig: null, opt: null, showing: 'opt', active: false };
  renderer.setAnimationLoop(() => {
    if (!S.view.active) return;
    controls.update();
    renderer.render(scene, camera);
  });
  return S.view;
}

function setPreviewObject(kind, gltf) {
  const v = initView();
  if (v[kind]) {
    v.scene.remove(v[kind].scene);
    disposeScene(v[kind].scene);
  }
  v[kind] = gltf;
  if (gltf) v.scene.add(gltf.scene);
  applyPreviewVisibility();
}

function applyPreviewVisibility() {
  const v = S.view;
  if (!v) return;
  for (const kind of ['orig', 'opt']) if (v[kind]) v[kind].scene.visible = v.showing === kind || (kind === 'orig' && !v.opt);
  const wire = $('o-wire').checked;
  for (const kind of ['orig', 'opt']) {
    v[kind]?.scene.traverse((o) => {
      for (const m of [o.material].flat().filter(Boolean)) m.wireframe = wire;
    });
  }
  $('o-show-orig').classList.toggle('active', v.showing === 'orig');
  $('o-show-opt').classList.toggle('active', v.showing === 'opt');
}

function frame(gltf) {
  const v = S.view;
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1e-3);
  const dist = (radius / Math.sin(THREE.MathUtils.degToRad(v.camera.fov) / 2)) * 1.05;
  v.camera.position.copy(center).add(new THREE.Vector3(1, 0.75, 1.15).normalize().multiplyScalar(dist));
  v.camera.near = dist / 100;
  v.camera.far = dist * 100;
  v.camera.updateProjectionMatrix();
  v.controls.target.copy(center);
  v.controls.update();
  const maxDim = Math.max(size.x, size.z, 1e-3);
  const step = 10 ** Math.floor(Math.log10(maxDim));
  v.grid.scale.setScalar(Math.ceil((maxDim * 2) / step) * step);
  v.grid.position.set(center.x, box.min.y, center.z);
}

function clearPreview() {
  setPreviewObject('orig', null);
  setPreviewObject('opt', null);
  $('o-name').textContent = 'Preview';
  $('o-meta').textContent = 'Select a file to compare original and optimized.';
  $('o-compare').replaceChildren();
  $('o-notes').replaceChildren();
}

async function select(i) {
  const prev = S.files[S.selected];
  S.selected = i;
  if (prev) renderRow(prev);
  const f = S.files[i];
  renderRow(f);
  $(`o-row-${i}`)?.scrollIntoView({ block: 'nearest' });
  $('o-name').textContent = f.path.split('/').pop();
  $('o-meta').textContent = f.path.includes('/') ? f.path : formatSize(f.size);
  const seq = ++S.previewSeq;
  $('o-stage-status').textContent = 'Loading…';
  try {
    const gltf = await loadModel(f, readConfig());
    if (seq !== S.previewSeq) return disposeScene(gltf.scene);
    setPreviewObject('opt', null);
    setPreviewObject('orig', gltf);
    frame(gltf);
    await updatePreview();
  } catch (err) {
    if (seq === S.previewSeq) $('o-stage-status').textContent = `Couldn't load: ${err.message}`;
  }
}

let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 350);
}

// Run the real pipeline on the selected file and show the result loaded back from the bytes we'd write.
async function updatePreview() {
  const f = S.files[S.selected];
  if (!f || !S.view?.orig) return;
  const seq = ++S.previewSeq;
  $('o-stage-status').textContent = 'Optimizing…';
  try {
    const cfg = readConfig();
    const { glb, notes } = await optimizeFile(f, cfg);
    if (seq !== S.previewSeq) return;
    const gltf = await loader.parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
    if (seq !== S.previewSeq) return disposeScene(gltf.scene);
    setPreviewObject('opt', gltf);
    const before = f.info && !f.info.error ? f.info : null;
    const after = glbInfo(glb);
    renderCompare(f, before, after);
    $('o-notes').replaceChildren(...notes.map((n) => el('div', null, 'ℹ ' + n)));
    $('o-stage-status').textContent = '';
  } catch (err) {
    console.error(err);
    if (seq === S.previewSeq) $('o-stage-status').textContent = `Couldn't optimize: ${err.message || err}`;
  }
}

function renderCompare(f, before, after) {
  const row = (label, a, b, better) => {
    const tr = el('tr');
    tr.append(el('td', null, label), el('td', 'num', a), el('td', 'num' + (better ? ' better' : ''), b));
    return tr;
  };
  const rows = [row('File size', formatSize(f.size), `${formatSize(after.bytes)} (${pct(after.bytes, f.size)})`, after.bytes < f.size)];
  if (before) {
    rows.push(row('Triangles', before.tris.toLocaleString(), after.tris.toLocaleString(), after.tris < before.tris));
    const n = Math.max(before.textures.length, after.textures.length);
    for (let i = 0; i < n; i++) {
      const a = before.textures[i];
      const b = after.textures[i];
      rows.push(row(n > 1 ? `Texture ${i + 1}` : 'Texture', a ? texLabel(a) : '—', b ? texLabel(b) : '—', a && b && b.bytes < a.bytes));
    }
  }
  $('o-compare').replaceChildren(...rows);
}

// ---------- Tabs ----------

function setTab(tab) {
  const optimize = tab === 'optimize';
  document.querySelector('.app').classList.toggle('mode-optimize', optimize);
  $('tab-library').classList.toggle('active', !optimize);
  $('tab-optimize').classList.toggle('active', optimize);
  $('tab-library').setAttribute('aria-selected', String(!optimize));
  $('tab-optimize').setAttribute('aria-selected', String(optimize));
  store.set('tab', tab);
  if (optimize) initView();
  if (S.view) S.view.active = optimize;
}

// ---------- Wiring ----------

$('tab-library').addEventListener('click', () => setTab('library'));
$('tab-optimize').addEventListener('click', () => setTab('optimize'));
$('o-browse').addEventListener('click', browse);
$('o-load').addEventListener('click', loadFolder);
$('o-dir').addEventListener('keydown', (e) => e.key === 'Enter' && loadFolder());
$('o-run').addEventListener('click', runAll);
$('o-check-all').addEventListener('change', (e) => {
  for (const f of S.files) f.checked = e.target.checked;
  S.files.forEach(renderRow);
  renderSummary();
});
$('o-show-orig').addEventListener('click', () => {
  if (S.view) S.view.showing = 'orig';
  applyPreviewVisibility();
});
$('o-show-opt').addEventListener('click', () => {
  if (S.view) S.view.showing = 'opt';
  applyPreviewVisibility();
});
$('o-wire').addEventListener('change', applyPreviewVisibility);
for (const id of SETTING_IDS) {
  $(id).addEventListener('input', () => {
    showSettingValues();
    saveSettings();
    // The scale changes the original too, so reload both sides of the preview.
    if (id === 'o-fbx-scale' && S.files[S.selected] && isFbx(S.files[S.selected])) select(S.selected);
    else if (id !== 'o-recursive') schedulePreview();
  });
}
for (const r of document.querySelectorAll('input[name="o-mode"]')) r.addEventListener('change', saveSettings);

restoreSettings();
fetch('/api/settings')
  .then((r) => (r.ok ? r.json() : null))
  .then(applyRecent)
  .catch(() => {});
setTab(store.get('tab', 'library'));
