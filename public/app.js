import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createSplitter } from './split.js';

const FORMAT_LABEL = { gltf: 'glTF', glb: 'GLB', fbx: 'FBX', obj: 'OBJ', 'fbx-unity': 'FBX Unity', blend: 'Blend' };
const VIEWABLE = new Set(['gltf', 'glb', 'fbx', 'fbx-unity', 'obj']);
const KIND_LABEL = { model: 'Models', character: 'Characters', animation: 'Animations' };
const PAGE = 150;
const THUMB_SIZE = 256;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fileUrl = (p) => '/files/' + p.split('/').map(encodeURIComponent).join('/');
const thumbName = (id) => id.replaceAll('/', '__') + '.png';

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

const state = {
  assets: [],
  packs: new Map(),
  filtered: [],
  rendered: 0,
  selected: -1,
  filters: { q: '', pack: '', collection: '', format: '', kind: '', tag: '', fav: false },
  favorites: new Set(store.get('favorites', [])),
  thumbs: new Set(),
  thumbFailed: new Set(),
  autoThumbs: store.get('autoThumbs', true),
};

// ---------- Loading models (shared by viewer and thumbnailer) ----------

const gltfLoader = new GLTFLoader();

// FBX files often point at textures the browser can't reach as written: an absolute path from the author's machine,
// a dropped sub-folder (Kenney's "Textures\colormap.png" gets requested as "colormap.png"), or no name at all
// (".../undefined"). The server already found the real files, so redirect those requests by file name.
async function fbxTextureRedirect(asset, format) {
  const byName = new Map();
  try {
    const res = await fetch(`/api/deps?id=${encodeURIComponent(asset.id)}&format=${encodeURIComponent(format)}`);
    if (res.ok) {
      for (const f of (await res.json()).files) {
        if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(f.src)) byName.set(f.src.split('/').pop().toLowerCase(), fileUrl(f.src));
      }
    }
  } catch {}
  const only = byName.size === 1 ? [...byName.values()][0] : null;
  return (u) => {
    let name = String(u).split(/[?#]/)[0].split('/').pop() || '';
    try {
      name = decodeURIComponent(name);
    } catch {}
    name = name.toLowerCase();
    if (name === 'undefined') return only || u;
    return byName.get(name) || u;
  };
}

async function loadModel(asset, format) {
  const url = fileUrl(asset.formats[format]);
  if (format === 'gltf' || format === 'glb') {
    const g = await gltfLoader.loadAsync(url);
    return { object: g.scene, animations: g.animations, source: { parser: g.parser, url: new URL(url, location.href).href } };
  }
  if (format === 'fbx' || format === 'fbx-unity') {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(await fbxTextureRedirect(asset, format));
    const o = await new FBXLoader(manager).loadAsync(url);
    return { object: o, animations: o.animations || [] };
  }
  if (format === 'obj') {
    const objLoader = new OBJLoader();
    if (asset.mtl) {
      const materials = await new MTLLoader().loadAsync(fileUrl(asset.mtl)).catch(() => null);
      if (materials) {
        materials.preload();
        objLoader.setMaterials(materials);
      }
    }
    return { object: await objLoader.loadAsync(url), animations: [] };
  }
  throw new Error(`${FORMAT_LABEL[format] || format} can't be previewed`);
}

function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [o.material].flat().filter(Boolean)) {
      for (const v of [...Object.values(m), m.userData.origMap]) if (v?.isTexture) v.dispose();
      m.dispose();
    }
  });
}

// Sits the model on y=0, centred in x/z. Returns its bounding box size.
function groundObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box.min.y;
  return size;
}

function frameCamera(camera, size, controls) {
  const radius = Math.max(size.length() / 2, 1e-3);
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (radius / Math.sin(fov / 2)) * 1.05;
  const target = new THREE.Vector3(0, size.y / 2, 0);
  camera.position.copy(target).add(new THREE.Vector3(1, 0.75, 1.15).normalize().multiplyScalar(dist));
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(target);
  if (controls) {
    controls.target.copy(target);
    controls.update();
  }
}

function addLights(scene, renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(3, 6, 4);
  scene.add(sun);
}

// ---------- Viewer ----------

let splitter = null;

const viewer = {
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  grid: null,
  current: null,
  mixer: null,
  clips: [],
  clock: new THREE.Clock(),
  asset: null,
  format: null,
  seq: 0,
  textureCache: new Map(),
};

function initViewer() {
  const stage = $('stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  stage.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  addLights(scene, renderer);

  const grid = new THREE.GridHelper(1, 10, 0x888888, 0x888888);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotateSpeed = 2;

  Object.assign(viewer, { renderer, scene, camera, controls, grid });

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

  renderer.setAnimationLoop(() => {
    const dt = viewer.clock.getDelta();
    viewer.mixer?.update(dt);
    controls.update();
    renderer.render(scene, camera);
  });

  $('t-grid').addEventListener('change', (e) => (grid.visible = e.target.checked));
  $('t-wire').addEventListener('change', applyWireframe);
  $('t-rotate').addEventListener('change', (e) => (controls.autoRotate = e.target.checked));
  $('v-variant').addEventListener('change', (e) => applyVariant(e.target.value));
  $('v-anim').addEventListener('change', (e) => playClip(Number(e.target.value)));
  $('v-copy').addEventListener('click', copyPath);
  $('x-browse').addEventListener('click', browseFolder);
  loadSettings();
  $('x-copy').addEventListener('click', () => copyToFolder(false));
  $('v-fav').addEventListener('click', () => viewer.asset && toggleFavorite(viewer.asset));
  $('v-close').addEventListener('click', () => $('viewer').classList.remove('open'));
}

function applyWireframe() {
  const on = $('t-wire').checked;
  viewer.current?.traverse((o) => {
    for (const m of [o.material].flat().filter(Boolean)) m.wireframe = on;
  });
}

async function applyVariant(path) {
  const root = viewer.current;
  if (!root) return;
  let tex = null;
  if (path) {
    tex = viewer.textureCache.get(path);
    if (!tex) {
      tex = await new THREE.TextureLoader().loadAsync(fileUrl(path));
      tex.colorSpace = THREE.SRGBColorSpace;
      viewer.textureCache.set(path, tex);
    }
  }
  if (root !== viewer.current) return;
  root.traverse((o) => {
    for (const m of [o.material].flat().filter(Boolean)) {
      if (!('origMap' in m.userData)) m.userData.origMap = m.map;
      if (!m.userData.origMap) continue;
      if (tex) {
        // glTF textures are not flipped; OBJ/FBX ones are. Match whatever the original used.
        const t = tex.flipY === m.userData.origMap.flipY ? tex : cloneFlipped(tex, m.userData.origMap.flipY);
        m.map = t;
      } else {
        m.map = m.userData.origMap;
      }
      m.needsUpdate = true;
    }
  });
}

function cloneFlipped(tex, flipY) {
  const key = `${tex.uuid}|${flipY}`;
  let t = viewer.textureCache.get(key);
  if (!t) {
    t = tex.clone();
    t.flipY = flipY;
    t.needsUpdate = true;
    viewer.textureCache.set(key, t);
  }
  return t;
}

function playClip(i) {
  viewer.mixer?.stopAllAction();
  const clip = viewer.clips[i];
  if (clip && viewer.mixer) viewer.mixer.clipAction(clip).play();
}

function copyPath() {
  const p = viewer.asset?.formats[viewer.format];
  if (!p) return;
  const done = () => {
    $('v-copy').textContent = 'Copied';
    setTimeout(() => ($('v-copy').textContent = 'Copy path'), 1200);
  };
  const text = 'files/' + p;
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}

function fallbackCopy(text, done) {
  const t = el('textarea');
  t.value = text;
  document.body.append(t);
  t.select();
  document.execCommand('copy');
  t.remove();
  done();
}

function showAsset(asset) {
  viewer.asset = asset;
  $('viewer').classList.add('open');
  $('v-name').textContent = asset.name;
  const pack = state.packs.get(asset.packId);
  $('v-meta').textContent = `${asset.pack} · ${asset.collection} · ${asset.license}`;
  $('v-panel').hidden = false;
  $('v-fav').hidden = false;
  updateFavButton();

  const tags = $('v-tags');
  tags.replaceChildren(
    ...asset.tags.map((t) => {
      const b = el('button', 'tag', t);
      b.type = 'button';
      b.addEventListener('click', () => setFilter('tag', t));
      return b;
    }),
  );

  const variants = pack?.textureVariants || [];
  $('v-variant-wrap').hidden = !variants.length;
  $('v-variant').replaceChildren(el('option', null, 'Default'), ...variants.map((v) => Object.assign(el('option', null, v.name), { value: v.path })));
  $('v-variant').firstChild.value = '';

  const first = asset.primary || Object.keys(asset.formats)[0];
  showFormat(first);
}

function renderFormatButtons() {
  const asset = viewer.asset;
  $('v-formats').replaceChildren(
    ...Object.keys(asset.formats).map((f) => {
      const b = el('button', f === viewer.format ? 'active' : '', FORMAT_LABEL[f] || f);
      b.type = 'button';
      if (!VIEWABLE.has(f)) {
        b.title = 'Download only';
        b.textContent += ' ↓';
      }
      b.addEventListener('click', () => showFormat(f));
      return b;
    }),
  );
}

async function showFormat(format) {
  const asset = viewer.asset;
  viewer.format = format;
  renderFormatButtons();
  const path = asset.formats[format];
  $('v-path').textContent = 'files/' + path;
  $('v-download').href = fileUrl(path) + '?download';
  showExport(asset, format);

  if (!VIEWABLE.has(format)) {
    setStats(null);
    $('v-status').textContent = `${FORMAT_LABEL[format]} files can't be previewed in the browser — download to open.`;
    return;
  }
  const seq = ++viewer.seq;
  $('v-status').textContent = 'Loading…';
  try {
    const { object, animations, source } = await loadModel(asset, format);
    if (seq !== viewer.seq) return disposeObject(object);
    setModel(object, animations, source);
    $('v-status').textContent = '';
  } catch (err) {
    if (seq !== viewer.seq) return;
    console.error(err);
    clearModel();
    setStats(null);
    $('v-status').textContent = `Couldn't load ${FORMAT_LABEL[format]}: ${err.message || err}`;
  }
}

function clearModel() {
  splitter?.clear();
  if (!viewer.current) return;
  viewer.mixer?.stopAllAction();
  viewer.scene.remove(viewer.current);
  disposeObject(viewer.current);
  viewer.current = null;
  viewer.mixer = null;
}

function setModel(object, animations, source) {
  clearModel();
  const size = groundObject(object);
  viewer.scene.add(object);
  viewer.current = object;
  splitter?.setModel(object, viewer.asset, source, viewer.format);

  const maxDim = Math.max(size.x, size.z, 1e-3);
  const step = 10 ** Math.floor(Math.log10(maxDim));
  viewer.grid.scale.setScalar(Math.ceil((maxDim * 2) / step) * step);
  frameCamera(viewer.camera, size, viewer.controls);

  applyWireframe();
  const variant = $('v-variant').value;
  if (variant) applyVariant(variant);

  viewer.clips = animations;
  viewer.mixer = animations.length ? new THREE.AnimationMixer(object) : null;
  $('v-anim-wrap').hidden = !animations.length;
  $('v-anim').replaceChildren(...animations.map((c, i) => Object.assign(el('option', null, c.name || `Clip ${i + 1}`), { value: i })));
  if (animations.length) playClip(0);

  setStats(object, size);
}

function setStats(object, size) {
  const dl = $('v-stats');
  if (!object) return dl.replaceChildren();
  let tris = 0;
  let meshes = 0;
  const mats = new Set();
  object.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    for (const m of [o.material].flat()) mats.add(m);
  });
  const n = (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(3));
  const rows = [
    ['Size (W×H×D)', `${n(size.x)} × ${n(size.y)} × ${n(size.z)}`],
    ['Triangles', Math.round(tris).toLocaleString()],
    ['Meshes', meshes],
    ['Materials', mats.size],
  ];
  if (viewer.clips.length) rows.push(['Animations', viewer.clips.length]);
  dl.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, String(v))]));
}

// ---------- Export (copy a model and everything it references into a game project) ----------

const exportState = { seq: 0, asset: null, format: null };

const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const exportQuery = (a, f) => `id=${encodeURIComponent(a.id)}&format=${encodeURIComponent(f)}`;

function setExportStatus(text, kind = '') {
  $('x-status').textContent = text;
  $('x-status').className = 'x-status ' + kind;
}

function renderExportFiles(files, actions = {}) {
  $('x-files').replaceChildren(
    ...files.map((f) => {
      const li = el('li');
      const name = el('span', null, f.out);
      if (actions[f.out]) name.append(' ', el('span', 'act', actions[f.out]));
      li.append(name, el('span', 'size', f.size != null ? formatSize(f.size) : ''));
      return li;
    }),
  );
}

async function showExport(asset, format) {
  const seq = ++exportState.seq;
  Object.assign(exportState, { asset, format, files: [] });
  $('x-zip').href = `/api/export.zip?${exportQuery(asset, format)}`;
  $('x-summary').textContent = `Files needed for ${FORMAT_LABEL[format] || format}:`;
  $('x-files').replaceChildren();
  $('x-warnings').replaceChildren();
  setExportStatus('');
  try {
    const res = await fetch(`/api/deps?${exportQuery(asset, format)}`);
    if (!res.ok) throw new Error(await res.text());
    const { files, warnings } = await res.json();
    if (seq !== exportState.seq) return;
    exportState.files = files;
    const total = files.reduce((n, f) => n + f.size, 0);
    $('x-summary').textContent = `${files.length} file${files.length === 1 ? '' : 's'} needed for ${FORMAT_LABEL[format] || format} (${formatSize(total)}):`;
    renderExportFiles(files);
    $('x-warnings').replaceChildren(...warnings.map((w) => el('div', null, '⚠ ' + w)));
  } catch (err) {
    if (seq === exportState.seq) setExportStatus(`Couldn't list files: ${err.message}`, 'err');
  }
}

function applySettings(s) {
  if (s.exportDest && !$('x-dest').value.trim()) $('x-dest').value = s.exportDest;
  $('x-recent').replaceChildren(...(s.recentDests || []).map((d) => Object.assign(el('option'), { value: d })));
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    if (res.ok) applySettings(await res.json());
  } catch {}
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
  return { res, data };
}

async function browseFolder() {
  $('x-browse').disabled = true;
  setExportStatus('Choose a folder in the window that just opened…');
  try {
    const { res, data } = await postJson('/api/pick-folder', { start: $('x-dest').value.trim() });
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (data.cancelled) return setExportStatus('');
    $('x-dest').value = data.dest;
    applySettings(data);
    setExportStatus('');
  } catch (err) {
    setExportStatus(err.message, 'err');
  } finally {
    $('x-browse').disabled = false;
  }
}

async function copyToFolder(overwrite) {
  const { asset, format } = exportState;
  const dest = $('x-dest').value.trim();
  if (!asset) return;
  if (!dest) return browseFolder().then(() => $('x-dest').value.trim() && copyToFolder(overwrite));
  $('x-copy').disabled = true;
  setExportStatus('Copying…');
  try {
    const { res, data } = await postJson('/api/export', { id: asset.id, format, dest, overwrite });
    if (res.status === 409) {
      const lines = data.conflicts.map((c) => `${c.out}  (yours ${formatSize(c.existingSize)} → library ${formatSize(c.newSize)})`);
      if (confirm(`These files already exist in the folder with a different size:\n\n${lines.join('\n')}\n\nOverwrite them?`)) return copyToFolder(true);
      return setExportStatus('Nothing copied — your existing files were kept.', 'err');
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    applySettings(data);
    const label = { copy: 'copied', replace: 'replaced', overwrite: 'overwritten' };
    renderExportFiles(exportState.files, Object.fromEntries(data.files.map((f) => [f.out, label[f.action]])));
    setExportStatus(`✓ Copied ${data.files.length} file${data.files.length === 1 ? '' : 's'} → ${data.dest}`, 'ok');
  } catch (err) {
    setExportStatus(err.message, 'err');
  } finally {
    $('x-copy').disabled = false;
  }
}

// ---------- Thumbnails (rendered in the browser, saved by the server) ----------

const thumbs = { renderer: null, scene: null, camera: null, queue: [], queued: new Set(), wanted: new Set(), busy: false };

function initThumbRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
  const scene = new THREE.Scene();
  addLights(scene, renderer);
  Object.assign(thumbs, { renderer, scene, camera: new THREE.PerspectiveCamera(35, 1, 0.01, 1000) });
}

const needsThumb = (a) => !a.preview && a.primary && !state.thumbs.has(thumbName(a.id)) && !state.thumbFailed.has(a.id);

function enqueueThumb(a, { force = false } = {}) {
  if (!needsThumb(a) || thumbs.queued.has(a.id)) return;
  thumbs.queued.add(a.id);
  if (force) thumbs.wanted.add(a.id);
  thumbs.queue.push(a);
  updateThumbStatus();
  pumpThumbs();
}

async function pumpThumbs() {
  if (thumbs.busy) return;
  thumbs.busy = true;
  if (!thumbs.renderer) initThumbRenderer();
  while (thumbs.queue.length) {
    const a = thumbs.queue.shift();
    thumbs.queued.delete(a.id);
    // Skip cards that scrolled away before their turn (unless queued by "generate all").
    if (!thumbs.wanted.has(a.id) && !visibleIds.has(a.id)) continue;
    thumbs.wanted.delete(a.id);
    try {
      await makeThumb(a);
    } catch (err) {
      console.warn('Thumbnail failed', a.id, err);
      state.thumbFailed.add(a.id);
    }
    updateThumbStatus();
  }
  thumbs.busy = false;
  updateThumbStatus();
}

async function makeThumb(a) {
  const { object } = await loadModel(a, a.primary);
  const size = groundObject(object);
  thumbs.scene.add(object);
  frameCamera(thumbs.camera, size);
  thumbs.renderer.render(thumbs.scene, thumbs.camera);
  const blob = await new Promise((r) => thumbs.renderer.domElement.toBlob(r, 'image/png'));
  thumbs.scene.remove(object);
  disposeObject(object);
  const res = await fetch(`/api/thumb?id=${encodeURIComponent(a.id)}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
  const name = thumbName(a.id);
  state.thumbs.add(name);
  for (const img of document.querySelectorAll(`.card[data-id="${CSS.escape(a.id)}"] .thumb`)) setThumb(img, a);
}

function updateThumbStatus() {
  const missing = state.assets.filter(needsThumb).length;
  const pending = thumbs.queue.length + (thumbs.busy ? 1 : 0);
  $('thumb-status').textContent = `${missing} without thumbnail` + (pending ? ` · ${pending} rendering` : '');
}

// ---------- Grid ----------

const visibleIds = new Set();
const cardObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const id = e.target.dataset.id;
      if (e.isIntersecting) {
        visibleIds.add(id);
        if (state.autoThumbs) enqueueThumb(state.byId.get(id));
      } else visibleIds.delete(id);
    }
  },
  { rootMargin: '200px' },
);

function setThumb(box, a) {
  const src = a.preview ? fileUrl(a.preview) : state.thumbs.has(thumbName(a.id)) ? `/thumbs/${encodeURIComponent(thumbName(a.id))}?v=${state.thumbVersion}` : null;
  if (src) {
    const img = el('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = src;
    box.replaceChildren(img);
  } else {
    box.replaceChildren(el('span', 'ph', a.name.split(' ').map((w) => w[0]).join('').slice(0, 3).toUpperCase()));
  }
}

function makeCard(a, i) {
  const card = el('button', 'card');
  card.type = 'button';
  card.dataset.id = a.id;
  card.dataset.i = i;
  card.setAttribute('role', 'option');
  card.title = `${a.name} — ${a.pack} / ${a.collection}`;
  const box = el('div', 'thumb');
  setThumb(box, a);
  const info = el('div', 'info');
  info.append(el('div', 'name', a.name));
  const badges = el('div', 'badges');
  for (const f of Object.keys(a.formats)) badges.append(el('span', `badge ${f}`, FORMAT_LABEL[f] || f));
  info.append(badges);
  card.append(box, info);
  if (state.favorites.has(a.id)) card.append(el('span', 'star', '★'));
  if (i === state.selected) card.classList.add('selected');
  card.addEventListener('click', () => select(i));
  cardObserver.observe(card);
  return card;
}

function renderGrid() {
  const grid = $('grid');
  for (const c of grid.children) cardObserver.unobserve(c);
  visibleIds.clear();
  grid.replaceChildren();
  state.rendered = 0;
  renderMore();
  $('empty').hidden = state.filtered.length > 0;
  $('count').textContent = `${state.filtered.length.toLocaleString()} of ${state.assets.length.toLocaleString()} assets`;
}

function renderMore(upTo = state.rendered + PAGE) {
  const grid = $('grid');
  const end = Math.min(upTo, state.filtered.length);
  const frag = document.createDocumentFragment();
  for (let i = state.rendered; i < end; i++) frag.append(makeCard(state.filtered[i], i));
  grid.append(frag);
  state.rendered = end;
}

new IntersectionObserver((e) => e[0].isIntersecting && state.rendered < state.filtered.length && renderMore(), { rootMargin: '600px' }).observe($('sentinel'));

function select(i, { scroll = false } = {}) {
  if (i < 0 || i >= state.filtered.length) return;
  if (i >= state.rendered) renderMore(i + PAGE);
  $('grid').querySelector('.card.selected')?.classList.remove('selected');
  state.selected = i;
  const card = $('grid').children[i];
  card?.classList.add('selected');
  if (scroll) card?.scrollIntoView({ block: 'nearest' });
  const a = state.filtered[i];
  history.replaceState(null, '', '#' + encodeURIComponent(a.id));
  showAsset(a);
}

function toggleFavorite(a) {
  if (state.favorites.has(a.id)) state.favorites.delete(a.id);
  else state.favorites.add(a.id);
  store.set('favorites', [...state.favorites]);
  updateFavButton();
  const card = $('grid').querySelector(`.card[data-id="${CSS.escape(a.id)}"]`);
  if (card) {
    card.querySelector('.star')?.remove();
    if (state.favorites.has(a.id)) card.append(el('span', 'star', '★'));
  }
}

function updateFavButton() {
  const on = viewer.asset && state.favorites.has(viewer.asset.id);
  $('v-fav').textContent = on ? '★' : '☆';
  $('v-fav').setAttribute('aria-pressed', String(!!on));
}

// ---------- Search & filters ----------

function fuzzy(text, q) {
  let i = 0;
  for (const c of text) if (c === q[i] && ++i === q.length) return true;
  return false;
}

function score(a, terms) {
  let total = 0;
  for (const t of terms) {
    let s;
    if (a.nameLower === t) s = 100;
    else if (a.nameLower.startsWith(t)) s = 60;
    else if (a.nameLower.includes(t)) s = 40;
    else if (a.tags.some((g) => g.startsWith(t))) s = 30;
    else if (a.hay.includes(t)) s = 20;
    else if (t.length >= 3 && fuzzy(a.nameLower, t)) s = 5;
    else return 0;
    total += s;
  }
  return total;
}

function passes(a, f, skip) {
  if (skip !== 'pack' && f.pack && a.packId !== f.pack) return false;
  if (skip !== 'collection' && f.collection && a.collectionId !== f.collection) return false;
  if (skip !== 'format' && f.format && !a.formats[f.format]) return false;
  if (skip !== 'kind' && f.kind && a.kind !== f.kind) return false;
  if (skip !== 'tag' && f.tag && !a.tags.includes(f.tag)) return false;
  if (f.fav && !state.favorites.has(a.id)) return false;
  return true;
}

function applyFilters({ keepSelection = true } = {}) {
  const f = state.filters;
  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const prev = state.filtered[state.selected]?.id;
  const scored = [];
  for (const a of state.assets) {
    if (!passes(a, f)) continue;
    const s = terms.length ? score(a, terms) : 1;
    if (s > 0) scored.push([s, a]);
  }
  if (terms.length) scored.sort((x, y) => y[0] - x[0]);
  state.filtered = scored.map((x) => x[1]);
  state.selected = keepSelection && prev ? state.filtered.findIndex((a) => a.id === prev) : -1;
  renderGrid();
  renderTags();
  store.set('filters', { ...f, q: '' });
}

function setFilter(key, value) {
  state.filters[key] = value;
  if (key === 'pack') {
    state.filters.collection = '';
    fillCollections();
  }
  syncControls();
  applyFilters();
}

function fillSelect(sel, options, allLabel) {
  sel.replaceChildren(Object.assign(el('option', null, allLabel), { value: '' }), ...options.map(([v, label]) => Object.assign(el('option', null, label), { value: v })));
}

function counts(key, fn) {
  const c = new Map();
  for (const a of state.assets) if (passes(a, state.filters, key)) for (const v of [fn(a)].flat()) c.set(v, (c.get(v) || 0) + 1);
  return c;
}

function fillCollections() {
  const packs = state.filters.pack ? [state.packs.get(state.filters.pack)] : [...state.packs.values()];
  const seen = new Map();
  for (const p of packs) for (const c of p.collections) seen.set(c.id, c.name);
  fillSelect($('f-collection'), [...seen].sort((a, b) => a[1].localeCompare(b[1])), 'All collections');
}

function renderTags() {
  const c = counts('tag', (a) => a.tags);
  const top = [...c].sort((a, b) => b[1] - a[1]).slice(0, 40);
  if (state.filters.tag && !top.some(([t]) => t === state.filters.tag)) top.unshift([state.filters.tag, c.get(state.filters.tag) || 0]);
  $('tags').replaceChildren(
    ...top.map(([t, n]) => {
      const b = el('button', 'tag' + (t === state.filters.tag ? ' active' : ''), t);
      b.type = 'button';
      b.append(el('span', 'n', String(n)));
      b.addEventListener('click', () => setFilter('tag', state.filters.tag === t ? '' : t));
      return b;
    }),
  );
}

function syncControls() {
  const f = state.filters;
  $('search').value = f.q;
  $('f-pack').value = f.pack;
  $('f-collection').value = f.collection;
  $('f-format').value = f.format;
  $('f-kind').value = f.kind;
  $('f-fav').checked = f.fav;
}

function initFilters(index) {
  fillSelect($('f-pack'), index.packs.map((p) => [p.id, `${p.name} (${p.count})`]), 'All packs');
  fillCollections();
  const formats = index.formatPriority.filter((f) => state.assets.some((a) => a.formats[f]));
  fillSelect($('f-format'), formats.map((f) => [f, FORMAT_LABEL[f] || f]), 'Any format');
  const kinds = [...new Set(state.assets.map((a) => a.kind))];
  fillSelect($('f-kind'), kinds.map((k) => [k, KIND_LABEL[k] || k]), 'Everything');

  const saved = store.get('filters', {});
  for (const k of Object.keys(state.filters)) if (k in saved && k !== 'q') state.filters[k] = saved[k];
  if (state.filters.pack && !state.packs.has(state.filters.pack)) state.filters.pack = '';
  fillCollections();
  syncControls();

  let t;
  $('search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.filters.q = e.target.value;
      applyFilters({ keepSelection: false });
    }, 80);
  });
  $('f-pack').addEventListener('change', (e) => setFilter('pack', e.target.value));
  $('f-collection').addEventListener('change', (e) => setFilter('collection', e.target.value));
  $('f-format').addEventListener('change', (e) => setFilter('format', e.target.value));
  $('f-kind').addEventListener('change', (e) => setFilter('kind', e.target.value));
  $('f-fav').addEventListener('change', (e) => setFilter('fav', e.target.checked));
  $('clear').addEventListener('click', () => {
    Object.assign(state.filters, { q: '', pack: '', collection: '', format: '', kind: '', tag: '', fav: false });
    fillCollections();
    syncControls();
    applyFilters();
  });

  $('auto-thumbs').checked = state.autoThumbs;
  $('auto-thumbs').addEventListener('change', (e) => {
    state.autoThumbs = e.target.checked;
    store.set('autoThumbs', state.autoThumbs);
    if (state.autoThumbs) for (const id of visibleIds) enqueueThumb(state.byId.get(id));
  });
  $('thumbs-all').addEventListener('click', () => {
    for (const a of state.filtered) enqueueThumb(a, { force: true });
  });
}

// ---------- Keyboard ----------

function gridColumns() {
  return getComputedStyle($('grid')).gridTemplateColumns.split(' ').length || 1;
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.app').classList.contains('mode-optimize')) return;
  const typing = e.target.matches('input, select, textarea');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    $('search').focus();
    $('search').select();
    return;
  }
  if (e.key === 'Escape') {
    if (typing) e.target.blur();
    else $('viewer').classList.remove('open');
    return;
  }
  if (typing && e.target !== $('search')) return;
  const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: gridColumns(), ArrowUp: -gridColumns() };
  if (e.key in moves && !(typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))) {
    e.preventDefault();
    if (typing) e.target.blur();
    const from = state.selected < 0 ? (moves[e.key] > 0 ? -1 : state.filtered.length) : state.selected;
    const to = Math.max(0, Math.min(state.filtered.length - 1, from + moves[e.key]));
    select(to, { scroll: true });
    return;
  }
  if (!typing && e.key === 'f' && viewer.asset) toggleFavorite(viewer.asset);
});

// ---------- Boot ----------

async function main() {
  const [indexRes, thumbsRes] = await Promise.all([fetch('/api/index'), fetch('/api/thumbs')]);
  if (!indexRes.ok) {
    $('count').textContent = await indexRes.text();
    return;
  }
  const index = await indexRes.json();
  state.thumbs = new Set(thumbsRes.ok ? await thumbsRes.json() : []);
  state.thumbVersion = Date.now();
  state.assets = index.assets;
  state.byId = new Map(index.assets.map((a) => [a.id, a]));
  for (const p of index.packs) state.packs.set(p.id, p);
  for (const a of state.assets) {
    a.nameLower = a.name.toLowerCase();
    a.hay = [a.name, a.collection, a.pack, ...a.tags].join(' ').toLowerCase();
  }

  initViewer();
  splitter = createSplitter({ el, getDest: () => $('x-dest').value.trim(), browse: browseFolder, postJson, applySettings, formatSize });
  initFilters(index);
  applyFilters({ keepSelection: false });
  updateThumbStatus();

  selectFromHash();
  window.addEventListener('hashchange', selectFromHash);
}

function selectFromHash() {
  let id;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  if (!state.byId.has(id) || state.filtered[state.selected]?.id === id) return;
  let i = state.filtered.findIndex((a) => a.id === id);
  if (i < 0) {
    $('clear').click();
    i = state.filtered.findIndex((a) => a.id === id);
  }
  if (i >= 0) select(i, { scroll: true });
}

main().catch((err) => {
  console.error(err);
  $('count').textContent = `Failed to start: ${err.message}`;
});
