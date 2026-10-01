// Works out which files a model needs (buffers, materials, textures) so it can be copied somewhere else and still load.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_RE = /[^\0"'<>|*?\r\n]{1,260}?\.(png|jpe?g|tga|bmp|gif|webp)\b/gi;

const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);
const toPosix = (p) => p.split(path.sep).join('/');

/**
 * @param {string} filesRoot absolute path of files/
 * @param {string} rel model path relative to files/ (posix)
 * @returns {Promise<{ files: { src: string, out: string }[], warnings: string[] }>}
 *   src: path relative to files/, out: path relative to the destination folder.
 */
export async function resolveDeps(filesRoot, rel) {
  const modelAbs = path.join(filesRoot, rel);
  const dir = path.dirname(modelAbs);
  const ext = path.extname(rel).slice(1).toLowerCase();
  const files = new Map();
  const warnings = [];

  const add = (abs) => {
    const relToFiles = toPosix(path.relative(filesRoot, abs));
    if (relToFiles.startsWith('..')) return;
    let out = toPosix(path.relative(dir, abs));
    // References that climb out of the model's folder would break once copied; flatten them next to the model.
    if (out.startsWith('..')) {
      out = path.basename(abs);
      warnings.push(`${out} was outside the model folder; copied next to it (you may need to fix the reference).`);
    }
    files.set(relToFiles, out);
  };

  // A URI/path written inside a model file, resolved relative to `base`.
  const addRef = async (base, ref, what) => {
    if (!ref || ref.startsWith('data:')) return;
    let decoded = ref;
    try {
      decoded = decodeURIComponent(ref);
    } catch {}
    const abs = path.resolve(base, decoded.replaceAll('\\', '/'));
    if (await isFile(abs)) add(abs);
    else warnings.push(`Missing ${what}: ${ref}`);
  };

  add(modelAbs);

  if (ext === 'gltf' || ext === 'glb') {
    const json = ext === 'gltf' ? JSON.parse(await readFile(modelAbs, 'utf8')) : readGlbJson(await readFile(modelAbs));
    for (const b of json.buffers || []) await addRef(dir, b.uri, 'buffer');
    for (const img of json.images || []) await addRef(dir, img.uri, 'texture');
  } else if (ext === 'obj') {
    const text = await readFile(modelAbs, 'utf8');
    const mtls = [...text.matchAll(/^mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]);
    for (const m of mtls) {
      const mtlAbs = path.resolve(dir, m);
      if (!(await isFile(mtlAbs))) {
        warnings.push(`Missing material: ${m}`);
        continue;
      }
      add(mtlAbs);
      const mtl = await readFile(mtlAbs, 'utf8');
      // map_Kd [-options] file — the file name is the last token on the line.
      for (const line of mtl.matchAll(/^\s*(map_\w+|bump|disp|decal|refl|norm)\s+(.+?)\s*$/gim)) {
        await addRef(path.dirname(mtlAbs), line[2].split(/\s+/).at(-1), 'texture');
      }
    }
  } else if (ext === 'fbx') {
    // FBX stores texture paths as strings, often an absolute path from the author's machine.
    // Match by file name in the folders textures usually live in.
    const buf = await readFile(modelAbs);
    const names = new Set();
    for (const m of buf.toString('latin1').matchAll(IMAGE_RE)) names.add(m[0].replaceAll('\\', '/'));
    const found = new Set();
    for (const ref of names) {
      const base = path.posix.basename(ref);
      if (found.has(base.toLowerCase())) continue;
      const candidates = [
        path.resolve(dir, ref.replace(/^[a-z]:\//i, '/').replace(/^\/+/, '')),
        path.join(dir, base),
        path.join(dir, 'Textures', base),
        path.join(dir, 'textures', base),
        path.join(dir, '..', 'texture', base),
        path.join(dir, '..', 'textures', base),
        path.join(dir, '..', 'Textures', base),
      ];
      for (const c of candidates) {
        if (c.startsWith(dir + path.sep) || c.startsWith(path.dirname(dir) + path.sep)) {
          if (await isFile(c)) {
            add(c);
            found.add(base.toLowerCase());
            break;
          }
        }
      }
    }
    for (const ref of names) if (!found.has(path.posix.basename(ref).toLowerCase())) warnings.push(`Texture not found: ${path.posix.basename(ref)}`);
  }

  return { files: [...files].map(([src, out]) => ({ src, out })), warnings: [...new Set(warnings)] };
}

function readGlbJson(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('Not a GLB file');
  const len = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB has no JSON chunk');
  return JSON.parse(buf.toString('utf8', 20, 20 + len));
}
