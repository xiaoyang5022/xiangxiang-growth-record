/* Durable local outbox, explicit conflict resolution and append-only restore UI. */
const SAFE_KEY = KEY + '-safety-v1';
const copyState = x => structuredClone(x);
// JSONB does not preserve object key order. Derived milestone ids are rebuilt locally.
const canonicalState = x => Array.isArray(x)?x.map(canonicalState):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().filter(k=>!(k==='id'&&x.activity==='milestone')).map(k=>[k,canonicalState(x[k])])):x;
const sameState = (a,b) => JSON.stringify(canonicalState(a)) === JSON.stringify(canonicalState(b));
let safety, durable, conflictRow=null, syncEpoch=0, localRevision=0, connecting=null, storageFault=false;
function validState(x) {
  if(!x || typeof x!=='object') throw Error('备份不是有效的账本');
  for(const key of ['records','items','activities','redeems']) {
    if(!Array.isArray(x[key])) throw Error('备份缺少 '+key);
    const ids=new Set();
    for(const r of x[key]) {
      if(!r || typeof r!=='object' || typeof r.id!=='string' || !/^[\w-]+$/.test(r.id) || ids.has(r.id)) throw Error('记录编号无效或重复');
      ids.add(r.id);
      for(const field of ['coin','jade','price','limit']) if(r[field]!==undefined && (typeof r[field]!=='number'||!Number.isFinite(r[field]))) throw Error('分值或价格无效');
    }
  }
  const dates=new Set();
  for(const r of x.records) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(r.date||'') || !Number.isFinite(Date.parse(r.date))) throw Error('记录日期无效');
    if(r.activity==='breakfast'){if(dates.has(r.date))throw Error('同一天存在重复早餐');dates.add(r.date)}
  }
  if(!x.activities.some(a=>a.id==='breakfast')) throw Error('备份缺少早餐项目');
  const result=copyState(x);
  result.revive=result.revive||{count:0,pending:0};result.awards=result.awards||[];
  result.trash=Array.isArray(result.trash)?result.trash:[];
  result.activities.find(a=>a.id==='breakfast').limit=1;
  result.activities.find(a=>a.id==='breakfast').core=true;
  return result;
}
function persistSafety(next) {
  // One atomic write carries the data AND the pending flag/version.
  localStorage.setItem(SAFE_KEY,JSON.stringify(next));
  safety=next;durable=copyState(next.state);
  // Compatibility mirror is not authoritative once SAFE_KEY exists.
  try{localStorage.setItem(KEY,JSON.stringify(next.state))}catch{}
}
function checkpoint(reason,state=durable) {
  return [{id:uid(),at:new Date().toISOString(),reason,state:copyState(state)},...(safety.backups||[])].slice(0,20);
}
function syncLabel() {
  if(storageFault)return setCloudStatus('本机保存失败，请立即导出备份','pending');
  if(conflictRow)return setCloudStatus('发现两份不同数据，待选择','pending');
  if(!cloudUser)return setCloudStatus(safety.dirty?'本机有待同步内容':'仅本机保存','pending');
  if(safety.owner && safety.owner!==cloudUser.id)return setCloudStatus('账号不同，已暂停同步','pending');
  if(safety.dirty)return setCloudStatus(navigator.onLine?'有修改待同步':'离线保存，联网后重试','pending');
  setCloudStatus(safety.lastSync?'已同步 · '+new Date(safety.lastSync).toLocaleString('zh-CN'):'等待连接',safety.lastSync?'online':'pending');
}
function safetyBoot() {
  try {
    const raw=localStorage.getItem(SAFE_KEY),legacy=localStorage.getItem(KEY);
    safety=raw?JSON.parse(raw):{state:validState(legacy?JSON.parse(legacy):S),owner:null,version:0,dirty:false,unverified:!!legacy,backups:[],lastSync:null};
    if(!Number.isSafeInteger(safety.version)||safety.version<0||!Array.isArray(safety.backups))throw Error('本机同步信息无效');
    S=validState(safety.state);safety.state=copyState(S);durable=copyState(S);
    persistSafety(safety);
  }catch(error){
    storageFault=true;
    // Never overwrite an unreadable primary envelope.
    safety={state:copyState(S),owner:null,version:0,dirty:true,unverified:true,backups:[]};durable=copyState(S);
    alert('本机数据无法安全读取或保存。已暂停云同步，请先导出备份并联系维护者。');
  }
  cloudVersion=safety.version||0;
  rebuildStreakAndAwards();render();syncLabel();initCloud();
}
save = function() {
  if(storageFault){S=copyState(durable);render();alert('本机存储已暂停，本次操作未保存。请先导出备份，再刷新页面。');throw Error('本机存储不可用，未保存本次操作')}
  enforceBreakfastRule();
  try{
    S=validState(S);
    // Capture removed items automatically for records, shop and activity deletion.
    for(const key of ['records','items','activities']) {
      const present=new Set(S[key].map(x=>x.id));
      for(const old of durable[key]) if(!present.has(old.id)&&old.activity!=='milestone') {
        S.trash.push({id:uid(),kind:key,data:copyState(old),deletedAt:new Date().toISOString()});
      }
    }
    persistSafety({...safety,state:copyState(S),dirty:true,backups:checkpoint('修改前')});
    localRevision++;render();queueCloudSave();
  }catch(e){S=copyState(durable);render();alert('保存未完成：'+e.message+'。本次修改已撤回，请导出备份。');throw e}
};
queueCloudSave = function() {
  syncLabel();clearTimeout(cloudTimer);
  if(cloudUser && !conflictRow && !storageFault)cloudTimer=setTimeout(flushCloud,500);
};
function acceptCloud(row) {
  const next=validState(row.state);
  persistSafety({...safety,state:next,version:+row.version,owner:cloudUser.id,dirty:false,unverified:false,lastSync:new Date().toISOString(),backups:checkpoint('云端载入前')});
  cloudVersion=+row.version;S=copyState(next);rebuildStreakAndAwards();render();syncLabel();
}
function flagConflict(row) {conflictRow=row;syncLabel();renderScore();}
async function readRemote() {
  const {data,error}=await SB.from('xiangxiang_state').select('state,version,updated_at').eq('user_id',cloudUser.id).maybeSingle();
  if(error)throw error;return data;
}
pullCloud = async function() {
  if(!cloudUser||storageFault||cloudBusy||conflictRow)return;
  if(safety.owner&&safety.owner!==cloudUser.id){syncLabel();return}
  if(safety.dirty&&!safety.unverified)return flushCloud();
  cloudBusy=true;const epoch=syncEpoch;
  try{
    const row=await readRemote();if(epoch!==syncEpoch)return;
    if(row){
      if(!safety.dirty&&!safety.unverified&&+row.version===safety.version){syncLabel();return}
      if(sameState(row.state,safety.state)){acceptCloud(row)}
      else if(safety.dirty||safety.unverified){flagConflict(row)}
      else acceptCloud(row);
    }else{
      if(safety.version>0){setCloudStatus('云端账本暂缺，已保留本机副本','pending');return}
      persistSafety({...safety,owner:cloudUser.id,dirty:true,unverified:false});
    }
  }catch(e){setCloudStatus('连接失败，本机内容已保留','pending')}
  finally{cloudBusy=false}
  if(safety.dirty&&!safety.unverified&&!conflictRow)queueCloudSave();
};
flushCloud = async function() {
  if(!SB||!cloudUser||cloudBusy||storageFault||conflictRow||!safety.dirty)return;
  if(safety.owner!==cloudUser.id||safety.unverified){syncLabel();return}
  if(!navigator.onLine){syncLabel();return}
  cloudBusy=true;const epoch=syncEpoch, revision=localRevision, sent=copyState(safety.state), expected=safety.version;
  let success=false;
  setCloudStatus('正在同步…','pending');
  try{
    const {data,error}=await SB.rpc('sync_xiangxiang_state',{p_state:sent,p_expected_version:expected});
    if(epoch!==syncEpoch)return;
    if(error){
      if(String(error.message).includes('SYNC_CONFLICT')){
        const row=await readRemote();if(epoch!==syncEpoch)return;
        // Handles a successful upload whose response was lost, without duplicating it.
        if(row&&sameState(row.state,sent)){
          persistSafety({...safety,version:+row.version,dirty:localRevision!==revision,lastSync:new Date().toISOString()});cloudVersion=+row.version;success=true;
        }else if(row)flagConflict(row);
        else throw error;
      }else throw error;
    }else{
      const row=data?.[0];if(!row)throw Error('未收到保存确认');
      persistSafety({...safety,version:+row.version,dirty:localRevision!==revision,lastSync:new Date().toISOString()});cloudVersion=+row.version;success=true;
    }
  }catch(e){setCloudStatus('未同步成功，本机内容已保留','pending')}
  finally{cloudBusy=false}
  if(success){syncLabel();if(safety.dirty)queueCloudSave()}
};
applyCloud = function(row) {
  if(!row?.state||cloudBusy||storageFault||!cloudUser||safety.owner!==cloudUser.id)return;
  if(+row.version<=safety.version)return;
  if(safety.dirty||safety.unverified){flagConflict(row);return}
  // Don't replace form contents while the user is typing; next foreground sync pulls it.
  if(['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;
  try{acceptCloud(row)}catch{setCloudStatus('云端数据校验失败，本机副本已保留','pending')}
};
connectCloud = async function(user) {
  if(connecting)return connecting;
  connecting=(async()=>{
    cloudUser=user;syncEpoch++;
    if(storageFault){syncLabel();return}
    if(safety.owner&&safety.owner!==user.id){render();syncLabel();return}
    if(!safety.owner)persistSafety({...safety,owner:user.id});
    if(cloudChannel)await SB.removeChannel(cloudChannel);
    cloudChannel=SB.channel('xiangxiang-safe-'+user.id).on('postgres_changes',{event:'*',schema:'public',table:'xiangxiang_state',filter:'user_id=eq.'+user.id},p=>applyCloud(p.new)).subscribe();
    await pullCloud();render();syncLabel();
  })();
  try{await connecting}finally{connecting=null}
};
initCloud = async function() {
  if(!SB){setCloudStatus('暂时无法连接，本机内容已保留','pending');return}
  try{const {data,error}=await SB.auth.getSession();if(error)throw error;if(data.session?.user)await connectCloud(data.session.user)}catch{setCloudStatus('登录连接暂不可用，本机内容已保留','pending')}
};
cloudLogout = async function() {
  if(cloudBusy)return alert('正在同步，请稍后退出。');
  if(safety.dirty&&!confirm('还有未同步修改。退出后将保留在这台手机，重新登录同一账号后继续同步。确定退出？'))return;
  syncEpoch++;clearTimeout(cloudTimer);
  const {error}=await SB.auth.signOut({scope:'local'});if(error)return alert('退出失败，请稍后重试');
  if(cloudChannel)await SB.removeChannel(cloudChannel);cloudChannel=null;cloudUser=null;conflictRow=null;recoveryMode=false;render();syncLabel();
};
function downloadState(state,label='备份') {
  const url=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='相相-'+label+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
exportData=()=>downloadState(S);
function reviewConflict(){
  if(!conflictRow)return alert('暂无待处理冲突');
  open(`<h2>选择要继续使用的账本</h2><p>本机 ${S.records.filter(r=>r.activity!=='milestone').length} 条记录；云端 ${conflictRow.state.records.filter(r=>r.activity!=='milestone').length} 条记录。两份都可以先下载查看。</p><p class="muted">选择前会保存本机副本；云端旧版本仍可在历史版本找回。</p><div class="actions"><button class="outline" onclick="exportData()">下载本机副本</button><button class="outline" onclick="downloadState(conflictRow.state,'云端副本')">下载云端副本</button><button class="primary" onclick="resolveConflict('remote')">使用云端版本</button><button class="secondary" onclick="resolveConflict('local')">使用本机版本</button><button class="outline" onclick="close()">稍后处理</button></div>`);
}
async function resolveConflict(choice){
  if(!conflictRow||cloudBusy)return;
  if(choice==='local'&&!confirm('将用本机账本替换云端当前账本。云端旧版仍保存在历史版本中。确定？'))return;
  const row=conflictRow;
  try{
    if(choice==='remote'){acceptCloud(row);conflictRow=null}
    else {persistSafety({...safety,version:+row.version,unverified:false,dirty:true,backups:checkpoint('选择本机版本前')});cloudVersion=+row.version;conflictRow=null}
    close();render();syncLabel();if(safety.dirty)await flushCloud();
  }catch(e){alert('未能安全保存选择：'+e.message)}
}
function replaceSafely(x,reason){
  if(cloudBusy||conflictRow)return alert('请先完成同步或处理冲突，再恢复数据。');
  const next=validState(x);if(!confirm(reason+'将替换当前账本，并自动保留替换前的本机副本。继续？'))return;
  persistSafety({...safety,backups:checkpoint(reason+'前')});S=next;rebuildStreakAndAwards();save();close();
}
importData = function(el){
  const f=el.files[0];if(!f)return;if(f.size>5*1024*1024)return alert('备份文件超过 5MB，请联系维护者协助导入');
  const reader=new FileReader();reader.onload=()=>{try{replaceSafely(JSON.parse(reader.result),'导入备份')}catch(e){alert('导入未完成：'+e.message)}};reader.onerror=()=>alert('无法读取文件');reader.readAsText(f);
};
let historyRows=[],historyPage=0;
async function showCloudHistory(page=0){
  if(!cloudUser)return alert('请先登录云同步');
  try{
    const user=cloudUser.id;
    const {data,error}=await SB.from('xiangxiang_history').select('id,version,captured_at,reason').eq('user_id',user).order('captured_at',{ascending:false}).order('id',{ascending:false}).range(page*20,page*20+19);
    if(error)throw error;if(cloudUser?.id!==user)return;
    historyRows=data;historyPage=page;
    open(`<h2>云端历史版本</h2><p class="muted">每次成功保存都会留下一份版本，至少保留30天。从此次升级开始积累。恢复前也会保留当前版本。</p>${data.map((r,i)=>`<div class="record"><div class="grow">${esc(new Date(r.captured_at).toLocaleString('zh-CN'))}<br><small>版本 ${r.version}</small></div><button class="outline tiny" onclick="cloudHistoryAction(${i},false)">下载</button><button class="secondary tiny" onclick="cloudHistoryAction(${i},true)">恢复</button></div>`).join('')||'<p>暂无历史版本</p>'}<div class="actions">${page?'<button class="outline" onclick="showCloudHistory(historyPage-1)">上一页</button>':''}${data.length===20?'<button class="outline" onclick="showCloudHistory(historyPage+1)">下一页</button>':''}<button class="outline" onclick="close()">关闭</button></div>`);
  }catch{alert('暂时无法读取历史版本，请联网后重试')}
}
async function cloudHistoryAction(index,restore){
  const row=historyRows[index],user=cloudUser?.id;if(!row||!user)return;
  try{const {data,error}=await SB.from('xiangxiang_history').select('state').eq('user_id',user).eq('id',row.id).single();if(error)throw error;if(cloudUser?.id!==user)return;if(restore)replaceSafely(data.state,'恢复云端版本');else downloadState(data.state,'历史版本-'+row.version)}catch(e){alert('操作未完成：'+e.message)}
}
function showLocalBackups(){open(`<h2>本机恢复副本</h2><p class="muted">保留最近20份修改前副本。清除网站数据会一并清除，建议下载到手机文件或个人网盘。</p>${safety.backups.map((b,i)=>`<div class="record"><div class="grow">${esc(new Date(b.at).toLocaleString('zh-CN'))}<br>${esc(b.reason)}</div><button class="outline tiny" onclick="downloadState(safety.backups[${i}].state,'本机副本')">下载</button><button class="secondary tiny" onclick="replaceSafely(safety.backups[${i}].state,'恢复本机副本')">恢复</button></div>`).join('')||'<p>暂无副本</p>'}<button class="outline" onclick="close()">关闭</button>`)}
function showTrash(){open(`<h2>回收站</h2><p class="muted">恢复删除的记录、商品和项目。导入或整本恢复造成的大量变更也可用历史版本撤回。</p>${(S.trash||[]).map((t,i)=>`<div class="record"><div class="grow">${esc(t.data?.label||t.data?.name||'已删除内容')}<br><small>${esc(new Date(t.deletedAt).toLocaleString('zh-CN'))}</small></div><button class="secondary tiny" onclick="restoreTrash(${i})">恢复</button></div>`).join('')||'<p>回收站是空的</p>'}<button class="outline" onclick="close()">关闭</button>`)}
function restoreTrash(index){
  const t=S.trash?.[index];if(!t||!['records','items','activities'].includes(t.kind))return;
  if(S[t.kind].some(x=>x.id===t.data.id))return alert('当前账本已有同编号内容，请先查看历史版本');
  if(t.kind==='records'&&t.data.activity==='breakfast'&&S.records.some(r=>r.activity==='breakfast'&&r.date===t.data.date))return alert('当天已有早餐，不能重复恢复');
  const next=copyState(S);next[t.kind].push(t.data);next.trash.splice(index,1);
  try{S=validState(next);rebuildStreakAndAwards();save();showTrash()}catch(e){alert('恢复未完成：'+e.message)}
}
const originalRenderScore=renderScore;
renderScore=function(){
  originalRenderScore();
  const settings=document.querySelector('#score .settings');if(!settings||!safety)return;
  const backupDetails=[...settings.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='数据备份与恢复');
  if(backupDetails)backupDetails.innerHTML=`<summary>数据保护与恢复</summary><p class="muted">云端历史版本用于撤回误操作；独立下载的备份还能防止云端项目意外丢失。请每周导出一次。</p><div class="actions"><button class="secondary" onclick="showCloudHistory()">云端历史版本</button><button class="secondary" onclick="showTrash()">回收站</button><button class="outline" onclick="showLocalBackups()">本机恢复副本</button><button class="outline" onclick="exportData()">导出备份</button><label class="outline" style="margin:0;cursor:pointer">导入备份<input type="file" accept="application/json" onchange="importData(this)" hidden></label></div>`;
  if(conflictRow)settings.insertAdjacentHTML('afterbegin','<div class="notice">本机与云端有不同内容，自动同步已暂停。<button class="secondary" onclick="reviewConflict()">查看并选择</button></div>');
  if(safety.owner&&cloudUser&&safety.owner!==cloudUser.id)settings.insertAdjacentHTML('afterbegin','<div class="notice">本机账本属于另一账号。请先导出备份，再退出并登录原账号，避免混入其他人的数据。</div>');
  syncLabel();
};
window.addEventListener('online',()=>pullCloud());
window.addEventListener('offline',syncLabel);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')pullCloud()});
window.addEventListener('beforeunload',event=>{if(safety?.dirty){event.preventDefault();event.returnValue=''}});
// A second browser tab must not silently overwrite this tab's durable edits.
window.addEventListener('storage',event=>{if(event.key===SAFE_KEY){storageFault=true;syncEpoch++;clearTimeout(cloudTimer);setCloudStatus('另一窗口更新了账本，请导出当前副本后刷新','pending')}});
setInterval(()=>{if(cloudUser&&!conflictRow&&navigator.onLine)pullCloud()},30000);
