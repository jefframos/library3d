# Animation library

Humanoid animation packs shared between projects. Filled by `npm run animations:fetch`
(`scripts/fetch-animations.mjs`): starters by default, `-- --all`, `--clips A,B`, `--list`,
`--pack kaykit --zip <file>`. Send the clips a project needs into its models/animations/.

    <pack>/pack.json      name, author, license, page
    <pack>/clips/*.glb    one clip per file: the motion (clip 0) + "Reference" (the rig's T-pose)
    <pack>/source/        the pack's original GLB (splitting more clips doesn't re-download)

All packs here are CC0 (see each pack's License.txt).
