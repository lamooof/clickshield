import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../internal/httpapi/assets/replay-recorder.js',import.meta.url),'utf8');
test('replay stops old capture and starts a fresh recording for the next visit',async()=>{
  const captures=[],requests=[],listeners=new Map(),timers=new Set();
  const on=(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn)};
  const off=(name,fn)=>listeners.get(name)?.delete(fn);
  const timer=fn=>{timers.add(fn);return fn};
  const context={TextEncoder,Blob,crypto:{randomUUID},btoa:value=>Buffer.from(value,'binary').toString('base64'),
    location:{href:'https://site.test/'},document:{hidden:false,addEventListener:on,removeEventListener:off},
    navigator:{sendBeacon:()=>true},CustomEvent:class {},dispatchEvent(){},addEventListener:on,removeEventListener:off,
    setInterval:timer,clearInterval:id=>timers.delete(id),setTimeout:timer,clearTimeout:id=>timers.delete(id),
    fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true}},
    rrwebRecord:options=>{const capture={emit:options.emit,stopped:false};captures.push(capture);capture.emit({type:2,timestamp:Date.now(),data:{}});return ()=>{capture.stopped=true}}};
  context.window=context;runInNewContext(source,context);
  const config=id=>({apiBase:'https://collector.test',key:'pk_test',sessionId:id,visitorId:randomUUID(),pageIndex:()=>1,safeURL:v=>v});
  const first=randomUUID(),second=randomUUID();
  await context.ClickShieldReplay.start(config(first));
  captures[0].emit({type:3,timestamp:Date.now(),data:{}});
  context.ClickShieldReplay.stop();
  assert.ok(captures[0].stopped);assert.equal(listeners.get('pagehide').size,0);
  await context.ClickShieldReplay.start(config(second));
  captures[0].emit({type:3,timestamp:Date.now(),data:{}}); // Late callback from old recorder.
  captures[1].emit({type:3,timestamp:Date.now(),data:{}});
  context.ClickShieldReplay.stop();await new Promise(resolve=>setImmediate(resolve));
  for(const fn of [...timers])fn();
  assert.equal(captures.length,2);assert.ok(captures.every(c=>c.stopped));
  for(const id of [first,second]){
    const chunks=requests.filter(r=>r.session_id===id);
    assert.deepEqual(chunks.map(c=>c.sequence),[0,1]);
    assert.equal(chunks[0].page_id,chunks[1].page_id);
  }
  assert.notEqual(requests.find(r=>r.session_id===first).page_id,requests.find(r=>r.session_id===second).page_id);
  assert.equal(timers.size,0);assert.equal(listeners.get('visibilitychange').size,0);
});
