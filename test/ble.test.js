import test from 'node:test';
import assert from 'node:assert/strict';
import {BleUpdater} from '../src/ble.js';
function firmware(){const b=new Uint8Array(1024);b[0]=0xe9;return new Blob([b]);}
function device(){const b=new BleUpdater(()=>{});b.device={gatt:{connected:true}};b.authorized=true;b.control={writeValueWithResponse:async()=>{}};b.data={};return b;}
test('BLE transfer uses SHA256 metadata, ordered offsets and exact byte count',async()=>{
 const b=device(),decoder=new TextDecoder();let transferred=0,ended=false,meta;
 b.exchange=async(ch,bytes,accept)=>{
  let response;
  if(ch===b.control){const body=JSON.parse(decoder.decode(bytes));if(body.op==='ota.begin'){meta=body;response='OTA_READY';}else{ended=true;response='OTA_OK_RESTART';}}
  else{assert.equal(new DataView(bytes.buffer).getUint32(0,true),transferred);assert(bytes.length<=184);transferred+=bytes.length-4;response='ACK:'+transferred;}
  assert(accept(response));return response;
 };
 let progress=0;await b.upload(firmware(),p=>progress=p);
 assert.equal(transferred,1024);assert.equal(progress,100);assert.equal(meta.sha256.length,64);assert.equal(meta.board,'esp32dev');assert(ended);assert(!b.busy);
});
test('BLE rejects invalid firmware before starting the update',async()=>{const b=device();b.exchange=()=>assert.fail('must not start');await assert.rejects(()=>b.upload(new Blob([new Uint8Array(1024)]),()=>{}));assert(!b.busy);});
test('BLE aborts after transfer failure and clears busy state',async()=>{const b=device();let aborted=false;b.control.writeValueWithResponse=async bytes=>{aborted=JSON.parse(new TextDecoder().decode(bytes)).op==='ota.abort';};b.exchange=async(ch)=>{if(ch===b.control)return 'OTA_READY';throw new Error('Transfer failed');};await assert.rejects(()=>b.upload(firmware(),()=>{}));assert(aborted);assert(!b.busy);});
