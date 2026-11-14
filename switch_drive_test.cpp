// Tests how relay inputs are driven: power-up order and on/off sequences, for both RELAY_FLOAT_WHEN_OFF settings.
// Stand-ins for the Arduino pin functions record every call, so the order of operations can be checked.
#include <cstdio>
#include <string>
#include <vector>
#define INPUT 0
#define OUTPUT 1
#define HIGH 1
#define LOW 0
static std::vector<std::string> calls;
static void pinMode(int pin, int m) { calls.push_back("mode" + std::to_string(pin) + (m == OUTPUT ? "=OUT" : "=IN")); }
static void digitalWrite(int pin, int v) { calls.push_back("write" + std::to_string(pin) + (v ? "=HIGH" : "=LOW")); }
#include "../relay/switch_drive.h"
static int fails = 0, checks = 0;
#define CHECK(c, m) do { checks++; if (!(c)) { fails++; printf("  FAIL  %s\n", m); } } while (0)
static std::string joined() { std::string s; for (auto& c : calls) s += (s.empty() ? "" : " ") + c; calls.clear(); return s; }
int main() {
  printf("relay input drive (RELAY_FLOAT_WHEN_OFF = %d)\n", (int)RELAY_FLOAT_WHEN_OFF);
#if RELAY_FLOAT_WHEN_OFF
  initSwitch(4, 0);              CHECK(joined() == "mode4=IN", "active-low input starts released (relay off), never driven");
  writeSwitch(4, true, 0);       CHECK(joined() == "write4=LOW mode4=OUT", "on: latch LOW first, then enable the output, so there is no glitch");
  writeSwitch(4, false, 0);      CHECK(joined() == "mode4=IN", "off: released, never driven HIGH");
  writeSwitch(4, true, 0); writeSwitch(4, true, 0); joined();
  initSwitch(5, 1);              CHECK(joined() == "write5=LOW mode5=OUT", "active-high input starts driven LOW (off), level latched before it becomes an output");
  writeSwitch(5, true, 1);       CHECK(joined() == "write5=HIGH", "active-high on drives HIGH");
  writeSwitch(5, false, 1);      CHECK(joined() == "write5=LOW", "active-high off drives LOW");
#else
  initSwitch(4, 0);              CHECK(joined() == "write4=HIGH mode4=OUT", "active-low input starts driven HIGH (off), level latched first");
  writeSwitch(4, true, 0);       CHECK(joined() == "write4=LOW", "on drives LOW");
  writeSwitch(4, false, 0);      CHECK(joined() == "write4=HIGH", "off drives HIGH");
  initSwitch(5, 1);              CHECK(joined() == "write5=LOW mode5=OUT", "active-high input starts driven LOW (off)");
  writeSwitch(5, true, 1);       CHECK(joined() == "write5=HIGH", "active-high on drives HIGH");
#endif
  printf("%d checks, %d failed\n", checks, fails);
  return fails ? 1 : 0;
}
