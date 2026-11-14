#!/bin/sh
# Builds and runs the relay core unit tests and the relay input drive tests, and builds the real-time bridge used by test/integration.js.
set -e
cd "$(dirname "$0")"
g++ -std=c++17 -Wall -Wextra -O1 relay_core_test.cpp -o /tmp/relay_core_test
/tmp/relay_core_test
# relay input drive, with the pin released when off and with it always driven
g++ -std=c++17 -Wall -Wextra -DRELAY_FLOAT_WHEN_OFF=1 switch_drive_test.cpp -o /tmp/switch_drive_float
/tmp/switch_drive_float
g++ -std=c++17 -Wall -Wextra -DRELAY_FLOAT_WHEN_OFF=0 switch_drive_test.cpp -o /tmp/switch_drive_driven
/tmp/switch_drive_driven
g++ -std=c++17 -Wall -Wextra -O2 -pthread relay_cli.cpp -o /tmp/relay_cli
echo "built /tmp/relay_cli"
