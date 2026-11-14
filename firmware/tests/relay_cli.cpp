// relay_cli.cpp
//
// Runs the real relay core in real time on a normal computer, driven through
// stdin/stdout. Used by test/integration.js to check the web app against the
// firmware logic. Not part of the firmware itself.
//
// stdin lines:   W <hex>     a frame written to the command characteristic
//                CONN / DISC  Bluetooth connect / disconnect
//                PEDAL 0|1    foot pedal short (0) / long (1) press
//                PROBE 0|1    fake light probe fitted or not (default: fitted)
//                TEMPFIT 0|1  fake temperature probe fitted or not (default: fitted)
//                TEMP <centi> the temperature it reads, in 0.01 C (default 2000)
//                TEMPERR 0|1  make its reads fail
//                LUX <centilux> [<darkCentilux>]   light level with the lamp on (and, optionally, with it off)
//                QUIT
// stdout lines:  N <hex>     notification sent to the tablet
//                L E|S 0|1 <ms>   enlarger / safelight output changed
//                B <kind> <vol> <ms>   buzzer
#include "../relay/relay_core.h"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using namespace fstop;
static const auto T0 = std::chrono::steady_clock::now();
static uint32_t nowMs() { return 1000u + (uint32_t)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - T0).count(); }
static std::mutex outMx, coreMx;

static std::atomic<bool> probeOn{true}, sensing{false}, lampOn{false};
static std::atomic<uint32_t> luxLit{10000}, luxDark{3};
static std::atomic<bool> tempFit{true}, tempRunning{false}, tempErr{false};
static std::atomic<int> tempCenti{2000};

struct CliHal : Hal {
  bool connected = false;
  uint32_t lastSample = 0;
  uint32_t tempLast = 0;
  bool tempPresent() override { return tempFit; }
  void tempRun(bool on) override { tempRunning = on; tempLast = nowMs(); }
  TempResult tempRead(int16_t* v) override {
    if (!tempRunning || nowMs() - tempLast < 1000) return TR_NONE;
    tempLast = nowMs(); if (tempErr) return TR_ERROR; *v = (int16_t)tempCenti.load(); return TR_OK;
  }
  bool sensorPresent() override { return probeOn; }
  void sensorRun(bool on) override { sensing = on; lastSample = nowMs(); }
  SensorResult sensorRead(uint32_t* v) override {
    if (!sensing || nowMs() - lastSample < 100) return SR_NONE;
    lastSample = nowMs(); *v = lampOn ? luxLit.load() : luxDark.load(); return SR_OK;
  }
  void setEnlarger(bool on) override { lampOn = on; std::lock_guard<std::mutex> l(outMx); printf("L E %d %u\n", on ? 1 : 0, nowMs()); fflush(stdout); }
  void setSafelight(bool on) override { std::lock_guard<std::mutex> l(outMx); printf("L S %d %u\n", on ? 1 : 0, nowMs()); fflush(stdout); }
  void beep(Beep k, uint8_t v) override { std::lock_guard<std::mutex> l(outMx); printf("B %d %d %u\n", (int)k, (int)v, nowMs()); fflush(stdout); }
  bool notify(const uint8_t* d, size_t n) override {
    if (!connected) return false;
    std::lock_guard<std::mutex> l(outMx);
    printf("N "); for (size_t i = 0; i < n; i++) printf("%02x", d[i]); printf("\n"); fflush(stdout);
    return true;
  }
};

static std::vector<uint8_t> fromHex(const std::string& h) {
  std::vector<uint8_t> b;
  for (size_t i = 0; i + 1 < h.size(); i += 2) b.push_back((uint8_t)std::stoi(h.substr(i, 2), nullptr, 16));
  return b;
}

int main() {
  CliHal hal; RelayCore core(hal);
  { std::lock_guard<std::mutex> l(coreMx); core.begin(nowMs()); }
  bool quit = false;
  std::thread reader([&] {
    std::string line;
    while (std::getline(std::cin, line)) {
      std::istringstream is(line); std::string cmd; is >> cmd;
      std::lock_guard<std::mutex> l(coreMx);
      uint32_t now = nowMs();
      if (cmd == "W") { std::string h; is >> h; auto b = fromHex(h); core.onFrame(b.data(), b.size(), now); }
      else if (cmd == "CONN") { hal.connected = true; core.onConnect(now); }
      else if (cmd == "DISC") { hal.connected = false; core.onDisconnect(now); }
      else if (cmd == "PEDAL") { int lg = 0; is >> lg; core.pedal(lg != 0, now); }
      else if (cmd == "PROBE") { int v = 1; is >> v; probeOn = v != 0; }
      else if (cmd == "TEMPFIT") { int v = 1; is >> v; tempFit = v != 0; }
      else if (cmd == "TEMP") { int v = 2000; is >> v; tempCenti = v; }
      else if (cmd == "TEMPERR") { int v = 0; is >> v; tempErr = v != 0; }
      else if (cmd == "LUX") { uint32_t a = 0, b = 0; is >> a; if (is >> b) luxDark = b; luxLit = a; }
      else if (cmd == "QUIT") { quit = true; break; }
    }
    quit = true;
  });
  while (!quit) {
    { std::lock_guard<std::mutex> l(coreMx); core.tick(nowMs()); }
    std::this_thread::sleep_for(std::chrono::microseconds(400));
  }
  reader.join();
  return 0;
}
