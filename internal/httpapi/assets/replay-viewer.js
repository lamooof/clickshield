(() => {
 'use strict';let player=null,total=0,playing=false,width=900,height=600,marks=[];
 const $=id=>document.getElementById(id);
 const format=ms=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`;
 function scale(){const v=$('viewport'),p=$('player');const k=Math.min(v.clientWidth/width,v.clientHeight/height);p.style.transform=`scale(${k})`;p.style.left=`${Math.max(0,(v.clientWidth-width*k)/2)}px`;p.style.top=`${Math.max(0,(v.clientHeight-height*k)/2)}px`}
 function pause(){player?.pause();playing=false;$('play').textContent='Воспроизвести'}
 function pageLabel(ms){const i=marks.findLastIndex(m=>m.offset<=ms),m=marks[Math.max(0,i)];$('page-label').textContent=m?`Страница ${Math.max(0,i)+1} из ${marks.length} · ${m.url}`:''}
 function update(){if(!player)return;const ms=Math.max(0,Math.min(total,player.getCurrentTime()));$('seek').value=ms;$('time').textContent=`${format(ms)} / ${format(total)}`;pageLabel(ms);if(playing&&ms>=total)pause()}
 function drawMarks(){$('marks').replaceChildren(...marks.slice(1).map(m=>{const s=document.createElement('span');s.style.left=`${total?m.offset/total*100:0}%`;s.title=m.url;return s}))}
 $('play').onclick=()=>{if(!player)return;if(playing){pause();return}let at=Number($('seek').value);if(at>=total)at=0;player.play(at);playing=true;$('play').textContent='Пауза'};
 $('seek').oninput=()=>{if(!player)return;const at=Number($('seek').value);if(playing)player.play(at);else player.pause(at);update()};
 $('speed').onchange=()=>player?.setConfig({speed:Number($('speed').value)});
 $('skip').onchange=()=>player?.setConfig({skipInactive:$('skip').checked});
 setInterval(update,200);addEventListener('resize',scale);
 addEventListener('message',e=>{
  if(e.source!==parent||e.data?.type!=='clickshield:replay')return;
  try{pause();player?.destroy();$('player').replaceChildren();player=null;$('play').disabled=true;
   const t=window.ReplayTimeline.merge(e.data.pages);if(!t.events.length){$('message').textContent='Нет полного снимка страницы. Запись неполная.';return}
   marks=t.marks;const meta=t.events.find(x=>x.type===4)?.data;width=Math.max(1,Number(meta?.width)||900);height=Math.max(1,Number(meta?.height)||600);
   player=new window.rrwebReplay.Replayer(t.events,{root:$('player'),speed:Number($('speed').value),skipInactive:$('skip').checked,UNSAFE_replayCanvas:false,showWarning:false});
   player.on('resize',size=>{width=Math.max(1,size.width);height=Math.max(1,size.height);scale()});
   player.pause(0);total=player.getMetaData().totalTime;$('seek').max=total;$('seek').value=0;$('play').disabled=false;drawMarks();scale();update();
   const notes=[e.data.incomplete&&'часть событий не доставлена',t.skipped&&`пропущено страниц: ${t.skipped}`].filter(Boolean);
   $('message').textContent=notes.length?`Запись неполная: ${notes.join(', ')}`:`Страниц: ${marks.length}`;
  }catch(err){$('message').textContent='Не удалось воспроизвести эту запись.';parent.postMessage({type:'clickshield:replay-error',message:String(err)},'*')}
 });parent.postMessage({type:'clickshield:replay-ready'},'*');
})();
