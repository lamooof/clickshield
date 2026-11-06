(() => {
  'use strict';
  const loadScript = src => new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=src;el.async=true;el.onload=resolve;el.onerror=reject;document.head.append(el)});
  const redact=text=>String(text).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[email]').replace(/(?:\+?\d[\d\s().-]{8,}\d)/g,'[number]');
  function sanitize(event,safeURL){
    // Masking happens in rrweb before emit. Also remove URL credentials, form
    // targets, handlers and common personal identifiers from serialized nodes.
    const walk=value=>{
      if(!value||typeof value!=='object')return;
      if(value.attributes){for(const name of Object.keys(value.attributes)){
        if(/^on/i.test(name)||/^data-/i.test(name)||['value','action','srcdoc','data','nonce','integrity'].includes(name))delete value.attributes[name];
        else if(['href','src','poster','xlink:href'].includes(name)){
          const raw=String(value.attributes[name]||'');
          if(raw.startsWith('data:')){delete value.attributes[name];continue}
          value.attributes[name]=safeURL(raw);
        } else if(typeof value.attributes[name]==='string' && ['title','alt','aria-label','aria-description','placeholder','label'].includes(name)) value.attributes[name]=redact(value.attributes[name]);
      }}
      if(typeof value.textContent==='string'&&value.tagName!=='style')value.textContent=redact(value.textContent);
      // rrweb incremental text mutations use {id, value}, rather than the
      // textContent field used by full snapshots. Geometry attributes must
      // remain intact: SVG paths and points also contain long digit sequences.
      if(typeof value.id==='number'&&typeof value.value==='string')value.value=redact(value.value);
      if(typeof value.href==='string')value.href=safeURL(value.href);
      for(const [name,child] of Object.entries(value)){if(name==='attributes')continue;if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child)}
    };walk(event);return event;
  }
  let activeStop = null;
  window.ClickShieldReplay={stop(){activeStop?.()},async start(cfg){
    activeStop?.();
    let cancelled = false;
    activeStop = () => { cancelled = true; };
    if (!window.rrwebRecord) await loadScript(`${cfg.apiBase}/assets/rrweb-record.js`);
    if (cancelled) return;
    const record=window.rrwebRecord?.record||window.rrwebRecord;
    if(typeof record!=='function')return;
    const pageID=crypto.randomUUID();let sequence=0,events=[],pending=[],sending=false,stopped=false,stopRecording;
    const base={session_id:cfg.sessionId,visitor_id:cfg.visitorId,page_id:pageID};
    let queuedBytes=0;const MAX_QUEUE=8*1024*1024;
    const status=value=>dispatchEvent(new CustomEvent('clickshield:replay-status',{detail:{status:value}}));
    const encode=bytes=>{let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value)};
    const prepare=()=>{
      if(!events.length)return;const group=events;events=[];
      const raw=new TextEncoder().encode(JSON.stringify(group));if(raw.length>MAX_QUEUE||queuedBytes+raw.length>MAX_QUEUE){stop();status('size_limit');return}
      const seq=sequence++,parts=Math.ceil(raw.length/131072);queuedBytes+=raw.length;
      const meta={...base,page_index:cfg.pageIndex(),page_url:cfg.safeURL(location.href),sequence:seq,part_count:parts,started_at:group[0].timestamp,ended_at:group[group.length-1].timestamp};
      for(let i=0;i<parts;i++){const bytes=raw.subarray(i*131072,(i+1)*131072);pending.push({body:JSON.stringify({...meta,part_index:i,data:encode(bytes)}),bytes:bytes.length,attempts:0})}
    };
    const endpoint=`${cfg.apiBase}/v1/replay?key=${encodeURIComponent(cfg.key)}`;
    async function send(){
      if(sending||!pending.length)return;sending=true;
      try{while(pending.length){const part=pending[0];const r=await fetch(endpoint,{method:'POST',mode:'cors',credentials:'omit',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:part.body});
        if(r.ok){pending.shift();queuedBytes-=part.bytes;continue}
        if([403,413,422].includes(r.status)){stop();pending=[];queuedBytes=0;status(r.status===413?'size_limit':'unavailable');break}
        part.attempts++;if(part.attempts>10){stop();pending=[];queuedBytes=0;status('upload_failed')}break;
      }}catch(_){status('retrying')}finally{sending=false}
    }
    function stop(){if(stopped)return;stopped=true;try{stopRecording?.()}catch(_){}}
    stopRecording=record({
      emit(event){try{if(stopped)return;events.push(sanitize(event,cfg.safeURL));if(events.length>=100){prepare();send()}}catch(_){stop();status('recording_failed')}},
      maskAllInputs:true,maskInputOptions:{password:true,email:true,tel:true},
      blockSelector:'iframe, object, embed, script, [contenteditable], [data-cs-private], [data-private], .rr-block, .cs-private',
      maskTextSelector:'.rr-mask, .personal-data, [data-cs-mask]',
      recordCanvas:false,recordCrossOriginIframes:false,inlineImages:false,
      checkoutEveryNms:60000,sampling:{mousemove:100,scroll:150,input:'last'},
      errorHandler(){return true}
    });
    status('recording');
    const timer=setInterval(()=>{prepare();send();if(stopped&&!pending.length)clearInterval(timer)},5000);
    const onVisibility = () => {if(document.hidden){prepare();send()}};
    document.addEventListener('visibilitychange',onVisibility);
    const onPageHide = () => {
      prepare();
      // Beacon has a shared ~64 KiB browser budget. Larger parts have already
      // been sent while the page was active and remain visibly incomplete on loss.
      let budget=60000;
      for(const p of pending){const size=new TextEncoder().encode(p.body).length;if(size>budget)break;if(!navigator.sendBeacon?.(endpoint,new Blob([p.body],{type:'text/plain;charset=UTF-8'})))break;budget-=size}
      finish();
    };
    addEventListener('pagehide',onPageHide,{capture:true});
    const durationTimer=setTimeout(()=>{finish();status('duration_limit')},60*60*1000);
    function finish(){
      prepare();stop();send();clearTimeout(durationTimer);
      document.removeEventListener('visibilitychange',onVisibility);
      removeEventListener('pagehide',onPageHide,{capture:true});
      if(activeStop===finish)activeStop=null;
      if(!pending.length)clearInterval(timer);
    }
    activeStop=finish;
    prepare();send();
    return finish;
  }};
})();
