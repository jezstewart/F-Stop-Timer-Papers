# F-stop darkroom timer: relay firmware and tablet web app

The tablet shows the interface. The relay unit (an ESP32-S3 board) times every exposure by itself and switches the enlarger and safelight, so a tablet that sleeps, crashes or loses Bluetooth cannot change an exposure in progress.

```
web/                  the tablet app (open index.html over https)
firmware/relay/       relay firmware: relay.ino, relay_core.h (timing and metering logic), opt3001.h (light probe driver), config.h (pins)
firmware/tests/       unit tests and a real-time test bridge for the timing logic
test/integration.js   runs the real web app against the real timing logic
test/simulator.js    drives the simulator through metering, calibration and a print
docs/PROTOCOL.md      the Bluetooth messages
simulator/            the interactive simulator, for trying the interface with no hardware. Includes a simulated darkroom bench for the light probe and paper calibration
```

## What has and has not been tested

Tested on a PC:

* The timing and metering logic in `relay_core.h`, the probe driver in `opt3001.h` and the relay pin drive in `switch_drive.h`: 266 unit checks (exposure length, strip test gaps, pause, cancel, pedal, focus timeout, lost link, plan validation, latency offset, safelight, one-hour lamp cap, probe averaging and settling, metering safety rules, the enlarger shake delay, OPT3001 register handling against a fake I2C bus, and the order in which the relay pins are driven).
* The web app against that same logic: 355 integration checks, including the Meter, Print and Calibrate tabs, the paper list with its keyboard, and a check that nothing runs underneath the tab bar. The only fake parts are the Bluetooth radio and, for the probe, the light sensor itself. Frames pass byte for byte in both directions.

**Not tested, because it needs hardware:** `relay.ino` (Bluetooth service, pins, buzzer, saved settings, and the Wire glue for the light probe), a real OPT3001 (its noise, conversion time and the "settled" thresholds will probably need tuning), Web Bluetooth in Chrome on your tablet, and the mains switching. It was written against the NimBLE-Arduino 2.x and Arduino-ESP32 3.x documentation and type-checked, but expect to fix small things on first run. The bring-up steps below are designed so you find them safely.

## Parts

* ESP32-S3-WROOM-1 N16R8 development board with the expansion adapter.
* A 2-channel 5 V relay module: the common blue board with two Songle SRD-05VDC-SL-C relays and optocoupler inputs.
* A foot pedal (a normally open switch), and a passive piezo buzzer.
* A time-lag 2 A fuse and holder, a master switch, an enclosure, cable glands, mains cable suitable for your country, and a separate certified USB charger for the board.
* Optional light probe: a TI OPT3001 breakout board on a short cable (3V3, GND, SDA, SCL to the pins in `config.h`, GPIO 8 and 9 by default). The Meter tab shows "No light probe fitted" until the relay finds it.
* Optional: a 275 V AC varistor across the relay contacts, and an inrush limiter (NTC thermistor), see below.

## Choosing the relay for a transformer-fed halogen enlarger

The enlarger's 100 W halogen lamp runs from a transformer, so the relay switches the mains side of a transformer: about 0.5 A steady, but a much larger surge when it is energised. Transformer inrush can be 10 to 15 times the rated current for several cycles, and up to about 60 times for a toroidal one.

* **Zero-cross solid state relays, such as the G3MB-202P, are the wrong tool.** Switching on at zero voltage is the worst moment to energise a transformer, and manufacturers of solid state relays say zero-cross starting should be avoided for this load. A generic random turn-on solid state relay is not a proven answer either. Solid state relays also usually fail shorted.
* **A mechanical relay is a good match.** The contacts of the SRD-05VDC-SL-C are rated 10 A, about twenty times the steady current, so the surge is comfortable. They leak nothing when off. Like any relay, the contacts can weld shut after a bad surge, so keep the master switch.
* Mechanical relays take about 10 ms to switch. Use the latency offset in Settings if you want to trim it.

Suggested split: relay 1 for the enlarger, relay 2 for the safelight, both on the one module.

## Wiring the 2-channel relay module

Its pin header is labelled VCC, IN2, IN1, GND, and a second header GND, VCC, JD-VCC with a blue jumper. VCC and JD-VCC are names printed on the **relay module**, not on the ESP32 board; the ESP32-S3-WROOM-1 N16R8 board has no pin called VCC at all. Its terminal for this is labelled **5Vin**, at the bottom of the left-hand column (just above GND) on the terminal adapter — that's the one both relay-module wires below connect to.

**Correction:** an earlier version of this README said to power VCC from the board's 3V3 pin. That's wrong and is corrected below. Powering the opto-coupler side at only 3.3 V leaves little margin for the LED inside it to turn on reliably, so the relay can be slow or inconsistent to trigger. The standard, well-tested wiring (the same one used in the most widely followed ESP32 relay tutorials) powers VCC from 5 V as well, and relies on the GPIO pin pulling LOW to switch the relay, which works the same regardless of VCC. If you already wired VCC to 3V3, move that one wire to 5V; nothing else changes.

| Module | Goes to | Notes |
|---|---|---|
| **Leave the blue jumper on** | | It ties VCC to JD-VCC, so both sides run from the one 5 V feed below. There's no separate isolated coil supply in this design, so removing it buys nothing. |
| VCC or JD-VCC | board 5Vin | one wire is enough; the jumper carries it to the other pin. Powers the opto-coupler LEDs and the relay coils (about 70 mA each). |
| GND | board GND | |
| IN1 | GPIO 4 | enlarger, `PIN_ENLARGER` |
| IN2 | GPIO 5 | safelight, `PIN_SAFELIGHT` |

The inputs are **active low**: the relay is on when the pin is low. `config.h` is already set that way, and this still works correctly with VCC at 5 V, because the GPIO only needs to pull down to its own 0 V to turn the opto-coupler on; it never needs to swing up to 5 V. An unconnected input leaves the relay off, so the relay stays off while the board boots. Power the board from a USB charger that can supply at least 1 A, because two coils and the board together draw a few hundred milliamps.

If you'd rather keep the logic and coil supplies on separate wires for easier troubleshooting (equivalent electrically, just two wires instead of one), remove the jumper and run a second wire from board 5Vin to the other pin; either way both ends up at 5 V, since this design has only the one 5 V source.

Other connections:

| Board pin | Goes to |
|---|---|
| GPIO 6 | foot pedal, other leg to GND |
| GPIO 7 | piezo buzzer, other leg to GND |

Avoid GPIO 0, 3, 45, 46 (boot), 19, 20 (USB), 26 to 32 (flash), 33 to 37 (octal flash and PSRAM on N16R8). Check your own board's labels.

**Mains side.** Use COM and NO (normally open) on each relay, so an unpowered relay means lamp off. Switch the live wire only:

```
mains live --[T2A fuse]--[master switch]-- relay 1 COM ...NO -- enlarger live
mains live --------------------------------- relay 2 COM ...NO -- safelight live
neutral and earth pass straight through to both, never through the relay
```

If the fuse blows, the relay contacts weld shut, or the lamp dips when it switches on, the transformer's surge is too large. Fit an inrush limiter (an NTC thermistor in series with the enlarger's mains lead, sized for the transformer) or use a relay with heavier contacts.

## Mains safety

The enlarger and safelight are mains loads. Use an enclosed box with the mains wiring separated from the board, a time-lag fuse (2 A), a proper earth connection, strain relief on every cable, and an RCD-protected supply, which matters in a wet room. Add a master switch. Have someone qualified check the mains side before you use it.

## First power-up, with nothing on mains

0. Wire the low-voltage side only (module VCC, JD-VCC, GND, IN1, IN2, pedal, buzzer). Leave the mains terminals empty.
1. Flash the firmware (below). Open the serial monitor at 115200 baud. You should see `relay ready: FStopRelay`.
2. Install a Bluetooth scanner app (for example nRF Connect) on the tablet or a phone. You should see `FStopRelay` and the service `6f9c0001-...`.
3. Open the web app (below) and tap Connect. The Relay panel (tap "Relay" in the status bar) should show `connected`, `protocol 1`, and status updates arriving.
4. Test each output without mains: Focus light on should light the module's IN1 LED and click relay 1, the Safelight button relay 2, and a start should switch relay 1 for the shown time. Check with a multimeter on continuity between COM and NO. Both relays must be off when the board is unplugged or resetting.
5. Try the foot pedal (short press starts, pauses, resumes; hold one second to cancel) and the buzzer.
6. Only then connect the mains wiring, inside the enclosure.

## Flashing the relay

1. Install the Arduino IDE (see "Using a Raspberry Pi instead of a PC" below if that's what you have). Open File, then Preferences, and add `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json` under Additional Board Manager URLs. In Boards Manager install "esp32 by Espressif Systems" version 3.x. In Library Manager install "NimBLE-Arduino" by h2zero, version 2.x.
2. Open `firmware/relay/relay.ino`. Edit pins and polarity in `config.h` if needed.
3. Board: "ESP32S3 Dev Module". Set Flash Size to 16 MB. For PSRAM choose "OPI PSRAM" (or Disabled). Menu names can differ slightly between versions.
4. Connect the USB port labelled UART or COM (not the native USB one), pick the port, and upload. The same cable can power the board for every step up to "connect the mains wiring" below; a Pi 4 or a PC can both supply this over USB with current to spare.

### Using a Raspberry Pi instead of a PC

This works well, with one thing to know: Arduino only ship the current Arduino IDE 2.x for Windows, macOS and Linux on x86-64, not for Linux on Arm, so the normal download from arduino.cc won't run on a Pi. Use the older Arduino IDE 1.8.19 instead, which Arduino do build for Arm, and which handles this sketch just as well:

* Easiest: `sudo apt update && sudo apt install arduino` installs it from Raspberry Pi OS's own repository.
* Or download it directly: on the Pi, open arduino.cc's software page, scroll to "Legacy IDE (1.8.X)", and get the Linux ARM 64 bit build; extract it and run `install.sh`.

From there, steps 1 to 4 above are identical: the esp32 board package publishes an Arm64 Linux build of its toolchain too, so Boards Manager installs it the same way.

If the Tools, Port menu doesn't show the board, your user account likely isn't in the `dialout` group yet, which Linux requires for serial port access: run `sudo usermod -a -G dialout $USER`, then log out and back in.

## Hosting and installing the web app

Web Bluetooth only works on a secure page.

1. Put the `web` folder on any HTTPS static host (GitHub Pages, Netlify and similar are free).
2. On the tablet open the address in **Chrome**. Web Bluetooth also works in Samsung Internet, not in Safari or on iOS.
3. Use the browser menu, "Install app" or "Add to Home screen". It then opens fullscreen and works without a network.
4. Tap Connect and choose `FStopRelay`. After a drop the app reconnects by itself. After the page is reloaded you may need to tap Connect again, and the pairing list is a system dialog you cannot recolour, so do this with the room lights on.

For development without a host: on a computer run `python3 -m http.server 8080` in `web`, connect the tablet by USB with debugging on, run `adb reverse tcp:8080 tcp:8080`, and open `http://localhost:8080` in Chrome on the tablet. Localhost counts as secure.

When you change any web file, change `CACHE` in `web/sw.js` and `APP_VERSION` in `web/index.html` to the same new name, so tablets pick up the new version. The Relay panel shows the app version, so you can confirm which build a tablet is running. The test suite checks that the two match.

## Tablet setup checklist

Red safelight filter film over the screen, fullscreen (installed app), Do Not Disturb on, auto-rotate off, on its charger with the screen kept awake, and paper fog test passed. A web page cannot change the tablet's backlight, so the "dim while exposing" setting only darkens the page's own pixels.

## Light probe and the Meter tab

The probe measures light on the baseboard. The relay averages the readings and reports them over Bluetooth; the tablet turns them into stops and shows them on the Meter tab. There is no paper calibration: everything is relative to a reading you store.

1. **Zero probe.** Cover the probe and press Zero probe. The enlarger stays off, the safelight goes off for a few seconds, and the probe's dark offset is stored on the tablet.
2. **Start metering.** The enlarger comes on (as in focus mode, with the same timeout) and the safelight goes off. Wait for the status to read Steady before trusting or storing a reading; at low light it can take a few seconds.
3. **Highlight and shadow.** Aim the probe at the part of the image that should be the lightest in the print and press **Store highlight**. That is the densest part of the negative, so it is the *dimmest* light. Then aim it at the part that should be darkest (the thinnest part of the negative, the *brightest* light) and press **Store shadow**. The table shows each in stops, as log D relative to the brightest stored reading, and how many stops brighter the shadow is than the highlight.
4. **Set reference** stores the current reading as 0 stops. If you never set one, the highlight is the reference. The bar shows 3 stops darker to 7 stops lighter than the reference, with the live reading, highlight and shadow marked.

Metering ends by itself when focus mode ends, when an exposure starts (foot pedal included), when you leave the Meter tab, or when the Bluetooth link is lost; the safelight then comes back on. The safelight setting you chose is never changed by metering.

## Tab order

Meter, Print, Time, Strip test, Recipe, Develop, Log, Scale, Calibrate, Settings. The first two are the analysis workflow (meter the negative, then read the time); Time, Strip test and Recipe are the manual timers; Calibrate is the one-off paper setup, kept apart from printing; Scale and Log are tools.

## Paper profile, calibration and the tone scale (Calibrate and Exposure tabs)

The **Calibrate** tab measures your paper and holds the profile. The **Print** tab turns your highlight and shadow readings into an exposure time using that profile, and shows where the highlight and shadow will land on the paper. It never chooses the grade: you enter it.

**Profile.** One profile per paper, enlarger and filter set (at the moment one, set up as Ilford Multigrade RC Deluxe, satin, with Multigrade filters). It stores, for each grade you calibrate, two doses measured on blank paper: the dose that first gives a visible tone (the print highlight) and the dose that gives full black. Doses are in lux seconds as your probe reads them, using the nominal times typed on the Timer tab, so they are only meaningful for this probe position and enlarger. Nothing is pre-loaded: the profile starts empty and every number in it is your own measurement.

**Calibrating a grade** (Calibrate tab):
1. Choose the grade, put its filter in, remove the negative, and put the probe on the baseboard. Start metering, wait for Steady and press Store light. Keep the same height and aperture for the strips.
2. Set up a highlight strip test. It runs on the Strip test tab, so set the base time and step first. Blank paper, short times. After processing and drying, pick the lightest strip that is clearly darker than unexposed paper. If every strip shows tone, press Redo and use a shorter base time.
3. Do the same with longer times for the shadow strips, and pick the first strip that is as black as the strips beyond it. If none reaches full black, redo it with a longer base time.

The grade is saved once both strips are picked. Calibrate at least two grades, for example 0 and 5, or 0, 2 and 5. Grades in between are interpolated in a straight line, which assumes the filter steps are equal; grades outside the calibrated ones are refused rather than guessed. The strips are processed and dried between steps, so the Calibrate tab keeps its place if you close the app. **Export profile** (top right of the Calibrate tab) saves the profile and the calibration strips as a JSON file for backup, and **Import profile** reads such a file back. Importing adds the file's grades to the ones already in the app and overwrites a grade with the same number; it never removes anything. A file that is not a profile export, or whose grades are invalid, is refused with a message and changes nothing. The app also asks the browser to keep its saved data, and the Relay panel says whether it agreed.

**Using it.** Store a highlight and a shadow reading on the Meter tab, then open the Exposure tab: choose the current paper grade, and the time that puts the highlight at the paper's first tone appears. You can place the highlight some stops above first tone, and change the time in steps; the markers (H for highlight, S for shadow) on the scale move with the time, and spread or close up when you change the grade. The lines under the scale say how many stops the negative covers against how many the paper covers at that grade. Use as base time copies the time to the Timer tab.

**Grey and red.** The tone scale is true grey only while you are setting up: the link is up, the relay is idle or armed, the lamp is off and you are not metering. In every other case, including whenever the app cannot tell, it is red, and it is red on the exposure screen. Grey is dim (limit set in Settings, 30% by default) but it still contains blue-green light. Before trusting it, do a fog test: put a scrap of paper near the screen with the grey scale showing, for longer than you would ever leave it, and develop it. If it fogs, lower the limit or switch True grey tone scale off in Settings. If the red safelight film is over the screen, the grey will look red.

The shape between first tone and full black is a smooth S, not a measurement: only those two end points come from your paper.

## Simulator

Open `simulator/fstop_timer_simulator_tablet.html` in a browser. It runs the same screens as the web app against a simulated relay unit, and adds a **darkroom bench** panel: a light probe that reads the light at the baseboard (with lag, noise, an optional warm-up and a dark level you can change), a Multigrade filter that takes some light away, a negative with an adjustable range, and a paper whose real response is hidden. Strip tests and prints develop on the simulated paper, so you judge the strips by eye, calibrate two grades, predict a print at a grade in between, expose it and see how close it came. Set the speed to 10x to get through long exposures quickly. All the numbers on the bench are invented, so use it to learn how the screens behave, not to predict your own paper. The paper response in the simulator never leaves the page.

## Develop tab: temperature and the process timer

With a DS18B20 temperature probe in the developer (data on GPIO 10 with a 4.7k pull-up, see the pin map), the **Develop** tab shows the developer temperature and times the baths. The relay reads the probe only while this tab is open, and never during an exposure.

* **Target 20 degrees C.** The screen says how far you are from 20, and warns outside 18 to 24 degrees C, the range Ilford gives for its stop bath and fixer.
* **Ilford publishes no change of tray development time for other temperatures.** Its tray times are for 20 degrees C; the table of times at 25 to 40 degrees C in its processing sheet is for machine processors. So the timer does not invent an adjustment. **Time change per degree C** is off by default; if you find a value that works for you, set it (0.5% to 10% per degree, longer when colder, shorter when warmer, limited to half or double) and the screen says the adjustment is your own.
* **The baths.** Develop, Stop bath, Fix and an optional Wash, with Ilford's figures for MULTIGRADE RC Deluxe at 20 degrees C as presets: MULTIGRADE developer 1+9 for 1 minute or 1+14 for 1.5 minutes, Bromophen or PQ Universal for 2 minutes; Ilfostop for 10 seconds; Rapid Fixer 1+4 for 30 seconds or 1+9 for 1 minute; wash for 2 minutes. Ilford's minimum recommended development time for good prints is about 45 seconds.
* **Cues on the relay's buzzer** (so it works with the tablet face down): a long cue at the start of each bath and at the end, a tick for each of the last five seconds, and a cue 10 seconds before the end of the develop time to lift the print so it drains.
* The timer keeps running if you change tab; the header shows which bath it is in. Pause, Next bath and Reset are on the Develop tab. The timing runs on the tablet, so keep the tablet awake.

## Current paper grade, and where to start an exposure

The **current paper grade** (the Multigrade filter you have in the enlarger, 00 to 5 in half steps) is shown as a chip at the top of every screen, labelled "Current paper grade". Tap it to go to the Print screen, where the **Current paper grade** buttons change it. It is separate from calibrating a grade: the grade chips on the Calibrate tab choose which grade to measure and never change the current paper grade.

There are two places to start an exposure, and the screen you are on decides which one runs:

* **Timer tab:** Start runs the base time and offset (a manual exposure, whatever the grade).
* **Exposure tab (called Print in earlier versions):** Start runs the time shown on the Exposure screen, worked out from your highlight reading, the current paper grade and the paper profile. The foot pedal runs that same time while the Print tab is open, and the Timer tab's own base time is left alone. If the Print screen has no time yet (no profile for the grade, or no highlight reading), Start is switched off and the pedal runs whatever was armed before. **Use as base time** copies the printed time to the Timer tab when you want to work from it there.

The exposure screen shows the grade instead of the stops for an exposure started from the Exposure tab, and the log records it as "Print time, grade X".

## Versions

The Settings screen shows the app version and, when connected, the relay firmware version. If the relay reports firmware older than the app needs (currently 1.3), a banner on every screen says so. After uploading new firmware or a new `web` folder, check both numbers. Firmware 1.2 is the first with the shake delay, and 1.3 the first with the temperature probe.

## Shake delay and print time compensation

Both are in **Settings**.

**Enlarger shake delay** (off, or 0.5 to 10 seconds). After you press Start, the relay switches the enlarger off (if the focus light was on) and waits that long before the first exposure, so vibrations from the button press settle. The status chip reads Waiting and the screen counts down. The wait is part of the relay, so a sleeping or crashed tablet cannot change it, and the lamp is never on during it. Cancel works (the screen button or a long press on the foot pedal); Pause does not. It happens once, before the first step, and does not change the gaps between steps of a strip test or recipe. Old tablets that do not send the setting get no delay.

**Print time compensation** (minus 20% to plus 20%). A multiplier for dry-down or toning, applied to single exposures and recipes (a recipe's burns and dodges keep their stop relationships). It is not applied to strip tests, and **Use as base** copies the time without it, so it is never counted twice. The tone scale on the Print tab does not include it.

## Relay pin drive and the relay module

With `RELAY_FLOAT_WHEN_OFF` set to 1 in `config.h` (the default), an active-low relay input is released (set to input) when the relay is off, instead of being driven HIGH, and it is set that way before anything else runs at power-up. A 3.3 V HIGH can leave a module whose optocoupler is powered from 5 V partly switched on; a released pin cannot. Set it to 0 if your module has its own transistor or level shifter. Either way, check what your module's input does with a multimeter before connecting mains.

## Interface colours and light safety

The interface is red on black. The only other colour is a light-safe orange (red 255, green 77, blue 0), used for the text of the active tab and of every active or selected button (Start, the chosen step size, Focus light, Safelight, the banner), always on a dark red background rather than a bright red block. Orange has a little green in it: on an LCD the green sub-pixels glow at roughly 7% of full, from a few letters. That is far less than a grey or white area, but it is not zero, so include it in your paper fog test. To go back to pure red, change `--o` at the top of the style block in `web/index.html` to the red `--r4` value.

The page declares `color-scheme: dark`, so the tablet browser's automatic dark mode does not re-colour it. Without that, some browsers can turn black text on a red button (the Start button, the selected chips) white. The test suite checks the colours the browser actually computes on every tab and fails if any element uses anything lighter than the red and orange palette. The grey tone scale is the one deliberate exception.

## Running next to the first version of the app

This version keeps its data under its own name (`fstop-papers-v1`) and its offline cache under `fstop-papers-`, so it can be hosted on the same GitHub Pages account as the first version without the two sharing or deleting each other's data. The first time it opens with nothing saved, it reads (never writes) the first version's saved profile and times and turns them into its first paper. The first version is not changed.

## Updating the tablet app

Change `CACHE` in `web/sw.js` and `APP_VERSION` in `web/index.html` together whenever you change a web file (the test suite checks they match), upload the `web` folder, and open the app on the tablet. The Relay panel shows the app version.

## Running the tests

```
firmware/tests/run_tests.sh      # 266 unit tests for relay_core.h, opt3001.h, ds18b20.h and switch_drive.h, and builds /tmp/relay_cli
node test/simulator.js           # 78 checks driving the simulator: the shake delay, metering, calibrating two grades, predicting and exposing a print
python3 firmware/tests/try_relay.py   # drive that same build by hand (needs run_tests.sh first)
node test/integration.js         # the real web app against that same build; needs Playwright (npm i playwright)
```

`run_tests.sh` needs a C++ compiler (`sudo apt install build-essential` on Raspberry Pi OS or Debian if you don't already have one) and takes a couple of seconds. It exercises `relay_core.h`, the timing logic also used by `relay.ino`, with no hardware or Bluetooth involved. It also compiles `/tmp/relay_cli`, a command-line build of that same logic, running in real time, which the other two tools drive rather than you typing raw protocol bytes.

`try_relay.py` is the easiest way to see that logic behave: `connect`, then `expose 2` arms and starts a 2 second exposure and prints each relay and buzzer change as it happens, with real timestamps. `help` lists the rest (`focus on`/`off`, `pause`, `resume`, `cancel`, `pedal`, `disconnect` to rehearse a dropped link).

`test/integration.js` is the one that matters most, since it checks the actual `web/index.html` against this logic with a mocked Bluetooth layer standing in for the radio only; every frame crosses that mock byte for byte. It needs Node and Playwright's Chromium (`npm i playwright && npx playwright install chromium`, not `playwright install chrome`, which Playwright doesn't build for Arm). On a Pi, Playwright's own dependency installer only recognises Ubuntu by name, so skip `--with-deps`; if Chromium then complains about a missing shared library on launch, install it with `apt` and try again. This one is already covered: it passed 172 of 172 before the project was handed over, so there's no need to reproduce it unless you change the protocol or the app. `try_relay.py` can also drive the fake probe (`LUX`, `PROBE` lines on the bridge's stdin; see `relay_cli.cpp`).

## Changing the protocol

Edit `docs/PROTOCOL.md`, then `relay_core.h`, then the `encode` and `decode` functions in `web/index.html`, then run both tests. If you change a UUID, change it in `relay.ino` and `web/index.html`.
