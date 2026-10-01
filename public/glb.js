// GLB helpers shared by the splitter and the optimizer.
// GLTFExporter always re-encodes images through a canvas as PNG/JPEG. To control the exact image bytes (the original
// file, or our own resized/re-encoded version), textures are tagged by name before export and their images are
// swapped in the binary afterwards.
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const TAG = '__glb_img_';
const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;

/** @returns {{ json: object, bin: Uint8Array }} */
export function parseGlb(glb) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB file');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
  const binStart = 20 + jsonLen;
  const bin = binStart + 8 <= glb.length ? glb.subarray(binStart + 8, binStart + 8 + dv.getUint32(binStart, true)) : new Uint8Array();
  return { json, bin };
}

export function packGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + (bin.length ? 8 + bin.length : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, GLB_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  if (bin.length) {
    const o = 20 + jsonBytes.length + jsonPad;
    dv.setUint32(o, bin.length, true);
    dv.setUint32(o + 4, GLB_BIN, true);
    out.set(bin, o + 8);
  }
  return out;
}

/**
 * Original PNG/JPEG/WebP bytes of a texture loaded by GLTFLoader, or null if unknown.
 * @param {{ parser: object, url: string } | null} source
 */
export async function originalImage(source, tex) {
  const parser = source?.parser;
  // flipY textures (OBJ/FBX) get flipped by the exporter, so their original bytes would be upside down.
  if (!parser || tex.flipY) return null;
  const ref = parser.associations.get(tex);
  if (ref?.textures == null) return null;
  const texDef = parser.json.textures?.[ref.textures];
  const imageIndex = texDef?.source ?? texDef?.extensions?.EXT_texture_webp?.source;
  const img = parser.json.images?.[imageIndex];
  if (!img) return null;
  let bytes;
  if (img.bufferView != null) bytes = new Uint8Array(await parser.getDependency('bufferView', img.bufferView));
  else if (img.uri) bytes = new Uint8Array(await (await fetch(new URL(img.uri, source.url))).arrayBuffer());
  else return null;
  const mimeType = img.mimeType || (/\.jpe?g(\?|$)/i.test(img.uri || '') ? 'image/jpeg' : /\.webp(\?|$)/i.test(img.uri || '') ? 'image/webp' : 'image/png');
  return ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) ? { bytes, mimeType } : null;
}

/**
 * Export to GLB, using the given bytes for each texture's image.
 * @param {import('three').Object3D | import('three').Object3D[]} input
 * @param {Map<import('three').Texture, { bytes: Uint8Array, mimeType: string }>} images
 * @param {{ animations?: import('three').AnimationClip[] }} [options]
 */
export async function exportGlb(input, images = new Map(), { animations = [] } = {}) {
  const roots = [input].flat();
  const used = new Set();
  for (const root of roots) {
    root.traverse((o) => {
      for (const m of [o.material].flat().filter(Boolean)) for (const v of Object.values(m)) if (v?.isTexture) used.add(v);
    });
  }

  const tags = new Map();
  const renamed = [];
  for (const tex of used) {
    const img = images.get(tex);
    if (!img) continue;
    const tag = TAG + tags.size;
    tags.set(tag, { ...img, name: tex.name });
    renamed.push([tex, tex.name]);
    tex.name = tag;
  }

  let glb;
  try {
    // When every image gets replaced anyway, let the exporter write tiny placeholders instead of full-size PNGs.
    const maxTextureSize = tags.size && tags.size === used.size ? 4 : Infinity;
    glb = new Uint8Array(await new GLTFExporter().parseAsync(roots.length === 1 ? roots[0] : roots, { binary: true, animations, maxTextureSize }));
  } finally {
    for (const [tex, name] of renamed) tex.name = name;
  }
  return tags.size ? replaceImages(glb, tags) : glb;
}

function replaceImages(glb, tags) {
  const { json, bin } = parseGlb(glb);
  const views = (json.bufferViews || []).map((bv) => bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength));
  let webp = false;
  for (const t of json.textures || []) {
    const img = tags.get(t.name);
    if (!img) continue;
    if (img.name) t.name = img.name;
    else delete t.name;
    const imageDef = json.images?.[t.source];
    if (imageDef?.bufferView == null) continue;
    views[imageDef.bufferView] = img.bytes;
    imageDef.mimeType = img.mimeType;
    if (img.mimeType === 'image/webp') {
      t.extensions = { ...t.extensions, EXT_texture_webp: { source: t.source } };
      delete t.source;
      webp = true;
    }
  }
  if (webp) {
    json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'EXT_texture_webp'])];
    json.extensionsRequired = [...new Set([...(json.extensionsRequired || []), 'EXT_texture_webp'])];
  }

  let size = 0;
  const offsets = views.map((v) => {
    const o = size;
    size += Math.ceil(v.length / 4) * 4;
    return o;
  });
  const newBin = new Uint8Array(size);
  views.forEach((v, i) => {
    newBin.set(v, offsets[i]);
    json.bufferViews[i].byteOffset = offsets[i];
    json.bufferViews[i].byteLength = v.length;
  });
  if (json.buffers?.[0]) json.buffers[0].byteLength = size;
  return packGlb(json, newBin);
}
