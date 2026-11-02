// optimizeAnimation.mjs
//
// Shrinks an animation-only GLB (no meshes) by rewriting its clip data
// directly, without a 3D engine round trip (three's exporter rebuilds a file
// from its own scene and can lose clips whose tracks don't bind, e.g. the
// flattened Mixamo files). Used by fetch-animations.mjs. A copy of
// there-is-rope's tools/animations/optimizeAnimation.mjs (its editor's Library
// tab uses that one): fix both.
//
// - Tracks that never change keep one key (most bones of a baked clip).
// - Keys that interpolation already reproduces (within `rotationTolerance`
//   radians / `translationTolerance` metres) are dropped; the first and last
//   always stay, so loops and clip lengths don't change.
// - With an own reference clip (rig/AnimationLibrary.ownReference), tracks
//   that only repeat what the reference already sets are dropped: the
//   retargeter fills missing channels from it (and the reference's own
//   from the node's rest transform).
// - Everything is packed into one buffer view; identical time arrays shared.
//
// Nodes, skins and the rest of the file are kept as they are.

const FLOAT = 5126;
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT = {
    5120: { bytes: 1, read: (v, o) => v.getInt8(o), norm: (x) => Math.max(x / 127, -1) },
    5121: { bytes: 1, read: (v, o) => v.getUint8(o), norm: (x) => x / 255 },
    5122: { bytes: 2, read: (v, o) => v.getInt16(o, true), norm: (x) => Math.max(x / 32767, -1) },
    5123: { bytes: 2, read: (v, o) => v.getUint16(o, true), norm: (x) => x / 65535 },
    5125: { bytes: 4, read: (v, o) => v.getUint32(o, true), norm: (x) => x },
    5126: { bytes: 4, read: (v, o) => v.getFloat32(o, true), norm: (x) => x },
};

export const DefaultAnimationOptimize = {
    rotationTolerance: 0.001,
    translationTolerance: 0.0005,
    /** The clip that is the file's own reference pose (rig/AnimationLibrary.ownReference). */
    referenceClip: 'Reference',
};

/** Whether `glb` is animation-only: clips, no meshes, no compression extensions this can't read. */
export function isAnimationGlb(glb) {
    try {
        const { json } = parseGlb(glb);
        return !!json.animations?.length && !json.meshes?.length && !(json.extensionsRequired ?? []).length;
    } catch {
        return false;
    }
}

/** The optimized GLB and notes on what changed. Throws if `glb` isn't animation-only. */
export function optimizeAnimationGlb(glb, options = {}) {
    const settings = { ...DefaultAnimationOptimize, ...options };
    if (!isAnimationGlb(glb)) throw new Error('not an animation-only GLB');
    const { json, bin } = parseGlb(glb);
    const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

    const read = (index) => {
        const accessor = json.accessors[index];
        const size = SIZE[accessor.type];
        const component = COMPONENT[accessor.componentType];
        const out = new Float32Array(accessor.count * size);
        if (accessor.bufferView === undefined) return out;
        const bufferView = json.bufferViews[accessor.bufferView];
        const stride = bufferView.byteStride ?? size * component.bytes;
        const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        for (let i = 0; i < accessor.count; i++) {
            for (let k = 0; k < size; k++) {
                const raw = component.read(view, start + i * stride + k * component.bytes);
                out[i * size + k] = accessor.normalized ? component.norm(raw) : raw;
            }
        }
        return out;
    };

    // Tracks, read once.
    const clips = json.animations.map((animation) => ({
        name: animation.name,
        tracks: animation.channels.filter((c) => c.target.node !== undefined).map((channel) => {
            const sampler = animation.samplers[channel.sampler];
            const path = channel.target.path;
            const size = path === 'rotation' ? 4 : path === 'weights' ? null : 3;
            return {
                node: channel.target.node, path, size,
                interpolation: sampler.interpolation ?? 'LINEAR',
                times: read(sampler.input), values: read(sampler.output),
                outputAccessor: sampler.output,
            };
        }),
    }));
    const keysBefore = clips.reduce((n, c) => n + c.tracks.reduce((m, t) => m + t.times.length, 0), 0);

    const reference = clips.find((c) => c.name === settings.referenceClip) ?? null;
    const restOf = (node, path) => {
        const n = json.nodes[node] ?? {};
        return path === 'rotation' ? n.rotation ?? [0, 0, 0, 1] : path === 'scale' ? n.scale ?? [1, 1, 1] : n.translation ?? [0, 0, 0];
    };
    // What the reference sets at time 0 for each channel (or the node's rest).
    const referenceValue = (node, path) => {
        const track = reference?.tracks.find((t) => t.node === node && t.path === path);
        return track ? Array.from(track.values.subarray(track.interpolation === 'CUBICSPLINE' ? track.size : 0, (track.interpolation === 'CUBICSPLINE' ? 2 : 1) * track.size)) : restOf(node, path);
    };

    let dropped = 0;
    for (const clip of clips) {
        const isReference = clip === reference;
        const end = Math.max(0, ...clip.tracks.map((t) => t.times[t.times.length - 1] ?? 0));
        const kept = [];
        for (const track of clip.tracks) {
            if (!track.size || track.interpolation === 'CUBICSPLINE') {
                kept.push(track);
                continue;
            }
            const constant = isConstant(track);
            // Equal to what the retargeter would use without it: drop it (only when the file has its own reference).
            if (constant && reference) {
                const base = isReference ? restOf(track.node, track.path) : referenceValue(track.node, track.path);
                if (close(track.values.subarray(0, track.size), base, track.path, settings)) {
                    dropped++;
                    continue;
                }
            }
            if (constant) {
                track.times = track.times.slice(0, 1);
                track.values = track.values.slice(0, track.size);
            } else if (track.interpolation === 'LINEAR') {
                const before = track.times.length;
                const { times, values } = track;
                reduceKeys(track, settings);
                // A reduced track gets its own time array (~100 bytes of JSON): not worth it for a few keys.
                if ((before - track.times.length) * (track.size + 1) * 4 < 160) Object.assign(track, { times, values });
            }
            kept.push(track);
        }
        // Keep the clip's length: if nothing reaches its end any more, one track holds its value to it.
        if (end > 0 && !kept.some((t) => t.times[t.times.length - 1] >= end - 1e-6)) {
            const track = kept.find((t) => t.size && t.interpolation !== 'CUBICSPLINE');
            if (track) {
                track.times = Float32Array.from([track.times[0], end]);
                track.values = Float32Array.from([...track.values.subarray(0, track.size), ...track.values.subarray(track.values.length - track.size)]);
            }
        }
        clip.tracks = kept;
    }
    const keysAfter = clips.reduce((n, c) => n + c.tracks.reduce((m, t) => m + t.times.length, 0), 0);

    // Rebuild the binary: non-animation accessors (skins' inverse binds…) copied, then the tracks.
    const chunks = [];
    let length = 0;
    const accessors = [];
    const push = (array) => {
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        const offset = length;
        chunks.push(bytes);
        length += bytes.length;
        const pad = (4 - (length % 4)) % 4;
        if (pad) {
            chunks.push(new Uint8Array(pad));
            length += pad;
        }
        return offset;
    };
    const addAccessor = (values, type, extra = {}) => {
        accessors.push({ bufferView: 0, byteOffset: push(values), componentType: FLOAT, count: values.length / SIZE[type], type, ...extra });
        return accessors.length - 1;
    };

    const animationAccessors = new Set(json.animations.flatMap((a) => a.samplers.flatMap((s) => [s.input, s.output])));
    const remap = new Map();
    (json.accessors ?? []).forEach((accessor, i) => {
        if (animationAccessors.has(i)) return;
        if (accessor.componentType === FLOAT) {
            remap.set(i, addAccessor(read(i), accessor.type, pick(accessor, ['min', 'max', 'name'])));
        } else {
            // Kept as is (e.g. joint indices): raw bytes, tightly packed.
            const component = COMPONENT[accessor.componentType];
            const values = read(i);
            const raw = new (accessor.componentType === 5125 ? Uint32Array : component.bytes === 2 ? (accessor.componentType === 5122 ? Int16Array : Uint16Array) : (accessor.componentType === 5120 ? Int8Array : Uint8Array))(values.length);
            for (let k = 0; k < values.length; k++) raw[k] = accessor.normalized ? Math.round(values[k] * (component.bytes === 1 ? 255 : 65535)) : values[k];
            accessors.push({ bufferView: 0, byteOffset: push(raw), componentType: accessor.componentType, count: accessor.count, type: accessor.type, ...pick(accessor, ['normalized', 'min', 'max', 'name']) });
            remap.set(i, accessors.length - 1);
        }
    });

    const sharedTimes = new Map();
    const timesAccessor = (times) => {
        const key = Array.from(times).join(',');
        if (!sharedTimes.has(key)) sharedTimes.set(key, addAccessor(times, 'SCALAR', { min: [times[0]], max: [times[times.length - 1]] }));
        return sharedTimes.get(key);
    };
    const animations = clips.map((clip, a) => {
        const samplers = [];
        const channels = [];
        for (const track of clip.tracks) {
            const outputType = track.size ? (track.size === 4 ? 'VEC4' : 'VEC3') : json.accessors[track.outputAccessor].type;
            samplers.push({ input: timesAccessor(track.times), output: addAccessor(track.values, outputType), interpolation: track.interpolation });
            channels.push({ sampler: samplers.length - 1, target: { node: track.node, path: track.path } });
        }
        return { ...pick(json.animations[a], ['name', 'extras']), channels, samplers };
    });

    const out = { ...json, animations, accessors };
    out.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: length }];
    out.buffers = [{ byteLength: length }];
    for (const skin of out.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = remap.get(skin.inverseBindMatrices);
    // Nothing else in an animation-only file points at buffer data; drop leftovers that would.
    delete out.images;
    delete out.textures;
    delete out.samplers;
    delete out.materials;

    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
    }
    const result = packGlb(out, data);
    if (result.length >= glb.length) return { glb, notes: ['Animation: already compact, left as it is.'] };
    const notes = [
        `Animation: ${keysBefore} → ${keysAfter} keys${dropped ? `, ${dropped} tracks the reference already sets dropped` : ''}.`,
    ];
    return { glb: result, notes };
}

function pick(object, keys) {
    return Object.fromEntries(keys.filter((k) => object[k] !== undefined).map((k) => [k, object[k]]));
}

function isConstant(track) {
    const { values, size } = track;
    for (let i = size; i < values.length; i++) if (Math.abs(values[i] - values[i % size]) > 1e-6) return false;
    return true;
}

function close(a, b, path, settings) {
    if (path === 'rotation') return quatAngle(a, 0, b, 0) <= settings.rotationTolerance;
    const tolerance = path === 'translation' ? settings.translationTolerance : 1e-4;
    return a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
}

function quatAngle(a, i, b, j) {
    const dot = Math.abs(a[i] * b[j] + a[i + 1] * b[j + 1] + a[i + 2] * b[j + 2] + a[i + 3] * b[j + 3]);
    return 2 * Math.acos(Math.min(1, dot));
}

/** Greedy: from each kept key, reach as far as interpolation stays within tolerance of every skipped key. */
function reduceKeys(track, settings) {
    const { times, values, size, path } = track;
    const n = times.length;
    if (n <= 2) return;
    const keep = [0];
    const lerped = new Float32Array(size);
    const fits = (from, to) => {
        for (let k = from + 1; k < to; k++) {
            const u = (times[k] - times[from]) / Math.max(times[to] - times[from], 1e-9);
            if (size === 4) {
                // nlerp the short way, as AnimationSource samples it.
                const sign = dot4(values, from * 4, values, to * 4) < 0 ? -1 : 1;
                let length = 0;
                for (let c = 0; c < 4; c++) {
                    lerped[c] = values[from * 4 + c] + (values[to * 4 + c] * sign - values[from * 4 + c]) * u;
                    length += lerped[c] * lerped[c];
                }
                length = Math.sqrt(length) || 1;
                for (let c = 0; c < 4; c++) lerped[c] /= length;
                if (quatAngle(lerped, 0, values, k * 4) > settings.rotationTolerance) return false;
            } else {
                const tolerance = path === 'translation' ? settings.translationTolerance : 1e-4;
                for (let c = 0; c < size; c++) {
                    const v = values[from * size + c] + (values[to * size + c] - values[from * size + c]) * u;
                    if (Math.abs(v - values[k * size + c]) > tolerance) return false;
                }
            }
        }
        return true;
    };
    let from = 0;
    while (from < n - 1) {
        let to = from + 1;
        while (to + 1 < n && fits(from, to + 1)) to++;
        keep.push(to);
        from = to;
    }
    if (keep.length === n) return;
    track.times = Float32Array.from(keep, (k) => times[k]);
    const out = new Float32Array(keep.length * size);
    keep.forEach((k, i) => out.set(values.subarray(k * size, k * size + size), i * size));
    track.values = out;
}

function dot4(a, i, b, j) {
    return a[i] * b[j] + a[i + 1] * b[j + 1] + a[i + 2] * b[j + 2] + a[i + 3] * b[j + 3];
}

function parseGlb(glb) {
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file');
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    const binStart = 20 + jsonLength;
    const bin = binStart + 8 <= glb.length ? glb.subarray(binStart + 8, binStart + 8 + view.getUint32(binStart, true)) : new Uint8Array();
    return { json, bin };
}

function packGlb(json, bin) {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const total = 12 + 8 + jsonBytes.length + jsonPad + (bin.length ? 8 + bin.length : 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonBytes.length + jsonPad, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
    if (bin.length) {
        const offset = 20 + jsonBytes.length + jsonPad;
        view.setUint32(offset, bin.length, true);
        view.setUint32(offset + 4, 0x004e4942, true);
        out.set(bin, offset + 8);
    }
    return out;
}
