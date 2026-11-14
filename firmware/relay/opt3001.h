// opt3001.h - driver for the TI OPT3001 ambient light sensor (I2C).
//
// No Arduino dependencies: the I2C bus is a template parameter, so this file is
// unit tested on a PC with a fake bus (firmware/tests) and used on the ESP32-S3
// through a small Wire wrapper in relay.ino.
//
// Register facts used here (check them against the datasheet if you change anything):
//   0x00 result:  bits 15..12 exponent E, bits 11..0 mantissa R.  lux = 0.01 * 2^E * R
//   0x01 config:  RN[15:12] = 1100 automatic full-scale range, CT bit 11 (0 = 100 ms, 1 = 800 ms),
//                 M[10:9] = 11 continuous / 00 shutdown, OVF bit 8, CRF bit 7 (conversion ready), L bit 4 latch
//   0x7E manufacturer id 0x5449, 0x7F device id 0x3001
//   16 bit registers, most significant byte first.
//
// NOTE: not yet run on real hardware. Conversion time, noise and the "settled" thresholds in
// SensorFilter (relay_core.h) are expected to need tuning once a probe is wired up.
#pragma once
#include <stdint.h>
#include "relay_core.h"

namespace fstop {

constexpr uint8_t  OPT_REG_RESULT = 0x00, OPT_REG_CONFIG = 0x01, OPT_REG_MANUF = 0x7E, OPT_REG_DEVICE = 0x7F;
constexpr uint16_t OPT_MANUF_ID = 0x5449, OPT_DEVICE_ID = 0x3001;
constexpr uint16_t OPT_CFG_RUN_100MS  = 0xC610;    // auto range, 100 ms, continuous, latched
constexpr uint16_t OPT_CFG_RUN_800MS  = 0xCE10;    // auto range, 800 ms, continuous, latched
constexpr uint16_t OPT_CFG_STOP       = 0xC010;    // auto range, shutdown
constexpr uint16_t OPT_CRF = 0x0080, OPT_OVF = 0x0100;
constexpr uint32_t OPT_POLL_MS = 10;               // how often to ask whether a conversion is ready
constexpr uint8_t  OPT_MAX_FAILS = 5;              // consecutive bus errors before the probe counts as gone

// Result register -> 0.01 lux. The sensor's resolution is 0.01 lux at exponent 0, so this is exact.
inline uint32_t opt3001Centilux(uint16_t result) { return (uint32_t)(result & 0x0FFF) << (result >> 12); }

// Bus needs:  bool read16(uint8_t reg, uint16_t* v);   bool write16(uint8_t reg, uint16_t v);   (false on any I2C error)
template <class Bus>
class Opt3001 {
 public:
  explicit Opt3001(Bus& bus, uint16_t runConfig = OPT_CFG_RUN_100MS) : bus_(bus), runCfg_(runConfig) {}

  // Looks for the sensor by reading its two id registers. Safe to call repeatedly while idle.
  bool detect() {
    uint16_t m = 0, d = 0;
    present_ = bus_.read16(OPT_REG_MANUF, &m) && m == OPT_MANUF_ID && bus_.read16(OPT_REG_DEVICE, &d) && d == OPT_DEVICE_ID;
    fails_ = 0; if (!present_) running_ = false;
    return present_;
  }
  bool present() const { return present_; }

  void run(bool on) {
    if (!present_) return;
    running_ = on;
    if (!bus_.write16(OPT_REG_CONFIG, on ? runCfg_ : OPT_CFG_STOP)) fail();
  }

  // Returns SR_NONE when no new reading is ready. Cheap enough to call every loop pass.
  SensorResult poll(uint32_t nowMs, uint32_t* centiLux) {
    if (!present_ || !running_ || (nowMs - lastPoll_) < OPT_POLL_MS) return SR_NONE;
    lastPoll_ = nowMs;
    uint16_t cfg = 0, res = 0;
    if (!bus_.read16(OPT_REG_CONFIG, &cfg)) { fail(); return SR_ERROR; }
    fails_ = 0;
    if (!(cfg & OPT_CRF)) return SR_NONE;                      // still converting
    if (!bus_.read16(OPT_REG_RESULT, &res)) { fail(); return SR_ERROR; }
    *centiLux = opt3001Centilux(res);
    return (cfg & OPT_OVF) ? SR_OVER : SR_OK;
  }

 private:
  void fail() { if (++fails_ >= OPT_MAX_FAILS) { present_ = false; running_ = false; } }
  Bus& bus_; uint16_t runCfg_;
  bool present_ = false, running_ = false;
  uint8_t fails_ = 0; uint32_t lastPoll_ = 0;
};

}  // namespace fstop
