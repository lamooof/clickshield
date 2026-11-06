import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = ['tracker-transport.js','tracker-session.js','tracker.js'].map(name => readFileSync(new URL('../internal/httpapi/assets/'+name,import.meta.url),'utf8')).join('\n');
function tracker({denyStorage=false, fail=false}={}) {
  let time=Date.now(), rejected=fail;
  const requests=[], intervals=[], listeners=new Map(), memory=new Map();
  const listen=(name,fn)=>{const list=listeners.get(name)||[];list.push(fn);listeners.set(name,list)};
  const fire=(name,data={})=>{for(const fn of listeners.get(name)||[])fn({type:name,...data})};
  const storage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)};
  const location={href:'https://site.test/?utm_source=first'};
  const document={currentScript:{src:'https://collector.test/tracker.js?key=pk_test',dataset:{}},baseURI:location.href,referrer:'',cookie:'',hidden:false,
    documentElement:{getAttribute:()=>null,dataset:{},scrollHeight:2000},body:{scrollHeight:2000},addEventListener:listen};
  const context={document,location,URL,URLSearchParams,TextEncoder,Uint8Array,Blob,Intl,console,
    Date:class extends Date {static now(){return time}},crypto:webcrypto,
    navigator:{userAgent:'Test browser',platform:'test',language:'ru',sendBeacon:()=>false},
    screen:{width:1200,height:800,colorDepth:24},innerWidth:1200,innerHeight:800,scrollY:0,
    history:{pushState(){},replaceState(){}},Event:class {constructor(type){this.type=type}},CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail}},
    addEventListener:listen,dispatchEvent:e=>fire(e.type,e),setInterval:fn=>intervals.push(fn),setTimeout:fn=>{queueMicrotask(fn)},
    fetch:async(url,options)=>{
      if(url.includes('/config'))return {ok:true,json:async()=>({replay_enabled:false})};
      requests.push({body:options.body,keepalive:options.keepalive});
      if(rejected)throw new Error('offline');
      return {ok:true,json:async()=>({decision:'ALLOW'})};
    }};
  context.window=context;
  for(const name of ['localStorage','sessionStorage'])Object.defineProperty(context,name,{get(){if(denyStorage)throw new Error('Storage denied');return storage}});
  runInNewContext(source,context);
  return {context,requests,fire,advance(ms){time+=ms;for(const fn of intervals)fn()},online(){rejected=false},batches(){return requests.map(r=>JSON.parse(r.body))}};
}

const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('large UTF-8 event batches drain without blocking later events',async()=>{
  const t=tracker();await settle();t.requests.length=0;
  for(let i=0;i<100;i++)t.context.ClickShield.track('large',{text:'я'.repeat(500),index:i});
  t.context.ClickShield.track('after');await t.context.ClickShield.flush();
  const batches=t.batches(),events=batches.flatMap(b=>b.events).filter(e=>e.type==='business');
  assert.equal(events.length,101);assert.equal(events.at(-1).name,'after');
  assert.equal(new Set(events.slice(0,100).map(e=>e.properties.index)).size,100);
  assert.ok(batches.length>1);
  for(const r of t.requests){assert.ok(Buffer.byteLength(r.body)<=48*1024);assert.notEqual(r.keepalive,true)}
});

test('retry keeps bytes and session identity across inactivity rollover',async()=>{
  const t=tracker();await settle();const old=t.context.ClickShield.sessionId;
  // Make the next request fail, then retain it while a new visit starts.
  const send=t.context.fetch;let offline=true;
  t.context.fetch=async(...args)=>{if(offline){t.requests.push({body:args[1].body});throw new Error('offline')}return send(...args)};
  t.context.ClickShield.track('old');await t.context.ClickShield.flush();const body=t.requests.at(-1).body;
  t.advance(31*60*1000);await settle();t.fire('focus');
  const current=t.context.ClickShield.sessionId;assert.notEqual(current,old);
  offline=false;t.context.ClickShield.track('new');await t.context.ClickShield.flush();
  assert.ok(t.requests.filter(r=>r.body===body).length>=2);
  const events=t.batches();assert.ok(events.some(b=>b.session_id===old&&b.events.some(e=>e.name==='old')));
  assert.ok(events.some(b=>b.session_id===current&&b.events.some(e=>e.name==='new')));
  assert.equal(t.context.document.documentElement.dataset.antifraudDecision,'allow');
});

test('blocked storage still initializes and sends events',async()=>{
  const t=tracker({denyStorage:true});assert.ok(t.context.ClickShield);
  t.context.ClickShield.track('without_storage');await t.context.ClickShield.flush();
  assert.ok(t.batches().some(b=>b.events.some(e=>e.name==='without_storage')));
});

test('idle visit stops sending and real activity starts fresh attribution',async()=>{
  const t=tracker();await settle();const first=t.context.ClickShield.sessionId;
  t.advance(31*60*1000);await settle();const count=t.requests.length;
  t.advance(31*60*1000);await settle();assert.equal(t.requests.length,count);
  t.context.location.href='https://site.test/new?utm_source=second';
  t.context.ClickShield.track('return');await t.context.ClickShield.flush();
  const id=t.context.ClickShield.sessionId;assert.notEqual(id,first);
  const batch=t.batches().find(b=>b.session_id===id);
  assert.equal(batch.utm.source,'second');assert.equal(batch.page_index,1);
  assert.equal(batch.events.filter(e=>e.type==='pageview').length,1);
});

test('beacon rejection retains queued batches for retry',async()=>{
  const t=tracker({fail:true});await settle();t.context.ClickShield.track('saved');
  t.fire('pagehide');t.online();await t.context.ClickShield.flush();
  assert.ok(t.batches().some(b=>b.events.some(e=>e.name==='saved')));
});
