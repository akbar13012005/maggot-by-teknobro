#pragma once
// Salin ke secrets.h. Jangan unggah secrets.h ke GitHub.
struct WifiProfile { const char *ssid; const char *password; };
static const WifiProfile WIFI_PROFILES[] = {
  {"ISI_WIFI_1", "ISI_PASSWORD_1"},
  {"", ""},
  {"", ""}
};
#define FIREBASE_API_KEY ""
// Tanpa slash terakhir. Contoh https://project-default-rtdb.asia-southeast1.firebasedatabase.app
#define FIREBASE_DATABASE_URL ""
#define FIREBASE_DEVICE_EMAIL ""
#define FIREBASE_DEVICE_PASSWORD ""
#define DEVICE_ID "maggot-01"
// Buat token acak minimal 32 karakter; hanya disimpan di ESP32 dan aplikasi pemilik.
// Kosong = BLE OTA dikunci. Bukan password Google/email utama.
#define BLE_ACCESS_TOKEN ""
