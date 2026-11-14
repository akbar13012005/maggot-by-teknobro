# Maggot by TeknoBro

Dashboard responsif ESP32 untuk monitoring suhu/kelembapan SHT31, kontrol pemanas
serta kipas+peltier, riwayat, profil WiFi, dan BLE OTA. Tema gelap dengan aksen cyan
mengikuti referensi desain. Halaman login dan pratinjau tersedia.

## Buka website melalui GitHub Pages

Hasil build siap pakai sudah tersedia di folder **docs/**.

1. Di repository ini, buka **Settings → Pages**.
2. Pada **Build and deployment**, pilih **Deploy from a branch**.
3. Pilih branch **main**, folder **/docs**, kemudian **Save**.
4. Tunggu GitHub menampilkan URL situs pada halaman Pages. Buka URL tersebut.
5. Jika Firebase menampilkan `auth/unauthorized-domain`, tambahkan hostname situs
   pada Firebase Console → Authentication → Settings → Authorized domains.
6. Login menggunakan **akun pemilik Firebase**, bukan akun ESP32. Password adalah
   password yang dibuat di Firebase Authentication, bukan otomatis password Gmail.

Mengaktifkan Pages adalah pengaturan repository yang perlu dilakukan pemilik.
Source repository dapat terlihat publik; data sensor dan perintah tetap dilindungi
oleh Firebase Authentication dan Database Rules. Tidak ada password dalam source.

## Pengembangan

```sh
npm ci
npm run dev
npm test
npm run build
```

Node.js 22 atau lebih baru direkomendasikan. Setelah mengubah source, commit juga
hasil `npm run build` di folder docs agar GitHub Pages menampilkan versi terbaru.
`base: './'` mendukung domain utama maupun subfolder repository.

## Halaman dan fitur

- **Monitoring:** suhu sensor, kelembapan udara, target, mode, gauge, tren 60 menit,
  status perintah relay, RSSI, versi firmware dan waktu pembaruan.
- **Kontrol:** AUTO/MANUAL, target 10–39°C, sakelar pendingin/pemanas tanpa pilihan durasi (firmware 1.1.0). Tombol menunggu konfirmasi ESP32 dan dinonaktifkan saat offline/OTA.
- **Riwayat:** filter tanggal WIB (maksimal 31 hari), pagination, ekspor CSV semua
  hasil yang dimuat. Pembacaan dipaginasi 1000 record/request; batas 50.000 record
  per rentang. Jika melebihi, pilih rentang lebih pendek. Record tanpa timestamp
  sinkron tidak masuk query tanggal. Grafik memberi jeda saat sensor invalid/gap.
- **WiFi:** kirim 1–5 profil; form tidak mengklaim membaca profil yang sudah tersimpan.
  Profil/password dikirim ke mailbox command melalui Firebase dan disimpan ESP32.
  Firmware tidak otomatis menghapus mailbox setelah ACK; pemilik/perangkat bisa
  membacanya sesuai rules. Perintah berikut mengganti mailbox tersebut.
- **Firmware & BLE:** ON/OFF Bluetooth lewat Firebase, pairing PIN LCD, autentikasi
  token BLE, validasi SHA256 dan transfer firmware sesuai protokol firmware 1.0.0.
- **PWA:** manifest, ikon, tombol instal. Opsi instal bergantung browser/perangkat.
  Ini web app responsif, bukan APK Android native. Service worker tidak menyimpan
  data Firebase, password, atau perintah; halaman memerlukan koneksi internet.

Pratinjau desain memakai data simulasi yang ditandai jelas. Semua pengiriman
perintah dan OTA dinonaktifkan pada pratinjau; CSV pratinjau diberi awalan SIMULASI.

## Integrasi Firebase dan firmware

`src/config.js` berisi konfigurasi publik Firebase, DEVICE_ID `maggot-01`, serta
UID pemilik `KWGkm6TmEyMRnnJwG0VfM9laPoX2`. Mengubah UID di sisi browser tidak
memberikan hak akses; Firebase Database Rules adalah pengaman sebenarnya.

Gunakan rules yang sudah disiapkan dalam percakapan/firmware:

- pemilik membaca `devices/maggot-01/reported` dan `history`;
- pemilik membaca/menulis `command`;
- ESP32 membaca command dan menulis reported/history;
- history memiliki `.indexOn: ["timestamp"]`;
- akun lain dan pengguna tanpa login ditolak.

Aplikasi tidak membaca root database, sehingga sesuai dengan rules per-node.
Jangan mengganti rules menjadi akses publik. Jangan memasukkan secrets.h,
password akun, service-account key, atau BLE token ke repository.

Command dikirim melalui transaksi mailbox, menyertakan UUID, bootId terbaru,
dan expiresAt 60 detik dengan offset waktu server Firebase. Transaksi mencegah
penimpaan command lain yang masih aktif. UI menunggu reported.lastCommandId dan
lastResult; tidak menampilkan keberhasilan hanya karena penulisan database sukses.
Tidak ada pengulangan otomatis perintah aktuator. Data lebih tua dari 20 detik
berstatus offline, kontrol dinonaktifkan, dan nilai terakhir ditandai.

Kontrol manual tanpa durasi membutuhkan firmware 1.1.0 di folder `firmware/`.
Baca `firmware/README.md` untuk mengganti empat file, mempertahankan secrets.h,
dan memeriksa polaritas relay. Menutup browser tidak mematikan pilihan manual.
Sensor invalid/OTA membatalkan manual; alarm >=40°C dapat menghidupkan pendingin
meski pengguna memilih OFF. Status relay adalah perintah, bukan umpan balik fisik.
Target tetap 10–39°C sesuai firmware. Jeda antaraktuator tetap 3 detik.

## BLE OTA

1. Aktifkan Bluetooth melalui tombol cloud saat ESP32 online.
2. Di browser HTTPS yang mendukung Web Bluetooth (misalnya Chrome Android), isi
   token `BLE_ACCESS_TOKEN` yang telah dikonfigurasi pada firmware. Token kosong
   pada firmware mengunci OTA; isi token minimal 32 karakter lalu upload USB dahulu.
3. Klik Hubungkan ESP32; pilih perangkat dan masukkan PIN LCD saat OS memintanya.
4. Pilih **firmware.bin aplikasi** dari build PlatformIO ESP32 DevKit/partisi ini.
   Jangan memilih bootloader.bin, partitions.bin, atau merged binary.
5. Centang kesiapan menghentikan aktuator, lalu Mulai update. Jangan tutup halaman.

App mengirim maksimum 180 byte data per paket, disertai offset little-endian,
menunggu ACK sebelum paket berikut. Jika platform menolak panjang ATT dengan
InvalidModificationError, gunakan fallback 16 byte. Integritas SHA256 diverifikasi
ESP32 sebelum boot image baru. Dukungan pairing dan ukuran MTU bervariasi; BLE
harus diuji pada HP/perangkat fisik. Safari/iOS dan sebagian browser tidak didukung.
Token hanya berada di memori/form saat sesi berjalan, tidak disimpan permanen.

Firmware lama belum mengaktifkan secure boot/signature/automatic boot rollback;
SHA256 bukan bukti keaslian penerbit. Gunakan file firmware sendiri dan sediakan
USB untuk pemulihan. Kontrol cloud ditahan selama upload dari halaman ini.

## Validasi

- Unit tests: freshness/offline, command expiry/boot binding, input limits, WiFi
  byte limits, mailbox contention, CSV escaping/WIB, dan state transfer BLE mock.
- Build produksi Vite.
- Pemeriksaan browser: login view, demo monitoring, disabled controls, navigasi,
  riwayat dan responsif 390 px.
- Belum diuji end-to-end dengan login pemilik nyata, ESP32, maupun BLE fisik.
  Login dan tes perangkat dilakukan pemilik; password tidak diminta di chat.

## Struktur

- `src/app.js`: state UI, Firebase listeners, commands, riwayat dan CSV.
- `src/model.js`: validasi, penentuan online, format CSV dan kontrak command.
- `src/ble.js`: pairing, autentikasi dan protokol OTA.
- `src/style.css`: desain responsif.
- `docs/`: hasil build siap GitHub Pages.

Referensi API: https://firebase.google.com/docs/web/setup,
https://firebase.google.com/docs/database/web/read-and-write,
https://developer.chrome.com/docs/capabilities/bluetooth.
