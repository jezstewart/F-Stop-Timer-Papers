// config.h - wiring and options for the relay unit.
// Edit this file to match how you wired the board. Nothing else needs changing.
#pragma once

// ---- Pins (ESP32-S3-WROOM-1 N16R8 development board) ------------------------
// Avoid: GPIO 0, 3, 45, 46 (boot strapping), 19, 20 (USB), 26-32 (flash),
//        33-37 (octal flash / PSRAM on N16R8), 43, 44 (UART0).
// Always check the pin labels printed on your own board.
#define PIN_ENLARGER   4     // relay module input IN1: enlarger
#define PIN_SAFELIGHT  5     // relay module input IN2: safelight
#define PIN_PEDAL      6     // foot pedal between this pin and GND (internal pull-up, normally open)
#define PIN_BUZZER     7     // passive piezo buzzer, other leg to GND
#define PIN_I2C_SDA    8     // light probe (OPT3001) SDA. Check your board's labels for GPIO 8 and 9.
#define PIN_I2C_SCL    9     // light probe (OPT3001) SCL
#define PIN_ONEWIRE    10    // temperature probe (DS18B20) data line, with a 4.7k pull-up to 3V3

// ---- Output polarity ---------------------------------------------------------
// 0 = the relay turns ON when the pin is LOW. This is right for the common blue
//     2-channel relay module with optocoupler inputs (Songle SRD-05VDC-SL-C relays).
//     An unconnected or floating input leaves the relay OFF.
// 1 = the relay turns ON when the pin is HIGH (for example a transistor driver
//     between the pin and a relay or solid state relay input).
#define ENLARGER_ACTIVE_HIGH   0
#define SAFELIGHT_ACTIVE_HIGH  0

// ---- What the pin does when the relay is off -----------------------------------------
// 1 = for an active-low module (the *_ACTIVE_HIGH options above set to 0), the pin is released (set to
//     input) instead of being driven HIGH when the relay is off. Switching on still drives the pin LOW.
//     Use this with a module whose optocoupler is powered from 5 V while the ESP32 only swings 3.3 V:
//     a 3.3 V "high" leaves about 1.7 V across the optocoupler, which can keep the relay partly on or
//     make it chatter. A released pin passes no current, so the relay is off, and it is also off
//     while the board is booting. If your module is wired with a transistor or level shifter, 0 is fine.
// 0 = always drive the pin HIGH or LOW.
#ifndef RELAY_FLOAT_WHEN_OFF
#define RELAY_FLOAT_WHEN_OFF   1
#endif

// ---- Light probe (OPT3001 on I2C, 3.3 V) -------------------------------------------
// Probe address: 0x44 with the sensor's ADDR pin to GND (the usual breakout default), 0x45 to VDD.
// Most breakouts already have I2C pull-up resistors; add 4.7k to 3V3 on SDA and SCL if yours does not.
#define PROBE_ENABLED   1
#define OPT3001_ADDR    0x44
#define I2C_HZ          100000   // keep at 100 kHz for a probe on a cable

// ---- Temperature probe (DS18B20 on 1-Wire, 3.3 V) --------------------------------------
// One probe on PIN_ONEWIRE. The relay only reads it while the tablet's Develop tab asks for it, and never
// while an exposure is timing. The bit timing is done in software and is not yet tested on real hardware.
#define TEMP_ENABLED    1

// ---- Timing ------------------------------------------------------------------
#define PEDAL_DEBOUNCE_MS   30
#define PEDAL_LONG_MS       1000     // hold this long to cancel

// ---- Bluetooth -----------------------------------------------------------------
#define BLE_DEVICE_NAME  "FStopRelay"

// ---- Debug output on the serial port (115200 baud) ------------------------------
#define SERIAL_DEBUG 1
