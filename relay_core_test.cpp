// Unit tests for relay_core.h. Build and run with firmware/tests/run_tests.sh
#include "../relay/relay_core.h"
#include "../relay/opt3001.h"
#include "../relay/ds18b20.h"
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <string>

using namespace fstop;
using Bytes = std::vector<uint8_t>;

static int failures = 0, checks = 0;
#define CHECK(cond, msg) do { checks++; if (!(cond)) { failures++; printf("  FAIL  %s  (%s:%d)\n", msg, __FILE__, __LINE__); } } while (0)
#define CHECK_NEAR(a, b, tol, msg) do { checks++; long _a = (long)(a), _b = (long)(b); if (labs(_a - _b) > (long)(tol)) { failures++; printf("  FAIL  %s: got %ld, expected %ld +/- %ld  (%s:%d)\n", msg, _a, _b, (long)(tol), __FILE__, __LINE__); } } while (0)

static uint32_t T = 1000;   // fake clock, ms

struct FakeHal : Hal {
  bool connected = true;
  bool enl = false, safe = false;
  struct Edge { uint32_t t; bool on; };
  std::vector<Edge> lamp, safeEdges;
  std::vector<Bytes> notes;
  std::vector<int> beeps;
  int configCalls = 0;
  // fake light probe: a sample every 100 ms, bright when the lamp is on, dark when it is off
  // fake temperature probe: a new reading about once a second while it is running
  bool tprobe = false, trunning = false; int16_t tval = 2000; TempResult tnext = TR_OK; uint32_t tlast = 0; int tRunCalls = 0;
  bool tempPresent() override { return tprobe; }
  void tempRun(bool on) override { trunning = on; if (on) { tRunCalls++; tlast = T; } }
  TempResult tempRead(int16_t* v) override { if (!trunning || T - tlast < 1000) return TR_NONE; tlast = T; if (tnext == TR_OK) *v = tval; return tnext; }
  bool probe = false, sensing = false; int runCalls = 0, stopCalls = 0;
  uint32_t lit = 10000, dark = 12;             // 100.00 lux and 0.12 lux
  SensorResult nextResult = SR_OK; uint32_t lastSample = 0;
  bool sensorPresent() override { return probe; }
  void sensorRun(bool on) override { sensing = on; if (on) { runCalls++; lastSample = T; } else stopCalls++; }
  SensorResult sensorRead(uint32_t* v) override {
    if (!sensing || T - lastSample < 100) return SR_NONE;
    lastSample = T; *v = enl ? lit : dark; return nextResult;
  }
  void setEnlarger(bool on) override { enl = on; lamp.push_back({ T, on }); }
  void setSafelight(bool on) override { safe = on; safeEdges.push_back({ T, on }); }
  void beep(Beep k, uint8_t) override { beeps.push_back(k); }
  bool notify(const uint8_t* d, size_t n) override { if (!connected) return false; notes.push_back(Bytes(d, d + n)); return true; }
  void configChanged(const Config&) override { configCalls++; }

  int countEvents(uint8_t ev) const { int c = 0; for (auto& b : notes) if (b.size() >= 2 && b[0] == M_EVENT && b[1] == ev) c++; return c; }
  Bytes firstEvent(uint8_t ev) const { for (auto& b : notes) if (b.size() >= 2 && b[0] == M_EVENT && b[1] == ev) return b; return Bytes(); }
  Bytes lastEvent(uint8_t ev) const { Bytes r; for (auto& b : notes) if (b.size() >= 2 && b[0] == M_EVENT && b[1] == ev) r = b; return r; }
  int countBeeps(int k) const { int c = 0; for (int b : beeps) if (b == k) c++; return c; }
  // durations of every lamp-on interval, in ms
  std::vector<uint32_t> onWindows() const {
    std::vector<uint32_t> w; uint32_t s = 0; bool on = false;
    for (auto& e : lamp) { if (e.on && !on) { s = e.t; on = true; } else if (!e.on && on) { w.push_back(e.t - s); on = false; } }
    return w;
  }
  std::vector<uint32_t> offGaps() const {
    std::vector<uint32_t> g; uint32_t s = 0; bool off = false; bool seenOn = false;
    for (auto& e : lamp) { if (e.on) { if (off && seenOn) g.push_back(e.t - s); off = false; seenOn = true; } else { if (seenOn) { s = e.t; off = true; } } }
    return g;
  }
  void clear() { lamp.clear(); safeEdges.clear(); notes.clear(); beeps.clear(); }
};

static void run(RelayCore& c, uint32_t ms) { for (uint32_t i = 0; i < ms; i++) { T++; c.tick(T); } }
static void send(RelayCore& c, const Bytes& b) { c.onFrame(b.data(), b.size(), T); }
static uint32_t rd32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

static Bytes u32(uint32_t v) { return { (uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24) }; }
static void arm(RelayCore& c, uint8_t id, uint8_t kind, uint32_t gap, const std::vector<uint32_t>& ms) {
  Bytes b = { C_ARM_BEGIN, id, kind, (uint8_t)ms.size() }; Bytes g = u32(gap); b.insert(b.end(), g.begin(), g.end()); send(c, b);
  for (size_t i = 0; i < ms.size(); i += 4) {
    size_t cnt = ms.size() - i < 4 ? ms.size() - i : 4;
    Bytes s = { C_ARM_STEPS, id, (uint8_t)i, (uint8_t)cnt };
    for (size_t k = 0; k < cnt; k++) { Bytes v = u32(ms[i + k]); s.insert(s.end(), v.begin(), v.end()); }
    send(c, s);
  }
  send(c, { C_ARM_END, id });
}
static void config(RelayCore& c, int16_t lat, uint16_t focusSec, uint8_t vol, bool mute, bool safeAuto) {
  send(c, { C_CONFIG, (uint8_t)(lat & 255), (uint8_t)((lat >> 8) & 255), (uint8_t)(focusSec & 255), (uint8_t)(focusSec >> 8), vol, (uint8_t)((mute ? 1 : 0) | (safeAuto ? 2 : 0)) });
}

struct Rig {
  FakeHal hal; RelayCore core; Rig() : core(hal) { T += 5000; core.begin(T); core.onConnect(T); send(core, { C_PING }); hal.clear(); }
};

static void test_single() {
  printf("single exposure\n");
  Rig r; arm(r.core, 1, K_SINGLE, 0, { 2000 });
  CHECK(r.core.state() == S_ARMED, "armed after ARM_END");
  CHECK(r.hal.countEvents(E_ARM_OK) == 1, "ARM_OK event");
  send(r.core, { C_START }); CHECK(r.hal.enl, "lamp on immediately after START");
  run(r.core, 2100);
  auto w = r.hal.onWindows();
  CHECK(w.size() == 1, "one lamp window");
  if (w.size()) CHECK_NEAR(w[0], 2000, 1, "lamp on for 2000 ms");
  CHECK(r.core.state() == S_ARMED, "back to armed");
  CHECK(r.hal.countEvents(E_DONE) == 1, "done event");
  Bytes d = r.hal.lastEvent(E_DONE); CHECK(d.size() == 6 && rd32(&d[2]) == 2000, "done event carries total lamp time");
  CHECK(r.hal.countBeeps(B_TICK) == 1, "one tick beep (at 1 s)");
  CHECK(r.hal.countBeeps(B_DONE) == 1, "done beep");
}

static void test_strip() {
  printf("strip test with gaps\n");
  Rig r; std::vector<uint32_t> ms = { 1000, 260, 327, 413, 520, 655 };
  arm(r.core, 2, K_STRIP, 500, ms);
  send(r.core, { C_START });
  run(r.core, 1000 + 260 + 327 + 413 + 520 + 655 + 5 * 500 + 200);
  auto w = r.hal.onWindows(); auto g = r.hal.offGaps();
  CHECK(w.size() == 6, "six lamp windows");
  for (size_t i = 0; i < w.size() && i < ms.size(); i++) CHECK_NEAR(w[i], ms[i], 1, "step duration");
  CHECK(g.size() == 5, "five gaps");
  for (size_t i = 0; i < g.size(); i++) CHECK_NEAR(g[i], 500, 2, "gap length, enlarger off");
  CHECK(r.hal.countEvents(E_STEP_DONE) == 5, "five step_done events");
  CHECK(r.hal.countEvents(E_DONE) == 1, "one done event");
  CHECK(r.hal.countBeeps(B_STEP) == 5, "step beeps");
}

static void test_no_gap_and_offset() {
  printf("latency offset and zero gap\n");
  { Rig r; config(r.core, 50, 300, 60, false, false); arm(r.core, 1, K_SINGLE, 0, { 1000 }); send(r.core, { C_START }); run(r.core, 1200);
    auto w = r.hal.onWindows(); CHECK(w.size() == 1, "one window"); if (w.size()) CHECK_NEAR(w[0], 1050, 1, "+50 ms offset"); }
  { Rig r; config(r.core, -20, 300, 60, false, false); arm(r.core, 1, K_SINGLE, 0, { 1000 }); send(r.core, { C_START }); run(r.core, 1200);
    auto w = r.hal.onWindows(); if (w.size()) CHECK_NEAR(w[0], 980, 1, "-20 ms offset"); }
  { Rig r; arm(r.core, 1, K_STRIP, 0, { 300, 200, 100 }); send(r.core, { C_START }); run(r.core, 700);
    auto w = r.hal.onWindows(); CHECK(w.size() == 3, "three back-to-back steps with no gap"); }
}

static void test_pause_cancel() {
  printf("pause, resume, cancel\n");
  { Rig r; arm(r.core, 1, K_SINGLE, 0, { 2000 }); send(r.core, { C_START }); run(r.core, 500);
    send(r.core, { C_PAUSE }); CHECK(r.core.state() == S_PAUSED && !r.hal.enl, "paused, lamp off");
    run(r.core, 1000); CHECK(r.core.state() == S_PAUSED, "still paused");
    send(r.core, { C_RESUME }); run(r.core, 1600);
    uint32_t sum = 0; for (auto x : r.hal.onWindows()) sum += x;
    CHECK_NEAR(sum, 2000, 3, "total lamp time preserved across a pause"); CHECK(r.core.state() == S_ARMED, "finished"); }
  { Rig r; arm(r.core, 1, K_STRIP, 1000, { 500, 500 }); send(r.core, { C_START }); run(r.core, 700);
    CHECK(r.core.state() == S_GAP, "in gap"); send(r.core, { C_PAUSE }); run(r.core, 3000);
    CHECK(r.core.state() == S_PAUSED, "pause during a gap holds it"); send(r.core, { C_RESUME }); CHECK(r.core.state() == S_GAP, "resumes into the gap"); }
  { Rig r; arm(r.core, 1, K_SINGLE, 0, { 2000 }); send(r.core, { C_START }); run(r.core, 300);
    send(r.core, { C_CANCEL }); CHECK(!r.hal.enl && r.core.state() == S_ARMED, "cancel: lamp off, armed");
    CHECK(r.hal.countEvents(E_CANCELLED) == 1, "cancelled event"); CHECK(r.hal.countEvents(E_DONE) == 0, "no done event"); }
}

static void test_pedal_and_offline() {
  printf("foot pedal with no Bluetooth link\n");
  Rig r; arm(r.core, 1, K_SINGLE, 0, { 1500 });
  r.hal.connected = false; r.core.onDisconnect(T);
  r.core.pedal(false, T); CHECK(r.core.state() == S_EXPOSING && r.hal.enl, "pedal starts the armed exposure");
  run(r.core, 300); r.core.pedal(false, T); CHECK(r.core.state() == S_PAUSED && !r.hal.enl, "pedal pauses");
  r.core.pedal(false, T); CHECK(r.core.state() == S_EXPOSING, "pedal resumes");
  run(r.core, 100); r.core.pedal(true, T); CHECK(r.core.state() == S_ARMED && !r.hal.enl, "long press cancels");
  r.core.pedal(false, T); run(r.core, 1700);
  uint32_t sum = 0; auto w = r.hal.onWindows(); for (size_t i = w.size() >= 1 ? w.size() - 1 : 0; i < w.size(); i++) sum += w[i];
  CHECK_NEAR(sum, 1500, 2, "final run lasts the armed time"); CHECK(r.core.state() == S_ARMED, "finished");
  CHECK(r.hal.countEvents(E_DONE) == 0, "done event could not be delivered yet");
  r.hal.connected = true; r.core.onConnect(T); r.hal.clear(); send(r.core, { C_PING });
  CHECK(r.hal.countEvents(E_DONE) == 1, "done event delivered after reconnecting");
}

static void test_link_loss_during_exposure() {
  printf("link loss during an exposure\n");
  Rig r; arm(r.core, 1, K_SINGLE, 0, { 1500 }); send(r.core, { C_START }); run(r.core, 300);
  r.hal.connected = false; r.core.onDisconnect(T);
  run(r.core, 1500);
  auto w = r.hal.onWindows(); CHECK(w.size() == 1, "one window"); if (w.size()) CHECK_NEAR(w[0], 1500, 1, "exposure completes at the commanded length");
  CHECK(r.core.state() == S_ARMED, "armed again"); CHECK(r.hal.countEvents(E_DONE) == 0, "not delivered while disconnected");
  r.hal.connected = true; r.core.onConnect(T); send(r.core, { C_PING });
  CHECK(r.hal.countEvents(E_DONE) == 1, "queued done event delivered on reconnect");
}

static void test_focus() {
  printf("focus light\n");
  { Rig r; config(r.core, 0, 2, 60, false, false); send(r.core, { C_FOCUS, 1 }); CHECK(r.hal.enl && r.core.state() == S_FOCUS, "focus on");
    for (int i = 0; i < 40; i++) { run(r.core, 50); send(r.core, { C_PING }); }
    CHECK(!r.hal.enl && r.core.state() == S_IDLE, "focus times out and switches the lamp off");
    CHECK(r.hal.countEvents(E_FOCUS_TIMEOUT) == 1, "timeout event"); }
  { Rig r; send(r.core, { C_FOCUS, 1 }); run(r.core, 1700);
    CHECK(!r.hal.enl && r.core.state() == S_FAULT && r.core.fault() == F_LINK_IN_FOCUS, "silent tablet in focus mode: lamp off, fault");
    CHECK(r.hal.countEvents(E_FAULT) == 1, "fault event");
    send(r.core, { C_PING }); arm(r.core, 1, K_SINGLE, 0, { 500 });
    CHECK(r.core.state() == S_ARMED, "ARM clears the fault"); }
  { Rig r; send(r.core, { C_FOCUS, 1 }); run(r.core, 200); r.hal.connected = false; r.core.onDisconnect(T);
    CHECK(!r.hal.enl && r.core.state() == S_FAULT, "disconnect in focus mode switches the lamp off at once");
    r.hal.connected = true; r.core.onConnect(T); r.hal.clear(); send(r.core, { C_PING });
    CHECK(r.hal.countEvents(E_FAULT) == 1, "fault event delivered after reconnect"); }
  { Rig r; arm(r.core, 1, K_SINGLE, 0, { 1000 }); send(r.core, { C_FOCUS, 1 }); run(r.core, 200); send(r.core, { C_START }); run(r.core, 1200);
    CHECK(r.core.state() == S_ARMED, "START from focus runs the exposure");
    auto w = r.hal.onWindows(); CHECK(w.size() == 1, "lamp stays on from focus into the exposure"); }
}

static void test_arm_validation() {
  printf("arming validation\n");
  { Rig r; send(r.core, { C_ARM_BEGIN, 1, K_STRIP, 3, 0, 0, 0, 0 }); send(r.core, { C_ARM_STEPS, 1, 0, 1, 1, 0, 0, 0 }); send(r.core, { C_ARM_END, 1 });
    CHECK(r.core.state() != S_ARMED && !r.core.planValid(), "incomplete plan is rejected");
    Bytes e = r.hal.lastEvent(E_ARM_ERR); CHECK(e.size() == 4 && e[3] == A_INCOMPLETE, "incomplete error code"); }
  { Rig r; arm(r.core, 1, K_SINGLE, 0, { 2000 }); send(r.core, { C_START }); run(r.core, 100); r.hal.notes.clear();
    arm(r.core, 2, K_SINGLE, 0, { 500 });
    Bytes e = r.hal.firstEvent(E_ARM_ERR); CHECK(e.size() == 4 && e[3] == A_BUSY, "cannot re-arm while running"); run(r.core, 2100);
    auto w = r.hal.onWindows(); CHECK(w.size() == 1 && w[0] > 1990, "running exposure unaffected"); }
  { Rig r; send(r.core, { C_ARM_BEGIN, 1, K_SINGLE, 1, 0, 0, 0, 0 }); send(r.core, { C_ARM_STEPS, 1, 0, 1, 0x00, 0x00, 0x20, 0x00 });   // 2,097,152 ms
    Bytes e = r.hal.lastEvent(E_ARM_ERR); CHECK(e.size() == 4 && e[3] == A_TOO_LONG, "step over 30 minutes is rejected"); }
  { Rig r; send(r.core, { C_ARM_BEGIN, 1, K_SINGLE, 13, 0, 0, 0, 0 });
    Bytes e = r.hal.lastEvent(E_ARM_ERR); CHECK(e.size() == 4 && e[3] == A_TOO_MANY, "13 steps is too many"); }
  { Rig r; send(r.core, { C_ARM_BEGIN, 1, K_SINGLE, 1, 0, 0, 0, 0 }); send(r.core, { C_ARM_STEPS, 9, 0, 1, 1, 0, 0, 0 });
    Bytes e = r.hal.lastEvent(E_ARM_ERR); CHECK(e.size() == 4 && e[3] == A_NO_SESSION, "wrong plan id is rejected"); }
  { Rig r; send(r.core, { C_ARM_BEGIN, 1, K_SINGLE, 1, 0, 0, 0, 0 }); send(r.core, { C_ARM_STEPS, 1, 0, 2, 1, 0, 0, 0 });
    Bytes e = r.hal.lastEvent(E_ARM_ERR); CHECK(e.size() == 4 && e[3] == A_BAD_FRAME, "wrong frame length is rejected"); }
  { Rig r; send(r.core, { C_START }); CHECK(r.core.state() == S_IDLE && !r.hal.enl, "START without a plan does nothing"); }
  { Rig r; arm(r.core, 1, K_RECIPE, 5000, { 12000, 4100, 2900, 5000, 700, 800, 900, 1000, 1100 });
    CHECK(r.core.state() == S_ARMED, "nine-step recipe plan is accepted (chunked in fours)"); }
}

static void test_safelight_and_config() {
  printf("safelight, volume and mute\n");
  { Rig r; config(r.core, 0, 300, 60, false, true); arm(r.core, 1, K_SINGLE, 0, { 1000 }); CHECK(r.hal.safe, "safelight on by default");
    send(r.core, { C_START }); CHECK(!r.hal.safe, "safelight off while exposing (setting on)"); run(r.core, 1100); CHECK(r.hal.safe, "safelight back on after"); }
  { Rig r; send(r.core, { C_SAFELIGHT, 0 }); CHECK(!r.hal.safe, "safelight can be switched off"); send(r.core, { C_SAFELIGHT, 1 }); CHECK(r.hal.safe, "and on"); }
  { Rig r; config(r.core, 0, 300, 60, true, false); arm(r.core, 1, K_SINGLE, 0, { 2500 }); send(r.core, { C_START }); run(r.core, 2600);
    CHECK(r.hal.beeps.empty(), "mute silences the buzzer"); }
  { Rig r; config(r.core, 0, 300, 80, false, false); CHECK(r.hal.countBeeps(B_TICK) == 1, "changing the volume plays a test beep");
    CHECK(r.core.config().volume == 80 && r.hal.configCalls >= 1, "config applied and reported for saving"); }
}

static void test_lamp_cap() {
  printf("one-hour lamp cap\n");
  Rig r; config(r.core, 0, 0, 60, false, false); send(r.core, { C_FOCUS, 1 });
  for (uint32_t i = 0; i < 3600 * 1000UL + 2000; i++) { T++; r.core.tick(T); if (i % 400 == 0) send(r.core, { C_PING }); }
  CHECK(!r.hal.enl && r.core.state() == S_FAULT && r.core.fault() == F_LAMP_TIMEOUT, "lamp forced off after an hour");
}

static void test_status_frame() {
  printf("status frame\n");
  Rig r; arm(r.core, 7, K_STRIP, 500, { 1000, 300, 300, 300, 300, 300 }); r.hal.clear(); run(r.core, 250);
  Bytes s; for (auto& b : r.hal.notes) if (b[0] == M_STATUS) s = b;
  CHECK(s.size() == 18, "status frame is 18 bytes"); if (s.size() == 18) {
    CHECK(s[1] == S_ARMED, "state armed"); CHECK((s[2] & 4) != 0, "safelight-user flag"); CHECK(s[4] == 6, "six steps"); CHECK(s[15] == K_STRIP, "kind strip");
    CHECK(s[13] == 0xFF && s[14] == 0xFF, "no focus timer"); CHECK(s[16] == 0xFF, "not paused"); CHECK(s[17] == 0, "no fault"); }
  send(r.core, { C_START }); run(r.core, 350); s.clear(); for (auto& b : r.hal.notes) if (b[0] == M_STATUS) s = b;
  if (s.size() == 18) { CHECK(s[1] == S_EXPOSING && (s[2] & 1), "exposing with lamp flag"); CHECK_NEAR(rd32(&s[9]), 1000, 0, "total"); CHECK(rd32(&s[5]) < 1000 && rd32(&s[5]) > 500, "remaining counts down"); }
  int statuses = 0; for (auto& b : r.hal.notes) if (b[0] == M_STATUS) statuses++;
  CHECK(statuses >= 5 && statuses <= 8, "status about every 100 ms");
}


static Bytes lastSensor(const FakeHal& h) { Bytes r; for (auto& b : h.notes) if (b.size() && b[0] == M_SENSOR) r = b; return r; }
static int countSensor(const FakeHal& h) { int c = 0; for (auto& b : h.notes) if (b.size() && b[0] == M_SENSOR) c++; return c; }
static Bytes lastStatus(const FakeHal& h) { Bytes r; for (auto& b : h.notes) if (b.size() && b[0] == M_STATUS) r = b; return r; }
struct MRig : Rig { MRig() { hal.probe = true; } };

static void test_sensor_filter() {
  printf("sensor filter\n");
  SensorFilter f;
  CHECK(f.busy() && f.count() == 0 && f.mean() == 0, "empty filter is busy");
  for (int i = 0; i < 3; i++) f.add(5000, false);
  CHECK(f.busy(), "busy until four readings have arrived");
  f.add(5000, false); CHECK(!f.busy() && f.mean() == 5000, "settled after four equal readings");
  f.add(5100, false); f.add(4950, false); f.add(5050, false); f.add(5000, false);
  CHECK(!f.busy(), "readings within 4 percent count as settled");
  CHECK_NEAR(f.mean(), 5013, 20, "mean of the window");
  f.add(2500, false); CHECK(f.count() == 1 && f.busy(), "a big drop restarts averaging and shows busy");
  f.add(2500, false); f.add(2500, false); f.add(2500, false); CHECK(!f.busy() && f.mean() == 2500, "settles again at the new level");
  SensorFilter g; for (int i = 0; i < 4; i++) g.add(1000 + (i % 2) * 150, false);
  CHECK(g.busy(), "alternating readings 15 percent apart stay busy");
  SensorFilter u; for (int i = 0; i < 6; i++) u.add(3, false);
  CHECK(!u.busy() && u.under(), "very low light is flagged under-range once steady");
  SensorFilter n; for (int i = 0; i < 6; i++) n.add(8 + (i % 2), false);
  CHECK(!n.busy(), "tiny noise at very low light still settles");
  SensorFilter o; o.add(8000, true); CHECK(o.over(), "over-range flag follows the newest reading");
  o.add(8000, false); CHECK(!o.over(), "and clears");
  SensorFilter w; for (int i = 0; i < 30; i++) w.add(1000, false); CHECK(w.count() == SensorFilter::WIN, "window is capped");
  w.reset(); CHECK(w.count() == 0 && w.busy(), "reset empties the window");
}

static void runLive(RelayCore& c, uint32_t ms) {          // like run(), with the tablet's heartbeat
  for (uint32_t i = 0; i < ms; i++) { T++; if (i % 400 == 0) send(c, { C_PING }); c.tick(T); }
}
static void test_metering() {
  printf("metering\n");
  { MRig r; send(r.core, { C_METER, MT_LIT }); r.hal.probe = false; MRig q; q.hal.probe = false;
    send(q.core, { C_METER, MT_LIT }); CHECK(q.core.meter() == MT_OFF && !q.hal.enl && q.core.state() == S_IDLE, "no probe: metering is refused and the lamp stays off");
    send(q.core, { C_METER, MT_DARK }); CHECK(q.core.meter() == MT_OFF, "no probe: dark metering refused too"); }
  { MRig r; runLive(r.core, 300); r.hal.clear();
    send(r.core, { C_METER, MT_LIT });
    CHECK(r.core.meter() == MT_LIT && r.hal.enl && r.core.state() == S_FOCUS, "lit metering turns the enlarger on in focus mode");
    CHECK(!r.hal.safe && r.core.safelight() == false, "safelight switches off while metering");
    CHECK(r.hal.sensing, "probe conversion started");
    runLive(r.core, 150); Bytes a = lastSensor(r.hal);
    CHECK(a.size() == 8, "sensor frame is 8 bytes (within the 20 byte limit)");
    CHECK(a.size() == 8 && a[1] & 1, "busy while the first readings arrive");
    runLive(r.core, 800); Bytes b = lastSensor(r.hal);
    CHECK(b.size() == 8 && !(b[1] & 1) && b[2] == MT_LIT, "settled, lit mode reported");
    CHECK(b.size() == 8 && rd32(&b[3]) == 10000, "value is the probe reading in 0.01 lux");
    CHECK(b.size() == 8 && b[7] >= 4, "sample count reported");
    Bytes st = lastStatus(r.hal); CHECK(st.size() == 18 && (st[2] & 8) && (st[2] & 16), "status flags: metering and probe present");
    CHECK(st.size() == 18 && (st[2] & 4), "status still records that the user wants the safelight on");
    int n0 = countSensor(r.hal); runLive(r.core, 1000); int d = countSensor(r.hal) - n0;
    CHECK(d >= 3 && d <= 5, "sensor frames about four per second");
    send(r.core, { C_METER, MT_OFF });
    CHECK(r.core.meter() == MT_OFF && !r.hal.enl && r.core.state() == S_IDLE, "metering off also ends the focus it started");
    CHECK(r.hal.safe, "safelight is back on");
    CHECK(!r.hal.sensing && r.hal.stopCalls >= 1, "probe conversion stopped");
    int n1 = countSensor(r.hal); runLive(r.core, 600); CHECK(countSensor(r.hal) == n1, "no sensor frames when not metering"); }
  { MRig r; send(r.core, { C_SAFELIGHT, 0 }); send(r.core, { C_METER, MT_LIT }); send(r.core, { C_METER, MT_OFF });
    CHECK(!r.hal.safe, "a safelight the user switched off stays off after metering"); }
  { MRig r; send(r.core, { C_FOCUS, 1 }); send(r.core, { C_METER, MT_LIT }); CHECK(r.core.meter() == MT_LIT, "metering while already focusing");
    send(r.core, { C_METER, MT_OFF }); CHECK(r.core.state() == S_FOCUS && r.hal.enl, "focus the user started stays on after metering ends");
    CHECK(r.hal.safe, "safelight back on"); }
  { MRig r; arm(r.core, 1, K_SINGLE, 0, { 1500 }); send(r.core, { C_METER, MT_LIT }); CHECK(r.hal.enl, "metering from armed");
    send(r.core, { C_START }); runLive(r.core, 20);
    CHECK(r.core.state() == S_EXPOSING && r.core.meter() == MT_OFF, "starting an exposure ends metering");
    CHECK(r.hal.safe, "safelight returns once the exposure starts");
    runLive(r.core, 1600); auto w = r.hal.onWindows(); CHECK(w.size() == 1, "lamp is not switched off between metering and exposure"); }
  { MRig r; arm(r.core, 1, K_SINGLE, 0, { 3000 }); send(r.core, { C_START }); runLive(r.core, 100);
    send(r.core, { C_METER, MT_LIT }); CHECK(r.core.meter() == MT_OFF && r.core.state() == S_EXPOSING, "metering is ignored during an exposure");
    send(r.core, { C_METER, MT_DARK }); CHECK(r.core.meter() == MT_OFF, "so is dark metering"); }
  { MRig r; config(r.core, 0, 2, 60, false, false); send(r.core, { C_METER, MT_LIT });
    for (int i = 0; i < 2300; i++) { T++; r.core.tick(T); if (i % 400 == 0) send(r.core, { C_PING }); }
    CHECK(!r.hal.enl && r.core.meter() == MT_OFF && r.hal.safe, "focus timeout ends metering, lamp off, safelight back"); }
  { MRig r; runLive(r.core, 100); send(r.core, { C_METER, MT_LIT }); runLive(r.core, 300); r.hal.clear();
    r.hal.connected = false; r.core.onDisconnect(T);
    CHECK(!r.hal.enl && r.core.state() == S_FAULT && r.core.fault() == F_LINK_IN_FOCUS, "link lost while metering: lamp off and fault, as in focus mode");
    CHECK(r.core.meter() == MT_OFF && r.hal.safe && !r.hal.sensing, "and metering ends with the safelight restored"); }
  { MRig r; send(r.core, { C_METER, MT_LIT }); r.hal.connected = true;
    for (int i = 0; i < 2000; i++) { T++; r.core.tick(T); }
    CHECK(r.core.fault() == F_LINK_IN_FOCUS && !r.hal.enl && r.core.meter() == MT_OFF, "heartbeat silence while metering switches everything back"); }
  { MRig r; send(r.core, { C_METER, MT_LIT }); runLive(r.core, 900);
    r.hal.lit = 2500; runLive(r.core, 250); Bytes a = lastSensor(r.hal);
    CHECK(a.size() == 8 && (a[1] & 1), "light change makes the reading busy again");
    runLive(r.core, 700); Bytes b = lastSensor(r.hal);
    CHECK(b.size() == 8 && !(b[1] & 1) && rd32(&b[3]) == 2500, "and it settles at the new level");
    r.hal.nextResult = SR_OVER; runLive(r.core, 300); Bytes c = lastSensor(r.hal); CHECK(c.size() == 8 && (c[1] & 2), "over-range flag reaches the tablet");
    r.hal.nextResult = SR_ERROR; runLive(r.core, 300); Bytes e = lastSensor(r.hal); CHECK(e.size() == 8 && (e[1] & 8), "probe error flag reaches the tablet"); }
  { MRig r; runLive(r.core, 100); r.hal.dark = 3; r.hal.clear(); send(r.core, { C_METER, MT_DARK });
    CHECK(r.core.meter() == MT_DARK && !r.hal.enl && r.core.state() == S_IDLE, "dark metering keeps the enlarger off");
    CHECK(!r.hal.safe, "safelight is off so it cannot reach the probe");
    runLive(r.core, 900); Bytes a = lastSensor(r.hal);
    CHECK(a.size() == 8 && a[2] == MT_DARK && !(a[1] & 1) && rd32(&a[3]) == 3, "dark reading reported once settled");
    CHECK(a.size() == 8 && (a[1] & 4), "a dark reading is flagged under range");
    runLive(r.core, 60000); CHECK(r.core.meter() == MT_OFF && r.hal.safe && !r.hal.sensing, "dark metering stops by itself after a minute"); }
  { MRig r; send(r.core, { C_FOCUS, 1 }); send(r.core, { C_METER, MT_DARK }); CHECK(r.core.meter() == MT_OFF && r.hal.enl, "dark metering refused while the user's focus light is on"); }
  { MRig r; send(r.core, { C_METER, MT_LIT }); send(r.core, { C_METER, MT_DARK });
    CHECK(r.core.meter() == MT_DARK && !r.hal.enl && r.core.state() == S_IDLE, "lit to dark switches the lamp off"); }
  { MRig r; send(r.core, { C_METER, MT_DARK }); send(r.core, { C_METER, MT_LIT });
    CHECK(r.core.meter() == MT_LIT && r.hal.enl, "dark to lit switches the lamp on"); }
  { MRig r; send(r.core, { C_METER, 9 }); CHECK(r.core.meter() == MT_OFF && !r.hal.enl, "unknown meter mode is ignored"); send(r.core, { C_METER }); CHECK(r.core.meter() == MT_OFF, "short METER frame is ignored"); }
  { MRig r; send(r.core, { C_METER, MT_LIT }); send(r.core, { C_PING }); send(r.core, { C_CANCEL });
    CHECK(r.core.meter() == MT_LIT, "a stray cancel does not end metering"); }
  { MRig r; arm(r.core, 1, K_SINGLE, 0, { 1500 }); send(r.core, { C_METER, MT_LIT }); r.core.pedal(false, T); runLive(r.core, 50);
    CHECK(r.core.state() == S_EXPOSING && r.core.meter() == MT_OFF && r.hal.safe, "foot pedal during metering starts the armed exposure and ends metering"); }
  { MRig r; send(r.core, { C_METER, MT_LIT }); r.core.pedal(false, T); runLive(r.core, 50);
    CHECK(r.core.state() == S_FOCUS && r.core.meter() == MT_LIT, "foot pedal with no plan leaves metering alone"); }
}

struct FakeBus {
  bool ok = true; uint16_t manuf = OPT_MANUF_ID, dev = OPT_DEVICE_ID, cfg = 0xC810, res = 0; bool ready = false;
  std::vector<uint16_t> writes; int reads = 0;
  bool read16(uint8_t reg, uint16_t* v) {
    reads++; if (!ok) return false;
    if (reg == OPT_REG_MANUF) *v = manuf; else if (reg == OPT_REG_DEVICE) *v = dev; else if (reg == OPT_REG_CONFIG) *v = cfg | (ready ? OPT_CRF : 0); else if (reg == OPT_REG_RESULT) { *v = res; ready = false; } else return false;
    return true;
  }
  bool write16(uint8_t reg, uint16_t v) { if (!ok) return false; if (reg == OPT_REG_CONFIG) { writes.push_back(v); cfg = v; } return true; }
};
static void test_opt3001() {
  printf("OPT3001 driver\n");
  CHECK(opt3001Centilux(0x0001) == 1, "exponent 0, mantissa 1 is 0.01 lux");
  CHECK(opt3001Centilux(0x0FFF) == 4095, "exponent 0 full mantissa is 40.95 lux");
  CHECK(opt3001Centilux(0x1001) == 2, "exponent 1 doubles the step");
  CHECK(opt3001Centilux(0xBFFF) == 8386560, "top range is 83865.60 lux");
  CHECK(opt3001Centilux(0x5A5A) == (0xA5Au << 5), "mantissa and exponent split correctly");
  { FakeBus b; Opt3001<FakeBus> o(b); CHECK(o.detect() && o.present(), "detected by its id registers"); }
  { FakeBus b; b.dev = 0x1234; Opt3001<FakeBus> o(b); CHECK(!o.detect(), "wrong device id is not accepted"); }
  { FakeBus b; b.manuf = 0; Opt3001<FakeBus> o(b); CHECK(!o.detect(), "wrong manufacturer id is not accepted"); }
  { FakeBus b; b.ok = false; Opt3001<FakeBus> o(b); CHECK(!o.detect() && !o.present(), "no sensor on the bus"); }
  { FakeBus b; Opt3001<FakeBus> o(b); uint32_t v = 0; o.detect();
    CHECK(o.poll(100, &v) == SR_NONE && b.reads == 2, "no bus traffic while not running");
    o.run(true); CHECK(b.writes.size() == 1 && b.writes[0] == OPT_CFG_RUN_100MS, "run writes the continuous 100 ms configuration");
    b.ready = false; CHECK(o.poll(200, &v) == SR_NONE, "nothing returned while a conversion is pending");
    b.ready = true; b.res = 0x0000 | 1234; CHECK(o.poll(210, &v) == SR_OK && v == 1234, "ready conversion is read and converted");
    CHECK(o.poll(215, &v) == SR_NONE, "polling is rate limited");
    b.ready = true; b.res = 0x4000 | 100; b.cfg |= OPT_OVF; CHECK(o.poll(230, &v) == SR_OVER && v == 1600, "overflow flag reported");
    o.run(false); CHECK(b.writes.back() == OPT_CFG_STOP, "stop writes the shutdown configuration");
    CHECK(o.poll(300, &v) == SR_NONE, "no polling after stop"); }
  { FakeBus b; Opt3001<FakeBus> o(b, OPT_CFG_RUN_800MS); o.detect(); o.run(true); CHECK(b.writes[0] == OPT_CFG_RUN_800MS, "800 ms configuration can be chosen"); }
  { FakeBus b; Opt3001<FakeBus> o(b); uint32_t v = 0; o.detect(); o.run(true); b.ok = false; SensorResult r = SR_NONE; uint32_t t = 1000;
    for (int i = 0; i < 4; i++) { t += 20; r = o.poll(t, &v); }
    CHECK(r == SR_ERROR && o.present(), "a few bus errors are reported but the probe is kept");
    t += 20; o.poll(t, &v); CHECK(!o.present(), "five errors in a row: probe counts as unplugged");
    b.ok = true; CHECK(o.detect() && o.present(), "found again after being plugged back in");
    o.run(true); b.ready = true; b.res = 77; t += 20; CHECK(o.poll(t, &v) == SR_OK && v == 77, "and readings work again"); }
}

static void configShake(RelayCore& c, uint8_t tenths, bool eightBytes = true) {
  std::vector<uint8_t> f = { C_CONFIG, 0, 0, 44, 1, 60, 0 };       // latency 0, focus timeout 300 s, volume 60
  if (eightBytes) f.push_back(tenths);
  send(c, f);
}
static Bytes lastEvent(const FakeHal& h, uint8_t code) { Bytes r; for (auto& b : h.notes) if (b.size() >= 2 && b[0] == M_EVENT && b[1] == code) r = b; return r; }
static void test_shake_delay() {
  printf("enlarger shake delay\n");
  { Rig r; configShake(r.core, 20); CHECK(r.core.config().shakeTenths == 20, "shake delay stored from the 8 byte config frame");
    arm(r.core, 1, K_SINGLE, 0, { 1000 }); r.hal.clear(); uint32_t t0 = T; send(r.core, { C_START });
    CHECK(r.core.state() == S_SETTLE && !r.hal.enl, "start with a shake delay waits with the lamp off");
    CHECK(r.core.isRunning(), "the wait counts as running (cancel works, arming is refused)");
    runLive(r.core, 1900);
    CHECK(r.core.state() == S_SETTLE && r.hal.lamp.empty(), "still waiting just before the delay ends, lamp has not come on");
    Bytes st = lastStatus(r.hal); CHECK(st.size() == 18 && st[1] == S_SETTLE, "status frame reports the settling state (7)");
    CHECK(st.size() == 18 && rd32(&st[9]) == 2000 && rd32(&st[5]) > 0 && rd32(&st[5]) <= 200, "status carries the time left and the total");
    runLive(r.core, 300);
    CHECK(r.core.state() == S_EXPOSING && r.hal.enl, "exposure begins when the delay is over");
    runLive(r.core, 1100);
    auto w = r.hal.onWindows(); CHECK(w.size() == 1 && w[0] >= 999 && w[0] <= 1002, "lamp window is just the exposure, without the wait");
    CHECK(!r.hal.lamp.empty() && r.hal.lamp[0].on && r.hal.lamp[0].t - t0 >= 2000 && r.hal.lamp[0].t - t0 <= 2003, "lamp came on 2.0 s after start");
    Bytes d = lastEvent(r.hal, E_DONE); CHECK(d.size() == 6 && rd32(&d[2]) >= 999 && rd32(&d[2]) <= 1002, "reported lamp time leaves out the wait");
    CHECK(r.core.state() == S_ARMED, "back to armed afterwards"); }
  { Rig r; configShake(r.core, 15); arm(r.core, 1, K_SINGLE, 0, { 800 }); send(r.core, { C_FOCUS, 1 }); runLive(r.core, 200); CHECK(r.hal.enl, "focus light on");
    r.hal.clear(); send(r.core, { C_START });
    CHECK(!r.hal.enl && r.core.state() == S_SETTLE, "starting from the focus light switches it off for the wait");
    runLive(r.core, 2400); auto w = r.hal.onWindows(); CHECK(w.size() == 1 && w[0] >= 799 && w[0] <= 802, "then one lamp window for the exposure only");
    CHECK(r.hal.lamp.size() == 3 && !r.hal.lamp[0].on && r.hal.lamp[1].on && r.hal.lamp[1].t - r.hal.lamp[0].t >= 1500 && r.hal.lamp[1].t - r.hal.lamp[0].t <= 1503, "lamp went off at the start and came back on 1.5 s later"); }
  { Rig r; configShake(r.core, 30); arm(r.core, 1, K_SINGLE, 0, { 1000 }); send(r.core, { C_START }); runLive(r.core, 500); r.hal.clear();
    send(r.core, { C_CANCEL });
    CHECK(r.core.state() == S_ARMED && !r.hal.enl, "cancel during the wait returns to armed with the lamp off");
    CHECK(lastEvent(r.hal, E_CANCELLED).size() == 2, "a cancelled event is sent");
    runLive(r.core, 3500); CHECK(r.hal.lamp.empty() && r.core.state() == S_ARMED, "the lamp never comes on after a cancel"); }
  { Rig r; configShake(r.core, 30); arm(r.core, 1, K_SINGLE, 0, { 1000 }); r.core.pedal(false, T); runLive(r.core, 100);
    CHECK(r.core.state() == S_SETTLE, "the foot pedal starts it with the delay too");
    r.core.pedal(false, T); runLive(r.core, 100); CHECK(r.core.state() == S_SETTLE, "a short pedal press during the wait is ignored");
    r.core.pedal(true, T); runLive(r.core, 50); CHECK(r.core.state() == S_ARMED && !r.hal.enl, "a long pedal press cancels"); }
  { Rig r; configShake(r.core, 20); arm(r.core, 1, K_SINGLE, 0, { 500 }); send(r.core, { C_START }); runLive(r.core, 100);
    send(r.core, { C_PAUSE }); CHECK(r.core.state() == S_SETTLE, "pause is ignored during the wait");
    send(r.core, { C_FOCUS, 1 }); CHECK(r.core.state() == S_SETTLE && !r.hal.enl, "focus light cannot be switched on during the wait");
    send(r.core, { C_METER, MT_LIT }); CHECK(r.core.meter() == MT_OFF, "metering cannot start during the wait"); }
  { Rig r; configShake(r.core, 20); arm(r.core, 1, K_SINGLE, 0, { 500 }); r.hal.beeps.clear(); send(r.core, { C_START }); runLive(r.core, 1900);
    int ticks = 0; for (auto& b : r.hal.beeps) if (b == B_TICK) ticks++;
    CHECK(ticks == 1, ("one tick per second while waiting (" + std::to_string(ticks) + ")").c_str()); }
  { Rig r; configShake(r.core, 20); arm(r.core, 1, K_STRIP, 1000, { 400, 400, 400 }); r.hal.clear(); send(r.core, { C_START }); runLive(r.core, 6000);
    auto w = r.hal.onWindows(), g = r.hal.offGaps();
    CHECK(w.size() == 3 && r.core.state() == S_ARMED, "a strip test still has all its steps");
    CHECK(g.size() == 2 && g[0] >= 999 && g[0] <= 1003 && g[1] >= 999 && g[1] <= 1003, "the delay comes only before the first step; the gaps between steps are unchanged"); }
  { Rig r; configShake(r.core, 20); arm(r.core, 1, K_SINGLE, 0, { 1000 }); send(r.core, { C_START }); runLive(r.core, 500);
    r.hal.connected = false; r.core.onDisconnect(T);
    for (int i = 0; i < 3500; i++) { T++; r.core.tick(T); }
    CHECK(r.core.state() == S_ARMED && r.core.fault() == F_NONE, "losing the link during the wait is not a fault: the exposure carries on and finishes");
    auto w = r.hal.onWindows(); CHECK(w.size() == 1 && w[0] >= 999 && w[0] <= 1002, "with its full exposure time"); }
  { Rig r; configShake(r.core, 101); CHECK(r.core.config().shakeTenths == 100, "a delay above 10.0 s is limited to 10.0 s");
    configShake(r.core, 0, false); CHECK(r.core.config().shakeTenths == 0, "a 7 byte frame from an older app means no delay");
    arm(r.core, 1, K_SINGLE, 0, { 500 }); send(r.core, { C_START }); CHECK(r.core.state() == S_EXPOSING && r.hal.enl, "with no delay the exposure starts at once, as before");
    runLive(r.core, 600); }
  { Rig r; configShake(r.core, 20); arm(r.core, 1, K_SINGLE, 0, { 500 }); send(r.core, { C_START });
    send(r.core, { C_CONFIG, 0, 0, 44, 1, 60, 0, 0 }); CHECK(r.core.state() == S_SETTLE, "changing settings during the wait does not disturb it");
    runLive(r.core, 2100); CHECK(r.core.state() == S_EXPOSING, "and the wait that was running still ends on time"); }
}

static std::vector<Bytes> tempFrames(const FakeHal& h) { std::vector<Bytes> r; for (auto& b : h.notes) if (b.size() == 4 && b[0] == M_TEMP) r.push_back(b); return r; }
static void test_temperature_and_beep() {
  printf("temperature probe and beep cues\n");
  { Rig r; r.hal.tprobe = false; send(r.core, { C_TEMP, 1 }); runLive(r.core, 3000);
    CHECK(!r.hal.trunning && tempFrames(r.hal).empty(), "TEMP is ignored when no probe is fitted"); }
  { Rig r; r.hal.tprobe = true; r.hal.tval = 2037; send(r.core, { C_TEMP, 1 });
    CHECK(r.hal.trunning, "TEMP on starts the probe");
    runLive(r.core, 3500); auto f = tempFrames(r.hal);
    CHECK(f.size() >= 3 && f.size() <= 4, "about one reading a second");
    CHECK(f.size() >= 1 && f[0][1] == 1 && (int16_t)(f[0][2] | (f[0][3] << 8)) == 2037, "frame carries the flag and the temperature in 0.01 C (20.37)");
    r.hal.clear(); r.hal.tval = -525; runLive(r.core, 1500); auto g = tempFrames(r.hal);
    CHECK(!g.empty() && (int16_t)(g.back()[2] | (g.back()[3] << 8)) == -525, "negative temperatures come through (-5.25 C)");
    Bytes st = lastStatus(r.hal); CHECK(st.size() == 18 && (st[2] & 32), "status flag bit 5 says the temperature probe is fitted");
    r.hal.tnext = TR_ERROR; r.hal.clear(); runLive(r.core, 1500); auto e = tempFrames(r.hal);
    CHECK(!e.empty() && e.back()[1] == 2, "a failed read is reported with the error flag");
    r.hal.tnext = TR_OK; send(r.core, { C_TEMP, 0 }); r.hal.clear(); runLive(r.core, 2500);
    CHECK(!r.hal.trunning && tempFrames(r.hal).empty(), "TEMP off stops the probe and the frames"); }
  { Rig r; r.hal.tprobe = true; send(r.core, { C_TEMP, 1 }); runLive(r.core, 1200);
    arm(r.core, 1, K_SINGLE, 0, { 1500 }); send(r.core, { C_START }); r.hal.clear(); runLive(r.core, 1400);
    CHECK(tempFrames(r.hal).empty() && r.core.state() == S_EXPOSING, "the probe is not read while an exposure is timing");
    runLive(r.core, 3000); CHECK(!tempFrames(r.hal).empty(), "and readings resume afterwards"); }
  { Rig r; r.hal.tprobe = true; send(r.core, { C_TEMP, 1 }); CHECK(r.hal.trunning, "reading");
    r.hal.connected = false; r.core.onDisconnect(T); CHECK(!r.hal.trunning, "losing the link stops the probe"); }
  { Rig r; r.hal.tprobe = true; Bytes st = lastStatus(r.hal); runLive(r.core, 300); st = lastStatus(r.hal);
    CHECK(st.size() == 18 && (st[2] & 32), "status shows the probe even before it is asked to read"); }
  { Rig r; send(r.core, { C_BEEP, B_STEP }); send(r.core, { C_BEEP, B_DONE }); send(r.core, { C_BEEP, B_TICK });
    CHECK(r.hal.beeps.size() == 3 && r.hal.beeps[0] == B_STEP && r.hal.beeps[1] == B_DONE && r.hal.beeps[2] == B_TICK, "BEEP plays the three cues");
    r.hal.beeps.clear(); send(r.core, { C_BEEP, 9 }); send(r.core, { C_BEEP }); CHECK(r.hal.beeps.empty(), "an unknown cue and a short frame are ignored");
    send(r.core, { C_CONFIG, 0, 0, 44, 1, 60, 1, 0 }); r.hal.beeps.clear(); send(r.core, { C_BEEP, B_STEP }); CHECK(r.hal.beeps.empty(), "muted: no beep");
    send(r.core, { C_CONFIG, 0, 0, 44, 1, 0, 0, 0 }); send(r.core, { C_BEEP, B_STEP }); CHECK(r.hal.beeps.empty(), "volume 0: no beep"); }
  { Rig r; arm(r.core, 1, K_SINGLE, 0, { 1500 }); send(r.core, { C_START }); runLive(r.core, 100); r.hal.beeps.clear();
    send(r.core, { C_BEEP, B_STEP }); CHECK(r.hal.beeps.empty(), "no process beeps while an exposure is timing"); runLive(r.core, 1600); }
}
static void test_ds18b20() {
  printf("DS18B20 driver\n");
  { const uint8_t rom[7] = { 0x02, 0x1C, 0xB8, 0x01, 0x00, 0x00, 0x00 };
    CHECK(ds18b20Crc8(rom, 7) == 0xA2, "CRC-8 matches the Maxim application note example ROM code"); }
  auto sp = [](uint8_t lo, uint8_t hi, uint8_t* out) { out[0] = lo; out[1] = hi; out[2] = 0x4B; out[3] = 0x46; out[4] = 0x7F; out[5] = 0xFF; out[6] = 0x0C; out[7] = 0x10; out[8] = ds18b20Crc8(out, 8); };
  struct V { uint8_t lo, hi; int16_t centi; };
  const V vecs[] = { { 0x91, 0x01, 2506 }, { 0xA2, 0x00, 1013 }, { 0x08, 0x00, 50 }, { 0x00, 0x00, 0 }, { 0xF8, 0xFF, -50 }, { 0x5E, 0xFF, -1013 }, { 0x6F, 0xFE, -2506 }, { 0x90, 0xFC, -5500 }, { 0x40, 0x01, 2000 } };
  for (auto& v : vecs) { uint8_t b[9]; sp(v.lo, v.hi, b); int16_t c = 0;
    char m[80]; snprintf(m, sizeof m, "datasheet value 0x%02X%02X decodes to %d (0.01 C)", v.hi, v.lo, v.centi);
    CHECK(ds18b20Decode(b, &c) && c == v.centi, m); }
  { uint8_t b[9]; sp(0x91, 0x01, b); b[8] ^= 1; int16_t c = 0; CHECK(!ds18b20Decode(b, &c), "a bad CRC is rejected"); }
  { uint8_t b[9]; sp(0x50, 0x05, b); int16_t c = 0; CHECK(!ds18b20Decode(b, &c), "+85.0 C, the power-on value, is rejected"); }
  struct FakeWire {                                        // answers like a probe, and records what it was sent
    bool present = true; std::vector<uint8_t> sent; uint8_t pad[9]; int rd = 0; int resets = 0;
    bool reset() { resets++; rd = 0; return present; }
    void write(uint8_t b) { sent.push_back(b); }
    uint8_t read() { return pad[rd++ % 9]; }
  };
  { FakeWire w; sp(0x40, 0x01, w.pad); Ds18b20<FakeWire> d(w); int16_t c = 0;
    CHECK(d.detect() && d.present(), "detected when something answers the reset");
    CHECK(d.poll(1000, &c) == TR_NONE && w.sent.empty(), "nothing is sent while it is not running");
    d.run(true); CHECK(d.poll(1000, &c) == TR_NONE && w.sent.size() == 2 && w.sent[0] == 0xCC && w.sent[1] == 0x44, "first poll starts a conversion: skip ROM, convert");
    CHECK(d.poll(1500, &c) == TR_NONE && w.sent.size() == 2, "still converting after 500 ms: the bus is left alone");
    TempResult tr = d.poll(1760, &c); CHECK(tr == TR_OK && c == 2000 && w.sent.size() == 4 && w.sent[2] == 0xCC && w.sent[3] == 0xBE, "after 750 ms it reads the scratchpad: 20.00 C");
    CHECK(d.poll(1900, &c) == TR_NONE, "no new conversion until a second after the last one began");
    CHECK(d.poll(2010, &c) == TR_NONE && w.sent.size() == 6, "then the next one starts");
    CHECK(d.poll(2770, &c) == TR_OK, "and another reading arrives"); }
  { FakeWire w; sp(0x40, 0x01, w.pad); Ds18b20<FakeWire> d(w); int16_t c = 0; d.detect(); d.run(true); d.poll(0, &c);
    w.pad[8] ^= 0xFF; CHECK(d.poll(800, &c) == TR_ERROR, "a corrupted read is an error, not a temperature"); CHECK(d.present(), "one failure does not unplug the probe"); }
  { FakeWire w; sp(0x40, 0x01, w.pad); Ds18b20<FakeWire> d(w); int16_t c = 0; d.detect(); d.run(true); uint32_t t = 0;
    w.present = false; TempResult last = TR_NONE; for (int i = 0; i < 5; i++) { t += 1100; last = d.poll(t, &c); }
    CHECK(last == TR_ERROR && !d.present(), "five failures in a row and the probe counts as gone");
    w.present = true; CHECK(d.detect() && d.present(), "and it is found again when plugged back in"); }
  { FakeWire w; w.present = false; Ds18b20<FakeWire> d(w); CHECK(!d.detect() && !d.present(), "nothing on the bus"); }
}

int main() {
  test_single(); test_strip(); test_no_gap_and_offset(); test_pause_cancel(); test_pedal_and_offline();
  test_link_loss_during_exposure(); test_focus(); test_arm_validation(); test_safelight_and_config(); test_lamp_cap(); test_status_frame();
  test_sensor_filter(); test_metering(); test_opt3001(); test_shake_delay(); test_temperature_and_beep(); test_ds18b20();
  printf("\n%d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
