// Split a multi-part model (e.g. a "pack of 18 hats" in one scene) into one .glb per chosen node.
// Each part gets its full transform baked into the vertices, is re-centred, and keeps only the materials/textures it uses.
import * as THREE from 'three';
import { exportGlb, originalImage } from './glb.js';
import { makeZip } from './zip.js';

const GENERIC_NAME = /^(object|mesh|node|group|geometry|polysurface|default)?[_ .-]?\d*$/i;

const $ = (id) => document.getElementById(id);

function meshStats(obj) {
  let meshes = 0;
  let tris = 0;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return { meshes, tris: Math.round(tris) };
}

/**
 * @param {{ el: Function, getDest: () => string, browse: () => Promise<void>, postJson: Function,
 *           applySettings: Function, formatSize: Function }} ctx
 */
export function createSplitter(ctx) {
  const { el } = ctx;
  const state = { root: null, asset: null, source: null, nodes: [], checked: new Set(), expanded: new Set(), suggested: [], busy: false };

  // ---------- Hierarchy ----------

  function buildNodes(root) {
    const list = [];
    const walk = (obj, depth, parent) => {
      const stats = meshStats(obj);
      if (!stats.meshes) return;
      const node = { obj, depth, parent, stats, children: [] };
      list.push(node);
      parent?.children.push(node);
      for (const c of obj.children) walk(c, depth + 1, node);
    };
    for (const c of root.children) walk(c, 0, null);
    return list;
  }

  // Walk down single-child chains (Sketchfab_model → root → GLTF_SceneRootNode → …) until the hierarchy branches.
  // Stop at a node that has geometry of its own (a car body with wheel children is one part, not just wheels).
  function suggest() {
    let level = state.nodes.filter((n) => !n.parent);
    while (level.length === 1 && level[0].children.length && !level[0].obj.isMesh) level = level[0].children;
    return level;
  }

  function setModel(root, asset, source = null, format = '') {
    restore();
    state.root = root;
    state.asset = asset;
    state.source = source;
    // Plain FBX exports are in centimetres; glTF expects metres.
    $('s-scale').value = format === 'fbx' ? '0.01' : '1';
    state.nodes = buildNodes(root);
    const total = meshStats(root).meshes;
    $('split').hidden = total < 2;
    setStatus('');
    if (total < 2) return;
    state.suggested = suggest();
    selectSuggested();
  }

  function clear() {
    restore();
    Object.assign(state, { root: null, asset: null, source: null, nodes: [] });
    state.checked.clear();
    $('split').hidden = true;
  }

  function expandTo(nodes) {
    state.expanded.clear();
    for (const n of nodes) for (let p = n.parent; p; p = p.parent) state.expanded.add(p);
  }

  function selectSuggested() {
    state.checked = new Set(state.suggested);
    expandTo(state.suggested);
    render();
  }

  // ---------- Naming ----------

  function displayName(node) {
    return node.obj.name || (node.obj.isMesh ? 'Mesh' : 'Group');
  }

  function baseName(node) {
    let name = node.obj.name;
    // "Object_4" says nothing; use the nearest meaningful ancestor name instead.
    for (let p = node.parent; GENERIC_NAME.test(name || '') && p; p = p.parent) name = p.obj.name;
    return (name || state.asset?.name || 'part').replace(/[^\w\-. ()]+/g, '_').replace(/^[_ .]+|[_ .]+$/g, '') || 'part';
  }

  // Strip the exporter's index suffix ("Viking_Hat_0" → "Viking_Hat") unless that would make names collide.
  function fileNames(nodes) {
    const prefix = $('s-prefix').value.trim().replace(/[^\w\-. ()]+/g, '_');
    const raw = nodes.map(baseName);
    const stripped = raw.map((n) => n.replace(/[_ ]\d+$/, '') || n);
    const counts = new Map();
    for (const n of stripped) counts.set(n.toLowerCase(), (counts.get(n.toLowerCase()) || 0) + 1);
    const used = new Map();
    return nodes.map((_, i) => {
      let n = counts.get(stripped[i].toLowerCase()) > 1 ? raw[i] : stripped[i];
      n = prefix + n;
      const key = n.toLowerCase();
      const k = (used.get(key) || 0) + 1;
      used.set(key, k);
      return (k > 1 ? `${n}_${k}` : n).slice(0, 110) + '.glb';
    });
  }

  function checkedInOrder() {
    return state.nodes.filter((n) => state.checked.has(n));
  }

  // ---------- Tree UI ----------

  function render() {
    const names = new Map();
    const order = checkedInOrder();
    fileNames(order).forEach((f, i) => names.set(order[i], f));

    const rows = [];
    const visible = (n) => !n.parent || (state.expanded.has(n.parent) && visible(n.parent));
    for (const n of state.nodes) {
      if (!visible(n)) continue;
      const row = el('div', 'tree-row' + (n.obj.isMesh && !n.children.length ? ' mesh' : ''));
      row.style.setProperty('--depth', n.depth);
      row.setAttribute('role', 'treeitem');

      const twisty = el('span', 'twisty', n.children.length ? (state.expanded.has(n) ? '▾' : '▸') : '');
      twisty.addEventListener('click', () => {
        if (state.expanded.has(n)) state.expanded.delete(n);
        else state.expanded.add(n);
        render();
      });

      const box = el('input');
      box.type = 'checkbox';
      box.checked = state.checked.has(n);
      box.addEventListener('change', () => {
        if (box.checked) state.checked.add(n);
        else state.checked.delete(n);
        render();
      });

      const label = el('label', 'label', displayName(n));
      label.addEventListener('click', () => box.click());
      const meta = el('span', 'meta', n.stats.meshes > 1 ? `${n.stats.meshes} meshes · ${n.stats.tris.toLocaleString()} tris` : `${n.stats.tris.toLocaleString()} tris`);
      row.append(twisty, box, label, meta);
      if (names.has(n)) row.append(el('span', 'out', '→ ' + names.get(n)));

      row.addEventListener('mouseenter', () => isolate(n.obj));
      row.addEventListener('mouseleave', restore);
      rows.push(row);
    }
    $('s-tree').replaceChildren(...rows);
    const count = state.checked.size;
    $('s-save').textContent = `Save ${count} part${count === 1 ? '' : 's'} to folder`;
    $('s-save').disabled = $('s-zip').disabled = !count || state.busy;
  }

  // Preview a node by hiding every other mesh.
  function isolate(obj) {
    if (!state.root) return;
    const keep = new Set();
    obj.traverse((o) => keep.add(o));
    state.root.traverse((o) => {
      if (!o.isMesh) return;
      if (!('splitVisible' in o.userData)) o.userData.splitVisible = o.visible;
      o.visible = keep.has(o) && o.userData.splitVisible;
    });
  }

  function restore() {
    state.root?.traverse((o) => {
      if (o.isMesh && 'splitVisible' in o.userData) {
        o.visible = o.userData.splitVisible;
        delete o.userData.splitVisible;
      }
    });
  }

  // ---------- Building parts ----------

  function flipWinding(geometry) {
    if (!geometry.index) geometry.setIndex([...Array(geometry.attributes.position.count).keys()]);
    const idx = geometry.index.array;
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    geometry.index.needsUpdate = true;
  }

  // Loaders can leave textures whose file failed to load (no image data); the exporter throws on those,
  // so export a copy of the material without them.
  const hasImage = (tex) => {
    const img = tex.image;
    return !!img && (img.data !== undefined || img.width > 0);
  };

  function exportable(material, warnings) {
    const broken = Object.entries(material).filter(([, v]) => v?.isTexture && !hasImage(v));
    if (!broken.length) return material;
    const copy = material.clone();
    for (const [key] of broken) copy[key] = null;
    warnings.add(`${material.name || 'A material'}: skipped ${broken.length} texture${broken.length === 1 ? '' : 's'} that failed to load.`);
    return copy;
  }

  async function buildPart(node, name, pivot, warnings) {
    restore();
    state.root.updateMatrixWorld(true);
    // Relative to the model's own root, so the viewer's "sit on the grid" offset isn't baked in.
    const toModel = state.root.matrixWorld.clone().invert();
    const group = new THREE.Group();
    group.name = name.replace(/\.glb$/, '');

    node.obj.traverse((o) => {
      if (!o.isMesh) return;
      if (o.isSkinnedMesh) {
        warnings.add(`${displayName(node)}: skinned (rigged) meshes can't be baked; skipped.`);
        return;
      }
      const m = new THREE.Matrix4().multiplyMatrices(toModel, o.matrixWorld);
      const g = o.geometry.clone();
      g.applyMatrix4(m);
      if (m.determinant() < 0) flipWinding(g);
      const mesh = new THREE.Mesh(g, Array.isArray(o.material) ? o.material.map((m) => exportable(m, warnings)) : exportable(o.material, warnings));
      mesh.name = o.name && !GENERIC_NAME.test(o.name) ? o.name : group.name;
      group.add(mesh);
    });
    if (!group.children.length) return null;

    const scale = Number($('s-scale').value) || 1;
    if (scale !== 1) for (const mesh of group.children) mesh.geometry.scale(scale, scale, scale);

    if (pivot !== 'keep') {
      const box = new THREE.Box3().setFromObject(group);
      const c = box.getCenter(new THREE.Vector3());
      const y = pivot === 'bottom' ? box.min.y : c.y;
      for (const mesh of group.children) mesh.geometry.translate(-c.x, -y, -c.z);
    }

    // Keep the original image bytes where we have them (GLTFExporter would re-encode them, usually larger).
    const images = new Map();
    for (const mesh of group.children) {
      for (const mat of [mesh.material].flat()) {
        for (const tex of Object.values(mat)) {
          if (!tex?.isTexture || images.has(tex)) continue;
          const orig = await originalImage(state.source, tex);
          if (orig) images.set(tex, orig);
        }
      }
    }
    try {
      // A single mesh is exported on its own: one node, named after the file, identity transform.
      const single = group.children.length === 1 ? group.children[0] : null;
      if (single) single.name = group.name;
      return await exportGlb(single || group, images);
    } finally {
      for (const mesh of group.children) mesh.geometry.dispose();
    }
  }

  async function buildAll() {
    const nodes = checkedInOrder();
    const names = fileNames(nodes);
    const pivot = $('s-pivot').value;
    const warnings = new Set();
    const files = [];
    for (let i = 0; i < nodes.length; i++) {
      setStatus(`Building ${i + 1} of ${nodes.length}: ${names[i]}…`);
      await new Promise((r) => setTimeout(r)); // let the status paint
      const data = await buildPart(nodes[i], names[i], pivot, warnings);
      if (data) files.push({ name: names[i], data });
    }
    return { files, warnings: [...warnings] };
  }

  // ---------- Output ----------

  function setStatus(text, kind = '') {
    $('s-status').textContent = text;
    $('s-status').className = 'x-status ' + kind;
  }

  async function withBusy(fn) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await fn();
    } catch (err) {
      console.error(err);
      setStatus(err.message || String(err), 'err');
    } finally {
      state.busy = false;
      render();
    }
  }

  const total = (files) => ctx.formatSize(files.reduce((n, f) => n + f.data.length, 0));

  function save() {
    return withBusy(async () => {
      if (!ctx.getDest()) await ctx.browse();
      const dest = ctx.getDest();
      if (!dest) return setStatus('Choose a folder first (Browse… above).', 'err');

      const { files, warnings } = await buildAll();
      const check = await ctx.postJson('/api/generated/check', { dest, files: files.map((f) => ({ name: f.name, size: f.data.length })) });
      if (!check.res.ok) throw new Error(check.data.error || check.res.statusText);
      if (check.data.conflicts.length) {
        const lines = check.data.conflicts.map((c) => `${c.out}  (yours ${ctx.formatSize(c.existingSize)} → new ${ctx.formatSize(c.newSize)})`);
        if (!confirm(`These files already exist in the folder with a different size:\n\n${lines.join('\n')}\n\nOverwrite them?`)) {
          return setStatus('Nothing saved — your existing files were kept.', 'err');
        }
      }

      let last;
      for (let i = 0; i < files.length; i++) {
        setStatus(`Saving ${i + 1} of ${files.length}: ${files[i].name}…`);
        const url = `/api/generated/write?dest=${encodeURIComponent(dest)}&name=${encodeURIComponent(files[i].name)}`;
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: files[i].data });
        last = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
        if (!res.ok) throw new Error(`${files[i].name}: ${last.error || res.statusText}`);
      }
      if (last) ctx.applySettings(last);
      setStatus(`✓ Saved ${files.length} file${files.length === 1 ? '' : 's'} (${total(files)}) → ${last?.dest || dest}` + (warnings.length ? `\n⚠ ${warnings.join('\n⚠ ')}` : ''), 'ok');
    });
  }

  function downloadZip() {
    return withBusy(async () => {
      const { files, warnings } = await buildAll();
      const zip = makeZip(files);
      const a = el('a');
      a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
      a.download = `${state.asset?.id.split('/').pop() || 'model'}-parts.zip`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      setStatus(`✓ Zipped ${files.length} file${files.length === 1 ? '' : 's'} (${ctx.formatSize(zip.length)})` + (warnings.length ? `\n⚠ ${warnings.join('\n⚠ ')}` : ''), 'ok');
    });
  }

  $('s-auto').addEventListener('click', selectSuggested);
  $('s-all-meshes').addEventListener('click', () => {
    const meshes = state.nodes.filter((n) => n.obj.isMesh);
    state.checked = new Set(meshes);
    expandTo(meshes);
    render();
  });
  $('s-none').addEventListener('click', () => {
    state.checked.clear();
    render();
  });
  $('s-prefix').addEventListener('input', render);
  $('s-save').addEventListener('click', save);
  $('s-zip').addEventListener('click', downloadZip);
  $('s-tree').addEventListener('mouseleave', restore);

  return { setModel, clear };
}
