#pragma once
#include <stdint.h>
#include <math.h>
namespace maggot {
enum class Output : uint8_t { OFF, HEAT, COOL };
struct Controller {
  float target=30, hysteresis=0.5f;
  Output output=Output::OFF, manual=Output::OFF;
  bool automatic=true;
  uint32_t offAt=0, manualAt=0, leaseMs=0, minOffMs=3000;
  bool alarm=false;
  void stop(uint32_t now) { if(output!=Output::OFF) offAt=now; output=Output::OFF; }
  Output step(float t, bool valid, bool updating, uint32_t now) {
    alarm=valid && t>=40;
    if(!valid || updating) { manual=Output::OFF; stop(now); return output; }
    Output want=Output::OFF;
    if(alarm) want=Output::COOL;
    else if(!automatic) {
      if(leaseMs==0 || uint32_t(now-manualAt)<leaseMs) want=manual;
      else manual=Output::OFF;
    } else if(output==Output::HEAT && t<target) want=Output::HEAT;
    else if(output==Output::COOL && t>target) want=Output::COOL;
    else if(t<=target-hysteresis) want=Output::HEAT;
    else if(t>=target+hysteresis) want=Output::COOL;
    if(want!=output) {
      if(output!=Output::OFF) stop(now); // always break before make
      else if(want!=Output::OFF && uint32_t(now-offAt)>=minOffMs) output=want;
    }
    return output;
  }
};
}
