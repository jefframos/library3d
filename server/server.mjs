#!/usr/bin/env node
// Local-only HTTP server for the asset library. No framework, no dependencies.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, readdir, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDeps } from './deps.mjs';
import { makeZip } from '../public/zip.js';
import { pickFolder } from './pick-folder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = path.join(ROOT, 'files');
const PUBLIC = path.join(ROOT, 'public');
const INDEX = path.join(ROOT, 'library', 'index.json');
const THUMBS = path.join(ROOT, 'library', 'thumbs');
const SETTINGS = path.join(ROOT, 'library', 'settings.json');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 5173;
const MAX_THUMB_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.blend': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.tga': 'image/x-tga',
  '.txt': 'text/plain; charset=utf-8',
};

// Allow-lists per served root: anything else is a 404, even if it exists.
const ASSET_EXTS = new Set(['.gltf', '.glb', '.bin', '.fbx', '.obj', '.mtl', '.blend', '.png', '.jpg', '.jpeg', '.gif', '.tga', '.txt']);
const PUBLIC_EXTS = new Set(['.html', '.js', '.css', '.svg', '.png']);
const THUMB_EXTS = new Set(['.png']);

const ASSET_ID = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;
const toPosix = (p) => p.split(path.sep).join('/');
const thumbName = (id) => id.replaceAll('/', '__') + '.png';

// Resolve a URL sub-path inside `base`, refusing anything that escapes it.
function resolveInside(base, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  const full = path.resolve(base, rel.replace(/^[/\\]+/, ''));
  return full.startsWith(base + path.sep) ? full : null;
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), TYPES['.json']);

async function serveFile(req, res, full, allowed, { cache = 'no-cache', download = false } = {}) {
  const ext = path.extname(full).toLowerCase();
  if (!allowed.has(ext)) return send(res, 404, 'Not found');
  let info;
  try {
    info = await stat(full);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!info.isFile()) return send(res, 404, 'Not found');
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cache,
    'Last-Modified': info.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`;
  if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(info.mtime.toUTCString())) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(full).on('error', () => res.destroy()).pipe(res);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function saveThumb(req, res, url) {
  const id = url.searchParams.get('id') || '';
  if (!ASSET_ID.test(id)) return send(res, 400, 'Bad asset id');
  if (req.headers['content-type'] !== 'image/png') return send(res, 415, 'Expected image/png');
  const body = await readBody(req, MAX_THUMB_BYTES);
  if (!body.subarray(0, 8).equals(PNG_SIGNATURE)) return send(res, 400, 'Not a PNG');
  await mkdir(THUMBS, { recursive: true });
  await writeFile(path.join(THUMBS, thumbName(id)), body);
  sendJson(res, 201, { ok: true, thumb: thumbName(id) });
}

async function listThumbs(res) {
  let names = [];
  try {
    names = (await readdir(THUMBS)).filter((n) => n.endsWith('.png'));
  } catch {}
  sendJson(res, 200, names);
}

// ---------- Export: a model plus everything it references ----------

let indexCache = { mtime: 0, byId: new Map() };

async function findAsset(id) {
  const info = await stat(INDEX).catch(() => null);
  if (!info) return null;
  if (info.mtimeMs !== indexCache.mtime) {
    const { assets } = JSON.parse(await readFile(INDEX, 'utf8'));
    indexCache = { mtime: info.mtimeMs, byId: new Map(assets.map((a) => [a.id, a])) };
  }
  return indexCache.byId.get(id) || null;
}

async function exportSet(url) {
  const id = url.searchParams.get('id') || '';
  const asset = ASSET_ID.test(id) ? await findAsset(id) : null;
  if (!asset) throw Object.assign(new Error('Unknown asset'), { status: 404 });
  const format = url.searchParams.get('format') || asset.primary;
  const rel = asset.formats[format];
  if (!rel) throw Object.assign(new Error(`Asset has no ${format} file`), { status: 404 });
  const deps = await resolveDeps(FILES, rel);
  for (const f of deps.files) f.size = (await stat(path.join(FILES, f.src))).size;
  return { asset, format, ...deps };
}

// ---------- Settings (last export folder), kept on disk so they survive browser/port changes ----------

const MAX_RECENT = 6;

// "export": where "Use in your game" copies to. "optimize": the folder loaded in the Optimize tab.
const SETTING_KEYS = { export: ['exportDest', 'recentDests'], optimize: ['optimizeDir', 'recentOptimizeDirs'] };

async function readSettings() {
  let s = {};
  try {
    s = JSON.parse(await readFile(SETTINGS, 'utf8'));
  } catch {}
  const out = {};
  for (const [last, recent] of Object.values(SETTING_KEYS)) {
    out[last] = typeof s[last] === 'string' ? s[last] : '';
    out[recent] = Array.isArray(s[recent]) ? s[recent].filter((d) => typeof d === 'string') : [];
  }
  return out;
}

async function rememberDest(dest, kind = 'export') {
  const [last, recent] = SETTING_KEYS[kind];
  const s = await readSettings();
  s[last] = dest;
  s[recent] = [dest, ...s[recent].filter((d) => d.toLowerCase() !== dest.toLowerCase())].slice(0, MAX_RECENT);
  await mkdir(path.dirname(SETTINGS), { recursive: true });
  await writeFile(SETTINGS, JSON.stringify(s, null, 2));
  return s;
}

async function readJsonBody(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('Expected JSON'), { status: 415 });
  try {
    return JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

// Returns an error message, or null if `destAbs` is an existing folder we may write into.
async function checkDest(destAbs) {
  if (destAbs === ROOT || destAbs.startsWith(ROOT + path.sep)) return 'Destination cannot be inside the asset library itself.';
  const info = await stat(destAbs).catch(() => null);
  return info?.isDirectory() ? null : `Folder not found: ${destAbs}`;
}

async function pickFolderRoute(req, res) {
  const body = await readJsonBody(req);
  const kind = body.purpose === 'optimize' ? 'optimize' : 'export';
  const settings = await readSettings();
  const start = typeof body.start === 'string' && path.isAbsolute(body.start) ? body.start : settings[SETTING_KEYS[kind][0]];
  const title = kind === 'optimize' ? 'Choose a folder of models to optimize' : 'Choose the folder in your game to copy models into';
  let picked;
  try {
    picked = await pickFolder({ title, start });
  } catch (err) {
    if (err.status) throw err;
    console.error(err);
    return sendJson(res, 501, { error: "Couldn't open a folder dialog here — paste the folder path instead." });
  }
  if (!picked) return sendJson(res, 200, { cancelled: true });
  const destAbs = path.resolve(picked);
  const problem = await checkDest(destAbs);
  if (problem) return sendJson(res, 400, { error: problem });
  sendJson(res, 200, { dest: destAbs, ...(await rememberDest(destAbs, kind)) });
}

// ---------- Optimize tab: a folder of models outside the library ----------
// The page can only read folders it explicitly opened (POST, so other sites can't trigger it); each gets a random token.

const openFolders = new Map(); // token -> absolute dir
const MODEL_FILE = /\.(glb|gltf)$/i;
const OUTPUT_DIR = 'optimized';
const BACKUP_DIR = '_originals';

async function listModels(dir, recursive) {
  const entries = await readdir(dir, { recursive, withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || !MODEL_FILE.test(e.name)) continue;
    const rel = toPosix(path.relative(dir, path.join(e.parentPath, e.name)));
    // Don't list our own output/backups as inputs.
    if (rel.split('/')[0] === OUTPUT_DIR || rel.split('/')[0] === BACKUP_DIR) continue;
    // Already optimized in place: report (and let the client read) the backed-up original instead.
    const backup = await stat(path.join(dir, BACKUP_DIR, rel)).catch(() => null);
    const info = backup || (await stat(path.join(dir, rel)));
    files.push({ path: rel, size: info.size, mtime: info.mtimeMs, backup: !!backup });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

async function openFolderRoute(req, res) {
  const body = await readJsonBody(req);
  if (typeof body.dir !== 'string' || !path.isAbsolute(body.dir.trim())) return sendJson(res, 400, { error: 'Choose a folder, or paste a full path.' });
  const dir = path.resolve(body.dir.trim());
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return sendJson(res, 400, { error: `Folder not found: ${dir}` });
  let token = [...openFolders].find(([, d]) => d === dir)?.[0];
  if (!token) {
    token = randomBytes(12).toString('hex');
    openFolders.set(token, dir);
  }
  const files = await listModels(dir, !!body.recursive);
  sendJson(res, 200, { token, dir, files, outputDir: OUTPUT_DIR, backupDir: BACKUP_DIR, ...(await rememberDest(dir, 'optimize')) });
}

function resolveInFolder(token, rel) {
  const dir = openFolders.get(token);
  if (!dir) throw Object.assign(new Error('Folder not open — load it again.'), { status: 404 });
  const full = resolveInside(dir, rel);
  if (!full) throw Object.assign(new Error('Bad path'), { status: 400 });
  return { dir, full };
}

// Writes an optimized GLB. mode "subfolder": <dir>/optimized/<path>.glb. mode "replace": backs the original up to
// <dir>/_originals/<path> (only the first time, so the true original is kept) and overwrites it.
async function writeOptimized(req, res, url) {
  const rel = url.searchParams.get('path') || '';
  const mode = url.searchParams.get('mode') === 'replace' ? 'replace' : 'subfolder';
  if (req.headers['content-type'] !== 'model/gltf-binary') return sendJson(res, 415, { error: 'Expected model/gltf-binary' });
  const { dir, full: source } = resolveInFolder(url.searchParams.get('token') || '', encodeURIComponent(rel).replaceAll('%2F', '/'));
  if (!MODEL_FILE.test(rel)) return sendJson(res, 400, { error: 'Only .glb/.gltf inputs can be optimized' });
  const body = await readBody(req, MAX_GENERATED_BYTES);
  if (body.length < 12 || body.toString('latin1', 0, 4) !== 'glTF') return sendJson(res, 400, { error: 'Not a GLB file' });

  const outRel = rel.replace(/\.gltf$/i, '.glb');
  let target;
  let backup = null;
  if (mode === 'replace' && /\.glb$/i.test(rel)) {
    target = source;
    const backupPath = path.join(dir, BACKUP_DIR, rel);
    if (!(await stat(backupPath).catch(() => null))) {
      await mkdir(path.dirname(backupPath), { recursive: true });
      await copyFile(source, backupPath);
    }
    backup = toPosix(path.join(BACKUP_DIR, rel));
  } else {
    target = path.join(dir, OUTPUT_DIR, outRel);
  }
  if (!target.startsWith(dir + path.sep)) return sendJson(res, 400, { error: 'Bad path' });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  sendJson(res, 200, { out: toPosix(path.relative(dir, target)), size: body.length, backup });
}

// Copies into a folder the user chose (e.g. their game's Assets folder).
// An existing file with the same size is assumed to be the same file (typically a shared texture) and replaced
// silently; a different size is a real conflict and needs `overwrite: true`.
async function copyToFolder(req, res) {
  const body = await readJsonBody(req);
  const url = new URL(`http://x/?id=${encodeURIComponent(body.id || '')}&format=${encodeURIComponent(body.format || '')}`);
  const { files, warnings } = await exportSet(url);

  const dest = typeof body.dest === 'string' ? body.dest.trim() : '';
  if (!dest || !path.isAbsolute(dest)) return sendJson(res, 400, { error: 'Choose a folder, or paste a full path like C:\\MyGame\\Assets\\Models' });
  const destAbs = path.resolve(dest);
  const problem = await checkDest(destAbs);
  if (problem) return sendJson(res, 400, { error: problem });

  const plan = [];
  const conflicts = [];
  for (const f of files) {
    const from = path.join(FILES, f.src);
    const to = path.resolve(destAbs, f.out);
    if (!to.startsWith(destAbs + path.sep)) return sendJson(res, 400, { error: `Refusing to write outside destination: ${f.out}` });
    const existing = await stat(to).catch(() => null);
    if (!existing) plan.push({ ...f, from, to, action: 'copy' });
    else if (existing.size === f.size) plan.push({ ...f, from, to, action: 'replace' });
    else {
      conflicts.push({ out: f.out, existingSize: existing.size, newSize: f.size });
      plan.push({ ...f, from, to, action: 'overwrite' });
    }
  }
  if (conflicts.length && !body.overwrite) return sendJson(res, 409, { error: 'Some files already exist with a different size.', conflicts });

  for (const f of plan) {
    await mkdir(path.dirname(f.to), { recursive: true });
    await copyFile(f.from, f.to);
  }
  const settings = await rememberDest(destAbs);
  sendJson(res, 200, {
    dest: destAbs,
    files: plan.map(({ out, action }) => ({ out, action })),
    warnings,
    ...settings,
  });
}

// ---------- Saving files generated in the browser (split parts) ----------

const MAX_GENERATED_BYTES = 256 * 1024 * 1024;
const GENERATED_NAME = /^[\w\- .()]{1,120}\.glb$/i;

async function resolveDest(dest) {
  if (typeof dest !== 'string' || !path.isAbsolute(dest.trim())) throw Object.assign(new Error('Choose a folder, or paste a full path like C:\\MyGame\\Assets\\Models'), { status: 400 });
  const destAbs = path.resolve(dest.trim());
  const problem = await checkDest(destAbs);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  return destAbs;
}

// Same rule as copyToFolder: same size → fine to replace, different size → the client must ask first.
async function checkGenerated(req, res) {
  const body = await readJsonBody(req);
  const destAbs = await resolveDest(body.dest);
  const conflicts = [];
  for (const f of Array.isArray(body.files) ? body.files : []) {
    if (!GENERATED_NAME.test(f?.name || '')) return sendJson(res, 400, { error: `Bad file name: ${f?.name}` });
    const existing = await stat(path.join(destAbs, f.name)).catch(() => null);
    if (existing && existing.size !== f.size) conflicts.push({ out: f.name, existingSize: existing.size, newSize: f.size });
  }
  sendJson(res, 200, { dest: destAbs, conflicts });
}

async function writeGenerated(req, res, url) {
  const name = url.searchParams.get('name') || '';
  if (!GENERATED_NAME.test(name)) return sendJson(res, 400, { error: `Bad file name: ${name}` });
  if (req.headers['content-type'] !== 'model/gltf-binary') return sendJson(res, 415, { error: 'Expected model/gltf-binary' });
  const destAbs = await resolveDest(url.searchParams.get('dest'));
  const body = await readBody(req, MAX_GENERATED_BYTES);
  if (body.length < 12 || body.toString('latin1', 0, 4) !== 'glTF') return sendJson(res, 400, { error: 'Not a GLB file' });
  const existed = !!(await stat(path.join(destAbs, name)).catch(() => null));
  await writeFile(path.join(destAbs, name), body);
  sendJson(res, 200, { dest: destAbs, out: name, action: existed ? 'replace' : 'copy', ...(await rememberDest(destAbs)) });
}

async function sendZip(res, url) {
  const { asset, format, files } = await exportSet(url);
  const entries = [];
  for (const f of files) {
    const full = path.join(FILES, f.src);
    entries.push({ name: f.out, data: await readFile(full), mtime: (await stat(full)).mtime });
  }
  const zip = makeZip(entries);
  const name = `${asset.id.split('/').pop()}-${format}.zip`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  res.end(zip);
}

const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = http.createServer(async (req, res) => {
  try {
    // Reject other Host headers (DNS rebinding) and cross-site writes.
    if (!allowedHosts.has(req.headers.host)) return send(res, 421, 'Misdirected request');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, 'Forbidden');
      if (p === '/api/thumb') return await saveThumb(req, res, url);
      if (p === '/api/export') return await copyToFolder(req, res);
      if (p === '/api/pick-folder') return await pickFolderRoute(req, res);
      if (p === '/api/generated/check') return await checkGenerated(req, res);
      if (p === '/api/generated/write') return await writeGenerated(req, res, url);
      if (p === '/api/folder/open') return await openFolderRoute(req, res);
      if (p === '/api/folder/write') return await writeOptimized(req, res, url);
      return send(res, 404, 'Not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    if (p === '/api/deps') {
      const { files, warnings, format } = await exportSet(url);
      return sendJson(res, 200, { format, files, warnings });
    }
    if (p === '/api/export.zip') return await sendZip(res, url);
    if (p === '/api/settings') return sendJson(res, 200, await readSettings());

    if (p === '/api/index') {
      if (!(await stat(INDEX).catch(() => null))) return send(res, 503, 'No index yet: run `npm run scan` first');
      return await serveFile(req, res, INDEX, new Set(['.json']));
    }
    if (p === '/api/thumbs') return await listThumbs(res);

    if (p.startsWith('/files/')) {
      const full = resolveInside(FILES, p.slice('/files/'.length));
      if (!full) return send(res, 404, 'Not found');
      return await serveFile(req, res, full, ASSET_EXTS, { cache: 'max-age=3600', download: url.searchParams.has('download') });
    }
    // /local/<token>/<path inside an opened folder> — path-style so .gltf files can resolve their .bin/textures.
    const local = p.match(/^\/local\/([0-9a-f]{24})\/(.+)$/);
    if (local) {
      const { full } = resolveInFolder(local[1], local[2]);
      return await serveFile(req, res, full, ASSET_EXTS);
    }
    if (p.startsWith('/thumbs/')) {
      const full = resolveInside(THUMBS, p.slice('/thumbs/'.length));
      if (!full) return send(res, 404, 'Not found');
      return await serveFile(req, res, full, THUMB_EXTS);
    }

    const full = resolveInside(PUBLIC, p === '/' ? 'index.html' : p);
    if (!full) return send(res, 404, 'Not found');
    return await serveFile(req, res, full, PUBLIC_EXTS);
  } catch (err) {
    console.error(err);
    if (res.headersSent) return;
    const message = err.status ? err.message : 'Server error';
    if (req.url.startsWith('/api/')) sendJson(res, err.status || 500, { error: message });
    else send(res, err.status || 500, message);
  }
});

// Opens the default browser; skipped with --no-open or NO_OPEN=1.
function openBrowser(url) {
  if (process.argv.includes('--no-open') || process.env.NO_OPEN) return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' })
    .on('error', () => console.log('Could not open a browser; open the URL above manually.'))
    .unref();
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — is the library already running? Try http://localhost:${PORT} or set PORT=...`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Asset library running at ${url}`);
  openBrowser(url);
});
