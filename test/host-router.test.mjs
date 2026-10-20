import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostRouter, HostUnavailableError, UnknownDeliveryError } from '../src/host-router.mjs';
test('automatic selection chooses first available host', async () => {
 const calls=[];const r=createHostRouter({hosts:['a','b'],isAvailable:async h=>h==='b',invoke:async h=>{calls.push(h);return h}});
 assert.equal(await r.call({name:'ping'}),'b');assert.deepEqual(calls,['b']);
});
test('explicit host never falls back', async () => {
 const calls=[];const r=createHostRouter({hosts:['a','b'],isAvailable:async h=>h==='b',invoke:async h=>{calls.push(h);return h}});
 await assert.rejects(r.call({}, {targetHost:'a'}),HostUnavailableError);assert.deepEqual(calls,[]);
});
test('invocation error does not cause duplicate dispatch', async () => {
 const calls=[];const r=createHostRouter({hosts:['a','b'],isAvailable:async()=>true,invoke:async h=>{calls.push(h);throw new Error('timeout')}});
 await assert.rejects(r.call({}),UnknownDeliveryError);assert.deepEqual(calls,['a']);
});
test('unknown host is rejected', async () => {
 const r=createHostRouter({hosts:['a'],isAvailable:async()=>true,invoke:async()=>true});
 await assert.rejects(r.call({}, {targetHost:'z'}),HostUnavailableError);
});
