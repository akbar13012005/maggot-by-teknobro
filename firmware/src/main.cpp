#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <StreamString.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <Adafruit_SHT31.h>
#include <LiquidCrystal_I2C.h>
#include <NimBLEDevice.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#include <atomic>
#include <time.h>
#include "config.h"
#include "control.h"
#include "relay.h"
#include "tls_roots.h"
using maggot::Output;
static maggot::Controller controller;
static Adafruit_SHT31 sensor;
static LiquidCrystal_I2C *lcd=nullptr;
static Preferences settings;
static bool sensorFound=false, sensorValid=false, btOn=false, btWanted=false;
static float temperature=NAN, humidity=NAN;
static uint32_t lastSample=0, lastValid=0, blinkAt=0, idleAt=0, passkey=0;
static char bootId[17], lastReply[100]="READY", lastCommand[49]="";
static char cloudResult[100]="READY";
static bool processingCloud=false;
static bool updating=false;
static size_t otaSize=0, otaReceived=0;
static uint32_t otaAt=0, restartAt=0;
static char otaHash[65];
static mbedtls_sha256_context sha;
static std::atomic<bool> bleConnected{false}, bleDisconnected{false};
static bool bleAuthorized=false;
static std::atomic<bool> cloudOK{false}, diskOK{false};
static std::atomic<uint32_t> historyDropped{0}, pendingCount{0}, cloudAt{0};
static std::atomic<int> lastHttpCode{0};
static SemaphoreHandle_t stateMutex;
static char stateJson[1600]="{}";
struct Message { uint16_t size; uint8_t kind; char data[1024]; }; // 0 cloud, 1 BLE control, 2 BLE data
static QueueHandle_t commands, records, wifiChanges;
struct History { char id[40]; char json[700]; };
static NimBLECharacteristic *bleStatus=nullptr;
static NimBLEServer *bleServer=nullptr;
static const char *SERVICE="70c10000-5b7a-4d9a-b003-a1cc38197001";
static const char *CONTROL="70c10001-5b7a-4d9a-b003-a1cc38197001";
static const char *DATA="70c10002-5b7a-4d9a-b003-a1cc38197001";
static const char *STATUS_UUID="70c10003-5b7a-4d9a-b003-a1cc38197001";
static uint64_t epochMs(){ time_t t=time(nullptr);return t>1700000000 ? uint64_t(t)*1000 : 0; }
// LCD 20x4: fixed cells, no heap allocation and no lcd.clear() flicker.
static void lcdRow(uint8_t row,const uint8_t *cells){
 if(!lcd || row>=4)return;
 static uint8_t previous[4][20]={};
 static bool valid[4]={false,false,false,false};
 uint8_t col=0;
 while(col<20){
  if(valid[row] && previous[row][col]==cells[col]){col++;continue;}
  lcd->setCursor(col,row);
  do{
   lcd->write(cells[col]);previous[row][col]=cells[col];col++;
  }while(col<20 && (!valid[row] || previous[row][col]!=cells[col]));
 }
 valid[row]=true;
}
static void line(uint8_t row,const char *text){
 uint8_t cells[20];memset(cells,' ',sizeof(cells));
 size_t count=strlen(text);if(count>20)count=20;
 memcpy(cells,text,count);lcdRow(row,cells);
}
static void centeredLine(uint8_t row,const char *text){
 uint8_t cells[20];memset(cells,' ',sizeof(cells));
 size_t count=strlen(text);if(count>20)count=20;
 memcpy(cells+(20-count)/2,text,count);lcdRow(row,cells);
}
static void columnLine(uint8_t row,const char *left,const char *right){
 uint8_t cells[20];memset(cells,' ',sizeof(cells));
 size_t a=strlen(left),b=strlen(right);if(a>10)a=10;if(b>10)b=10;
 memcpy(cells,left,a);memcpy(cells+10,right,b);lcdRow(row,cells);
}
static void outputs(){
 // De-energize the unused channel before energizing the requested one.
 const bool heat=controller.output==Output::HEAT, cool=controller.output==Output::COOL;
 if(!heat)digitalWrite(HEATER_PIN,maggot::relayLevel(false,HEATER_ACTIVE_LOW));
 if(!cool)digitalWrite(COOLER_PIN,maggot::relayLevel(false,COOLER_ACTIVE_LOW));
 if(heat)digitalWrite(HEATER_PIN,maggot::relayLevel(true,HEATER_ACTIVE_LOW));
 if(cool)digitalWrite(COOLER_PIN,maggot::relayLevel(true,COOLER_ACTIVE_LOW));
 digitalWrite(HEATER_LED_PIN,heat);digitalWrite(COOLER_LED_PIN,cool);
}
static void reply(const char *message){
 strlcpy(lastReply,message,sizeof(lastReply));
 if(processingCloud)strlcpy(cloudResult,message,sizeof(cloudResult));
 if(btOn && bleStatus){bleStatus->setValue(message);if(bleConnected)bleStatus->notify();}
}
static void abortOta(const char *reason){
 if(updating){Update.abort();mbedtls_sha256_free(&sha);updating=false;controller.stop(millis());outputs();}
 reply(reason);
}
class ServerCallbacks:public NimBLEServerCallbacks {
 void onConnect(NimBLEServer*) override {bleConnected=true;}
 void onDisconnect(NimBLEServer*) override {bleConnected=false;bleDisconnected=true;}
};
class WriteCallbacks:public NimBLECharacteristicCallbacks {
 uint8_t kind;
 public: explicit WriteCallbacks(uint8_t k):kind(k){}
 void onWrite(NimBLECharacteristic *ch) override {
  std::string v=ch->getValue();
  if(v.empty()||v.size()>1023)return;
  Message m{};m.kind=kind;m.size=v.size();memcpy(m.data,v.data(),m.size);
  // Never write flash or toggle outputs in a BLE callback. App waits for acknowledgement.
  xQueueSend(commands,&m,0);
 }
};
static ServerCallbacks serverCallbacks;
static WriteCallbacks ctrlCallbacks(1),dataCallbacks(2);
static void bluetoothTick(uint32_t now){
 if(bleDisconnected.exchange(false)){
  bleAuthorized=false;if(!restartAt)abortOta("DISCONNECTED");idleAt=now;
  if(btOn && btWanted)NimBLEDevice::startAdvertising();
 }
 if(btOn && !bleConnected && uint32_t(now-idleAt)>=BLE_IDLE_MS)btWanted=false;
 if(btWanted==btOn || updating)return;
 if(btWanted){
  passkey=100000+esp_random()%900000;
  NimBLEDevice::init("maggot by teknobro");
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setSecurityAuth(false,true,true); // fresh passkey; no stored bonding
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
  NimBLEDevice::setSecurityPasskey(passkey);
  bleServer=NimBLEDevice::createServer();bleServer->setCallbacks(&serverCallbacks,false);
  auto s=bleServer->createService(SERVICE);
  auto c=s->createCharacteristic(CONTROL,NIMBLE_PROPERTY::WRITE|NIMBLE_PROPERTY::WRITE_ENC|NIMBLE_PROPERTY::WRITE_AUTHEN,1024);
  c->setCallbacks(&ctrlCallbacks);
  auto d=s->createCharacteristic(DATA,NIMBLE_PROPERTY::WRITE|NIMBLE_PROPERTY::WRITE_ENC|NIMBLE_PROPERTY::WRITE_AUTHEN,244);
  d->setCallbacks(&dataCallbacks);
  bleStatus=s->createCharacteristic(STATUS_UUID,NIMBLE_PROPERTY::READ|NIMBLE_PROPERTY::NOTIFY|NIMBLE_PROPERTY::READ_ENC|NIMBLE_PROPERTY::READ_AUTHEN,128);
  bleStatus->setValue("READY");s->start();
  auto ad=NimBLEDevice::getAdvertising();ad->addServiceUUID(SERVICE);ad->setScanResponse(true);ad->start();
  btOn=true;idleAt=now;bleAuthorized=false;
 }else{
  NimBLEDevice::deinit(true);bleStatus=nullptr;bleServer=nullptr;
  btOn=false;bleConnected=false;bleAuthorized=false;
 }
}
static bool exactToken(const char *s){
 size_t n=strlen(BLE_ACCESS_TOKEN);if(n<32 || strlen(s)!=n)return false;
 uint8_t diff=0;for(size_t i=0;i<n;i++)diff|=s[i]^BLE_ACCESS_TOKEN[i];return diff==0;
}
static bool isHexHash(const char *s){if(strlen(s)!=64)return false;for(int i=0;i<64;i++)if(!isxdigit((unsigned char)s[i]))return false;return true;}
static bool commandFresh(JsonDocument &doc){
 const char *id=doc["id"]|"",*boot=doc["bootId"]|"";
 uint64_t now=epochMs(),expiry=doc["expiresAt"]|uint64_t(0);
 return strlen(id)>0 && strlen(id)<=48 && strcmp(id,lastCommand)!=0 && strcmp(boot,bootId)==0 && now && expiry>now && expiry-now<=120000;
}
static void handleMessage(Message &m,uint32_t now){
 if(m.kind==2){
  if(!bleAuthorized||!updating||m.size<5)return;
  uint32_t offset=0;memcpy(&offset,m.data,4);
  size_t count=m.size-4;
  if(offset!=otaReceived || count>otaSize-otaReceived){char b[48];snprintf(b,sizeof(b),"OFFSET:%u",unsigned(otaReceived));reply(b);return;}
  if(Update.write((uint8_t*)m.data+4,count)!=count){abortOta("WRITE_ERROR");return;}
  mbedtls_sha256_update_ret(&sha,(uint8_t*)m.data+4,count);
  otaReceived+=count;otaAt=now;char b[50];snprintf(b,sizeof(b),"ACK:%u",unsigned(otaReceived));reply(b);return;
 }
 StaticJsonDocument<1536> doc;
 if(deserializeJson(doc,m.data,m.size)){reply("INVALID_JSON");return;}
 const char *op=doc["op"]|"";
 if(m.kind==1){
  if(!strcmp(op,"auth")){
   bleAuthorized=exactToken(doc["token"]|"");reply(bleAuthorized?"AUTH_OK":"AUTH_FAILED");return;
  }
  if(!bleAuthorized){reply("AUTH_REQUIRED");return;}
 }else{
  if(!commandFresh(doc)){reply("STALE_OR_INVALID_COMMAND");return;}
  strlcpy(lastCommand,doc["id"]|"",sizeof(lastCommand));processingCloud=true;
 }
 if(!strcmp(op,"bluetooth")){
  if(!doc["enabled"].is<bool>()){reply("INVALID_ENABLED");return;}
  btWanted=doc["enabled"].as<bool>();idleAt=now;reply(updating?"DEFERRED_UNTIL_OTA_END":"ACCEPTED");return;
 }
 if(!strcmp(op,"settings")){
  if(updating){reply("OTA_BUSY");return;}
  if(!doc["target"].is<float>() && !doc["target"].is<int>()){reply("INVALID_TARGET");return;}
  float t=doc["target"].as<float>();
  if(!isfinite(t)||t<10||t>39){reply("TARGET_RANGE_10_39");return;}
  if(controller.target!=t){controller.target=t;settings.putFloat("target",t);}
  reply("OK");return;
 }
 if(!strcmp(op,"mode")){
  if(updating){reply("OTA_BUSY");return;}
  const char *mode=doc["mode"]|"";
  if(strcmp(mode,"AUTO") && strcmp(mode,"MANUAL")){reply("INVALID_MODE");return;}
  bool automatic=!strcmp(mode,"AUTO");
  if(automatic!=controller.automatic){controller.stop(now);outputs();controller.automatic=automatic;controller.manual=Output::OFF;controller.leaseMs=0;blinkAt=now?now:1;}
  reply("OK");return;
 }
 if(!strcmp(op,"manual")){
  if(updating||controller.automatic){reply("REQUIRES_MANUAL_MODE");return;}
  const char *out=doc["output"]|"";
  if(strcmp(out,"OFF")&&strcmp(out,"HEAT")&&strcmp(out,"COOL")){reply("INVALID_OUTPUT");return;}
  if(!doc["leaseSeconds"].isNull() && !doc["leaseSeconds"].is<unsigned>()){reply("INVALID_LEASE");return;}
  unsigned seconds=doc["leaseSeconds"]|60;
  if(seconds>300){reply("LEASE_RANGE_0_300");return;}
  controller.manual=!strcmp(out,"HEAT")?Output::HEAT:!strcmp(out,"COOL")?Output::COOL:Output::OFF;
  controller.manualAt=now;controller.leaseMs=seconds*1000;
  controller.step(temperature,sensorValid,updating,now);outputs();
  reply("OK");return;
 }
 if(!strcmp(op,"wifi")){
  if(updating){reply("OTA_BUSY");return;}
  JsonArray a=doc["profiles"].as<JsonArray>();bool valid=a.size()>0 && a.size()<=5;
  for(JsonObject p:a){const char *s=p["ssid"]|"",*pw=p["password"]|"";if(!strlen(s)||strlen(s)>32||strlen(pw)>63)valid=false;}
  if(!valid){reply("INVALID_WIFI_PROFILES");return;}
  Message change{};change.size=serializeJson(a,change.data,sizeof(change.data));
  if(xQueueSend(wifiChanges,&change,0)!=pdTRUE)reply("WIFI_BUSY");else reply("WIFI_QUEUED");return;
 }
 if(!strcmp(op,"ota.begin") && m.kind==1){
  if(updating){reply("OTA_BUSY");return;}
  if(!sensorValid||temperature>=40){reply("SENSOR_OR_TEMP_ALARM");return;}
  const char *hash=doc["sha256"]|"";size_t size=doc["size"]|0;
  if(strcmp(doc["board"]|"","esp32dev")||!isHexHash(hash)||size<1024||size>0x1c0000){reply("INVALID_IMAGE_METADATA");return;}
  controller.stop(now);outputs();controller.manual=Output::OFF;controller.leaseMs=0;
  if(!Update.begin(size,U_FLASH)){reply("OTA_BEGIN_FAILED");return;}
  updating=true;otaSize=size;otaReceived=0;otaAt=now;strlcpy(otaHash,hash,sizeof(otaHash));
  mbedtls_sha256_init(&sha);mbedtls_sha256_starts_ret(&sha,0);reply("OTA_READY");return;
 }
 if(!strcmp(op,"ota.end") && m.kind==1 && updating){
  if(otaReceived!=otaSize){reply("INCOMPLETE");return;}
  uint8_t digest[32];char hex[65];mbedtls_sha256_finish_ret(&sha,digest);
  for(int i=0;i<32;i++)snprintf(hex+i*2,3,"%02x",digest[i]);
  if(strcasecmp(hex,otaHash)){abortOta("SHA256_MISMATCH");return;}
  if(!Update.end()){abortOta("INVALID_IMAGE");return;}
  mbedtls_sha256_free(&sha);reply("OTA_OK_RESTART");restartAt=now+1500;return;
 }
 if(!strcmp(op,"ota.abort") && m.kind==1){abortOta("OTA_ABORTED");return;}
 reply("UNKNOWN_OPERATION");
}
static void snapshot(uint32_t now){
 StaticJsonDocument<1536> d;
 d["manualPersistent"]=true;
 d["heaterActiveLow"]=HEATER_ACTIVE_LOW;d["coolerActiveLow"]=COOLER_ACTIVE_LOW;
 d["heaterGpio"]=digitalRead(HEATER_PIN);d["coolerGpio"]=digitalRead(COOLER_PIN);
 d["firmware"]=FW_VERSION;d["bootId"]=bootId;d["uptimeMs"]=now;
 if(sensorValid){d["temperature"]=temperature;d["humidity"]=humidity;}else{d["temperature"]=nullptr;d["humidity"]=nullptr;}
 d["sensorOk"]=sensorValid;d["target"]=controller.target;d["mode"]=controller.automatic?"AUTO":"MANUAL";
 d["heater"]=controller.output==Output::HEAT;d["cooler"]=controller.output==Output::COOL;
 d["alarm"]=controller.alarm;d["bluetooth"]=btOn;d["bluetoothRequested"]=btWanted;d["bleConnected"]=bleConnected.load();d["updating"]=updating;
 d["wifi"]=WiFi.status()==WL_CONNECTED;d["rssi"]=WiFi.RSSI();d["cloud"]=cloudOK.load();
 d["timeValid"]=epochMs()!=0;d["sampledAt"]=epochMs();d["historyPending"]=pendingCount.load();d["historyDropped"]=historyDropped.load();d["storageOk"]=diskOK.load();
 d["lastCommandId"]=lastCommand;d["lastResult"]=cloudResult;d["httpCode"]=lastHttpCode.load();
 char out[1600];serializeJson(d,out,sizeof(out));xSemaphoreTake(stateMutex,portMAX_DELAY);strlcpy(stateJson,out,sizeof(stateJson));xSemaphoreGive(stateMutex);
}
static void recordHistory(uint32_t now,const char *kind){
 static uint32_t sequence=0;History r{};
 snprintf(r.id,sizeof(r.id),"%s-%08lu",bootId,(unsigned long)sequence++);
 StaticJsonDocument<700> d;d["bootId"]=bootId;d["uptimeMs"]=now;d["timeValid"]=epochMs()!=0;
 if(epochMs())d["timestamp"]=epochMs();else d["timestamp"]=nullptr;
 d["event"]=kind;if(sensorValid){d["temperature"]=temperature;d["humidity"]=humidity;}
 d["sensorOk"]=sensorValid;d["target"]=controller.target;d["mode"]=controller.automatic?"AUTO":"MANUAL";
 d["heater"]=controller.output==Output::HEAT;d["cooler"]=controller.output==Output::COOL;d["alarm"]=controller.alarm;
 serializeJson(d,r.json,sizeof(r.json));if(xQueueSend(records,&r,0)!=pdTRUE)historyDropped++;
}
// Only network task owns TLS, Firebase credentials, WiFi profile NVS and LittleFS.
static String wifiSsid[8],wifiPass[8];static int wifiCount=0;
static Preferences netPrefs;
static void loadProfiles(){
 StaticJsonDocument<1200> d;String saved=netPrefs.getString("profiles","");
 if(saved.length() && !deserializeJson(d,saved)){
  for(JsonObject p:d.as<JsonArray>()){if(wifiCount==5)break;wifiSsid[wifiCount]=p["ssid"].as<String>();wifiPass[wifiCount++]=p["password"].as<String>();}
 }
 for(auto &p:WIFI_PROFILES)if(strlen(p.ssid) && strcmp(p.ssid,"ISI_WIFI_1")){
  bool found=false;for(int i=0;i<wifiCount;i++)if(wifiSsid[i]==p.ssid)found=true;
  if(!found && wifiCount<8){wifiSsid[wifiCount]=p.ssid;wifiPass[wifiCount++]=p.password;}
 }
}
static uint64_t slotSeq[HISTORY_SLOTS]={},queueSequence=1;
static String slotPath(unsigned n){return String("/h")+n;}
static void initHistory(){
 // Format only a new, unformatted partition; later mount failures must not erase history.
 bool initialized=netPrefs.getBool("fsinit",false);
 bool mounted=LittleFS.begin(false);
 if(!mounted && !initialized){mounted=LittleFS.format() && LittleFS.begin(false);}
 diskOK=mounted;if(!mounted)return;netPrefs.putBool("fsinit",true);
 LittleFS.remove("/tmp");
 for(unsigned i=0;i<HISTORY_SLOTS;i++){
  File f=LittleFS.open(slotPath(i),"r");if(!f)continue;
  uint64_t seq=0;if(f.size()==sizeof(seq)+sizeof(History) && f.read((uint8_t*)&seq,sizeof(seq))==sizeof(seq) && seq){slotSeq[i]=seq;queueSequence=max(queueSequence,seq+1);pendingCount++;}
  else{f.close();LittleFS.remove(slotPath(i));historyDropped++;}
 }
}
static void saveHistory(const History &r){
 if(!diskOK){historyDropped++;return;}
 unsigned slot=0;bool freeSlot=false;
 for(unsigned i=0;i<HISTORY_SLOTS;i++){if(!slotSeq[i]){slot=i;freeSlot=true;break;}if(slotSeq[i]<slotSeq[slot])slot=i;}
 File f=LittleFS.open("/tmp","w");if(!f){historyDropped++;return;}
 uint64_t seq=queueSequence++;
 bool ok=f.write((uint8_t*)&seq,sizeof(seq))==sizeof(seq) && f.write((const uint8_t*)&r,sizeof(r))==sizeof(r);f.close();
 if(!ok){LittleFS.remove("/tmp");historyDropped++;return;}
 if(!freeSlot){LittleFS.remove(slotPath(slot));historyDropped++;slotSeq[slot]=0;pendingCount--;}
 if(!LittleFS.rename("/tmp",slotPath(slot))){historyDropped++;return;}
 slotSeq[slot]=seq;pendingCount++;
}
static String idToken,refreshToken;static uint32_t tokenAt=0;
class BoundedResponse:public StreamString {
 public:
 size_t write(const uint8_t *buffer,size_t size) override {
  if(length()+size>8192)return 0;
  return StreamString::write(buffer,size);
 }
 size_t write(uint8_t b) override { return write(&b,1); }
};
static int request(const String &url,const char *method,const String &body,String &result,const char *type="application/json"){
 WiFiClientSecure tls;tls.setCACert(TLS_ROOTS);tls.setHandshakeTimeout(6);
 HTTPClient http;http.setConnectTimeout(4000);http.setTimeout(4000);
 if(!http.begin(tls,url)){lastHttpCode=-1;return -1;}
 http.addHeader("Content-Type",type);
 int code=http.sendRequest(method,(uint8_t*)body.c_str(),body.length());
 // Responses are bounded by contract; reject oversized data from a misconfigured database.
 result="";
 if(code>0 && http.getSize()<=8192){
  BoundedResponse sink;
  if(http.writeToStream(&sink)>=0)result=sink;
  else code=-2;
 }else if(code>0)code=-2;
 http.end();lastHttpCode=code;return code;
}
static String formEncode(const String &value){
 String out;out.reserve(value.length()+16);
 const char *hex="0123456789ABCDEF";
 for(size_t i=0;i<value.length();i++){
  unsigned char c=value[i];
  if(isalnum(c)||c=='-'||c=='_'||c=='.'||c=='~')out+=char(c);
  else{out+='%';out+=hex[c>>4];out+=hex[c&15];}
 }
 return out;
}
static bool authenticate(){
 if(idToken.length() && uint32_t(millis()-tokenAt)<3000000)return true;
 String response,body;StaticJsonDocument<4096> d;int code;
 if(refreshToken.length()){
  body="grant_type=refresh_token&refresh_token="+formEncode(refreshToken);
  code=request(String("https://securetoken.googleapis.com/v1/token?key=")+FIREBASE_API_KEY,"POST",body,response,"application/x-www-form-urlencoded");
  if(code==200 && !deserializeJson(d,response)){idToken=d["id_token"].as<String>();refreshToken=d["refresh_token"].as<String>();tokenAt=millis();return idToken.length()>0;}
  refreshToken="";
 }
 body="";d.clear();d["email"]=FIREBASE_DEVICE_EMAIL;d["password"]=FIREBASE_DEVICE_PASSWORD;d["returnSecureToken"]=true;serializeJson(d,body);
 code=request(String("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=")+FIREBASE_API_KEY,"POST",body,response);
 d.clear();if(code!=200 || deserializeJson(d,response))return false;
 idToken=d["idToken"].as<String>();refreshToken=d["refreshToken"].as<String>();tokenAt=millis();return idToken.length()>0;
}
static bool firebase(const String &path,const char *method,const String &body,String &result){
 String url=String(FIREBASE_DATABASE_URL)+"/devices/"+DEVICE_ID+"/"+path+".json?auth="+idToken;
 int code=request(url,method,body,result);if(code==401){idToken="";tokenAt=0;}
 if(code>=200 && code<300){cloudAt=millis();cloudOK=true;return true;}
 cloudOK=false;return false;
}
static void uploadOldest(){
 unsigned slot=HISTORY_SLOTS;for(unsigned i=0;i<HISTORY_SLOTS;i++)if(slotSeq[i] && (slot==HISTORY_SLOTS || slotSeq[i]<slotSeq[slot]))slot=i;
 if(slot==HISTORY_SLOTS)return;
 File f=LittleFS.open(slotPath(slot),"r");History r{};
 if(!f || !f.seek(sizeof(uint64_t)) || f.read((uint8_t*)&r,sizeof(r))!=sizeof(r)){f.close();LittleFS.remove(slotPath(slot));slotSeq[slot]=0;pendingCount--;historyDropped++;return;}f.close();
 r.id[sizeof(r.id)-1]=0;r.json[sizeof(r.json)-1]=0;
 String response;
 if(firebase(String("history/")+r.id,"PUT",r.json,response)){
  // Idempotent PUT: reboot between HTTP success and deletion never duplicates a sample.
  LittleFS.remove(slotPath(slot));slotSeq[slot]=0;pendingCount--;
 }
}
static void networkTask(void*){
 netPrefs.begin("network",false);loadProfiles();initHistory();
 WiFi.persistent(false);WiFi.mode(WIFI_STA);WiFi.setAutoReconnect(false);
 configTime(0,0,"pool.ntp.org","time.google.com","time.cloudflare.com");
 uint32_t attemptAt=millis()-20000,lastPoll=0,lastPublish=0,lastUpload=0,nextAuth=0;
 unsigned profile=0;String offeredCommand="";
 for(;;){
  uint32_t now=millis();History record;
  while(xQueueReceive(records,&record,0)==pdTRUE)saveHistory(record);
  Message change;
  if(xQueueReceive(wifiChanges,&change,0)==pdTRUE){
   netPrefs.putString("profiles",String(change.data));wifiCount=0;loadProfiles();profile=0;WiFi.disconnect();attemptAt=now-20000;
  }
  if(WiFi.status()!=WL_CONNECTED){
   cloudOK=false;
   if(wifiCount && uint32_t(now-attemptAt)>=15000){
    WiFi.disconnect();WiFi.begin(wifiSsid[profile].c_str(),wifiPass[profile].c_str());profile=(profile+1)%wifiCount;attemptAt=now;
   }
   vTaskDelay(pdMS_TO_TICKS(100));continue;
  }
  if(!epochMs() || !strlen(FIREBASE_API_KEY) || !strlen(FIREBASE_DATABASE_URL) || !strlen(FIREBASE_DEVICE_EMAIL)){
   vTaskDelay(pdMS_TO_TICKS(100));continue;
  }
  if((int32_t)(now-nextAuth)<0){vTaskDelay(pdMS_TO_TICKS(100));continue;}
  if(!authenticate()){cloudOK=false;nextAuth=millis()+30000;vTaskDelay(pdMS_TO_TICKS(100));continue;}
  if(uint32_t(now-lastPoll)>=2000){
   lastPoll=now;String response;
   if(firebase("command","GET","",response) && response!="null" && response.length()<1024){
    StaticJsonDocument<1536> d;
    if(!deserializeJson(d,response)){
     String id=d["id"]|"";
     if(id.length() && id!=offeredCommand){Message m{};m.kind=0;m.size=response.length();memcpy(m.data,response.c_str(),m.size);if(xQueueSend(commands,&m,0)==pdTRUE)offeredCommand=id;}
    }
   }
  }
  if(uint32_t(now-lastPublish)>=5000){
   lastPublish=now;char state[1600];xSemaphoreTake(stateMutex,portMAX_DELAY);strlcpy(state,stateJson,sizeof(state));xSemaphoreGive(stateMutex);
   StaticJsonDocument<1800> d;deserializeJson(d,state);d["receivedAt"][".sv"]="timestamp";String body,response;serializeJson(d,body);firebase("reported","PUT",body,response);
  }
  if(uint32_t(now-lastUpload)>=1000){lastUpload=now;uploadOldest();}
  vTaskDelay(pdMS_TO_TICKS(50));
 }
}
static void displayTick(uint32_t now){
 if(!lcd)return;
 if(blinkAt){uint32_t elapsed=now-blinkAt;if(elapsed>=800){lcd->backlight();blinkAt=0;}else if((elapsed/200)%2==0)lcd->noBacklight();else lcd->backlight();}
 if(now<3500){
  centeredLine(0,"maggot by teknobro");
  centeredLine(1,"MEMULAI SISTEM");
  // Six custom glyphs provide a smooth, full-width graphical progress bar.
  unsigned pixels=min(100u,unsigned(now*100/3000));
  uint8_t cells[20];
  for(unsigned i=0;i<20;i++)cells[i]=uint8_t(constrain(int(pixels)-int(i*5),0,5));
  lcdRow(2,cells);
  centeredLine(3,!sensorFound?"SENSOR ERROR":now<1000?"Memeriksa sensor":now<2000?"Memuat pengaturan":now<2800?"Menyiapkan kontrol":"Sistem siap");
  return;
 }
 // Left column: cells 0-9. Right column: cells 10-19.
 // Temperature/setpoint units stay at cell 8; RH unit stays at cell 18.
 char left[16],right[16],message[21];
 if(sensorValid){
  snprintf(left,sizeof(left),"T: %5.1fC",temperature);
  snprintf(right,sizeof(right),"RH:%5.1f%%",humidity);
 }else{
  snprintf(left,sizeof(left),"T:  --.-C");
  snprintf(right,sizeof(right),"RH: --.-%%");
 }
 columnLine(0,left,right);
 snprintf(left,sizeof(left),"SET:%4.1fC",controller.target);
 snprintf(right,sizeof(right),"MODE: %s",controller.automatic?"AUTO":"MAN ");
 columnLine(1,left,right);
 snprintf(left,sizeof(left),"HEAT: %-3s",controller.output==Output::HEAT?"ON":"OFF");
 snprintf(right,sizeof(right),"COOL: %-3s",controller.output==Output::COOL?"ON":"OFF");
 columnLine(2,left,right);
 // Alarms take precedence; retain relay status while an alarm is shown.
 if(updating){
  unsigned percent=unsigned(otaSize?otaReceived*100/otaSize:0);
  snprintf(message,sizeof(message),"UPDATE FW: %3u%%",min(percent,100u));
  centeredLine(3,message);
 }else if(!sensorValid){
  centeredLine(3,"SENSOR ERROR");
 }else if(controller.alarm){
  centeredLine(3,"ALARM SUHU >=40C");
 }else if(btOn){
  centeredLine(3,"BLUETOOTH AKTIF");
  if(!bleConnected){
   snprintf(message,sizeof(message),"PIN PAIRING: %06lu",(unsigned long)passkey);
   centeredLine(2,message);
  }
 }else{
  columnLine(3,WiFi.status()==WL_CONNECTED?"WIFI: OK":"WIFI: --",cloudOK.load()?"CLOUD: OK":"CLOUD: --");
 }
}
void setup(){
 // Set each relay OFF before enabling its GPIO output driver.
 digitalWrite(HEATER_PIN,maggot::relayLevel(false,HEATER_ACTIVE_LOW));
 digitalWrite(COOLER_PIN,maggot::relayLevel(false,COOLER_ACTIVE_LOW));
 pinMode(HEATER_PIN,OUTPUT);
 pinMode(COOLER_PIN,OUTPUT);
 pinMode(HEATER_LED_PIN,OUTPUT);pinMode(COOLER_LED_PIN,OUTPUT);pinMode(WIFI_LED_PIN,OUTPUT);outputs();
 controller.minOffMs=INTERLOCK_MS;
 Serial.begin(115200);snprintf(bootId,sizeof(bootId),"%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
 settings.begin("control",false);float target=settings.getFloat("target",30);if(isfinite(target)&&target>=10&&target<=39)controller.target=target;
 Wire.begin(SDA_PIN,SCL_PIN);Wire.setClock(100000);Wire.setTimeOut(25);
 for(uint8_t address:{uint8_t(0x27),uint8_t(0x3f)}){Wire.beginTransmission(address);if(Wire.endTransmission()==0){lcd=new LiquidCrystal_I2C(address,20,4);lcd->init();lcd->backlight();break;}}
 if(lcd){for(uint8_t level=0;level<=5;level++){uint8_t rows[8];memset(rows,level?uint8_t(0x1f<<(5-level))&0x1f:0,8);lcd->createChar(level,rows);}}
 sensorFound=sensor.begin(0x44) || sensor.begin(0x45);
 stateMutex=xSemaphoreCreateMutex();commands=xQueueCreate(8,sizeof(Message));records=xQueueCreate(12,sizeof(History));wifiChanges=xQueueCreate(1,sizeof(Message));
 if(!stateMutex||!commands||!records||!wifiChanges){Serial.println("FATAL: queue allocation");while(true)delay(1000);}
 lastSample=millis()-SENSOR_MS;
 if(xTaskCreatePinnedToCore(networkTask,"network",16384,nullptr,1,nullptr,0)!=pdPASS){Serial.println("FATAL: network task unavailable");}
 Serial.printf("Maggot %s boot=%s; BLE OFF; heaterActiveLow=%d coolerActiveLow=%d\n",FW_VERSION,bootId,HEATER_ACTIVE_LOW,COOLER_ACTIVE_LOW);
}
void loop(){
 uint32_t now=millis();
 if(restartAt && (int32_t)(now-restartAt)>=0)ESP.restart();
 if(uint32_t(now-lastSample)>=SENSOR_MS){
  lastSample=now;
  if(!sensorFound)sensorFound=sensor.begin(0x44)||sensor.begin(0x45);
  if(sensorFound){temperature=sensor.readTemperature();humidity=sensor.readHumidity();}
  sensorValid=sensorFound && isfinite(temperature)&&isfinite(humidity)&&temperature>=-40&&temperature<=125&&humidity>=0&&humidity<=100;
  if(sensorValid)lastValid=now;else sensorFound=false;
 }
 if(uint32_t(now-lastValid)>SENSOR_STALE_MS)sensorValid=false;
 if(updating && !restartAt && (uint32_t(now-otaAt)>30000 || !sensorValid || temperature>=40))abortOta("OTA_TIMEOUT_OR_SENSOR_ALARM");
 Message message;for(int i=0;!restartAt && i<2 && xQueueReceive(commands,&message,0)==pdTRUE;i++){processingCloud=false;handleMessage(message,now);processingCloud=false;}
 bluetoothTick(now);
 controller.step(temperature,sensorValid,updating,now);
 outputs(); // Reassert GPIO state; no stale applied-state cache after command handling.
 digitalWrite(WIFI_LED_PIN,WiFi.status()==WL_CONNECTED?HIGH:((now/500)%2));
 if(uint32_t(now-cloudAt.load())>15000)cloudOK=false;
 static uint32_t lcdAt=0,stateAt=0,historyAt=0,logAt=0;
 if(uint32_t(now-logAt)>=10000){
  logAt=now;
  Serial.printf("[SYS] T=%.1f RH=%.1f sensor=%d mode=%s out=%u wifi=%d cloud=%d http=%d bt=%d queue=%lu heap=%u time=%d\n",
   temperature,humidity,sensorValid,controller.automatic?"AUTO":"MANUAL",unsigned(controller.output),
   WiFi.status()==WL_CONNECTED,cloudOK.load(),lastHttpCode.load(),btOn,(unsigned long)pendingCount.load(),ESP.getFreeHeap(),epochMs()!=0);
 }
 if(uint32_t(now-lcdAt)>=150){lcdAt=now;displayTick(now);}
 if(uint32_t(now-stateAt)>=1000){stateAt=now;snapshot(now);}
 static int previous=-1;int state=int(controller.output)+4*controller.automatic+8*sensorValid+16*controller.alarm+32*btOn+64*updating;
 if(state!=previous || uint32_t(now-historyAt)>=60000){recordHistory(now,state!=previous?"change":"sample");previous=state;historyAt=now;}
 delay(5); // yield to RTOS, no blocking animation or network request here
}
