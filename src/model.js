export function online(report, connected, now) {
 return !!(connected && report && Number.isFinite(report.receivedAt) && now-report.receivedAt >= -5000 && now-report.receivedAt <= 20000);
}
export function validReading(report) {
 return !!(report?.sensorOk && Number.isFinite(report.temperature) && Number.isFinite(report.humidity));
}
export function commandPayload(op, values, report, now, id) {
 if(!report?.bootId) throw new Error('Identitas perangkat belum tersedia.');
 if(op==='settings' && (!Number.isFinite(values.target)||values.target<10||values.target>39)) throw new Error('Target harus antara 10–39°C.');
 if(op==='mode' && !['AUTO','MANUAL'].includes(values.mode)) throw new Error('Mode tidak valid.');
 if(op==='manual' && (!['OFF','HEAT','COOL'].includes(values.output)||!Number.isInteger(values.leaseSeconds)||values.leaseSeconds<1||values.leaseSeconds>300)) throw new Error('Durasi manual harus 1–300 detik.');
 if(op==='bluetooth' && typeof values.enabled!=='boolean') throw new Error('Status Bluetooth tidak valid.');
 if(op==='wifi') {
  if(!Array.isArray(values.profiles)||!values.profiles.length||values.profiles.length>5) throw new Error('Isi 1–5 profil WiFi.');
  for(const p of values.profiles) {
   if(!p.ssid || new TextEncoder().encode(p.ssid).length>32 || new TextEncoder().encode(p.password).length>63) throw new Error('SSID maksimal 32 byte dan password maksimal 63 byte.');
  }
 }
 if(!['mode','settings','manual','wifi','bluetooth'].includes(op)) throw new Error('Perintah tidak dikenal.');
 return {...values,op,id,bootId:report.bootId,expiresAt:now+60000};
}
export function historyRows(value) {
 return Object.entries(value||{}).map(([id,v])=>({...v,id})).sort((a,b)=>(a.timestamp||0)-(b.timestamp||0)||a.id.localeCompare(b.id));
}
export const csvColumns=['id','waktu_WIB','timestamp','timeValid','bootId','uptimeMs','event','temperature','humidity','target','mode','heater','cooler','sensorOk','alarm'];
export function csvCell(value) {
 let s=value==null?'':String(value);
 if(typeof value==='string' && /^[=+\-@\t\r]/.test(s)) s="'"+s;
 return '"'+s.replaceAll('"','""')+'"';
}
export function csvText(rows) {
 const fmt=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
 return '\ufeff'+[csvColumns.join(','),...rows.map(row=>{
  const data={...row,waktu_WIB:row.timeValid&&Number.isFinite(row.timestamp)?fmt.format(new Date(row.timestamp))+' +07:00':''};
  return csvColumns.map(k=>csvCell(data[k])).join(',');
 })].join('\r\n');
}
export function wibRange(from,to) {
 const start=Date.parse(from+'T00:00:00+07:00'),end=Date.parse(to+'T23:59:59.999+07:00');
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>end) throw new Error('Rentang tanggal tidak valid.');
 if(end-start>31*86400000) throw new Error('Pilih rentang maksimal 31 hari per ekspor.');
 return {start,end};
}
export function acceptCommand(current, next, acknowledged, now) {
 return !(current?.id && current.expiresAt>now && current.id!==acknowledged);
}
