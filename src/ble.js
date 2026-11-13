const UUID={service:'70c10000-5b7a-4d9a-b003-a1cc38197001',control:'70c10001-5b7a-4d9a-b003-a1cc38197001',data:'70c10002-5b7a-4d9a-b003-a1cc38197001',status:'70c10003-5b7a-4d9a-b003-a1cc38197001'};
const encoder=new TextEncoder(),decoder=new TextDecoder();
export class BleUpdater {
 constructor(onStatus){this.onStatus=onStatus;this.authorized=false;this.busy=false;this.cancelled=false;this.listeners=new Set();}
 get connected(){return !!this.device?.gatt?.connected && this.authorized;}
 async connect(token){
  if(!navigator.bluetooth) throw new Error('Gunakan Chrome Android atau browser desktop yang mendukung Web Bluetooth melalui HTTPS.');
  if(encoder.encode(token).length<32) throw new Error('Token BLE minimal 32 karakter, sesuai secrets.h.');
  this.device=await navigator.bluetooth.requestDevice({filters:[{services:[UUID.service]}]});
  this.device.addEventListener('gattserverdisconnected',()=>{this.authorized=false;this.listeners.forEach(fn=>fn('DISCONNECTED'));this.onStatus('Koneksi BLE terputus.');});
  try{
   const server=await this.device.gatt.connect(),service=await server.getPrimaryService(UUID.service);
   this.control=await service.getCharacteristic(UUID.control);this.data=await service.getCharacteristic(UUID.data);this.status=await service.getCharacteristic(UUID.status);
   this.onStatus('Masukkan PIN pairing dari LCD saat diminta Android/browser.');
   await this.status.readValue();
   await this.status.startNotifications();
   this.status.addEventListener('characteristicvaluechanged',event=>{const text=decoder.decode(event.target.value);this.listeners.forEach(fn=>fn(text));});
   await this.exchange(this.control,encoder.encode(JSON.stringify({op:'auth',token})),s=>s==='AUTH_OK');
   this.authorized=true;this.onStatus('BLE terhubung dan terautentikasi.');
  }catch(error){this.disconnect();throw error;}
 }
 async exchange(characteristic,bytes,accept){
  let resolveMessage,rejectMessage;
  const message=new Promise((resolve,reject)=>{resolveMessage=resolve;rejectMessage=reject;});
  // Attach a handler immediately so disconnect during an ATT write never causes an unhandled rejection.
  message.catch(()=>{});
  const listener=text=>{
   if(accept(text)) resolveMessage(text);
   else if(/FAILED|ERROR|MISMATCH|INVALID|ABORTED|AUTH_REQUIRED|BUSY|TIMEOUT|DISCONNECTED|INCOMPLETE/.test(text))rejectMessage(new Error(text));
  };
  this.listeners.add(listener);
  let timer;
  try{
   await characteristic.writeValueWithResponse(bytes);
   timer=setTimeout(async()=>{
    try{const text=decoder.decode(await this.status.readValue());if(accept(text))resolveMessage(text);else rejectMessage(new Error('ESP32 belum mengonfirmasi: '+text));}
    catch{rejectMessage(new Error('Timeout konfirmasi BLE.'));}
   },6000);
   return await message;
  }finally{clearTimeout(timer);this.listeners.delete(listener);}
 }
 async upload(file,onProgress){
  if(!this.connected)throw new Error('Hubungkan dan autentikasi BLE terlebih dahulu.');
  if(!file || file.size<1024 || file.size>0x1c0000)throw new Error('Ukuran firmware harus 1 KB–1792 KiB.');
  if(this.busy)throw new Error('Update masih berjalan.');
  this.busy=true;this.cancelled=false;
  let started=false;
  try{
   const buffer=await file.arrayBuffer(),bytes=new Uint8Array(buffer);
   if(bytes[0]!==0xe9 || bytes[12]!==0 || bytes[13]!==0)throw new Error('File bukan image aplikasi ESP32 klasik yang sesuai.');
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('');
   if(this.cancelled)throw new Error('Update dibatalkan.');
   await this.exchange(this.control,encoder.encode(JSON.stringify({op:'ota.begin',board:'esp32dev',size:file.size,sha256:hash})),s=>s==='OTA_READY');
   started=true;let offset=0,chunkSize=180,corrections=0;
   while(offset<bytes.length){
    if(this.cancelled)throw new Error('Update dibatalkan.');
    const count=Math.min(chunkSize,bytes.length-offset),packet=new Uint8Array(count+4);
    new DataView(packet.buffer).setUint32(0,offset,true);packet.set(bytes.subarray(offset,offset+count),4);
    let reply;
    try{reply=await this.exchange(this.data,packet,s=>s===`ACK:${offset+count}`||s.startsWith('OFFSET:'));}
    catch(error){if(chunkSize>16 && this.device.gatt.connected && error.name==='InvalidModificationError'){chunkSize=16;continue;}throw error;}
    if(reply.startsWith('OFFSET:')){
     const expected=Number(reply.slice(7));
     if(!Number.isInteger(expected)||expected<0||expected>bytes.length||++corrections>3)throw new Error('Offset firmware tidak konsisten. Batalkan dan mulai ulang.');
     offset=expected;
    }else{offset+=count;corrections=0;}
    onProgress(Math.floor(offset/bytes.length*100));
   }
   await this.exchange(this.control,encoder.encode(JSON.stringify({op:'ota.end'})),s=>s==='OTA_OK_RESTART');
   started=false;this.onStatus('Firmware diverifikasi. ESP32 sedang restart; periksa versi pada dashboard.');
  }catch(error){
   if(started && this.device?.gatt?.connected){try{await this.control.writeValueWithResponse(encoder.encode('{"op":"ota.abort"}'));}catch{}}
   throw error;
  }finally{this.busy=false;}
 }
 cancel(){this.cancelled=true;}
 disconnect(){this.authorized=false;this.device?.gatt?.disconnect();}
}
