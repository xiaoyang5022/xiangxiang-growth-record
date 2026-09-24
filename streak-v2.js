/* Closed-loop streak protection card and visible streak rewards. */
const REVIVE_ITEM_ID='system-revive-card',REVIVE_PRICE=80,REVIVE_CAP=2;
const RECORD_REWARDS=new Map([[7,3],[14,5],[21,8],[30,12],[45,18],[60,25],[100,45]]);
function ensureReviveModel(state){
  state.revive=state.revive&&typeof state.revive==='object'?state.revive:{};
  state.revive.owned=Math.max(0,Math.min(REVIVE_CAP,Number.isFinite(+state.revive.owned)?Math.floor(+state.revive.owned):0));
  state.revive.count=Math.max(0,Number.isFinite(+state.revive.count)?Math.floor(+state.revive.count):0);
  state.revive.protectedDates=[...new Set((Array.isArray(state.revive.protectedDates)?state.revive.protectedDates:[]).filter(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  let item=state.items.find(i=>i.id===REVIVE_ITEM_ID);
  if(!item){state.items.push({id:REVIVE_ITEM_ID,name:'连胜复活卡',price:REVIVE_PRICE,cur:'coin',wish:false,order:-1,kind:'revive',system:true})}
  else Object.assign(item,{name:'连胜复活卡',price:REVIVE_PRICE,cur:'coin',kind:'revive',system:true,order:-1});
  return state;
}
const safetyValidState=validState;
validState=function(x){return ensureReviveModel(safetyValidState(x))};
function streakDates(){return [...new Set([...S.records.filter(r=>r.activity==='breakfast').map(r=>r.date),...S.revive.protectedDates])].sort()}
function statsFromDates(ds){let run=0,max=0,last='',lastRun=0,prev='';for(const d of ds){run=prev&&dateDiff(prev,d)===1?run+1:1;max=Math.max(max,run);prev=d;last=d;lastRun=run}let gap=last?dateDiff(last,D()):0;return {days:ds,last,lastRun,max,gap,cur:gap===0||gap===1?lastRun:0,pending:gap===2?lastRun:0}}
breakfastStats=function(){ensureReviveModel(S);return statsFromDates(streakDates())};
refreshBreak=function(){let x=breakfastStats();S.streak={...S.streak,cur:x.cur,max:x.max,lastDate:x.last,restored:false};S.revive.pending=x.pending};
rebuildStreakAndAwards=function(){
  ensureReviveModel(S);S.records=S.records.filter(r=>r.activity!=='milestone');
  let generated=[],run=0,prev='',highest=0,seen=new Set;
  for(const d of streakDates()){
    run=prev&&dateDiff(prev,d)===1?run+1:1;let rewards=[];
    if(run%7===0)rewards.push(['weekly-'+d,1,'连续满 '+run+' 天']);
    if(run%30===0)rewards.push(['monthly-'+d,2,'连续满 '+run+' 天']);
    if(run>highest)for(const [n,j] of RECORD_REWARDS)if(run===n&&!seen.has(n)){seen.add(n);rewards.push(['record-'+n,j,'突破历史纪录 '+n+' 天'])}
    highest=Math.max(highest,run);
    for(const [key,jade,label] of rewards)generated.push({id:uid(),date:d,activity:'milestone',milestoneKey:key,label:'里程碑奖励：'+label,coin:0,jade,note:'系统自动结算（早餐或复活保护均参与回溯）',createdAt:new Date(d+'T12:00').getTime()});
    prev=d;
  }
  S.records.push(...generated);S.awards=generated.map(r=>r.milestoneKey);refreshBreak();
};
function isoOffset(date,days){let x=new Date(date+'T12:00');x.setDate(x.getDate()+days);return x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0')}
function reviveOpportunity(){let target=isoOffset(D(),-1),days=new Set(streakDates());if(days.has(target))return null;let prior=isoOffset(target,-1);if(!days.has(prior))return null;let run=0,cursor=prior;while(days.has(cursor)){run++;cursor=isoOffset(cursor,-1)}return {date:target,run}}
function rewardAt(day){return (day%7===0?1:0)+(day%30===0?2:0)+(RECORD_REWARDS.get(day)||0)}
function nextReward(cur){for(let d=cur+1;d<=3650;d++)if(rewardAt(d))return {day:d,jade:rewardAt(d)};return null}
const baseRenderDash=renderDash;
renderDash=function(){
  ensureReviveModel(S);baseRenderDash();
  const stats=dashboard.querySelectorAll('.stat');
  if(stats[3])stats[3].innerHTML='<span class="muted">持有复活卡</span><b>'+S.revive.owned+' 张</b><small class="muted">累计使用 '+S.revive.count+' 次</small>';
  const oldNotice=dashboard.querySelector('.notice');if(oldNotice)oldNotice.remove();
  const chance=reviveOpportunity(),progress=dashboard.querySelector('.progress');
  if(chance&&progress){let html=S.revive.owned?`漏打了 ${chance.date} 的早餐，可消耗 1 张复活卡保护此前 ${chance.run} 天连胜。 <button class="secondary tiny" onclick="revive()">立即使用</button>`:`漏打了 ${chance.date} 的早餐。还可补救最近这 1 天，但目前没有复活卡。 <button class="secondary tiny" onclick="go('shop');setTimeout(()=>shopList('coin'),0)">去商店购买</button>`;progress.insertAdjacentHTML('afterend','<div class="notice revive-notice" style="margin-top:12px">'+html+'</div>')}
  const milestones=dashboard.querySelector('.milestones'),next=nextReward(S.streak.cur);
  if(milestones)milestones.insertAdjacentHTML('afterend',`<div class="card reward-guide"><div class="row"><b class="grow">下一份连胜奖励</b><span class="badge">${next.day} 天 · +${next.jade} 玉</span></div><div class="reward-rules"><span>每满 7 天 <b>+1 玉</b></span><span>每满 30 天 <b>额外 +2 玉</b></span></div><details><summary>查看破纪录奖励</summary><div class="reward-list">${[...RECORD_REWARDS].map(([d,j])=>`<span class="${S.awards.includes('record-'+d)?'done':''}">${d} 天<br><b>+${j} 玉</b></span>`).join('')}</div><p class="muted">同一天如果也达到 7 天或 30 天周期奖励，会自动叠加发放。</p></details></div>`);
};
const baseCalendarHtml=calendarHtml;
calendarHtml=function(){let html=baseCalendarHtml();for(const d of S.revive.protectedDates){const day=String(+d.slice(8));html=html.replace(new RegExp(`(<button class="cal-day [^"]*" onclick="openCalendarDate\\('${d}'\\)"><span>)${day}(</span><i>)[^<]*(</i>)`),`$1${day}$2♢$3`)}return html.replace('</div></div>','<span><i class="k-revive"></i>复活保护</span></div></div>')};
const baseShopList=shopList;
shopList=function(cur){
  ensureReviveModel(S);window.currentShop=cur;let b=balance()[cur];coinTab.classList.toggle('active',cur==='coin');jadeTab.classList.toggle('active',cur==='jade');let host=document.getElementById('shopList');
  host.innerHTML=S.items.filter(i=>i.cur===cur).sort((a,b)=>(a.order||0)-(b.order||0)).map(i=>i.kind==='revive'?`<div class="item revive-product"><div class="revive-icon">♢</div><div class="name">连胜复活卡<div class="muted">漏签后保护最近 1 天 · 持有 ${S.revive.owned}/${REVIVE_CAP} 张</div></div><b>${REVIVE_PRICE} 币</b><button class="primary tiny" onclick="redeem('${i.id}')" ${S.revive.owned>=REVIVE_CAP?'disabled':''}>${S.revive.owned>=REVIVE_CAP?'已满':'购买'}</button></div>`:`<div class="item"><button class="wish" onclick="wish('${i.id}')">${i.wish?'★':'☆'}</button><input class="name inline" value="${esc(i.name)}" onchange="editItem('${i.id}','name',this.value)"><input class="price inline" type="number" min="0" value="${i.price}" onchange="editItem('${i.id}','price',this.value)"><span>${cur==='coin'?'币':'玉'}</span><button class="primary tiny" onclick="redeem('${i.id}')">兑换</button><button class="danger tiny" onclick="deleteItem('${i.id}')">×</button></div>`).join('')+`<button class="outline" style="margin-top:12px" onclick="addItem('${cur}')">＋ 新增商品</button>`;
};
const baseEditItem=editItem,baseDeleteItem=deleteItem;
editItem=function(id,k,v){if(id===REVIVE_ITEM_ID)return alert('复活卡是系统商品，名称和价格固定。');baseEditItem(id,k,v)};
deleteItem=function(id){if(id===REVIVE_ITEM_ID)return alert('复活卡是连胜保护的一部分，不能删除。');baseDeleteItem(id)};
const baseSubmitRecord=submitRecord,baseSaveRecord=saveRecord,baseRenderHistory=renderHistory;
function releaseProtection(date){let i=S.revive.protectedDates.indexOf(date);if(i<0)return;S.revive.protectedDates.splice(i,1);if(S.revive.owned<REVIVE_CAP)S.revive.owned++;S.revive.count=Math.max(0,S.revive.count-1)}
function protectionReplaceText(){return S.revive.owned<REVIVE_CAP?'复活卡会退回库存。':'当前库存已满，复活卡无法退回，但累计使用次数会更正。'}
submitRecord=function(id){let date=fdate.value;if(id==='breakfast'&&S.revive.protectedDates.includes(date)){if(!confirm('这一天已使用复活保护。改为真实早餐记录后，'+protectionReplaceText()+'继续？'))return;releaseProtection(date)}baseSubmitRecord(id)};
saveRecord=function(id){let r=S.records.find(x=>x.id===id),date=fdate.value;if(r?.activity==='breakfast'&&S.records.some(x=>x.id!==id&&x.activity==='breakfast'&&x.date===date))return alert('这一天已经有早餐记录了，每天只能保留一次。');if(r?.activity==='breakfast'&&S.revive.protectedDates.includes(date)){if(!confirm('目标日期已有复活保护。改为真实早餐记录后，'+protectionReplaceText()+'继续？'))return;releaseProtection(date)}baseSaveRecord(id)};
renderHistory=function(){baseRenderHistory();let host=document.getElementById('historyRecords'),date=document.getElementById('historyDate')?.value;if(host&&S.revive.protectedDates.includes(date))host.insertAdjacentHTML('afterbegin','<div class="record"><div class="revive-icon">♢</div><div class="name">连胜复活保护<div class="muted">'+date+' · 已消耗 1 张复活卡</div></div></div>')};
redeem=function(id){
  let i=S.items.find(x=>x.id===id);if(!i)return;
  if(i.kind!=='revive'){let b=balance()[i.cur];if(b<i.price)return alert('还差 '+(i.price-b)+' '+(i.cur==='coin'?'相相币':'相相玉'));if(confirm('兑换「'+i.name+'」？')){S.redeems.push({id:uid(),date:D(),itemName:i.name,cur:i.cur,price:i.price,createdAt:Date.now()});save()}return}
  if(S.revive.owned>=REVIVE_CAP)return alert('最多持有 '+REVIVE_CAP+' 张复活卡，使用后再来购买吧。');
  if(balance().coin<REVIVE_PRICE)return alert('还差 '+(REVIVE_PRICE-balance().coin)+' 相相币');
  if(!confirm('花费 '+REVIVE_PRICE+' 相相币购买 1 张连胜复活卡？'))return;
  S.redeems.push({id:uid(),date:D(),itemName:'购买：连胜复活卡',cur:'coin',price:REVIVE_PRICE,createdAt:Date.now()});S.revive.owned++;save();
};
revive=function(){
  let chance=reviveOpportunity();if(!chance)return alert('目前没有可以复活的最近漏签。复活卡只能补救最近漏掉的 1 天。');
  if(S.revive.owned<1)return alert('还没有复活卡，请先到商店购买。');
  if(!confirm('消耗 1 张复活卡，保护 '+chance.date+' 并延续此前 '+chance.run+' 天连胜？'))return;
  S.revive.protectedDates.push(chance.date);S.revive.protectedDates=[...new Set(S.revive.protectedDates)].sort();S.revive.owned--;S.revive.count++;rebuildStreakAndAwards();save();
};
document.head.insertAdjacentHTML('beforeend',`<style>.stat small{display:block;margin-top:2px}.reward-guide{margin-top:10px}.reward-rules{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.reward-rules span{padding:8px 10px;border-radius:11px;background:#f8eee9;color:#806b61}.reward-guide details{border-top:1px solid var(--line);padding-top:10px}.reward-list{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:10px}.reward-list span{text-align:center;padding:8px 3px;border:1px dashed #ddc9bc;border-radius:11px;color:var(--muted);font-size:12px}.reward-list span.done{background:#f4dfe3;color:#9e536a;border-style:solid}.k-revive{background:#9c82b8!important}.revive-icon{width:34px;height:34px;display:grid;place-items:center;border-radius:12px;background:#efe8f7;color:#80659f;font-size:20px}.revive-product button:disabled{opacity:.55;cursor:default}@media(max-width:430px){.reward-list{grid-template-columns:repeat(3,1fr)}}</style>`);
