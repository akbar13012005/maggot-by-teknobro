# Firmware 1.1.1 — kontrol manual dan relay

Pembaruan website saja tidak mengubah keluaran relay ESP32. Upload firmware ini
untuk kontrol manual tanpa durasi dan pengaturan polaritas pendingin.

## Memperbarui proyek yang sudah berjalan

1. Salin `src/main.cpp`, `include/control.h`, `include/config.h`, dan
   `include/relay.h` dari folder ini ke lokasi yang sama di proyek PlatformIO Anda.
2. Pertahankan `include/secrets.h` milik Anda. Jangan unggah kredensial ke GitHub.
3. Build lalu Upload melalui USB. Jangan lakukan Erase Flash; target dan profil
   WiFi yang disimpan tetap digunakan. Versi pada website harus menjadi 1.1.1.
4. Pilih Manual. Mulai dengan kedua aktuator OFF dan cek LED modul relay serta
   kipas fisik. Uji sakelar pendingin ON lalu OFF sebelum mencoba pemanas.

Jika membuka folder ini sebagai proyek baru, salin secrets.example.h ke secrets.h
lalu isi konfigurasi yang sama dengan firmware lama. Jangan upload hasil build
placeholder tanpa konfigurasi akun/perangkat Anda.

## Polaritas tiap kanal

Pemetaan dikoreksi sesuai kabel yang dilaporkan pemilik: pemanas D27/GPIO27,
pendingin D26/GPIO26. Kedua kanal disetel aktif-LOW (ON=LOW, OFF=HIGH).
Laporan OFF membuat kipas hidup, sedangkan HEAT membuat semua mati, cocok dengan
GPIO26 yang sebelumnya salah diberi fungsi pemanas aktif-HIGH. Pengujian fisik
kedua kanal tetap diperlukan setelah upload.

Pengaturan di `include/config.h`:

```cpp
constexpr int HEATER_PIN=27, COOLER_PIN=26, WIFI_LED_PIN=2;
constexpr bool HEATER_ACTIVE_LOW=true;
constexpr bool COOLER_ACTIVE_LOW=true;
```

| Perintah | D27 pemanas | D26 pendingin |
| --- | --- | --- |
| OFF | HIGH | HIGH |
| HEAT | LOW | HIGH |
| COOL | HIGH | LOW |

Bila indikator pendingin mati tetapi kipas tetap mendapat daya, periksa apakah
kabel beban memakai COM–NC atau mendapat daya langsung. Untuk beban mati saat
relay tidak aktif, gunakan COM–NO sesuai rangkaian. Matikan sumber listrik sebelum
mengubah kabel. Jangan membalik polaritas berkali-kali tanpa melihat indikator.

`reported.heaterGpio`/`coolerGpio` membantu memeriksa level GPIO, bukan sensor
konfirmasi putaran kipas atau kontak relay. UI dan LCD tetap menunjukkan perintah.

## Perilaku manual

- `leaseSeconds: 0` menahan pilihan ON sampai OFF/mode berganti/reboot/proteksi.
- Firmware tetap menerima lease 1–300 detik dari website lama.
- `manualPersistent: true` menandai dukungan pada reported. Website baru mencegah
  pengiriman ON persisten ke firmware lama; OFF tetap kompatibel.
- Tidak ada perpanjangan perintah tersembunyi dari browser. Menutup browser atau
  kehilangan internet tidak mematikan output manual yang ditahan.
- Sensor invalid dan OTA mematikan output dan membatalkan pilihan manual.
- Alarm >=40°C memprioritaskan pendinginan, termasuk bila pengguna memilih OFF.
- Boot kembali AUTO. Pemanas dan pendingin tidak ON bersamaan; jeda OFF 3 detik.
- TTL `expiresAt` tetap 60 detik untuk menolak perintah lama; ini bukan durasi ON.

## Pemeriksaan

Test C++ host mencakup polaritas dua kanal, manual persisten, OFF, interlock,
alarm, sensor invalid, dan lease lama. Pengujian fisik tetap dilakukan pemilik.
