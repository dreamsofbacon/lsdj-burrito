# Dreamy_bacon's LSDJ Burrito

LSDJ Burrito is a web page that installs **your own copy** of [Little Sound Dj](https://www.littlesounddj.com) on an M-VAVE FM-1. It runs GameDude-based firmware (the source is in [lsdj-burrito-src](https://github.com/dreamsofbacon/lsdj-burrito-src)).

LSDj isn't included and is never uploaded anywhere. Your browser trims your `lsdj.gb` and puts it into an empty firmware template. The result is flashed through the FM-1's USB-MIDI updater.

Use Chrome or Edge with a USB data cable. The page needs Web MIDI with SysEx, so it must be served over HTTPS or from localhost.

What the page does:
- **Install:** choose `lsdj.gb` and pick sample kits, then install.
- **Songs:** export the FM-1's songs as `lsdj.sav`, or import a 128 KiB `.sav`. If an import fails, the previous songs are kept.
- **Restore:** reinstall M-VAVE's official V15 firmware, using a V15 `.fwsc` file you provide. The page checks it by hash before flashing.

**Status: alpha, not yet tested on hardware through this page.** Keep a way to recover the FM-1 (M-VAVE's updater) at hand.

## Licenses
- The firmware template and this page are GPL-3.0-only (see `LICENSE`).
- It contains Peanut-GB and MiniGB APU (MIT), Felucca (GPL-3.0-only), and unmodified JieLi AC79 SDK boot files (Apache-2.0). See `licenses/`.

Not affiliated with M-VAVE, Johan Kotlinski (LSDj) or Nintendo.
