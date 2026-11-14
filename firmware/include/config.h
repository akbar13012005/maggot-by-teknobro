#pragma once
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif
constexpr int HEATER_PIN=26, COOLER_PIN=27, WIFI_LED_PIN=2;
constexpr int HEATER_LED_PIN=25, COOLER_LED_PIN=33;
constexpr int SDA_PIN=21, SCL_PIN=22;
constexpr unsigned SENSOR_MS=2000, SENSOR_STALE_MS=6000;
constexpr unsigned INTERLOCK_MS=3000, BLE_IDLE_MS=600000;
constexpr unsigned HISTORY_SLOTS=64; // Sekitar 1 jam sampel/menit; event juga memakai slot
constexpr const char *FW_VERSION="1.1.0";

// GPIO level that energizes each relay. Confirm against the module indicator.
constexpr bool HEATER_ACTIVE_LOW=false;
constexpr bool COOLER_ACTIVE_LOW=true;
