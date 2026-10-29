# Dreamy_bacon's LSDJ Burrito

LSDJ Burrito runs **your own copy** of [Little Sound Dj](https://www.littlesounddj.com) on an M-VAVE FM-1, with GameDude-based firmware (the source is in [lsdj-burrito-src](https://github.com/dreamsofbacon/lsdj-burrito-src)). This repository is its web page.

With LSDJ Burrito running on the FM-1 (alpha 55 or later), connected by USB, the page talks to the running firmware over USB-MIDI (Chrome or Edge, MIDI with SysEx allowed). Firmware installation is a separate, explicitly confirmed action.

- **Live effects:** every channel's effects and the echo, following the FM-1 as you play; move a slider to change it on the FM-1, keep the setup on the FM-1.
- **Songs:** export the FM-1's songs as `lsdj.sav`, import a 128 KiB `.sav` (the FM-1 keeps its songs if an import fails).
- **Colours:** make a custom theme from a preset with a preview, send it (THEME: CUSTOM on the FM-1).
- **Settings:** change them, back up settings + effects + colours to a file, restore it.
- **Prepare firmware:** use your own LSDj ROM and explicitly choose its sample kits, entirely in the browser.

The section shortcuts distinguish physical-device controls from local firmware
tools. After preparation, links take you to the download, local preview or USB
installer; navigating never starts emulation or installation. Virtual FM-1 shows
the selected package's name and disables its selected-package preview button
while no package is available or preparation is in progress. Changing that
selection does not replace an already running virtual machine.

USB Connect and Install are disabled with an explanation when Web MIDI is absent
or the page is not a secure context (HTTPS/localhost). This checks browser API
availability, not device presence or permission. ROM preparation/download still
work on secure browsers without Web MIDI; emulator support has its own WebGL,
WebAssembly and audio requirements below.

## Master and channel effects (FM-1_977 and newer)

Effects shows a **Master** box first: the MASTER page (on the FM-1 it opens while FX
is held) and PU1-NOI mute buttons (lit = playing; the same mutes as hold FX + C4-F4
and MIDI CC 81, sent with link op 0x24 MUTE_SET, live only). Freeze is settable from
the page too. **Channel effects and echo** follow below with FILTER, DRIVE, LFO,
LO-FI, ECHO and ECHO MOD (977 had the echo pages in Master; 978 moved them back). The FM-1 page indicator follows
the live page, including the master pages while FX is held, without changing the
saved channel page. Older firmware shows the mutes but cannot be set from here.

## FX organization (FM-1_975 and newer)

The first card/device page is **MASTER**: **K1 All FX** switches channel DSP,
shared echo and compressor on/off together; **K2 Compressor** is shared by all
channels. All FX off keeps the original dry mix and channel mutes without
erasing any settings. It is independent of the cursor and the channel chosen
on the webpage. SAVE/Keep and 17-word settings backups retain the switch.

The remaining pages match the device knobs:

| Page | K1 | K2 | K3 | K4 |
| --- | --- | --- | --- | --- |
| 2 FILTER | Channel FX | Filter type | Cutoff | Resonance |
| 3 DRIVE | Drive | Distortion | Warmth | - |
| 4 LFO | Rate | Depth | Shape | Destination |
| 5 LO-FI | Crush | Decimate | Echo send | - |
| 6 ECHO | Time | Feedback | Mix | Tone |
| 7 ECHO MOD | Wobble | Sync | Mode | Freeze |

SELECT changes the device page. Unused knobs do nothing. ECHO and ECHO MOD
are shared; FILTER/DRIVE/LFO/LO-FI edit the chosen channel. Freeze remains
read-only on the webpage (hold FX + D5 on the FM-1).
Older connected firmware retains its original page/knob layout, with an
explanation that All FX needs 975 or newer. New-layout backups cannot be
restored to older firmware. Both 11-word and 17-word legacy backups remain
accepted on supporting firmware.

This does not resolve the reported physical cursor-following failure; hardware
diagnosis is still pending.

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
3. All recognized sample kits start selected. The ROM-free **FM-1_976** template holds **31 banks plus a 256-byte header (508,160 bytes)**. A typical ROM with 13 required program/data banks leaves 18 kit banks. If necessary, deselect kits yourself; the page never silently removes them. Unknown data and zero-filled banks remain mandatory. Some modified ROMs cannot fit even with no kits.
4. Kit bank numbers and retained sample bytes are preserved. Songs referring to omitted kits lose those samples. The global ROM checksum is recalculated for the sparse image.
5. Read the experimental/backup acknowledgement, then choose **Prepare firmware**. Template hashes, protected firmware, loader, slot mapping and package CRCs are checked before and after insertion.
6. Download the private `.fwsc` for M-UPGRADE, or use the separate USB installer. Preparing or downloading does **not** write to a device. Changing ROM options invalidates the generated installer selection.

The preparation status explains the next step and why the button is disabled.
If kits exceed the budget, it reports how many kit banks you must deselect. If
the required program/data alone exceeds capacity, removing kits cannot help;
choose a smaller compatible ROM instead. Files with no recognized kits retain
all required data. Invalid ROM headers are rejected before fetching the catalogue
or template. Failed file checks allow selecting the same file again; a later
file selection takes precedence over an earlier read or template request.
Installer file errors are shown explicitly and clear the invalid selection.

FM-1_976 uses the **verified LSDj 9.3.9 profile** for
matching program code, including custom or omitted sample kits.
The browser compares the program SHA-256, not the title, and writes a cursor
profile into the CRC-protected slot header. The firmware uses it to read
the cursor channel and, since FM-1_976, for every 9.3.9 helper: SEQ live / song
mode, EDIT tempo, ARP song cues, MIDI clock / KEYBD sync and the PLAY beat light
(975 and earlier used only the cursor, so SEQ did nothing in web builds).
Unknown programs use ALL-channel FX, explicitly reported before and after
preparation. Theme-accent bars, meaningful segments, choice selectors and CPU1
save fixes remain unchanged. The identity is newer than 973; normal alpha 71
builds are unchanged.

The template is **not hardware-validated**. Version-specific tempo shortcuts,
MIDI clock integration and song cues remain disabled. An exact ROM hash or
matching program fingerprint is evidence of identity, not proof of complete
firmware/ROM compatibility. Other structurally valid LSDj versions remain
experimental. The user reported successful webpage flashing of 972 but loss
of cursor-following; 973 corrects that behavior for the verified program.

### Updating from the installed LSDj

**One-time bootstrap:** firmware 973 and earlier cannot export their cartridge.
Use your original ROM once to prepare and install 974 or newer, then reconnect. Normal
private non-slot builds do not advertise cartridge export either.

For subsequent supported updates:

1. Back up songs and settings separately. Connect to the running FM-1.
2. Choose **Read installed LSDj (no device writes)**. A progress bar and Cancel
   button are available; reading may take several minutes over MIDI.
3. The page verifies the transferred slot and loads the latest template.
   All currently installed kit banks are retained and locked. Missing banks
   remain FF; previously omitted samples cannot be recovered from the device.
4. Accept the experimental/backup acknowledgement and choose **Prepare firmware**.
5. Download or preview the private package, then explicitly choose **Install**.

Reading never writes firmware, pauses LSDj or backs up songs/settings. Data stays
in browser memory, is not uploaded or persisted, and is discarded on reload.
This updates Burrito around the existing LSDj; changing LSDj itself still needs
a newer ROM. If the installed cartridge cannot fit a future template, the page
refuses preparation rather than dropping kits. Use the original-ROM path to
choose different kits explicitly.

The read-only protocol uses `CART_INFO` (0x22) and offset-echoed `CART_READ`
(0x23, 120-byte chunks). Timed-out reads retry; stale-offset replies are ignored;
short chunks, checksum/layout failures and changed cartridge metadata fail
explicitly. Cancel/disconnect releases the request and restores controls.
Preparation/installation and physical controls are locked during the read.
Old firmware gets bootstrap guidance, not a save-memory fallback.

Run `node tests/device-update.mjs` for synthetic transfer/failure tests.
Optional private ROM arguments compare device-readback preparation with the
original-ROM package byte-for-byte, including kit numbering and cursor profile.
For the actual C protocol bridge, compile source `tests/lsdj_cartridge_link.c`
with `gcc -std=c99 -O2 -Ifirmware -Isrc ...` and set `LSDJ_CARTRIDGE_LINK` to
that executable when running the Node test. Private temporary slots are removed.
On a fresh localhost page, run
`await (await import('./tests/loader-ui.mjs')).runDeviceUpdateUiTests()`
for mocked-MIDI UI checks. This suite never contacts a physical device.

**Flashing risk:** an earlier interrupted web install left an FM-1 unable to start. Keep stable power, the cable connected and this tab open/in front. Simulated transfer/retry tests and package integrity checks do not guarantee physical recovery. M-UPGRADE is an alternative transport, not proof that an experimental image is safe.

ROMs and samples stay local. The checked-in template contains an erased ROM window only. Generated firmware contains your ROM: keep it private and do not commit or publish it.

The template's matching [firmware source archive](lsdj/fm1-lsdj-template-source.zip)
includes build instructions, licenses and a per-file source manifest. It contains
no LSDj ROM or save. Rebuilding this archive reproduced the published template
and metadata byte-for-byte. Archive SHA-256:
`a6b1af73c28c92870604c94133f931c94a6596a5e186dbe3a70fe1811068862d`.

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

The FM-1_975 template passed local package-generation and
15-second firmware-emulator checks with LSDj 9.3.9: 661376 audio frames, LCD output,
input accepted and CPU not halted. Its erased cartridge window and matching
source-archive rebuild were verified. These checks do not validate physical
flashing, audible fidelity or save compatibility. The earlier 974 generated-slot
host test moved the real ROM cursor through channels 0/1/2/3/2/1/0 and verified
cutoff edits affected only that channel; its private SONG-screen fixture was
not available for the 975 rerun. Existing rendering tests still confirm no
channel tint across all 92 themes.

The 975 FX tests additionally verify bit-exact global bypass with channel mutes,
preserved settings, advancing echo/LFO/compressor state, seven-page mappings,
inert unused knobs, legacy page migration, and USB/Bluetooth settings round trips.
Browser checks cover All FX independently of the selected channel, live device
state, 11/17-word backups, older-firmware gating and overflow-free controls at
320/390/820/1280-pixel widths.

For that cursor regression, compile the source repository's `tests/lsdj_rom.c`
with `src/gb_port.c`, `build/minigb_apu.c`, `-Isrc -Ifirmware -Ivendor/peanut-gb`,
`-DMINIGB_APU_AUDIO_FORMAT_S16SYS -DAUDIO_SAMPLE_RATE=44100 -UNDEBUG` and `-lm`.
Run `tests/loader.mjs` with a private 9.3.9 ROM argument and environment variables
`LSDJ_SLOT_SMOKE` (compiled test path) and `LSDJ_CURSOR_SAVE` (a private, exact
128-KiB save that starts on the SONG screen). No save is modified or published.

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

For browser UI regressions, open a fresh local preview with the browser cache
disabled, then run this in its developer console:

```js
await (await import('./tests/loader-ui.mjs')).runLoaderUiTests()
```

This uses synthetic files and simulated network failures to check visible errors,
same-file retries, file-selection races, capacity guidance, consent and stale
download/installer invalidation. It never connects to or installs on a device.
It changes the form selections; reload afterward to discard the test state.
The suite also checks navigation targets and selected-package preview state.
On a fresh localhost page in a browser without Web MIDI, run
`await (await import('./tests/loader-ui.mjs')).runUnsupportedMidiUiTests()`
to check disabled USB controls, early rejection before install confirmation and
continued local preparation/download/preview selection. This test does not start
the emulator or access a device.

Run `node tests/fx-model.mjs` for FX format/layout tests (the FM-1_979 knob layout and
the 975-978 one, the FX+LIGHTS feature switches, the complete MIDI CC map),
`node tests/fx-diagram.mjs` for the Effects tab's wiring diagram and `node tests/zip.mjs`
for the Export all archive. On a fresh local preview,
run `await (await import('./tests/fx-ui.mjs')).runFxUiTests()` for simulated MIDI
controls and backup compatibility, and `.runExportUiTests()` from the same module for the
Songs tab's effects export and Export all .zip; reload afterward to remove the mock
connection. `tests/fx-shot.mjs` only connects a pretend FM-1_979 for screenshots and the
narrow-screen check.

From FM-1_979 the Songs tab exports the songs (`lsdj.sav`), the installed LSDj read back
from the FM-1 (`lsdj-installed.gb`, web installs from FM-1_974) and the effects
(`lsdj-burrito-effects.json`) separately, or all three as separate files in one `.zip`.
These go to the user's own computer only; nothing ROM-bearing is published.

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
