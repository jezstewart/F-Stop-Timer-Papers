// switch_drive.h - how a relay input pin is driven, kept apart from relay.ino so it can be tested on a PC.
// Uses the Arduino functions pinMode and digitalWrite; the tests supply recording stand-ins for them.
#pragma once
#include "config.h"

// Drives one relay input. With RELAY_FLOAT_WHEN_OFF, an active-low input is released when off (see config.h).
static inline void writeSwitch(int pin, bool on, int activeHigh) {
#if RELAY_FLOAT_WHEN_OFF
  if (!activeHigh) {
    if (on) { digitalWrite(pin, LOW); pinMode(pin, OUTPUT); }   // latch LOW first, then drive it: no glitch
    else pinMode(pin, INPUT);                                    // released: no current through the optocoupler, relay off
    return;
  }
#endif
  digitalWrite(pin, (on == (activeHigh != 0)) ? HIGH : LOW);
}
// Puts a relay input in its OFF state before anything else runs.
static inline void initSwitch(int pin, int activeHigh) {
#if RELAY_FLOAT_WHEN_OFF
  if (!activeHigh) { pinMode(pin, INPUT); return; }
#endif
  digitalWrite(pin, activeHigh ? LOW : HIGH);                   // latch the OFF level first, then make it an output
  pinMode(pin, OUTPUT);
}
