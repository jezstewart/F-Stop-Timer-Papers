// relay.ino - F-stop timer relay unit
//
// Target:    ESP32-S3 (tested design for ESP32-S3-WROOM-1 N16R8 dev boards)
// Needs:     Arduino-ESP32 core 3.x, and the "NimBLE-Arduino" library 2.x (h2zero)
// Board:     "ESP32S3 Dev Module"
//
// The timing logic lives in relay_core.h (unit tested on a PC). This file only
// connects it to Bluetooth, the two switch outputs, the foot pedal, the buzzer
// and saved settings. See docs/PROTOCOL.md for the messages.
//
// NOTE: this sketch has not been run on hardware by its author. The first
// power-up should be done with NOTHING connected to mains. See README.md.

#include <Arduino.h>
#include <Preferences.h>
#include <NimBLEDevice.h>
#include <math.h>
#include <Wire.h>
#include "config.h"
#include "relay_core.h"
#include "opt3001.h"
#include "ds18b20.h"
#include "switch_drive.h"

using namespace fstop;

// ---- Bluetooth identifiers (must match web/index.html) -----------------------
static const char* SVC_UUID  = "6f9c0001-3a5b-4c7d-9e21-8b4f1d2a7c10";
static const char* CMD_UUID  = "6f9c0002-3a5b-4c7d-9e21-8b4f1d2a7c10";   // write: commands from the tablet
static const char* EVT_UUID  = "6f9c0003-3a5b-4c7d-9e21-8b4f1d2a7c10";   // notify: status and events to the tablet
static const char* INFO_UUID = "6f9c0004-3a5b-4c7d-9e21-8b4f1d2a7c10";   // read: protocol and firmware version

#if SERIAL_DEBUG
#define DBG(...) Serial.printf(__VA_ARGS__)
#else
#define DBG(...)
#endif

// ---- Hand-over from the Bluetooth task to loop() ------------------------------
// BLE callbacks run on the Bluetooth task. They only copy data into this queue;
// everything else happens in loop(), so the core never needs locking.
struct QMsg { uint8_t type; uint8_t len; uint8_t data[MAX_FRAME]; };   // type: 0 frame, 1 connect, 2 disconnect
static QueueHandle_t rxQueue;
static NimBLECharacteristic* evtChar = nullptr;
static volatile bool bleConnected = false;

// ---- Buzzer (passive piezo on a PWM pin) ----------------------------------------
struct Tone { uint16_t hz; uint16_t ms; };
static const Tone TONE_TICK[] = { { 1250, 50 } };
static const Tone TONE_STEP[] = { { 880, 130 }, { 1320, 130 } };
static const Tone TONE_DONE[] = { { 880, 120 }, { 1100, 120 }, { 1480, 300 } };
static const Tone* seq = nullptr;
static uint8_t seqN = 0, seqI = 0, seqVol = 0;
static uint32_t segEnd = 0;

static uint32_t dutyFor(uint8_t vol) {              // 0..100 -> PWM duty (8 bit). A piezo is loudest at 50 %.
  float a = 0.15f + 0.85f * (vol / 100.0f);
  float d = asinf(a) / (float)M_PI;                 // 0.05 .. 0.5
  return (uint32_t)(d * 255.0f);
}
static void startSeg(uint32_t now) {
  ledcWriteTone(PIN_BUZZER, seq[seqI].hz);
  ledcWrite(PIN_BUZZER, dutyFor(seqVol));
  segEnd = now + seq[seqI].ms;
}
static void beepStart(Beep k, uint8_t vol) {
  switch (k) {
    case B_TICK: seq = TONE_TICK; seqN = 1; break;
    case B_STEP: seq = TONE_STEP; seqN = 2; break;
    default:     seq = TONE_DONE; seqN = 3; break;
  }
  seqI = 0; seqVol = vol; startSeg(millis());
}
static void beepUpdate(uint32_t now) {
  if (!seq || now < segEnd) return;
  if (++seqI >= seqN) { ledcWrite(PIN_BUZZER, 0); seq = nullptr; return; }
  startSeg(now);
}

// ---- Light probe (OPT3001 over I2C) ----------------------------------------------------------
// The driver logic is in opt3001.h (unit tested on a PC). This is only the Wire glue.
struct WireBus {
  bool read16(uint8_t reg, uint16_t* v) {
    Wire.beginTransmission((uint8_t)OPT3001_ADDR); Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((uint16_t)OPT3001_ADDR, (size_t)2) != 2) return false;
    uint16_t hi = Wire.read(), lo = Wire.read(); *v = (uint16_t)((hi << 8) | lo); return true;
  }
  bool write16(uint8_t reg, uint16_t v) {
    Wire.beginTransmission((uint8_t)OPT3001_ADDR); Wire.write(reg); Wire.write((uint8_t)(v >> 8)); Wire.write((uint8_t)(v & 255));
    return Wire.endTransmission() == 0;
  }
};
static WireBus wireBus;
static Opt3001<WireBus> probe(wireBus);
static uint32_t probeCheckAt = 0;

// ---- Temperature probe (DS18B20, 1-Wire bit-banged on one pin) ---------------------------------
// The driver logic is in ds18b20.h (unit tested on a PC). This is only the bit timing, from Maxim's
// standard-speed 1-Wire figures. The pin is open drain: LOW pulls the line down, HIGH lets the pull-up raise it.
struct OneWireBus {
  void begin() { pinMode(PIN_ONEWIRE, OUTPUT_OPEN_DRAIN); digitalWrite(PIN_ONEWIRE, HIGH); }
  bool reset() {
    noInterrupts();
    digitalWrite(PIN_ONEWIRE, LOW);  delayMicroseconds(480);
    digitalWrite(PIN_ONEWIRE, HIGH); delayMicroseconds(70);
    bool present = digitalRead(PIN_ONEWIRE) == LOW;                // a probe holds the line low for a moment
    interrupts();
    delayMicroseconds(410);
    return present;
  }
  void writeBit(bool one) {
    noInterrupts();
    digitalWrite(PIN_ONEWIRE, LOW);  delayMicroseconds(one ? 6 : 60);
    digitalWrite(PIN_ONEWIRE, HIGH); delayMicroseconds(one ? 64 : 10);
    interrupts();
  }
  bool readBit() {
    noInterrupts();
    digitalWrite(PIN_ONEWIRE, LOW);  delayMicroseconds(6);
    digitalWrite(PIN_ONEWIRE, HIGH); delayMicroseconds(9);
    bool b = digitalRead(PIN_ONEWIRE) != LOW;
    interrupts();
    delayMicroseconds(55);
    return b;
  }
  void write(uint8_t v) { for (uint8_t i = 0; i < 8; i++) { writeBit(v & 1); v >>= 1; } }       // least significant bit first
  uint8_t read() { uint8_t v = 0; for (uint8_t i = 0; i < 8; i++) if (readBit()) v |= (uint8_t)(1 << i); return v; }
};
static OneWireBus owBus;
static Ds18b20<OneWireBus> tempProbe(owBus);
static uint32_t tempCheckAt = 0;

// ---- Hardware abstraction for the core --------------------------------------------
struct EspHal : Hal {
  bool cfgDirty = false;
  void setEnlarger(bool on) override { writeSwitch(PIN_ENLARGER, on, ENLARGER_ACTIVE_HIGH); DBG("enlarger %s\n", on ? "ON" : "off"); }
  void setSafelight(bool on) override { writeSwitch(PIN_SAFELIGHT, on, SAFELIGHT_ACTIVE_HIGH); DBG("safelight %s\n", on ? "on" : "off"); }
  void beep(Beep k, uint8_t vol) override { beepStart(k, vol); }
  bool notify(const uint8_t* d, size_t n) override {
    if (!bleConnected || !evtChar) return false;
    evtChar->setValue(d, n);
    return evtChar->notify();
  }
  void configChanged(const Config&) override { cfgDirty = true; }
#if TEMP_ENABLED
  bool tempPresent() override { return tempProbe.present(); }
  void tempRun(bool on) override { tempProbe.run(on); }
  TempResult tempRead(int16_t* v) override { return tempProbe.poll(millis(), v); }
#endif
#if PROBE_ENABLED
  bool sensorPresent() override { return probe.present(); }
  void sensorRun(bool on) override { probe.run(on); DBG("probe %s\n", on ? "running" : "stopped"); }
  SensorResult sensorRead(uint32_t* v) override { return probe.poll(millis(), v); }
#endif
};
static EspHal hal;
static RelayCore core(hal);

// ---- Saved settings (written only while no exposure is running) ----------------------
static Preferences prefs;
static void loadConfig() {
  Config c;
  prefs.begin("fstop", true);
  c.latencyMs = prefs.getShort("lat", 0);
  c.focusTimeoutSec = prefs.getUShort("foc", 300);
  c.volume = prefs.getUChar("vol", 60);
  c.mute = prefs.getBool("mute", false);
  c.safeAuto = prefs.getBool("safe", false);
  c.shakeTenths = prefs.getUChar("shk", 0);
  prefs.end();
  core.setConfig(c);
}
static void saveConfigIfIdle() {
  if (!hal.cfgDirty || core.isRunning()) return;
  hal.cfgDirty = false;
  const Config& c = core.config();
  prefs.begin("fstop", false);
  prefs.putShort("lat", c.latencyMs); prefs.putUShort("foc", c.focusTimeoutSec);
  prefs.putUChar("vol", c.volume); prefs.putBool("mute", c.mute); prefs.putBool("safe", c.safeAuto); prefs.putUChar("shk", c.shakeTenths);
  prefs.end();
  DBG("settings saved\n");
}

// ---- Foot pedal ---------------------------------------------------------------------------
static bool pedalRaw = false, pedalDown = false, pedalLongFired = false;
static uint32_t pedalEdge = 0, pedalT = 0;
static void pollPedal(uint32_t now) {
  bool down = digitalRead(PIN_PEDAL) == LOW;
  if (down != pedalRaw) { pedalRaw = down; pedalEdge = now; }
  if ((now - pedalEdge) >= PEDAL_DEBOUNCE_MS && down != pedalDown) {
    pedalDown = down;
    if (down) { pedalT = now; pedalLongFired = false; }
    else if (!pedalLongFired) core.pedal(false, now);            // short press acts on release
  }
  if (pedalDown && !pedalLongFired && (now - pedalT) >= PEDAL_LONG_MS) {   // long press acts as soon as the time is reached
    pedalLongFired = true; core.pedal(true, now);
  }
}

// ---- Bluetooth callbacks --------------------------------------------------------------------
class ServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& info) override {
    QMsg m = { 1, 0, { 0 } }; xQueueSend(rxQueue, &m, 0);
  }
  void onDisconnect(NimBLEServer* server, NimBLEConnInfo& info, int reason) override {
    QMsg m = { 2, 0, { 0 } }; xQueueSend(rxQueue, &m, 0);
    NimBLEDevice::startAdvertising();                              // 2.x does not restart advertising by itself
  }
};
class CmdCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    NimBLEAttValue v = c->getValue();
    QMsg m; m.type = 0; m.len = v.length() > MAX_FRAME ? MAX_FRAME : (uint8_t)v.length();
    memcpy(m.data, v.data(), m.len);
    xQueueSend(rxQueue, &m, 0);
  }
};

static void startBle() {
  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCb());
  NimBLEService* svc = server->createService(SVC_UUID);

  NimBLECharacteristic* cmd = svc->createCharacteristic(CMD_UUID, NIMBLE_PROPERTY::WRITE);
  cmd->setCallbacks(new CmdCb());
  evtChar = svc->createCharacteristic(EVT_UUID, NIMBLE_PROPERTY::NOTIFY);
  NimBLECharacteristic* info = svc->createCharacteristic(INFO_UUID, NIMBLE_PROPERTY::READ);
  const uint8_t infoBytes[4] = { PROTOCOL_VERSION, FW_MAJOR, FW_MINOR, 0 };
  info->setValue(infoBytes, sizeof infoBytes);
  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_UUID);
  adv->setName(BLE_DEVICE_NAME);
  adv->enableScanResponse(true);
  adv->start();
}

// ---- Arduino entry points ----------------------------------------------------------------------
void setup() {
#if SERIAL_DEBUG
  Serial.begin(115200);
#endif
  // Outputs first, and in their OFF state. Fit the pull resistors described in README.md
  // so the switches are also off while the board is unpowered or booting.
  initSwitch(PIN_ENLARGER, ENLARGER_ACTIVE_HIGH);
  initSwitch(PIN_SAFELIGHT, SAFELIGHT_ACTIVE_HIGH);
  pinMode(PIN_PEDAL, INPUT_PULLUP);
  ledcAttach(PIN_BUZZER, 2000, 8);
  ledcWrite(PIN_BUZZER, 0);

#if TEMP_ENABLED
  owBus.begin();
  { bool found = tempProbe.detect(); (void)found; DBG("temperature probe %s\n", found ? "found" : "not found (it is looked for again every 2 s while idle)"); }
#endif
#if PROBE_ENABLED
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_HZ);
  Wire.setTimeOut(10);                                   // ms: a stuck bus must never hold up the timing loop for long
  { bool found = probe.detect(); (void)found;           // not inside DBG(): that vanishes when SERIAL_DEBUG is 0
    DBG("light probe %s\n", found ? "found" : "not found (it is looked for again every 2 s while idle)"); }
#endif
  rxQueue = xQueueCreate(32, sizeof(QMsg));
  loadConfig();
  core.begin(millis());               // enlarger off, safelight on
  startBle();
  DBG("relay ready: %s, protocol %u, firmware %u.%u\n", BLE_DEVICE_NAME, PROTOCOL_VERSION, FW_MAJOR, FW_MINOR);
}

void loop() {
  uint32_t now = millis();
  QMsg m;
  while (xQueueReceive(rxQueue, &m, 0) == pdTRUE) {
    if (m.type == 0) core.onFrame(m.data, m.len, now);
    else if (m.type == 1) { bleConnected = true; core.onConnect(now); DBG("tablet connected\n"); }
    else if (m.type == 2) { bleConnected = false; core.onDisconnect(now); DBG("tablet disconnected\n"); }
  }
#if TEMP_ENABLED
  if (!tempProbe.present() && (now - tempCheckAt) >= 2000 && (core.state() == S_IDLE || core.state() == S_ARMED)) {
    tempCheckAt = now;
    if (tempProbe.detect()) DBG("temperature probe found\n");
  }
#endif
#if PROBE_ENABLED
  // Look for a probe that was plugged in after boot. Only while nothing is timing, so an exposure is never delayed by the bus.
  if (!probe.present() && (now - probeCheckAt) >= 2000 && (core.state() == S_IDLE || core.state() == S_ARMED)) {
    probeCheckAt = now;
    if (probe.detect()) DBG("light probe found\n");
  }
#endif
  pollPedal(now);
  core.tick(now);
  beepUpdate(now);
  saveConfigIfIdle();
  delay(1);
}
