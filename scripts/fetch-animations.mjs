// fetch-animations.mjs
//
// `npm run animations:fetch` — downloads CC0 humanoid animation packs into
// this library's animations/ (ANIMATION_LIBRARY puts them elsewhere), to
// browse here and send to projects. (Moved from there-is-rope, which no longer
// reads this library.)
//
// A pack ships as one or more GLBs holding its clips. They're split into one
// small GLB per clip (skeleton only, no mesh) in <pack>/clips/, each carrying
// two clips: the animation (first, so "clip 0" is the motion) and
// "Reference", its rig's T-pose. A file with a Reference clip is retargeted
// from its own pose (there-is-rope's rig/AnimationLibrary.ownReference), so packs on other
// rigs than the project's Mixamo clips work side by side. Clips are compacted
// on the way (optimizeAnimation.mjs): a baked clip stores every bone every frame.
//
//   npm run animations:fetch                     a few starter clips of every pack
//   npm run animations:fetch -- --all            every clip
//   npm run animations:fetch -- --pack ual1 --clips Idle_Loop,Walk_Loop
//   npm run animations:fetch -- --list           the clips each pack has
//   npm run animations:fetch -- --pack kaykit --zip ~/Downloads/<file>.zip --all
//
// Packs without a direct download (itch.io "name your own price") need --zip:
// download it in a browser, then point the tool at the file.
//
// The pack's original GLBs are kept in <pack>/source/, so splitting more
// clips later doesn't download again. Existing clips are skipped; --force
// rewrites them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzip } from './unzip.mjs';
import { optimizeAnimationGlb } from './optimizeAnimation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const LIBRARY = path.resolve(process.env.ANIMATION_LIBRARY ?? path.resolve(REPO_ROOT, 'animations'));

/** The name the T-pose clip gets in every split file (rig/AnimationLibrary.ownReference). */
const REFERENCE = 'Reference';

/**
 * id: the folder in the library. glb: which files inside the zip hold the
 * clips (glTF exports with the full hierarchy; several files are fine, each
 * with its own reference clip). reference: the T-pose clip. zip: a direct
 * download, or null when it has to be downloaded by hand (`download`, --zip).
 */
const PACKS = [
    {
        id: 'quaternius-ual-1',
        alias: 'ual1',
        name: 'Universal Animation Library',
        author: 'Quaternius',
        license: 'CC0 1.0',
        page: 'https://quaternius.com/packs/universalanimationlibrary.html',
        zip: 'https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip',
        glb: /Godot\/.*\.glb$/,
        reference: 'A_TPose',
        starters: ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Idle_Talking_Loop', 'Sitting_Idle_Loop', 'PickUp_Table'],
    },
    {
        id: 'quaternius-ual-2',
        alias: 'ual2',
        name: 'Universal Animation Library 2',
        author: 'Quaternius',
        license: 'CC0 1.0',
        page: 'https://quaternius.com/packs/universalanimationlibrary2.html',
        zip: 'https://opengameart.org/sites/default/files/universal_animation_library_2standard.zip',
        // The female mannequin model ships in the same folder: only the clip file.
        glb: /Unreal-Godot\/UAL2_[^/]*\.glb$/,
        reference: 'A_TPose',
        starters: ['Idle_FoldArms_Loop', 'Idle_No_Loop', 'Yes', 'Idle_Lantern_Loop'],
    },
    {
        // The humanoid KayKit rig (Rig_Medium: regular characters; no fingers or neck).
        // OpenGameArt's "KayKit Character Animations" is the older blocky-character set: not this.
        id: 'kaykit-character-animations',
        alias: 'kaykit',
        name: 'KayKit Character Animations',
        author: 'Kay Lousberg',
        license: 'CC0 1.0',
        page: 'https://kaylousberg.itch.io/kaykit-character-animations',
        zip: null,
        download: 'https://kaylousberg.itch.io/kaykit-character-animations',
        glb: /Rig_Medium\/[^/]*\.glb$/i,
        reference: 'T-Pose',
        starters: [],
    },
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};

const wantedPack = option('pack');
const packs = PACKS.filter((p) => !wantedPack || p.id === wantedPack || p.alias === wantedPack);
if (!packs.length) {
    console.error(`❌ No pack "${wantedPack}". Packs: ${PACKS.map((p) => `${p.alias} (${p.id})`).join(', ')}`);
    process.exit(1);
}
const clipList = option('clips')?.split(',').map((s) => s.trim()).filter(Boolean);

for (const pack of packs) await fetchPack(pack);

async function fetchPack(pack) {
    const dir = path.resolve(LIBRARY, pack.id);
    const sourceDir = path.resolve(dir, 'source');
    const localZip = option('zip');
    let sources = fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir).filter((f) => /\.glb$/i.test(f)) : [];

    if (!sources.length || (localZip && wantedPack)) {
        if (!pack.zip && !(localZip && wantedPack)) {
            console.log(`⏭️  ${pack.name}: download it from ${pack.download} (free), then\n    npm run animations:fetch -- --pack ${pack.alias} --zip <the .zip> --all`);
            return;
        }
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-pack-'));
        let zip = localZip && wantedPack ? path.resolve(localZip.replace(/^~/, os.homedir())) : path.resolve(tmp, 'pack.zip');
        if (!(localZip && wantedPack)) {
            console.log(`⬇️  ${pack.name}: ${pack.zip}`);
            const response = await fetch(pack.zip);
            if (!response.ok) throw new Error(`${pack.zip}: ${response.status}`);
            fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
        }
        unzip(zip, tmp);
        const files = walk(tmp);
        const glbs = files.filter((f) => pack.glb.test(f.split(path.sep).join('/')));
        if (!glbs.length) throw new Error(`${pack.name}: no file matching ${pack.glb} in ${zip}`);
        fs.mkdirSync(sourceDir, { recursive: true });
        for (const glb of glbs) fs.copyFileSync(glb, path.resolve(sourceDir, path.basename(glb)));
        for (const extra of files.filter((f) => /(License\.txt|Preview\.png)$/i.test(f))) {
            fs.copyFileSync(extra, path.resolve(dir, path.basename(extra)));
        }
        fs.rmSync(tmp, { recursive: true, force: true });
        sources = glbs.map((g) => path.basename(g));
    }

    // Every clip of every source file (the reference clips aside); a name used by
    // more than one file is told apart by its file's name.
    const files = sources.sort().map((file) => {
        const glb = readGlb(fs.readFileSync(path.resolve(sourceDir, file)));
        const reference = glb.json.animations.findIndex((a) => a.name === pack.reference);
        if (reference < 0) throw new Error(`${pack.name}: no reference clip "${pack.reference}" in ${file}`);
        return { file, glb, reference };
    });
    const all = files.flatMap((f) => f.glb.json.animations.map((a, index) => ({ ...f, index, name: a.name }))
        .filter((c) => c.index !== f.reference));
    const count = new Map();
    for (const c of all) count.set(c.name, (count.get(c.name) ?? 0) + 1);
    for (const c of all) c.out = count.get(c.name) > 1 ? `${c.file.replace(/\.glb$/i, '')}_${c.name}` : c.name;

    if (flag('list')) {
        console.log(`${pack.name} (${pack.alias}): ${all.length} clips\n  ${all.map((c) => c.out).join(', ')}`);
        return;
    }

    const wanted = flag('all') ? all.map((c) => c.out) : clipList ?? pack.starters;
    const missing = wanted.filter((n) => !all.some((c) => c.out === n));
    if (missing.length) console.warn(`⚠️  ${pack.name}: no clip ${missing.join(', ')}`);

    const clipsDir = path.resolve(dir, 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });
    let written = 0;
    for (const clip of all.filter((c) => wanted.includes(c.out))) {
        const out = path.resolve(clipsDir, `${safeFile(clip.out)}.glb`);
        if (fs.existsSync(out) && !flag('force')) continue;
        // Compacted like the editor's optimizer: still-standing bones keep one key, redundant keys go.
        fs.writeFileSync(out, optimizeAnimationGlb(splitClip(clip.glb, clip.index, clip.reference)).glb);
        written++;
    }

    const meta = {
        name: pack.name, author: pack.author, license: pack.license, page: pack.page,
        reference: REFERENCE, clipCount: all.length,
    };
    fs.writeFileSync(path.resolve(dir, 'pack.json'), JSON.stringify(meta, null, 4) + '\n');
    const have = fs.readdirSync(clipsDir).filter((f) => f.endsWith('.glb')).length;
    console.log(`✅ ${pack.name}: ${written} new, ${have}/${all.length} clips in ${path.relative(process.cwd(), clipsDir)}`);
}

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.resolve(dir, e.name);
        return e.isDirectory() ? walk(full) : [full];
    });
}

function safeFile(name) {
    return name.replace(/[^A-Za-z0-9_-]+/g, '_');
}

function readGlb(buffer) {
    const jsonLength = buffer.readUInt32LE(12);
    const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf-8'));
    const binHeader = 20 + jsonLength;
    const bin = buffer.subarray(binHeader + 8, binHeader + 8 + buffer.readUInt32LE(binHeader));
    return { json, bin };
}

/**
 * One clip as its own GLB: every node (the skeleton, meshes dropped), the
 * skin (joints + inverse binds, so tools still see a rig), the clip, then the
 * reference clip renamed to REFERENCE. Only the data those use is kept.
 */
function splitClip(source, clipIndex, referenceIndex) {
    const { json, bin } = source;
    const accessors = [];
    const views = [];
    const chunks = [];
    let offset = 0;
    const remap = new Map();
    const copyAccessor = (index) => {
        if (remap.has(index)) return remap.get(index);
        const accessor = json.accessors[index];
        const view = json.bufferViews[accessor.bufferView];
        const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
        const bytes = { 5126: 4, 5123: 2, 5125: 4, 5121: 1 }[accessor.componentType];
        const length = accessor.count * size * bytes;
        const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        if (view.byteStride && view.byteStride !== size * bytes) throw new Error('interleaved animation data is not supported');
        chunks.push(bin.subarray(start, start + length));
        views.push({ buffer: 0, byteOffset: offset, byteLength: length });
        offset += length;
        const pad = (4 - (offset % 4)) % 4;
        if (pad) {
            chunks.push(Buffer.alloc(pad));
            offset += pad;
        }
        const { byteOffset: _, ...rest } = accessor;
        accessors.push({ ...rest, bufferView: views.length - 1 });
        remap.set(index, accessors.length - 1);
        return accessors.length - 1;
    };
    const copyAnimation = (animation, name) => ({
        name,
        channels: animation.channels.filter((c) => c.target.path !== 'weights'),
        samplers: animation.samplers.map((s) => ({ ...s, input: copyAccessor(s.input), output: copyAccessor(s.output) })),
    });

    const clip = json.animations[clipIndex];
    const out = {
        asset: { version: '2.0', generator: 'library3d fetch-animations' },
        scene: 0,
        scenes: json.scenes,
        nodes: json.nodes.map(({ mesh: _m, skin: _s, ...node }) => node),
        skins: (json.skins ?? []).map((s) => ({ ...s, inverseBindMatrices: s.inverseBindMatrices !== undefined ? copyAccessor(s.inverseBindMatrices) : undefined })),
        animations: [copyAnimation(clip, clip.name), copyAnimation(json.animations[referenceIndex], REFERENCE)],
    };
    out.accessors = accessors;
    out.bufferViews = views;
    out.buffers = [{ byteLength: offset }];
    if (!out.skins.length) delete out.skins;
    return writeGlb(out, Buffer.concat(chunks));
}

function writeGlb(json, bin) {
    let text = Buffer.from(JSON.stringify(json), 'utf-8');
    const jsonPad = (4 - (text.length % 4)) % 4;
    text = Buffer.concat([text, Buffer.alloc(jsonPad, 0x20)]);
    const binPad = (4 - (bin.length % 4)) % 4;
    const body = Buffer.concat([bin, Buffer.alloc(binPad)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + text.length + 8 + body.length, 8);
    const chunk = (type, data) => {
        const h = Buffer.alloc(8);
        h.writeUInt32LE(data.length, 0);
        h.writeUInt32LE(type, 4);
        return Buffer.concat([h, data]);
    };
    return Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, body)]);
}
