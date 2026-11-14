#include "control.h"
#include "relay.h"
#include "config.h"
#include <cassert>
#include <initializer_list>
using namespace maggot;
int main(){
 static_assert(HEATER_PIN==27 && COOLER_PIN==26,"Wiring: heater D27, cooler D26");
 static_assert(HEATER_ACTIVE_LOW && COOLER_ACTIVE_LOW,"Both relay channels active LOW");
 // Truth table on the actual configured GPIOs: OFF, HEAT, COOL.
 for(Output mode : {Output::OFF,Output::HEAT,Output::COOL}){
  int gpio[28]={};
  gpio[HEATER_PIN]=relayLevel(mode==Output::HEAT,HEATER_ACTIVE_LOW);
  gpio[COOLER_PIN]=relayLevel(mode==Output::COOL,COOLER_ACTIVE_LOW);
  assert(gpio[27]==(mode==Output::HEAT?0:1));
  assert(gpio[26]==(mode==Output::COOL?0:1));
  assert(gpio[26] || gpio[27]);
 }

 assert(relayLevel(false,true)==1);assert(relayLevel(true,true)==0);
 assert(relayLevel(false,false)==0);assert(relayLevel(true,false)==1);
 Controller persistent;persistent.automatic=false;persistent.manual=Output::COOL;persistent.leaseMs=0;
 assert(persistent.step(30,true,false,3000)==Output::COOL);
 assert(persistent.step(30,true,false,3600000)==Output::COOL);
 persistent.manual=Output::OFF;assert(persistent.step(30,true,false,3600001)==Output::OFF);
 persistent.manual=Output::HEAT;assert(persistent.step(30,true,false,3603001)==Output::HEAT);
 assert(persistent.step(30,false,false,3603002)==Output::OFF);
 assert(persistent.manual==Output::OFF);
 assert(persistent.step(30,true,false,3607000)==Output::OFF);
 Controller c;
 assert(c.step(29,true,false,2000)==Output::OFF);
 assert(c.step(29.5,true,false,3000)==Output::HEAT);
 assert(c.step(29.9,true,false,4000)==Output::HEAT);
 assert(c.step(30,true,false,5000)==Output::OFF);
 assert(c.step(31,true,false,7999)==Output::OFF);
 assert(c.step(30.5,true,false,8000)==Output::COOL);
 assert(c.step(30.1,true,false,9000)==Output::COOL);
 assert(c.step(30,true,false,10000)==Output::OFF);
 c.automatic=false; c.manual=Output::HEAT;c.manualAt=11000;c.leaseMs=60000;
 assert(c.step(28,true,false,13000)==Output::HEAT);
 assert(c.step(40,true,false,14000)==Output::OFF);
 assert(c.step(40,true,false,17000)==Output::COOL);
 assert(c.step(40,false,false,18000)==Output::OFF);
 assert(c.step(28,true,true,22000)==Output::OFF);
 assert(c.step(28,true,false,71000)==Output::OFF);
 Controller w;w.offAt=0xfffffff0;
 assert(w.step(29,true,false,0x100)==Output::OFF);
 assert(w.step(29,true,false,0x1000)==Output::HEAT);
 for(int valid=0;valid<2;valid++)for(int ota=0;ota<2;ota++){
  Controller z;z.step(25,valid,ota,5000);
  if(!valid||ota)assert(z.output==Output::OFF);
 }
}
