# 3D Asset Library Viewer — Plan

Status: steps 1–4 built and working. Step 5 deferred.

```
npm run scan     # rebuild library/index.json from files/
npm start        # http://localhost:5173  (PORT=... to change)
```

## Source data (`files/`)

11,080 files across 8 packs (all CC0) → **1,932 assets** after grouping formats.

| Layout | Packs | Structure |
|---|---|---|
| **KayKit** | Bits Bundle 1, Bits Bundle 2, Forest Nature | `Pack/[Pack/]Sub-pack/Assets/{fbx, fbx(unity), gltf, obj}/name.*` |
| **Kenney** | castle-kit, city-kit-commercial, survival-kit | `kit/Models/{FBX,GLB,OBJ} format/name.*` + `Previews/name.png` |
| **Quaternius** | Ultimate Nature Pack | `{Blends,FBX,OBJ}/Name.*` |
| **Flat** | 3D Desert Plants Pack | `Pack/models/01_name.glb` + `previews/01_name.gif` |

Quirks found and handled:
- Bundle 2 and Forest Nature are double-nested (`X/X/...`). The scanner doesn't rely on depth; it finds the last *format folder* in each path and treats everything before it as context.
- Bundle 2 sub-packs are named `KayKit Block Bits 1.0`; Bundle 1 uses `City Builder Bits`. Both clean up to a collection name (`Block`, `City Builder`).
- Both `fbx(unity)` and `fbx (unity)` spellings exist → `fbx-unity` variant.
- Prototype Bits has `Character/` (Dummy) and `Animations/{fbx,gltf}/Rig_Medium/` → kinds `character` and `animation`.
- 122 KayKit parts (e.g. car wheels) exist only as OBJ — kept, they're real assets.
- Textures are referenced relatively (`citybits_texture.png` next to the gltf, Kenney `Textures/colormap.png`), so models are loaded by URL from `/files/...` and resolve their own textures.
- Kenney ships alternate colour maps (`Models/Textures/variation-a…g.png`) → texture-variant picker in the viewer.
- `.blend` (Quaternius) is listed as a download-only format.

## Structure

```
library/
  files/                  # original packs, read-only, never modified
  scripts/scan.mjs        # walk files/, build library/index.json
  server/server.mjs       # plain Node http server, no dependencies
  public/                 # index.html, style.css, app.js (three.js via CDN import map)
  library/
    index.json            # generated catalog
    thumbs/               # generated thumbnail PNGs (<id with / → __>.png)
  package.json            # scan / start / dev scripts, no dependencies
```

## 1. `scan.mjs` — sanitize & catalog ✅

- **Format priority: `gltf > glb > fbx > obj`** (then `fbx-unity`, `blend`). `primary` = first viewable format an asset has; badges render in this order.
- Names: `01_saguaro_cactus` → "Saguaro Cactus", `BirchTree_1` → "Birch Tree 1", `building-a` → "Building A". Version/numeric suffixes that distinguish models (`_1`, `_2`) are kept.
- Tags from name/collection tokens + a per-collection category map (`city-builder` → `city`, `castle-kit` → `castle, medieval`, …).
- License read from each pack's `License.txt`.
- Output: `{ packs: [{id, name, license, count, collections, textureVariants}], assets: [...] }`, e.g.
  ```json
  {
    "id": "kaykit-bits-1/city-builder/bench",
    "name": "Bench",
    "pack": "KayKit Bits 1", "packId": "kaykit-bits-1",
    "collection": "City Builder", "collectionId": "city-builder",
    "kind": "model",
    "tags": ["bench", "builder", "city"],
    "formats": { "gltf": "...", "fbx": "...", "obj": "...", "fbx-unity": "..." },
    "primary": "gltf",
    "mtl": ".../obj/bench.mtl",
    "preview": null,
    "license": "CC0"
  }
  ```

## 2. `server.mjs` — safe local server ✅

- `GET /api/index` — full catalog (≈1.4 MB; search/filter/facets run client-side, instant at this size).
- `GET /api/thumbs` — list of generated thumbnails. `POST /api/thumb?id=` — save a PNG (id regex-validated, PNG signature checked, 4 MB cap).
- `GET /files/*` — decoded, resolved, must stay inside `files/`; extension allow-list (models, `.bin`, `.mtl`, textures, previews). `?download` adds `Content-Disposition`.
- Bound to `127.0.0.1`; rejects foreign `Host` headers (DNS rebinding) and cross-origin POSTs.

## 3. Viewer page ✅

- **Sidebar:** search (name > tag > anywhere, plus fuzzy subsequence on name), pack / collection / format / type filters, tag chips with live counts, favorites-only. Filters persist in `localStorage`.
- **Grid:** cards with preview or generated thumbnail, format badges; rendered in pages of 150 as you scroll.
- **Viewer:** GLTFLoader / FBXLoader / OBJLoader + MTLLoader. Switch format per asset, orbit, auto-frame, grid / wireframe / auto-rotate, Kenney texture variants, animation clip picker, size (W×H×D), triangle / mesh / material counts, copy path, download.
- **Keyboard:** `/` search, arrows move through the grid, `f` favorite, `Esc` closes / blurs. URL hash `#<asset id>` links to an asset.
- Mobile: single column, viewer opens full-screen.

## 4. Thumbnails ✅ (client-side)

- A second offscreen renderer draws the primary format at 256×256 and POSTs the PNG. Runs automatically for cards scrolled into view (toggle in sidebar), or "Generate all missing" for the current filter.
- 1,696 assets need one (Kenney and Desert Plants ship previews).

## 4b. Use in your game ✅ (`server/deps.mjs`, `server/zip.mjs`)

For the format selected in the viewer, the server works out every file the model needs and lists them in the viewer panel:
- **glTF / GLB:** `buffers[].uri` + `images[].uri` (e.g. `.bin` + `furniturebits_texture.png`, Kenney `Textures/colormap.png`).
- **OBJ:** `mtllib` → `.mtl` → its `map_*` / `bump` textures.
- **FBX:** texture paths are embedded (often the author's absolute `C:\Users\Kay Lousberg\...` path), so it matches by file name in the model folder, `Textures/`, or a sibling `texture(s)/` folder.

Relative layout is preserved (`Textures/colormap.png` stays in `Textures/`), so the copied model loads without edits.

- **Browse…** — `POST /api/pick-folder` opens the native folder dialog on this machine (`server/pick-folder.mjs`: Windows Explorer-style `IFileOpenDialog` via PowerShell, `osascript` on macOS, `zenity` on Linux) starting at the last folder used. Browsers can't return real folder paths, hence the server-side dialog.
- **Last folder** — the last folder and the 6 most recent ones are saved to `library/settings.json` (`GET /api/settings`), offered as suggestions in the path box.
- **Copy files to folder** — `POST /api/export {id, format, dest, overwrite}`. Existing file with the **same size** → replaced silently (shared textures are usually identical). **Different size** → `409`, the UI lists both sizes and asks before overwriting. Refuses relative paths, missing folders, and anything inside this library.
- **Download .zip** — `GET /api/export.zip?id=&format=`, same file set.
- `GET /api/deps?id=&format=` — the file list itself.

## 4c. Split into separate files ✅ (`public/split.js`)

For models with 2+ meshes (e.g. `hats/3d_props_stylized_hats_pack.glb`: 18 hats under `Sketchfab_model → root → GLTF_SceneRootNode`), the viewer shows the node hierarchy with checkboxes. Each ticked node becomes its own `.glb`:
- **Suggested** selection walks down single-child wrapper nodes until the hierarchy branches (→ the 18 hats); it stops at nodes that have geometry themselves (a tower with wheel children stays one part).
- Hovering a row isolates that node in the 3D view.
- The node's full world transform is baked into the vertices (mirrored transforms get their winding fixed); the result has identity transforms. A single-mesh part is exported as one node named after the file.
- **Pivot:** bottom centre (default, sits on y=0), centre of bounds, or keep original position. **Scale:** defaults to 0.01 for plain FBX (cm → m), 1 otherwise.
- File names come from node names with the exporter index stripped (`Viking_Hat_0` → `Viking_Hat.glb`), unless that would collide; generic names like `Object_4` use the nearest named ancestor. Optional prefix.
- Exported with three.js `GLTFExporter`, then the **original image bytes are swapped back in** for textures that came from glTF (the exporter re-encodes via canvas: 14 MB → 9.2 MB for the hats, byte-identical PNGs). Textures from OBJ/FBX keep the re-encoded image, since the exporter flips them.
- Save to the same folder as "Use in your game" (`POST /api/generated/check` for the same-size/different-size rule, then `POST /api/generated/write` per file), or download a zip built in the browser (`public/zip.js`, shared with the server).
- Skinned (rigged) meshes are skipped with a warning.

Related fix: Kenney FBX files reference `Textures\colormap.png` in a way `FBXLoader` requests as `FBX format/colormap.png` (404). FBX loads now redirect texture requests by file name to what `/api/deps` found, so those models render textured.

## 4d. Optimize tab ✅ (`public/optimize.js`, shared GLB helpers in `public/glb.js`)

For folders of game-ready models (e.g. the split hats: 85–95% of each file was a 1024²/2048² PNG). Runs in the browser; the server lists, reads and writes the folder.

- **Folder:** Browse… (native dialog) or paste; last/recent folders saved in `library/settings.json` (`optimizeDir`). Optional subfolders. `POST /api/folder/open` registers the folder under a random token; files are read via `GET /local/<token>/<path>` (path-style so `.gltf` can resolve `.bin`/textures). Only folders opened this way are readable.
- **Table:** size, triangles and texture resolution/format/bytes per file, read from the GLB header without loading it.
- **Textures:** max size (halving steps for clean downscales), JPEG (auto-PNG when the image has transparency) / WebP (`EXT_texture_webp`, required) / PNG / keep, quality. Unchanged textures keep their original bytes; a re-encode that comes out bigger is discarded.
- **Mesh:** meshoptimizer `simplify` (CDN, `meshoptimizer@0.22.0`) with target ratio, max error, lock borders; unused vertices are compacted. Multi-material and morph-target meshes are left alone. Draco / meshopt-compressed inputs are decoded.
- **Preview:** the selected file is optimized with the current settings (re-runs on change) and loaded back from the exact output bytes; Original/Optimized toggle, wireframe, before/after table.
- **Output** (`POST /api/folder/write`): `optimized/<path>.glb` (default), or replace in place with the first-ever original kept in `_originals/`. Inputs are always read from `_originals/` when it exists, so re-running never re-compresses an optimized file. `.gltf` inputs always go to `optimized/` as `.glb`.

Result on the 18 split hats + a KayKit table: 9.22 MB → 1.15 MB (JPEG 512 px, 50% triangles).

## 5. `organize.mjs` — deferred

- Clean copy at `organized/<category>/<pack>/<asset>/<format>`, dry-run by default, `--apply` to copy. Never touches originals. Revisit once the tags/collections from the viewer feel right.

## Notes

- FBX files are in centimetres, so their reported size is 100× the glTF/OBJ size of the same model.
- three.js r170 loads from jsDelivr, so the first visit needs internet; the browser caches it after that.
