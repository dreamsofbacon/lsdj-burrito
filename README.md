# Dreamy_bacon's LSDJ Burrito

LSDJ Burrito runs **your own copy** of [Little Sound Dj](https://www.littlesounddj.com) on an M-VAVE FM-1, with GameDude-based firmware (the source is in [lsdj-burrito-src](https://github.com/dreamsofbacon/lsdj-burrito-src)). This repository is its web page.

With LSDJ Burrito running on the FM-1 (alpha 55 or later), connected by USB, the page talks to the running firmware over USB-MIDI (Chrome or Edge, MIDI with SysEx allowed). It never writes firmware.

- **Live effects:** every channel's effects and the echo, following the FM-1 as you play; move a slider to change it on the FM-1, keep the setup on the FM-1.
- **Songs:** export the FM-1's songs as `lsdj.sav`, import a 128 KiB `.sav` (the FM-1 keeps its songs if an import fails).
- **Colours:** make a custom theme from a preset with a preview, send it (THEME: CUSTOM on the FM-1).
- **Settings:** change them, back up settings + effects + colours to a file, restore it.
- **ROM check:** is your own `lsdj.gb` a version tested on the FM-1 (read in the browser only).

**Installing firmware from this page is switched off for now.** An earlier version of the installer left an FM-1 unable to start (a transfer stopped part way). Install LSDJ Burrito with M-UPGRADE until installing is proven safe.

## Licenses
- This page is GPL-3.0-only (see `LICENSE`).
- The firmware (in lsdj-burrito-src) contains Peanut-GB and MiniGB APU (MIT), Felucca (GPL-3.0-only) and JieLi AC79 SDK boot files (Apache-2.0). See `licenses/`.

Not affiliated with M-VAVE, Johan Kotlinski (LSDj) or Nintendo.
