import './style.css';
import {initializeApp} from 'firebase/app';
import {getAuth,signInWithEmailAndPassword,signOut,onAuthStateChanged,setPersistence,browserSessionPersistence} from 'firebase/auth';
import {getDatabase,ref,onValue,query,orderByChild,startAt,startAfter,endAt,limitToFirst,limitToLast,get,runTransaction} from 'firebase/database';
import {firebaseConfig,DEVICE_ID,OWNER_UID} from './config.js';
import {online,validReading,commandPayload,historyRows,csvText,wibRange,acceptCommand} from './model.js';
import {icon,hydrateIcons} from './icons.js';
import {BleUpdater} from './ble.js';
hydrateIcons();
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const firebase=initializeApp(firebaseConfig),auth=getAuth(firebase),db=getDatabase(firebase);
const state={demo:false,user:null,report:null,connected:false,offset:0,clockReady:false,page:'monitoring',pending:null,history:[],trend:[],tablePage:0,unsub:[],historyBusy:false,historyLoaded:false};
let toastTimer,installPrompt,historyRequest=0,lastTrendWindow=0;
const now=()=>Date.now()+state.offset;
const number=v=>Number.isFinite(v)?v.toFixed(1):'—';
const timeFormat=new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const dateFormat=new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
function text(id,value){$(id).textContent=value;}
function toast(message,error=false){clearTimeout(toastTimer);const t=$('#toast');t.textContent=message;t.classList.toggle('error',error);t.hidden=false;toastTimer=setTimeout(()=>t.hidden=true,6500);}
function errorMessage(error){
 const code=String(error?.code||'');
 if(/invalid-credential|wrong-password|user-not-found|invalid-login-credentials/.test(code))return 'Email atau password tidak sesuai. Gunakan akun pemilik Firebase.';
 if(/too-many-requests/.test(code))return 'Terlalu banyak percobaan. Tunggu beberapa saat lalu coba lagi.';
 if(/network-request-failed/.test(code))return 'Koneksi internet terganggu. Periksa jaringan dan coba lagi.';
 if(/permission_denied|permission-denied/i.test(code+' '+error?.message))return 'Akses database ditolak. Periksa UID pemilik dan Firebase Database Rules.';
 if(/unauthorized-domain/.test(code))return 'Tambahkan domain website ke Authorized domains di Firebase Authentication.';
 return error?.message||'Terjadi kesalahan. Silakan coba lagi.';
}
function isOnline(){return state.demo||online(state.report,state.connected,now());}
function canCommand(){return !state.demo && state.user?.uid===OWNER_UID && isOnline() && state.clockReady && !state.pending && !state.report?.updating && !ble.busy;}
function cleanup(){trendUnsub?.();trendUnsub=null;state.unsub.forEach(fn=>fn());state.unsub=[];historyRequest++;state.pending=null;state.report=null;state.trend=[];state.history=[];state.historyLoaded=false;state.historyBusy=false;state.connected=false;state.clockReady=false;state.offset=0;ble.disconnect();$('#ble-token').value='';$('#password').value='';$('#firmware-file').value='';$('#wifi-profiles').replaceChildren();addProfile();}
function showApp(){ $('#login-view').hidden=true;$('#app-view').hidden=false;$('#demo-banner').hidden=!state.demo; text('#account-name',state.demo?'Pratinjau':(state.user?.email?.split('@')[0]||'Pemilik'));text('#account-label',state.demo?'Data simulasi':'Akun pemilik');setPage('monitoring');render();}
function showLogin(){cleanup();state.demo=false;state.user=null;$('#app-view').hidden=true;$('#login-view').hidden=false;text('#login-error','');}
$('#login-form').addEventListener('submit',async event=>{
 event.preventDefault();const button=$('#login-button');button.disabled=true;text('#login-error','');
 try{await setPersistence(auth,browserSessionPersistence);await signInWithEmailAndPassword(auth,$('#email').value.trim(),$('#password').value);}
 catch(error){text('#login-error',errorMessage(error));}
 finally{button.disabled=false;$('#password').value='';}
});
$('#show-password').onclick=()=>{const p=$('#password');p.type=p.type==='password'?'text':'password';$('#show-password').setAttribute('aria-label',p.type==='password'?'Tampilkan password':'Sembunyikan password');};
onAuthStateChanged(auth,async user=>{
 if(!user){if(!state.demo)showLogin();return;}
 if(user.uid!==OWNER_UID){await signOut(auth);text('#login-error','Akun ini bukan akun pemilik maggot-01. Gunakan akun pemilik (akbartriagung4).');return;}
 cleanup();state.demo=false;state.user=user;showApp();connectData();
});
$('#logout-button').onclick=async()=>{if(ble.busy){toast('Selesaikan atau batalkan update firmware sebelum keluar.',true);return;}showLogin();await signOut(auth);};
$('#demo-login').onclick=()=>showLogin();
$('#demo-button').onclick=()=>{
 cleanup();state.demo=true;state.user=null;const t=Date.now();
 state.report={temperature:32.7,humidity:66.9,target:30,mode:'AUTO',heater:false,cooler:true,bluetooth:false,sensorOk:true,alarm:false,rssi:-52,firmware:'1.0.0',receivedAt:t,bootId:'demo',storageOk:true,historyPending:0};
 state.trend=Array.from({length:61},(_,i)=>({id:'demo-'+i,timestamp:t-(60-i)*60000,timeValid:true,temperature:32.7+Math.sin(i/8)*.65+(60-i)/60*.6,humidity:66.9+Math.sin(i/11)*2,target:30,mode:'AUTO',heater:false,cooler:true,sensorOk:true,event:'sample'}));
 state.history=[...state.trend];state.historyLoaded=true;showApp();renderHistory();renderChart();
};
function connectData(){
 state.unsub.push(onValue(ref(db,'.info/connected'),s=>{state.connected=s.val()===true;render();}));
 state.unsub.push(onValue(ref(db,'.info/serverTimeOffset'),s=>{state.offset=Number(s.val())||0;state.clockReady=true;render();}));
 state.unsub.push(onValue(ref(db,`devices/${DEVICE_ID}/reported`),s=>{
  state.report=s.val();
  const p=state.pending;
  if(p && state.report?.lastCommandId===p.id){
   const result=state.report.lastResult;
   state.pending=null;
   const ok=['OK','ACCEPTED','WIFI_QUEUED','DEFERRED_UNTIL_OTA_END'].includes(result);
   toast(ok?result==='WIFI_QUEUED'?'Profil WiFi diterima. Tunggu ESP32 terhubung kembali.':`${p.label} dikonfirmasi ESP32.`:`ESP32 menolak perintah: ${result}`,!ok);
   if(ok&&p.op==='wifi'){$('#wifi-profiles').replaceChildren();addProfile();}
  }
  render();
 },error=>{state.report=null;toast(errorMessage(error),true);render();}));
 subscribeTrend();
}
let trendUnsub=null;
function subscribeTrend(){
 trendUnsub?.();if(!state.user||state.demo)return;
 lastTrendWindow=now();
 trendUnsub=onValue(query(ref(db,`devices/${DEVICE_ID}/history`),orderByChild('timestamp'),startAt(now()-3600000),limitToLast(1000)),s=>{state.trend=historyRows(s.val());renderChart();},error=>{state.trend=[];renderChart();toast(errorMessage(error),true);});

}
async function sendCommand(op,values,label){
 if(!canCommand()){toast(state.demo?'Pratinjau tidak mengirim perintah. Masuk dengan akun pemilik.':'Perangkat belum siap atau ada perintah yang masih menunggu konfirmasi.',true);return;}
 let payload;
 try{payload=commandPayload(op,values,state.report,now(),crypto.randomUUID());}catch(error){toast(errorMessage(error),true);return;}
 state.pending={...payload,label,sentAt:now()};render();
 try{
  const result=await runTransaction(ref(db,`devices/${DEVICE_ID}/command`),current=>acceptCommand(current,payload,state.report?.lastCommandId,now())?payload:undefined,{applyLocally:false});
  if(!result.committed)throw new Error('Ada perintah dari sesi lain yang belum selesai. Tunggu hingga diterima atau kedaluwarsa.');
 }catch(error){if(state.pending?.id===payload.id)state.pending=null;toast(errorMessage(error),true);render();}
}
const pages={monitoring:['Monitoring Suhu Maggot','Pantau lingkungan budidaya maggot, di mana saja.'],control:['Kontrol Perangkat','Atur kondisi budidaya dengan konfirmasi langsung dari ESP32.'],history:['Riwayat Pengukuran','Telusuri perubahan suhu dan kelembapan dari waktu ke waktu.'],wifi:['Jaringan WiFi','Kelola koneksi ESP32 agar monitoring tetap berjalan.'],firmware:['Firmware & Bluetooth','Hubungkan perangkat dan kelola pembaruan firmware.']};
function setPage(page){if(!pages[page])page='monitoring';state.page=page;$$('.page').forEach(p=>p.hidden=p.id!=='page-'+page);$$('[data-page]').forEach(b=>{b.classList.toggle('active',b.dataset.page===page);b.setAttribute('aria-current',b.dataset.page===page?'page':'false');});text('#page-title',pages[page][0]);text('#page-subtitle',pages[page][1]);closeMenu();if(page==='history')renderHistory();if(page==='monitoring')renderChart();}
$$('[data-page]').forEach(b=>b.onclick=()=>setPage(b.dataset.page));$$('[data-goto]').forEach(b=>b.onclick=()=>setPage(b.dataset.goto));
function closeMenu(){$('#sidebar').classList.remove('open');$('#mobile-shade').hidden=true;$('#menu-button').setAttribute('aria-expanded','false');}
$('#menu-button').onclick=()=>{const open=$('#sidebar').classList.toggle('open');$('#mobile-shade').hidden=!open;$('#menu-button').setAttribute('aria-expanded',String(open));};$('#mobile-shade').onclick=closeMenu;document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu();});
function render(){
 const r=state.report,on=isOnline(),valid=validReading(r),fresh=on&&valid,unknown=!r;
 const status=state.demo?'DATA SIMULASI':unknown?'MENUNGGU DATA':on?'PERANGKAT ONLINE':'PERANGKAT OFFLINE';
 const pill=$('#top-status');pill.classList.toggle('is-online',on&&!state.demo);pill.querySelector('span').textContent=status;pill.querySelector('i').style.background=on?'#29d6a0':'#8294b4';
 text('#side-status',state.demo?'Simulasi':unknown?'Menunggu':on?'Online':'Offline');text('#side-mode',r?.mode==='AUTO'?'Otomatis':r?.mode==='MANUAL'?'Manual':'—');text('#side-target',r?number(r.target)+'°C':'—');text('#side-bt',r?r.bluetooth?'Aktif':'Nonaktif':'—');
 text('#temperature',valid?number(r.temperature):'—');text('#humidity',valid?number(r.humidity):'—');text('#target-value',r?number(r.target):'—');text('#mode-badge',r?.mode==='AUTO'?'Mode Otomatis':r?.mode==='MANUAL'?'Mode Manual':'Mode —');
 const badge=$('#temperature-badge');badge.textContent=unknown?'Menunggu sensor':!on?'Data terakhir':!valid?'Sensor bermasalah':r.alarm?'Alarm suhu tinggi':'Sensor aktif';badge.className='badge'+(!valid&&!unknown?' error':r?.alarm||!on?' warning':'');
 const gauge=valid?r.temperature:null;$('#gauge-fill').setAttribute('stroke-dasharray',gauge==null?'0 100':`${Math.max(0,Math.min(100,(gauge-20)/25*100))} 100`);$('#gauge-fill').style.stroke=r?.alarm?'#ff6c7f':'#00b9dd';text('#gauge-value',number(gauge));text('#gauge-note',unknown?'Menunggu pembacaan perangkat':!on?'Pembacaan terakhir · perangkat offline':!valid?'Periksa sambungan sensor SHT31':r.alarm?'Batas suhu maksimum tercapai':`Target ${number(r.target)}°C · ${r.mode==='AUTO'?'kontrol otomatis':'kontrol manual'}`);
 text('#heater-status',r?(r.heater?'MENYALA':'MATI')+(!on?' · terakhir':''):'—');text('#cooler-status',r?(r.cooler?'MENYALA':'MATI')+(!on?' · terakhir':''):'—');$('#heater-status').style.color=r?.heater?'#ffbd81':'#b5c4df';$('#cooler-status').style.color=r?.cooler?'#4ad5fa':'#b5c4df';text('#wifi-signal',r&&Number.isFinite(r.rssi)?`${r.rssi} dBm`:'—');text('#wifi-strength',!on?'Data terakhir':r?.rssi>-67?'Sinyal baik':'Sinyal lemah');
 text('#updated-label',state.demo?'Data contoh untuk pratinjau':r?.receivedAt?`Pembaruan ${timeFormat.format(new Date(r.receivedAt))} WIB${!on?' · offline':''}`:'Belum ada pembaruan');text('#firmware-label','Firmware '+(r?.firmware||'—'));$('#footer-dot').style.background=on?'#29d6a0':'#7a8aab';
 let notice='';if(!state.demo){if(!state.connected)notice='Koneksi ke Firebase terputus. Data terakhir ditampilkan; kontrol dinonaktifkan.';else if(!r)notice='Menunggu laporan ESP32. Pastikan perangkat menyala dan terhubung ke Firebase.';else if(!on)notice='ESP32 belum mengirim pembaruan dalam 20 detik. Nilai yang terlihat adalah data terakhir.';else if(!r.sensorOk)notice='Sensor bermasalah. Firmware mematikan kedua aktuator sampai pembacaan kembali valid.';else if(r.alarm)notice='Alarm suhu ≥40°C. Pemanas dimatikan; pendinginan diprioritaskan oleh firmware.';else if(r.updating)notice='Pembaruan firmware sedang berlangsung. Aktuator dimatikan sementara.';else if(r.storageOk===false)notice='Penyimpanan lokal perangkat bermasalah. Periksa ESP32 agar riwayat offline tidak hilang.';}
 text('#connection-notice',notice);$('#connection-notice').hidden=!notice;
 if(state.pending&&now()>state.pending.expiresAt+5000){state.pending=null;toast('Perintah tidak terkonfirmasi hingga batas waktu. Periksa status ESP32 sebelum mencoba lagi.',true);}
 text('#command-notice',state.pending?`${state.pending.label}: ${now()-state.pending.sentAt>25000?'belum ada konfirmasi; jangan mengulang perintah dahulu.':'menunggu konfirmasi ESP32…'}`:'');$('#command-notice').hidden=!state.pending;
 const enabled=canCommand();$$('[data-command]').forEach(b=>b.disabled=!enabled);
 $('#auto-button').classList.toggle('selected',r?.mode==='AUTO');$('#manual-button').classList.toggle('selected',r?.mode==='MANUAL');$('#auto-button').disabled=!enabled||r?.mode==='AUTO';$('#manual-button').disabled=!enabled||r?.mode==='MANUAL';
 const manual=enabled&&r?.mode==='MANUAL';$('#heat-button').disabled=!manual||!fresh||r?.alarm;$('#cool-button').disabled=!manual||!fresh;$('#off-button').disabled=!manual;
 text('#manual-help',r?.mode==='MANUAL'?'Pilih satu aktuator. Setelah durasi berakhir, output kembali OFF kecuali proteksi suhu meminta pendinginan.':'Pilih mode Manual untuk mengendalikan relay.');
 if(document.activeElement!==$('#target-input')&&!$('#target-input').dataset.dirty)$('#target-input').value=Number.isFinite(r?.target)?r.target:'';
 text('#bt-state',!r?'Belum diketahui':r.bluetooth?'Bluetooth aktif':'Bluetooth nonaktif');$('#bt-on').disabled=!enabled||!!r?.bluetooth;$('#bt-off').disabled=!enabled||!r?.bluetooth;
 $('#history-export').disabled=state.historyBusy||!state.history.length;$('#ble-connect').disabled=state.demo||!state.user||ble.busy||!navigator.bluetooth;updateBleButtons();
}
$('#auto-button').onclick=()=>sendCommand('mode',{mode:'AUTO'},'Mode Otomatis');$('#manual-button').onclick=()=>sendCommand('mode',{mode:'MANUAL'},'Mode Manual');$('#target-input').oninput=()=>$('#target-input').dataset.dirty='1';
$('#target-form').onsubmit=async e=>{e.preventDefault();await sendCommand('settings',{target:Number($('#target-input').value)},'Target suhu');delete $('#target-input').dataset.dirty;};
for(const [id,output,label] of [['heat-button','HEAT','Pemanas ON'],['cool-button','COOL','Pendingin ON'],['off-button','OFF','Kedua aktuator OFF']])$('#'+id).onclick=()=>sendCommand('manual',{output,leaseSeconds:Number($('#lease-input').value)},label);
$('#bt-on').onclick=()=>sendCommand('bluetooth',{enabled:true},'Bluetooth ON');$('#bt-off').onclick=()=>sendCommand('bluetooth',{enabled:false},'Bluetooth OFF');
function addProfile(){const box=$('#wifi-profiles');if(box.children.length>=5){toast('Maksimal lima profil WiFi.',true);return;}const index=box.children.length+1,el=document.createElement('div');el.className='wifi-profile';el.innerHTML=`<div class="profile-heading"><span>JARINGAN ${index}</span><button type="button" class="icon-button remove-profile" aria-label="Hapus jaringan">${icon('close')}</button></div><div class="profile-fields"><div><label>Nama WiFi (SSID)<input class="ssid" autocomplete="off" placeholder="Nama jaringan" required></label></div><div><label>Password WiFi<input class="wifi-password" type="password" autocomplete="new-password" placeholder="Kosong jika jaringan terbuka"></label></div></div>`;el.querySelector('.remove-profile').onclick=()=>{if(box.children.length===1)return;el.remove();[...box.children].forEach((n,i)=>n.querySelector('.profile-heading span').textContent='JARINGAN '+(i+1));};box.append(el);}
$('#add-wifi').onclick=addProfile;addProfile();
$('#wifi-form').onsubmit=e=>{e.preventDefault();const profiles=$$('.wifi-profile').map(el=>({ssid:el.querySelector('.ssid').value,password:el.querySelector('.wifi-password').value}));sendCommand('wifi',{profiles},'Profil WiFi');};
function renderChart(){
 const rows=state.trend.filter(r=>r.timeValid&&Number.isFinite(r.timestamp)&&r.timestamp>=now()-3600000&&r.timestamp<=now()+5000);
 const container=$('#trend-chart');text('#trend-count',rows.length+' catatan');
 if(!rows.some(r=>r.sensorOk&&Number.isFinite(r.temperature))){container.innerHTML=`<div class="chart-empty">${icon('chart')}<span>Belum ada riwayat pada 60 menit terakhir.</span><small>Grafik muncul setelah ESP32 mengirim catatan.</small></div>`;return;}
 const width=600,height=215,left=35,right=36,top=12,bottom=27,w=width-left-right,h=height-top-bottom,start=now()-3600000;
 const temps=rows.filter(r=>r.sensorOk&&Number.isFinite(r.temperature)).map(r=>r.temperature),min=Math.min(20,Math.floor(Math.min(...temps)/5)*5),max=Math.max(45,Math.ceil(Math.max(...temps)/5)*5);
 const x=t=>left+(t-start)/3600000*w,y=v=>top+(max-v)/(max-min)*h,yr=v=>top+(100-v)/100*h;
 let grid='',labels='';for(let i=0;i<=4;i++){const yy=top+i*h/4;grid+=`<line x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}" stroke="#26324c" stroke-dasharray="3 5"/>`;labels+=`<text x="${left-8}" y="${yy+4}" text-anchor="end">${Math.round(max-(max-min)*i/4)}°</text><text x="${width-right+8}" y="${yy+4}">${100-i*25}%</text>`;}
 for(let i=0;i<=4;i++){labels+=`<text x="${left+i*w/4}" y="${height-3}" text-anchor="middle">${new Intl.DateTimeFormat('id-ID',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(start+i*900000))}</text>`;}
 function path(field,scale){let d='',last=0;for(const r of rows){if(!r.sensorOk||!Number.isFinite(r[field])){last=0;continue;}const move=!last||r.timestamp-last>180000;d+=`${move?'M':'L'}${x(r.timestamp).toFixed(2)},${scale(r[field]).toFixed(2)} `;last=r.timestamp;}return d;}
 const points=rows.filter(r=>r.sensorOk&&Number.isFinite(r.temperature)).map(r=>`<circle cx="${x(r.timestamp).toFixed(2)}" cy="${y(r.temperature).toFixed(2)}" r="2" fill="#0dc8e8"><title>${timeFormat.format(new Date(r.timestamp))} WIB · ${r.temperature.toFixed(1)}°C · ${number(r.humidity)}% RH</title></circle>`).join('');
 container.innerHTML=`<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Grafik suhu dan kelembapan selama 60 menit terakhir"><g>${grid}</g><g fill="#788fb2" font-size="9" font-family="system-ui">${labels}</g><path d="${path('humidity',yr)}" fill="none" stroke="#a496ff" stroke-width="1.7" opacity=".7"/><path d="${path('temperature',y)}" fill="none" stroke="#04c2df" stroke-width="2.5"/>${points}</svg>`;
}
function defaultDates(){const value=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());$('#date-from').value=value;$('#date-to').value=value;}
defaultDates();
async function loadHistory(){
 if(state.historyBusy)return;
 if(state.demo){renderHistory();toast('Riwayat pratinjau menggunakan 61 catatan simulasi.');return;}
 if(!state.user)return;
 let range;try{range=wibRange($('#date-from').value,$('#date-to').value);}catch(error){toast(errorMessage(error),true);return;}
 const loadedDates=[$('#date-from').value,$('#date-to').value];
 const requestId=++historyRequest;state.historyBusy=true;state.historyLoaded=false;state.history=[];state.tablePage=0;renderHistory();render();
 try{
  const result=[];let last=null;
  for(;;){
   const constraints=[orderByChild('timestamp'),last?startAfter(last.timestamp,last.id):startAt(range.start),endAt(range.end),limitToFirst(1000)];
   const s=await get(query(ref(db,`devices/${DEVICE_ID}/history`),...constraints));if(requestId!==historyRequest)return;
   const batch=[];s.forEach(child=>batch.push({...child.val(),id:child.key}));result.push(...batch);
   if(result.length>50000)throw new Error('Lebih dari 50.000 catatan. Pilih rentang lebih pendek.');
   if(batch.length<1000)break;last=batch.at(-1);text('#history-info',`Memuat ${result.length.toLocaleString('id-ID')} catatan…`);
  }
  state.history=result;state.historyDates=loadedDates;state.historyLoaded=true;
 }catch(error){if(requestId===historyRequest){state.history=[];toast(errorMessage(error),true);}}
 finally{if(requestId===historyRequest){state.historyBusy=false;renderHistory();render();}}
}
$('#history-form').onsubmit=e=>{e.preventDefault();loadHistory();};
function renderHistory(){
 const rows=state.history,total=rows.length,pages=Math.ceil(total/50);state.tablePage=Math.max(0,Math.min(state.tablePage,pages-1));
 text('#history-info',state.historyBusy?'Memuat riwayat…':state.historyLoaded?`${total.toLocaleString('id-ID')} catatan${state.demo?' simulasi':''}. Catatan tanpa waktu sinkron tidak termasuk filter tanggal.`:'Pilih tanggal, lalu tekan Tampilkan data.');
 const body=$('#history-body');body.replaceChildren();
 for(const r of [...rows].reverse().slice(state.tablePage*50,state.tablePage*50+50)){
  const tr=document.createElement('tr');for(const v of [r.timeValid&&r.timestamp?dateFormat.format(new Date(r.timestamp)):'Belum sinkron',Number.isFinite(r.temperature)?number(r.temperature)+'°C':'—',Number.isFinite(r.humidity)?number(r.humidity)+'%':'—',number(r.target)+'°C',r.mode||'—',r.heater?'ON':'OFF',r.cooler?'ON':'OFF',r.sensorOk?'OK':'ERROR']){const td=document.createElement('td');td.textContent=v;tr.append(td);}body.append(tr);
 }
 if(!total){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=8;td.textContent=state.historyBusy?'Sedang memuat…':'Belum ada catatan untuk ditampilkan.';td.style.textAlign='center';tr.append(td);body.append(tr);}
 text('#table-page',total?`Halaman ${state.tablePage+1} / ${pages}`:'0 catatan');$('#prev-page').disabled=!total||state.tablePage===0;$('#next-page').disabled=!total||state.tablePage>=pages-1;
}
$('#prev-page').onclick=()=>{state.tablePage--;renderHistory();};$('#next-page').onclick=()=>{state.tablePage++;renderHistory();};
function downloadCsv(){if(!state.history.length)return;const blob=new Blob([csvText(state.history)],{type:'text/csv;charset=utf-8;'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${state.demo?'SIMULASI-':''}maggot-${state.demo?'pratinjau':(state.historyDates||[]).join('-')}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}
$('#history-export').onclick=downloadCsv;$('#header-export').onclick=()=>{setPage('history');if(!state.historyLoaded)loadHistory();else toast('Pilih rentang tanggal, lalu tekan Unduh CSV.');};
const ble=new BleUpdater(message=>{text('#ble-status',message);updateBleButtons();});
text('#ble-support',navigator.bluetooth?'Tersedia di browser ini. Pastikan Bluetooth ESP32 aktif dan perangkat berada di dekat Anda.':'Browser ini tidak mendukung Web Bluetooth. Gunakan Chrome Android atau Chrome/Edge desktop yang kompatibel melalui HTTPS.');
function updateBleButtons(){$('#ota-start').disabled=state.demo||!state.user||!ble.connected||ble.busy||!$('#firmware-file').files.length||!$('#ota-confirm').checked;$('#ota-cancel').disabled=!ble.busy;$('#logout-button').disabled=ble.busy;}
$('#ble-connect').onclick=async()=>{if(state.demo||!state.user)return;$('#ble-connect').disabled=true;try{await ble.connect($('#ble-token').value);$('#ble-token').value='';toast('ESP32 terhubung melalui BLE.');}catch(error){text('#ble-status',errorMessage(error));toast(errorMessage(error),true);}finally{render();}};
$('#firmware-file').onchange=updateBleButtons;$('#ota-confirm').onchange=updateBleButtons;
$('#ota-start').onclick=async()=>{if(!$('#ota-confirm').checked||state.demo||!state.user)return;try{const job=ble.upload($('#firmware-file').files[0],percent=>{$('#ota-progress').value=percent;text('#ble-status',`Mengirim firmware: ${percent}% · Jangan tutup halaman.`);});render();await job;toast('Firmware terkirim dan diverifikasi. Tunggu ESP32 restart.');}catch(error){text('#ble-status',errorMessage(error));toast(errorMessage(error),true);}finally{render();}};
$('#ota-cancel').onclick=()=>{ble.cancel();text('#ble-status','Membatalkan setelah paket berjalan selesai…');};
window.addEventListener('beforeunload',event=>{if(ble.busy){event.preventDefault();event.returnValue='';}});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;});
$('#install-button').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;}else toast('Buka menu browser → Tambahkan ke layar utama atau Instal aplikasi. Jika opsi belum tersedia, gunakan website langsung.');};
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
setInterval(()=>{if($('#app-view').hidden)return;render();if(!state.demo&&state.user&&now()-lastTrendWindow>300000)subscribeTrend();},1000);
setInterval(()=>{if(!$('#app-view').hidden)renderChart();},30000);
renderHistory();
