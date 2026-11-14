#pragma once
namespace maggot {
constexpr int relayLevel(bool on, bool activeLow) { return (on != activeLow) ? 1 : 0; }
}
