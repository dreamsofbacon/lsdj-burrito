# Dreamy_bacon's LSDJ Burrito

LSDJ Burrito runs **your own copy** of [Little Sound Dj](https://www.littlesounddj.com) on an M-VAVE FM-1, with GameDude-based firmware (the source is in [lsdj-burrito-src](https://github.com/dreamsofbacon/lsdj-burrito-src)). This repository is its web page.

With LSDJ Burrito running on the FM-1 (alpha 55 or later), connected by USB, the page talks to the running firmware over USB-MIDI (Chrome or Edge, MIDI with SysEx allowed). Firmware installation is a separate, explicitly confirmed action.

- **Live effects:** every channel's effects and the echo, following the FM-1 as you play; move a slider to change it on the FM-1, keep the setup on the FM-1.
- **Songs:** export the FM-1's songs as `lsdj.sav`, import a 128 KiB `.sav` (the FM-1 keeps its songs if an import fails).
- **Colours:** make a custom theme from a preset with a preview, send it (THEME: CUSTOM on the FM-1).
- **Settings:** change them, back up settings + effects + colours to a file, restore it.
- **Prepare firmware:** use your own LSDj ROM and explicitly choose its sample kits, entirely in the browser.

## Importing saves with extra bytes

Raw LSDj saves are 131072 bytes. For a 131088-byte file (such as the reported LSDj
Patcher export), the importer offers an explicit warning and confirmation to use
only the first 131072 bytes, excluding the final 16. The extra bytes' format is
not verified: this option is not suitable for a file with a leading header.
Cancelling sends nothing. Your original file is never modified; the USB/Bluetooth
save protocol still accepts exactly 131072 bytes. Other file sizes are rejected.
Back up the FM-1's songs before replacing them, and use the matching LSDj version.

Run `node tests/save-import.mjs` for confirmation, cancellation, byte-preservation
and simulated transfer checks. Optional local save-file paths test the same
conversion without writing any files or contacting a device.

## Experimental multi-version loader

1. Back up songs and settings before changing firmware or LSDj versions. Save compatibility between versions is not guaranteed.
2. Choose your own `.gb` file under **Prepare firmware**. The page checks its LSDj title, MBC5 mapper, size, 128 KiB RAM requirement and header checksum. GBC-only and rumble cartridges are refused.
3. All recognized sample kits start selected. The ROM-free **FM-1_967** template holds **31 banks plus a 256-byte header (508,160 bytes)**. A typical ROM with 13 required program/data banks leaves 18 kit banks. If necessary, deselect kits yourself; the page never silently removes them. Unknown data and zero-filled banks remain mandatory. Some modified ROMs cannot fit even with no kits.
4. Kit bank numbers and retained sample bytes are preserved. Songs referring to omitted kits lose those samples. The global ROM checksum is recalculated for the sparse image.
5. Read the experimental/backup acknowledgement, then choose **Prepare firmware**. Template hashes, protected firmware, loader, slot mapping and package CRCs are checked before and after insertion.
6. Download the private `.fwsc` for M-UPGRADE, or use the separate USB installer. Preparing or downloading does **not** write to a device. Changing ROM options invalidates the generated installer selection.

The template is **not hardware-validated**. It intentionally disables version-specific tempo shortcuts, MIDI clock integration, song cues and cursor-following effects for every ROM, including 9.3.9. An exact ROM hash or matching program fingerprint is evidence of identity, not proof that this firmware/ROM combination boots or plays correctly. Other structurally valid LSDj versions remain experimental.

**Flashing risk:** an earlier interrupted web install left an FM-1 unable to start. Keep stable power, the cable connected and this tab open/in front. Simulated transfer/retry tests and package integrity checks do not guarantee physical recovery. M-UPGRADE is an alternative transport, not proof that an experimental image is safe.

ROMs and samples stay local. The checked-in template contains an erased ROM window only. Generated firmware contains your ROM: keep it private and do not commit or publish it.

The template's matching [firmware source archive](lsdj/fm1-lsdj-template-source.zip)
includes build instructions, licenses and a per-file source manifest. It contains
no LSDj ROM or save. Rebuilding this archive reproduced the published template
and metadata byte-for-byte. Archive SHA-256:
`aa6010d2c5a630b1168039a701c8eb1436a6576d1924495d9bddf4f3d28c1f31`.

## Local preview and checks

### Virtual FM-1 (3D)

The **Virtual FM-1** section executes the actual `.fwsc` firmware on
[Joakim Eriksson's FM-1 emulator](https://github.com/joakimeriksson/fm1-emu),
not just the embedded Game Boy ROM. Choose a local package and Start, or use
**Preview selected installer firmware** for the package prepared/selected above.
This captures a separate copy; later installer selection changes do not replace
an already running virtual machine.

The emulator and Three.js assets are served locally and loaded on demand.
No private packages are uploaded, no hosted emulator iframe is used, and this
section never requests MIDI access or writes a physical device. The live Songs,
Settings and Effects sections still target the physical FM-1, not the emulator.

Click keys, drag/scroll knobs, or focus the 3D instrument and use arrows, Z/X and
Shift/Enter for the firmware's Game Boy direction, B/A and Select/Start keys.
The mapping follows Burrito; other firmware may assign those keys differently.
Press X (A) to leave LSDj's first-boot cartridge test once it finishes.
Front view and tilt/turn controls adjust the 3D camera view; Enlarge screen shows
a readable LCD alongside it. Pause retains the
virtual machine; **Stop/restart/reload discards all virtual songs/settings**, even
changes saved through the simulated firmware. There is no browser persistence or
raw `.sav` import into the emulator in this version. Export/import above remains
a physical-device operation.

WebGL2, WebAssembly/JIT and AudioWorklet support are required (current Chrome/Edge,
HTTPS or localhost). Audio starts only after an explicit Start. Switching tabs
pauses emulation. Starting a physical firmware install stops the emulator to free
resources. The default 240 MHz is the hardware clock; lower choices deliberately
underclock the simulation. Watch the real-time/short-buffer counters: running a
Game Boy emulator inside an FM-1 emulator is expensive. Successful emulation is
not a hardware flashing/recovery guarantee or proof of accurate audible playback.
Alpha 66 and generated FM-1_967 packages passed headless CPU/display tests; the
967 runtime also passed a 15-second headless run. Both packages reached LSDj's song
screen in the 3D view. Browser tests measured below real-time here (about 50-90%).
One VS Code embedded-browser tab crashed during testing; a fresh tab subsequently
passed a 50+ second emulated 967 run, pause/resume and 3D key/knob checks. That crash is unresolved, so this
remains an experimental preview, not a stable audio-production tool.

Upstream source revision, deployed WASM provenance, versions and asset hashes are
pinned in [emulator/upstream.json](emulator/upstream.json). The WASM was obtained
from upstream's deployed page, not rebuilt here; source is MIT-licensed. The
worklet/JIT are unchanged upstream files. Retain both MIT license files under
`emulator/vendor/` when distributing. The 3D shell and Burrito integration are
local additions; the live panel artwork/hit testing comes from the emulator.

Run `node tests/emulator.mjs` for asset integrity, package and runtime checks.
Optional `.fwsc` arguments execute local packages with the actual FM-1 emulator;
optional `.gb` arguments prepare an experimental package in memory and test it.
Tests select fitting kits explicitly and do not save ROM-bearing packages.

Serve this repository on loopback, for example `python -m http.server 8891 --bind 127.0.0.1`, and open `http://localhost:8891/` in Chrome or Edge. Loading directly from `file:` is not supported.

Run `node tests/loader.mjs` with Node 22+ for synthetic ROM, sample selection, slot, protected-template, package and simulated transport regressions. Optional positional arguments are local ROM paths; these test package round trips without saving ROM-bearing packages. With `LSDJ_SLOT_SMOKE` set to the firmware's compiled `tests/lsdj_rom.c` executable, they also test each generated slot with the emulator for 600 frames. This is not an audible sample or hardware test.

Rebuild the ROM-free assets using the firmware repository's `tools/lsdj_template.py` (see its README), then copy **only** its verified empty template and matching metadata into `lsdj/`. Never replace the template with a generated user-ROM package.
When updating the template, also replace its matching source archive, verify the
rebuild, and update the archive checksum above. Do not include ROMs, saves, private
calibration, build outputs or credentials in the source archive.

## Licenses
- This page is GPL-3.0-only (see `LICENSE`).
- The firmware (in lsdj-burrito-src) contains Peanut-GB and MiniGB APU (MIT), Felucca (GPL-3.0-only) and JieLi AC79 SDK boot files (Apache-2.0). See `licenses/`.
- The optional virtual FM-1 runtime and Three.js are MIT-licensed; see `emulator/vendor/LICENSE-fm1-emu.txt` and `emulator/vendor/LICENSE-three.txt`.

Not affiliated with M-VAVE, Johan Kotlinski (LSDj) or Nintendo.
