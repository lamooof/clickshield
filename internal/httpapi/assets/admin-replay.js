'use strict';
// Full-screen session replay. Uses $, api, esc, fmtDate, toast, state, refreshDashboard from admin.js.
function bindReplay(id){state.replayData=null;for(const b of document.querySelectorAll('[data-watch-replay]'))b.onclick=()=>openReplay(id)}
async function openReplay(id){
  const dialog=$('#replay-dialog'),info=$('#replay-info');
  info.textContent='Загрузка записи…';$('#replay-delete').disabled=true;dialog.dataset.session=id;
  $('#replay-body').innerHTML='<iframe id="replay-frame" title="Запись посещения" src="/assets/replay.html"></iframe>';
  if(!dialog.open)dialog.showModal();
  try{
    const data=await api(`/v1/sessions/${id}/replay`);
    if(!dialog.open||dialog.dataset.session!==id)return;
    if(!data.pages?.length){info.textContent='Запись не доставлена или срок хранения истёк.';$('#replay-body').replaceChildren();return}
    state.replayData=data;sendReplay();
    info.textContent=`Сессия ${id.slice(0,8)} · хранится до ${fmtDate(data.expires_at)}${data.incomplete?' · часть записи не доставлена':''}`;
    $('#replay-delete').disabled=false;$('#replay-delete').onclick=()=>deleteReplay(id);
  }catch(e){info.textContent=e.message}
}
function sendReplay(){const frame=$('#replay-frame'),d=state.replayData;if(frame&&d)frame.contentWindow.postMessage({type:'clickshield:replay',pages:d.pages,incomplete:d.incomplete},'*')}
async function deleteReplay(id){
  if(!confirm('Удалить запись посещения?'))return;
  try{await api(`/v1/sessions/${id}/replay`,{method:'DELETE'});$('#replay-dialog').close();$('#replay-section').innerHTML='<p class="muted">Запись удалена.</p>';document.querySelectorAll('[data-watch-replay]').forEach(b=>b.remove());toast('Запись удалена');await refreshDashboard()}catch(e){toast(e.message,true)}
}
$('#replay-close').onclick=()=>$('#replay-dialog').close();
$('#replay-dialog').addEventListener('close',()=>{state.replayData=null;$('#replay-body').replaceChildren()});
addEventListener('message',e=>{const frame=$('#replay-frame');if(!frame||e.source!==frame.contentWindow)return;if(e.data?.type==='clickshield:replay-ready')sendReplay();if(e.data?.type==='clickshield:replay-error')toast('Ошибка воспроизведения записи',true)});
