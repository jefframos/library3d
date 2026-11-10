# Sound effects

One-shot sounds collected from earlier projects, deduped, for reuse in new games. Music, ambience over 1 MB and voice
clips were left out.

| Folder | From | Good for | Licence |
|---|---|---|---|
| `feel-nice-vibrations/` | Feel (More Mountains) NiceVibrations samples | **impacts** (punches, body, concrete, wood, glass, metal, car crash), objects, weapons, UI | Unity Asset Store EULA: OK inside your games |
| `feel-demos/` | Feel demo scenes | barbarian hits/attacks, strike, bounce, springs | Unity Asset Store EULA |
| `ragdoll-impacts/` | Mocha Inc Active Ragdoll | thuds, bricks, rocks, anvil, metal, ball impacts | Unity Asset Store EULA |
| `liquid/` | Archanor Liquid Mesh FX | splashes, paint, acid | Unity Asset Store EULA |
| `factory-games/<game>/` | this repo's games | Kenney impacts, coins, UI, pops, explosions | mostly Kenney (CC0) |
| `hexasort/`, `hole/`, `monster-merge/`, `trumpzone/`, `cleaner/` | other projects | pops, bubbles, squash, whoosh, collect, growls | as bought for those projects |

Asset Store sounds may be shipped inside games, but not redistributed as raw files publicly: keep this repo private.

## Making a game sound from these

Trim the silence at the start (it makes hits feel late) and save as mono ogg in the game's `raw-assets/audio`:

```bash
ffmpeg -i in.wav -af "silenceremove=start_periods=1:start_threshold=-50dB" -ac 1 -c:a libvorbis -q:a 6 out.ogg
```

Then `npm run audio`.

## Where to find more (free or cheap)

- **Kenney** (kenney.nl/assets, category Audio): CC0. Impact Sounds, Interface Sounds, RPG Audio.
- **Sonniss GDC Game Audio Bundle** (gdc.sonniss.com): tens of GB of pro sounds, free each year, royalty-free.
- **Freesound** (freesound.org): filter by CC0 licence.
- **Pixabay sound effects**, **Mixkit**: free, no attribution.
- **Zapsplat**: free with attribution, or a paid licence.
- For punchy, casual game hits: search "cartoon punch", "body impact", "thud", "stomp", "wood crack".
