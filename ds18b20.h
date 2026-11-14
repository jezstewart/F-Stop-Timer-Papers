// ds18b20.h - driver for the Dallas/Maxim DS18B20 temperature probe on a 1-Wire bus (one probe only).
//
// No Arduino dependencies: the bus is a template parameter, so the logic is unit tested on a PC against
// a fake probe (firmware/tests) and used on the ESP32-S3 through the bit-banged bus in relay.ino.
//
// Facts used (check them against the datasheet if you change anything):
//   commands: 0xCC skip ROM (one device on the bus), 0x44 convert temperature, 0xBE read scratchpad (9 bytes)
//   12 bit conversion takes up to 750 ms; temperature = signed 16 bit value / 16 degrees C (bytes 0 and 1)
//   byte 8 is a CRC-8 (polynomial x^8 + x^5 + x^4 + 1) of bytes 0 to 7
//   +85.0 C (0x0550) is the power-on value, so it means "no conversion happened", not a real reading
//
// NOTE: the bus timing in relay.ino is not yet tested on real hardware.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "relay_core.h"

namespace fstop {

constexpr uint8_t  DS_SKIP_ROM = 0xCC, DS_CONVERT = 0x44, DS_READ_SCRATCH = 0xBE;
constexpr uint32_t DS_CONVERT_MS = 750;          // 12 bit conversion, worst case
constexpr uint32_t DS_PERIOD_MS  = 1000;         // a new reading about once a second
constexpr uint8_t  DS_MAX_FAILS  = 5;            // consecutive failures before the probe counts as gone

// CRC-8 used by the DS18B20 and by 1-Wire ROM codes.
inline uint8_t ds18b20Crc8(const uint8_t* d, size_t n) {
  uint8_t crc = 0;
  for (size_t i = 0; i < n; i++) {
    uint8_t in = d[i];
    for (uint8_t j = 0; j < 8; j++) {
      uint8_t mix = (uint8_t)((crc ^ in) & 1);
      crc >>= 1; if (mix) crc ^= 0x8C;
      in >>= 1;
    }
  }
  return crc;
}

// Scratchpad -> temperature in 0.01 C. False when the CRC is wrong or the value is the power-on +85.0 C.
inline bool ds18b20Decode(const uint8_t sp[9], int16_t* centi) {
  if (ds18b20Crc8(sp, 8) != sp[8]) return false;
  int16_t raw = (int16_t)(((uint16_t)sp[1] << 8) | sp[0]);
  if (raw == 0x0550) return false;
  int32_t c = (int32_t)raw * 100;
  c = (c >= 0 ? c + 8 : c - 8) / 16;             // /16 degrees, rounded to the nearest 0.01
  *centi = (int16_t)c;
  return true;
}

// Bus needs:  bool reset();  (true if a probe answered)    void write(uint8_t);    uint8_t read();
template <class Bus>
class Ds18b20 {
 public:
  explicit Ds18b20(Bus& bus) : bus_(bus) {}

  bool detect() { present_ = bus_.reset(); fails_ = 0; if (!present_) { running_ = false; converting_ = false; } return present_; }
  bool present() const { return present_; }

  void run(bool on) { running_ = on; converting_ = false; convStart_ = 0; started_ = false; }

  // Call often. Returns TR_NONE until a reading is ready (about one a second). The conversion itself happens
  // inside the probe, so this only talks to the bus briefly (about 1 ms to start, 6 ms to read).
  TempResult poll(uint32_t nowMs, int16_t* centi) {
    if (!present_ || !running_) return TR_NONE;
    if (!converting_) {
      if (started_ && (nowMs - convStart_) < DS_PERIOD_MS) return TR_NONE;
      if (!bus_.reset()) return fail();
      bus_.write(DS_SKIP_ROM); bus_.write(DS_CONVERT);
      converting_ = true; started_ = true; convStart_ = nowMs;
      return TR_NONE;
    }
    if ((nowMs - convStart_) < DS_CONVERT_MS) return TR_NONE;
    converting_ = false;
    if (!bus_.reset()) return fail();
    bus_.write(DS_SKIP_ROM); bus_.write(DS_READ_SCRATCH);
    uint8_t sp[9]; for (uint8_t i = 0; i < 9; i++) sp[i] = bus_.read();
    if (!ds18b20Decode(sp, centi)) return fail();
    fails_ = 0; return TR_OK;
  }

 private:
  TempResult fail() { converting_ = false; if (++fails_ >= DS_MAX_FAILS) { present_ = false; running_ = false; } return TR_ERROR; }
  Bus& bus_;
  bool present_ = false, running_ = false, converting_ = false, started_ = false;
  uint8_t fails_ = 0; uint32_t convStart_ = 0;
};

}  // namespace fstop
