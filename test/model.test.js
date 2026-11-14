import test from 'node:test';
import assert from 'node:assert/strict';
import {online,commandPayload,csvText,wibRange,acceptCommand,validReading,manualTogglePayload} from '../src/model.js';
const now=1800000000000,report={bootId:'boot-current',receivedAt:now,sensorOk:true,temperature:32.7,humidity:66.9};
test('offline and stale snapshots cannot be treated as live',()=>{assert(online(report,true,now));assert(!online(report,false,now));assert(!online(report,true,now+20001));assert(!online({...report,receivedAt:now+6000},true,now));assert(!online(null,true,now));});
test('commands bind to current boot and expire in 60 seconds',()=>{const cmd=commandPayload('mode',{mode:'MANUAL'},report,now,'cmd1');assert.deepEqual(cmd,{mode:'MANUAL',op:'mode',id:'cmd1',bootId:'boot-current',expiresAt:now+60000});});
test('manual actuator and temperature inputs reject invalid values',()=>{assert.throws(()=>commandPayload('settings',{target:40},report,now,'a'));assert.throws(()=>commandPayload('settings',{target:NaN},report,now,'a'));assert.throws(()=>commandPayload('manual',{output:'BOTH',leaseSeconds:60},report,now,'a'));assert.throws(()=>commandPayload('manual',{output:'HEAT',leaseSeconds:301},report,now,'a'));assert.throws(()=>commandPayload('mode',{mode:'AUTO'},null,now,'a'));});
test('WiFi limits apply to UTF8 bytes, not JS code units',()=>{assert.throws(()=>commandPayload('wifi',{profiles:[{ssid:'あ'.repeat(11),password:''}]},report,now,'a'));assert.throws(()=>commandPayload('wifi',{profiles:[]},report,now,'a'));assert.equal(commandPayload('wifi',{profiles:[{ssid:'WiFi',password:''}]},report,now,'a').profiles.length,1);});
test('mailbox protects active commands from another session',()=>{assert(!acceptCommand({id:'other',expiresAt:now+1000},{},'old',now));assert(acceptCommand({id:'other',expiresAt:now-1},{},'old',now));assert(acceptCommand({id:'acked',expiresAt:now+1000},{},'acked',now));});
test('CSV quotes values, prevents formulas, preserves unknown timestamps',()=>{const csv=csvText([{id:'=formula',mode:'AUTO',timeValid:false,timestamp:null,temperature:-1},{id:'a',timeValid:true,timestamp:now}]);assert(csv.includes('"\'=formula"'));assert(csv.includes('"-1"'));assert(csv.includes('+07:00'));assert(!csv.includes('1970'));});
test('date ranges use WIB and reject invalid order and >31 days',()=>{assert.equal(wibRange('2026-11-13','2026-11-13').start,Date.parse('2026-11-12T17:00:00Z'));assert.throws(()=>wibRange('2026-11-14','2026-11-13'));assert.throws(()=>wibRange('2026-01-01','2026-03-01'));});
test('invalid sensor values never render as a valid measurement',()=>{assert(validReading(report));assert(!validReading({...report,temperature:null}));assert(!validReading({...report,sensorOk:false}));});
test('persistent manual requires explicit firmware capability; OFF works on legacy firmware',()=>{
 assert.throws(()=>commandPayload('manual',{output:'COOL',leaseSeconds:0},report,now,'x'));
 assert.equal(commandPayload('manual',{output:'COOL',leaseSeconds:0},{...report,manualPersistent:true},now,'x').leaseSeconds,0);
 assert.equal(commandPayload('manual',{output:'OFF',leaseSeconds:60},report,now,'x').output,'OFF');
 assert.throws(()=>commandPayload('manual',{output:'HEAT',leaseSeconds:-1},report,now,'x'));
});

test('switches invert acknowledged output rather than local optimistic state',()=>{
 assert.deepEqual(manualTogglePayload({cooler:true},'COOL'),{output:'OFF',leaseSeconds:60});
 assert.deepEqual(manualTogglePayload({heater:false},'HEAT'),{output:'HEAT',leaseSeconds:0});
 assert.throws(()=>manualTogglePayload({},'BOTH'));
});
