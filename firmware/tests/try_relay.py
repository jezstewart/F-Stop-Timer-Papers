#!/usr/bin/env python3
"""
try_relay.py - talk to the real relay timing logic (relay_core.h) by hand.

Starts /tmp/relay_cli (build it first with run_tests.sh) and lets you drive it
with plain commands instead of typing raw protocol bytes. Everything you type
really runs through RelayCore, the same C++ class the firmware uses, so the
timing you see here is the timing your hardware will give you.

Commands:
  connect / disconnect          simulate the Bluetooth link (relay_cli starts disconnected)
  expose <seconds>               arm a single exposure and start it immediately
  focus on / focus off
  pause / resume / cancel
  pedal [long]
  meter lit / meter dark / meter off   start or stop light-probe metering
  lux <lit> [<dark>]             fake probe light level in lux (lamp on, and optionally lamp off)
  probe on / probe off           fake probe fitted or not
  quit

Needs only the Python 3 standard library. Run: python3 try_relay.py
"""
import struct
import subprocess
import sys
import threading
import time

CLI = "/tmp/relay_cli"
STATE = ["IDLE", "ARMED", "FOCUS", "EXPOSING", "GAP", "PAUSED", "FAULT"]
FAULT = {0: "none", 1: "link lost in focus mode", 2: "lamp on too long"}


def u32(v):
    return struct.pack("<I", v).hex()


class Relay:
    def __init__(self):
        try:
            self.p = subprocess.Popen([CLI], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        except FileNotFoundError:
            sys.exit(f"{CLI} not found. Build it first: firmware/tests/run_tests.sh")
        self.plan_id = 0
        self.last_state = None
        self.linked = False
        self.last_sensor = 0
        threading.Thread(target=self._pinger, daemon=True).start()
        threading.Thread(target=self._reader, daemon=True).start()

    def _send(self, line):
        self.p.stdin.write(line + "\n")
        self.p.stdin.flush()

    def _pinger(self):                       # the tablet sends PING every 500 ms; without it the relay sees a lost link
        while True:
            time.sleep(0.5)
            if self.linked:
                self._send("W 01")

    def _reader(self):
        for line in self.p.stdout:
            self._handle(line.rstrip("\n"))

    def _handle(self, line):
        parts = line.split(" ")
        if parts[0] == "L":
            which = "enlarger" if parts[1] == "E" else "safelight"
            print(f"  [{int(parts[3]):>6} ms] {which:<10} {'ON' if parts[2] == '1' else 'off'}")
        elif parts[0] == "B":
            kind = {"0": "tick", "1": "step", "2": "done"}.get(parts[1], parts[1])
            print(f"  [{int(parts[3]):>6} ms] buzzer     {kind}")
        elif parts[0] == "N":
            self._decode(bytes.fromhex(parts[1]))

    def _decode(self, b):
        if b[0] == 0x81 and len(b) >= 18:  # STATUS
            state = STATE[b[1]]
            if state != self.last_state:
                lamp = "lamp on" if b[2] & 1 else "lamp off"
                print(f"           status: {state} ({lamp})")
                self.last_state = state
        elif b[0] == 0x83 and len(b) >= 8:  # SENSOR
            if time.time() - self.last_sensor >= 1.0:       # about one line per second is plenty
                self.last_sensor = time.time()
                flags = [n for bit, n in ((1, "busy"), (2, "over range"), (4, "under range"), (8, "probe error")) if b[1] & bit]
                mode = {1: "lit", 2: "dark"}.get(b[2], b[2])
                print(f"           probe ({mode}): {struct.unpack('<I', b[3:7])[0] / 100:.2f} lx, {b[7]} samples" + (f" [{', '.join(flags)}]" if flags else ""))
        elif b[0] == 0x82 and len(b) >= 2:  # EVENT
            ev = b[1]
            if ev == 1:
                print(f"           event: exposure done, total lamp time {struct.unpack('<I', b[2:6])[0]} ms")
            elif ev == 2:
                print("           event: cancelled")
            elif ev == 4:
                print("           event: focus light timed out")
            elif ev == 5:
                print(f"           event: FAULT - {FAULT.get(b[2], b[2])}")
            elif ev == 8:
                print(f"           event: plan rejected, code {b[3]}")

    # ---- readable commands, each building the real protocol frames ----
    def connect(self):
        self._send("CONN")
        self._send("W 01")
        self.linked = True

    def disconnect(self):
        self.linked = False
        self._send("DISC")

    def meter(self, mode):
        self._send(f"W 32{ {'off': 0, 'lit': 1, 'dark': 2}[mode]:02x}")

    def lux(self, lit, dark=None):          # fake probe: light level with the lamp on (and optionally off), in lux
        self._send(f"LUX {round(lit * 100)}" + (f" {round(dark * 100)}" if dark is not None else ""))

    def probe(self, fitted):
        self._send(f"PROBE {1 if fitted else 0}")

    def expose(self, seconds):
        self.plan_id = (self.plan_id + 1) & 0xFF
        ms = round(seconds * 1000)
        self._send(f"W 10{self.plan_id:02x}0001{u32(0)}")       # ARM_BEGIN: single, 1 step, no gap
        self._send(f"W 11{self.plan_id:02x}0001{u32(ms)}")      # ARM_STEPS: step 0 = ms
        self._send(f"W 12{self.plan_id:02x}")                   # ARM_END
        time.sleep(0.05)
        self._send("W 20")                                      # START

    def focus(self, on):
        self._send(f"W 30{'01' if on else '00'}")

    def pause(self):
        self._send("W 21")

    def resume(self):
        self._send("W 22")

    def cancel(self):
        self._send("W 23")

    def pedal(self, long_press=False):
        self._send(f"PEDAL {1 if long_press else 0}")

    def quit(self):
        self._send("QUIT")
        self.p.wait(timeout=2)


def main():
    r = Relay()
    print("Connected to relay_cli. Not yet linked -- type 'connect' first. 'help' lists commands.\n")
    while True:
        try:
            line = input("> ").strip()
        except EOFError:
            break
        if not line:
            continue
        word, *rest = line.split()
        if word in ("quit", "exit"):
            r.quit()
            break
        elif word == "help":
            print(__doc__)
        elif word == "connect":
            r.connect()
        elif word == "disconnect":
            r.disconnect()
        elif word == "expose" and rest:
            r.expose(float(rest[0]))
        elif word == "focus" and rest and rest[0] in ("on", "off"):
            r.focus(rest[0] == "on")
        elif word == "meter" and rest and rest[0] in ("lit", "dark", "off"):
            r.meter(rest[0])
        elif word == "lux" and rest:
            r.lux(float(rest[0]), float(rest[1]) if len(rest) > 1 else None)
        elif word == "probe" and rest and rest[0] in ("on", "off"):
            r.probe(rest[0] == "on")
        elif word == "pause":
            r.pause()
        elif word == "resume":
            r.resume()
        elif word == "cancel":
            r.cancel()
        elif word == "pedal":
            r.pedal(long_press=(rest[:1] == ["long"]))
        else:
            print("Not understood. Type 'help' for the command list.")


if __name__ == "__main__":
    main()
