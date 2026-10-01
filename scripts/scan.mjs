#!/usr/bin/env node
// Walks files/ and writes library/index.json. Read-only: never renames, moves or writes inside files/.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = path.join(ROOT, 'files');
const OUT = path.join(ROOT, 'library', 'index.json');

// Primary format used by the viewer/thumbnailer is the first one an asset has.
const FORMAT_PRIORITY = ['gltf', 'glb', 'fbx', 'obj', 'fbx-unity', 'blend'];
const MODEL_EXTS = new Set(['gltf', 'glb', 'fbx', 'obj', 'blend']);
const PREVIEW_EXTS = new Set(['png', 'gif', 'jpg', 'jpeg']);

// Folders that only say "which format lives here"; everything after them is a sub-path, everything before is context.
const FORMAT_DIR = /^(fbx|fbx ?\(unity\)|gltf|glb|obj|blends?|(fbx|glb|gltf|obj) format|models)$/i;
const UNITY_DIR = /^fbx ?\(unity\)$/i;
const PREVIEW_DIR = /^previews?$/i;
const NOISE_DIR = /^(assets|models|animations|character)$/i;

// Known packs by top-level folder. Unknown packs fall back to a cleaned-up folder name.
const PACKS = [
  { match: /^KayKit_Bits_Bundle1/i, id: 'kaykit-bits-1', name: 'KayKit Bits 1', author: 'Kay Lousberg' },
  { match: /^KayKit_Bits_Bundle2/i, id: 'kaykit-bits-2', name: 'KayKit Bits 2', author: 'Kay Lousberg' },
  { match: /^KayKit_Forest_Nature/i, id: 'kaykit-forest-nature', name: 'KayKit Forest Nature', author: 'Kay Lousberg' },
  { match: /^kenney_castle-kit/i, id: 'kenney-castle-kit', name: 'Kenney Castle Kit', author: 'Kenney', collection: 'Castle Kit', layout: 'kenney' },
  { match: /^kenney_city-kit-commercial/i, id: 'kenney-city-commercial', name: 'Kenney City Kit (Commercial)', author: 'Kenney', collection: 'City Commercial', layout: 'kenney' },
  { match: /^kenney_survival-kit/i, id: 'kenney-survival-kit', name: 'Kenney Survival Kit', author: 'Kenney', collection: 'Survival Kit', layout: 'kenney' },
  { match: /^Ultimate Nature Pack/i, id: 'quaternius-ultimate-nature', name: 'Quaternius Ultimate Nature', author: 'Quaternius', collection: 'Ultimate Nature' },
  { match: /^3D_desert_plants/i, id: 'desert-plants', name: 'Desert Plants', collection: 'Desert Plants' },
];

// Extra tags per collection id, on top of the tokens found in names.
const CATEGORY_TAGS = {
  'city-builder': ['city'],
  furniture: ['furniture', 'interior'],
  halloween: ['halloween', 'spooky'],
  prototype: ['prototype'],
  restaurant: ['food', 'interior', 'restaurant'],
  'space-base': ['space', 'scifi'],
  block: ['blocks'],
  'board-game': ['game'],
  'fantasy-weapons': ['weapon', 'fantasy'],
  holiday: ['holiday', 'christmas'],
  'rpg-tools': ['tools', 'rpg'],
  resource: ['resource'],
  'forest-nature': ['nature', 'forest'],
  'castle-kit': ['castle', 'medieval'],
  'city-commercial': ['city', 'building'],
  'survival-kit': ['survival'],
  'ultimate-nature': ['nature'],
  'desert-plants': ['nature', 'plant', 'desert'],
};

const STOPWORDS = new Set(['the', 'and', 'with', 'for', 'bits', 'kit', 'pack', 'color', 'colour', 'variation', 'ultimate', 'large', 'small', 'medium']);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// "KayKit Block Bits 1.0" -> "Block", "KayKit_Forest_Nature_Pack_1.0_FREE" -> "Forest Nature".
function cleanFolderName(s) {
  return s
    .replace(/\(\d+\)/g, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\bv?\d+(\.\d+)+\b/gi, ' ')
    .replace(/\b(kaykit|bits|pack|free|lowpoly|low poly|3d|by quaternius)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "01_saguaro_cactus" -> "Saguaro Cactus", "BirchTree_1" -> "Birch Tree 1", "building-a" -> "Building A".
function labelFromStem(stem) {
  return stem
    .replace(/^\d+[_-]+/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function tokens(s) {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/^color\d+$/.test(t) && !STOPWORDS.has(t));
}

function packFor(top) {
  const known = PACKS.find((p) => p.match.test(top));
  if (known) return known;
  const name = cleanFolderName(top) || top;
  return { id: slug(name), name, collection: name };
}

async function licenseFor(topDir) {
  const entries = await readdir(topDir, { recursive: true, withFileTypes: true });
  const lic = entries.find((e) => e.isFile() && /^licen[sc]e(\.txt|\.md)?$/i.test(e.name));
  if (!lic) return { license: 'Unknown', licenseFile: null };
  const full = path.join(lic.parentPath, lic.name);
  const text = await readFile(full, 'utf8');
  const license = /\bCC0\b|Creative Commons Zero/i.test(text) ? 'CC0' : 'See license';
  return { license, licenseFile: path.relative(FILES, full).split(path.sep).join('/') };
}

async function main() {
  const entries = await readdir(FILES, { recursive: true, withFileTypes: true });
  const assets = new Map();
  const previews = new Map();
  const packs = new Map();
  const fileSet = new Set();
  let duplicates = 0;

  const files = entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(FILES, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
  for (const f of files) fileSet.add(f);

  for (const rel of files) {
    const segs = rel.split('/');
    const fileName = segs.pop();
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0) continue;
    const ext = fileName.slice(dot + 1).toLowerCase();
    const stem = fileName.slice(0, dot);
    const top = segs[0];
    if (!top) continue;
    const pack = packFor(top);

    if (!packs.has(pack.id)) {
      packs.set(pack.id, { ...pack, match: undefined, top, textureVariants: [], count: 0, collections: new Map() });
    }
    const packInfo = packs.get(pack.id);

    // Kenney ships alternate colour maps in Models/Textures; the viewer can swap them in.
    if (pack.layout === 'kenney' && ext === 'png' && segs.length === 3 && /^models$/i.test(segs[1]) && /^textures$/i.test(segs[2])) {
      packInfo.textureVariants.push({ name: labelFromStem(stem), path: rel });
      continue;
    }

    if (PREVIEW_EXTS.has(ext) && segs.some((s) => PREVIEW_DIR.test(s))) {
      previews.set(`${pack.id}|${slug(stem)}`, rel);
      continue;
    }
    if (!MODEL_EXTS.has(ext)) continue;

    const fi = segs.findLastIndex((s) => FORMAT_DIR.test(s));
    const ctx = segs.slice(1, fi === -1 ? segs.length : fi);
    const sub = fi === -1 ? [] : segs.slice(fi + 1);

    const kind = ctx.some((s) => /^animations$/i.test(s)) ? 'animation' : ctx.some((s) => /^character$/i.test(s)) ? 'character' : 'model';
    const collCandidates = ctx.filter((s) => !NOISE_DIR.test(s)).map(cleanFolderName).filter(Boolean);
    const collection = collCandidates.at(-1) || pack.collection || pack.name;
    const collectionId = slug(collection);

    const format = ext === 'fbx' && segs.some((s) => UNITY_DIR.test(s)) ? 'fbx-unity' : ext;
    const idParts = [pack.id, collectionId, kind === 'model' ? null : kind, ...sub.map(slug), slug(stem)].filter(Boolean);
    const id = idParts.join('/');

    let asset = assets.get(id);
    if (!asset) {
      const name = labelFromStem(stem);
      const tags = new Set([
        ...tokens(name),
        ...tokens(collection),
        ...sub.flatMap(tokens),
        ...(CATEGORY_TAGS[collectionId] || []),
        ...(kind === 'model' ? [] : [kind]),
      ]);
      asset = {
        id,
        name,
        pack: pack.name,
        packId: pack.id,
        collection,
        collectionId,
        kind,
        tags: [...tags].sort(),
        formats: {},
        primary: null,
        mtl: null,
        preview: null,
        license: null,
      };
      assets.set(id, asset);
    }
    if (asset.formats[format]) {
      duplicates++;
      continue;
    }
    asset.formats[format] = rel;
    if (format === 'obj') {
      const mtl = rel.slice(0, -4) + '.mtl';
      if (fileSet.has(mtl)) asset.mtl = mtl;
    }
  }

  for (const p of packs.values()) Object.assign(p, await licenseFor(path.join(FILES, p.top)));

  const list = [...assets.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const a of list) {
    // Keep format keys in priority order so badges render consistently.
    a.formats = Object.fromEntries(FORMAT_PRIORITY.filter((f) => a.formats[f]).map((f) => [f, a.formats[f]]));
    a.primary = Object.keys(a.formats).find((f) => f !== 'blend') || null;
    a.preview = previews.get(`${a.packId}|${slug(a.formats[a.primary]?.split('/').pop().replace(/\.[^.]+$/, '') ?? a.name)}`) || null;
    const p = packs.get(a.packId);
    a.license = p.license;
    p.count++;
    p.collections.set(a.collectionId, a.collection);
  }

  const packList = [...packs.values()]
    .filter((p) => p.count > 0)
    .map(({ id, name, author, license, licenseFile, count, collections, textureVariants }) => ({
      id,
      name,
      author: author || null,
      license,
      licenseFile,
      count,
      collections: [...collections].map(([cid, cname]) => ({ id: cid, name: cname })),
      textureVariants,
    }));

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), formatPriority: FORMAT_PRIORITY, packs: packList, assets: list }));

  const byFormat = {};
  for (const a of list) for (const f of Object.keys(a.formats)) byFormat[f] = (byFormat[f] || 0) + 1;
  console.log(`Scanned ${files.length} files -> ${list.length} assets in ${packList.length} packs`);
  for (const p of packList) console.log(`  ${p.name.padEnd(32)} ${String(p.count).padStart(5)}  ${p.license}  [${p.collections.map((c) => c.name).join(', ')}]`);
  console.log('  formats:', byFormat);
  console.log(`  with preview: ${list.filter((a) => a.preview).length}, no viewable format: ${list.filter((a) => !a.primary).length}, duplicate files skipped: ${duplicates}`);
  console.log(`Wrote ${path.relative(ROOT, OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
