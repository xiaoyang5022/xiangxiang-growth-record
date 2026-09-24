/* Growth journal v3: flexible weekly participation, gentle milestones, no streak pressure. */
const GROWTH_VERSION=3,GROWTH_DEFAULT_TARGET=3;
const GROWTH_CATEGORY_RULES={breakfast:{name:'早餐记录',rewards:[[10,1],[30,2],[60,3]]},share:{name:'分享照片/视频',rewards:[[10,1],[30,2],[60,3]]},task:{name:'完成小任务',rewards:[[10,1],[30,2],[60,3]]}};
let growthMigrationChanged=false;
function growthIso(date){return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0')}
function growthShift(date,days){let x=new Date(date+'T12:00');x.setDate(x.getDate()+days);return growthIso(x)}
function growthWeekStart(date){let x=new Date(date+'T12:00'),offset=(x.getDay()+6)%7;x.setDate(x.getDate()-offset);return growthIso(x)}
function growthIsUserRecord(r){return r&&r.activity!=='milestone'&&r.activity!=='system-refund'&&((+r.coin||0)>0||(+r.jade||0)>0)}
function growthRecords(){return S.records.filter(growthIsUserRecord)}
function growthWeekInfo(date=D()){
  const start=growthWeekStart(date),end=growthShift(start,6),rows=growthRecords().filter(r=>r.date>=start&&r.date<=end);
  return {start,end,rows,days:[...new Set(rows.map(r=>r.date))].sort()};
}
function ensureGrowthV3(state){
  let changed=false;
  state.growth=state.growth&&typeof state.growth==='object'?state.growth:{};
  if(!Number.isInteger(+state.growth.target)||+state.growth.target<2||+state.growth.target>5){state.growth.target=GROWTH_DEFAULT_TARGET;changed=true}else state.growth.target=+state.growth.target;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(state.growth.startDate||'')){state.growth.startDate=D();changed=true}
  state.growth.version=GROWTH_VERSION;
  const systemItem=state.items.find(i=>i.id==='system-revive-card');
  if(systemItem){state.items=state.items.filter(i=>i.id!=='system-revive-card');changed=true}
  state.revive=state.revive&&typeof state.revive==='object'?state.revive:{count:0,pending:0};
  const owned=Math.max(0,Math.floor(+state.revive.owned||0));
  if(owned){
    if(!state.records.some(r=>r.id==='growth-v3-revive-refund'))state.records.push({id:'growth-v3-revive-refund',date:D(),activity:'system-refund',label:'复活卡下架退款',coin:owned*80,jade:0,note:'未使用复活卡按每张 80 相相币退回',createdAt:Date.now()});
    state.revive.owned=0;changed=true;
  }
  if(!state.growthV3Migrated){
    const share=state.activities.find(a=>a.id==='share');
    if(share&&share.name==='分享照片/视频'&&+share.coin===2){share.coin=3;changed=true}
    const priceUpgrades=[['一杯奶茶','coin',30,35],['甜品下午茶','coin',40,45],['一顿外卖','coin',60,70],['小饰品','coin',100,100],['两张电影票','coin',120,140],['大牌口红','jade',3,10],['进阶化妆品','jade',5,15],['一双鞋','jade',8,20],['一条裙子','jade',10,25],['周边游','jade',25,60]];
    for(const [name,cur,oldPrice,newPrice] of priceUpgrades){let item=state.items.find(i=>i.name===name&&i.cur===cur&&+i.price===oldPrice);if(item&&oldPrice!==newPrice){item.price=newPrice;changed=true}}
    state.growthV3Migrated=true;changed=true;
  }
  if(changed)growthMigrationChanged=true;
  return state;
}
const growthBaseValidState=validState;
validState=function(x){return ensureGrowthV3(growthBaseValidState(x))};

function growthAward(id,date,key,label,jade,note){return {id,date,activity:'milestone',milestoneKey:key,label,coin:0,jade,note,createdAt:new Date(date+'T12:00').getTime()}}
rebuildStreakAndAwards=function(){
  ensureGrowthV3(S);
  const preserved=S.records.filter(r=>r.activity!=='milestone'||!String(r.milestoneKey||'').startsWith('growth-'));
  const source=preserved.filter(growthIsUserRecord),generated=[],target=S.growth.target,start=S.growth.startDate;
  const weeks=new Map();
  for(const r of source){if(r.date<start)continue;let key=growthWeekStart(r.date);if(!weeks.has(key))weeks.set(key,new Set);weeks.get(key).add(r.date)}
  const achieved=[];
  for(const [week,datesSet] of [...weeks].sort(([a],[b])=>a.localeCompare(b))){let dates=[...datesSet].sort();if(dates.length<target)continue;let date=dates[target-1];achieved.push({week,date});generated.push(growthAward('v3-week-'+week,date,'growth-weekly-'+week,'每周成长奖励：活跃 '+target+' 天',1,'本周任意 '+target+' 天留下正向记录，自动获得'))}
  const months=new Map();
  for(const a of achieved){let month=a.date.slice(0,7);if(!months.has(month))months.set(month,[]);months.get(month).push(a)}
  for(const [month,list] of months){list.sort((a,b)=>a.date.localeCompare(b.date));if(list.length>=4){let date=list[3].date;generated.push(growthAward('v3-month-'+month,date,'growth-monthly-'+month,'月度成长奖励：完成 4 周目标',1,'同一自然月完成 4 次每周成长目标，自动获得'))}}
  for(const [activity,rule] of Object.entries(GROWTH_CATEGORY_RULES)){
    const rows=source.filter(r=>r.activity===activity).sort((a,b)=>a.date.localeCompare(b.date)||(+a.createdAt||0)-(+b.createdAt||0));
    for(const [count,jade] of rule.rewards)if(rows.length>=count){let date=rows[count-1].date;generated.push(growthAward('v3-cat-'+activity+'-'+count,date,'growth-category-'+activity+'-'+count,'成长里程碑：'+rule.name+' '+count+' 次',jade,'累计记录达到 '+count+' 次，自动获得'))}
  }
  S.records=[...preserved,...generated];
  S.awards=S.records.filter(r=>r.activity==='milestone'&&r.milestoneKey).map(r=>r.milestoneKey);
};

calendarHtml=function(){
  let now=new Date(),m=new Date(now.getFullYear(),now.getMonth()+calOffset,1),year=m.getFullYear(),month=m.getMonth(),first=m.getDay(),days=new Date(year,month+1,0).getDate(),today=D();
  let out='<div class="calendar"><div class="cal-head"><button class="secondary tiny" onclick="moveCalendar(-1)">‹</button><b>'+year+' 年 '+(month+1)+' 月</b><button class="secondary tiny" onclick="moveCalendar(1)">›</button></div><div class="cal-week">'+['日','一','二','三','四','五','六'].map(x=>'<span>'+x+'</span>').join('')+'</div><div class="cal-days">';
  for(let i=0;i<first;i++)out+='<span></span>';
  for(let day=1;day<=days;day++){
    let ds=year+'-'+String(month+1).padStart(2,'0')+'-'+String(day).padStart(2,'0'),rs=S.records.filter(r=>r.date===ds),hasBreakfast=rs.some(r=>r.activity==='breakfast'),hasShare=rs.some(r=>r.activity==='share'),hasOther=rs.some(r=>growthIsUserRecord(r)&&!['breakfast','share'].includes(r.activity)),hasAward=rs.some(r=>r.activity==='milestone'),symbol=hasBreakfast?'●':hasShare?'◆':hasOther?'•':hasAward?'✦':'';
    out+='<button class="cal-day '+(ds===today?'today ':'')+(hasBreakfast?'breakfast ':'')+((hasShare||hasOther)?'extra ':'')+'" onclick="openCalendarDate(\''+ds+'\')"><span>'+day+'</span><i>'+symbol+'</i></button>';
  }
  return out+'</div><div class="cal-key"><span><i class="k-breakfast"></i>早餐</span><span><i class="k-extra"></i>分享/成长记录</span><span><i class="k-award"></i>成长奖励</span></div></div>';
};

function growthCategoryCards(){
  return Object.entries(GROWTH_CATEGORY_RULES).map(([activity,rule])=>{let count=growthRecords().filter(r=>r.activity===activity).length,next=rule.rewards.find(([n])=>count<n),done=rule.rewards.filter(([n])=>count>=n).reduce((sum,[,j])=>sum+j,0),pct=next?Math.min(100,count/next[0]*100):100;return `<div class="growth-category"><div class="row"><b class="grow">${esc(rule.name)}</b><span>${count} 次</span></div><div class="progress jadebar"><span style="width:${pct}%"></span></div><small class="muted">${next?`再 ${next[0]-count} 次得 +${next[1]} 玉`:`已完成全部里程碑 · 共 +${done} 玉`}</small></div>`}).join('');
}
renderDash=function(){
  const b=balance(),week=growthWeekInfo(),target=S.growth.target,active=week.days.length,left=Math.max(0,target-active),done=active>=target,month=D().slice(0,7),monthRows=growthRecords().filter(r=>r.date.startsWith(month)),monthCoin=monthRows.reduce((n,r)=>n+(+r.coin||0),0),monthJade=S.records.filter(r=>r.date.startsWith(month)).reduce((n,r)=>n+(+r.jade||0),0);
  let recent=[...S.records,...S.redeems.map(r=>({...r,label:'兑换：'+r.itemName,coin:r.cur==='coin'?-r.price:0,jade:r.cur==='jade'?-r.price:0}))].sort((x,y)=>(+y.createdAt||0)-(+x.createdAt||0)).slice(0,9);
  let wishes=S.items.filter(i=>i.wish).slice(0,3).map(i=>{let value=b[i.cur],p=i.price?Math.min(100,value/i.price*100):100,unit=i.cur==='coin'?'币':'玉';return '<div class="card"><div class="row"><b class="grow">☆ '+esc(i.name)+'</b><span class="'+(i.cur==='jade'?'jade':'')+'">'+value+'/'+i.price+' '+unit+'</span></div><div class="progress '+(i.cur==='jade'?'jadebar':'')+'" style="margin-top:9px"><span style="width:'+p+'%"></span></div></div>'}).join('');
  dashboard.innerHTML=`<div class="card hero"><img class="hero-bunny" src="xiangxiang-rabbit.png" alt="抱着爱心的相相兔"><div class="hero-copy"><h1>本周已记录 ${active} 天</h1><p>${done?'本周的小目标完成啦，+1 相相玉 ♡':left?`再记录 ${left} 天，就能获得 +1 相相玉`:'每一件小事都算成长 ♡'}</p></div><div class="balances"><div class="balance">相相币<b>${b.coin}</b></div><div class="balance">相相玉<b class="jade">${b.jade}</b></div></div></div><div class="grid"><div class="stat"><span class="muted">本周活跃</span><b>${active}/${target} 天</b></div><div class="stat"><span class="muted">本周记录</span><b>${week.rows.length} 笔</b></div><div class="stat"><span class="muted">本月获得相相币</span><b>${monthCoin} 币</b></div><div class="stat"><span class="muted">本月获得相相玉</span><b>${monthJade} 玉</b></div></div><div class="section-title"><span>本周成长目标</span><span class="muted">任意 ${target} 天 · +1 玉</span></div><div class="progress"><span style="width:${Math.min(100,active/target*100)}%"></span></div><div class="gentle-note">不需要连续，也不需要每天都完美。早餐、分享、任务等正向记录都算本周活跃。</div><div class="section-title"><span>成长日历</span><span class="muted">点日期查看账本</span></div><div class="card">${calendarHtml()}</div><div class="section-title"><span>累计成长里程碑</span><span class="muted">10 · 30 · 60 次</span></div><div class="card growth-categories">${growthCategoryCards()}</div>${wishes?'<div class="section-title"><span>心愿目标</span></div>'+wishes:''}<div class="section-title"><span>最近流水</span><button class="secondary tiny" onclick="go('score')">去记录</button></div><div class="card">${records(recent)}</div>`;
};

const growthBaseRenderScore=renderScore;
renderScore=function(){
  growthBaseRenderScore();
  const intro=score.querySelector('.card .muted');if(intro)intro.textContent='早餐、分享、任务和其他正向记录都会计入本周活跃；早餐仍然每天最多加分一次。';
  score.querySelectorAll('.quick small').forEach(el=>{el.textContent=el.textContent.replace(' · 连胜核心','')});
  const settings=score.querySelector('.settings');if(settings)settings.insertAdjacentHTML('afterbegin',`<details open><summary>成长规则</summary><p class="muted">每周一重新开始统计；一周中任意 ${S.growth.target} 天留下正向记录，即得 +1 相相玉，不要求连续。一个自然月完成 4 次周目标，再得 +1 玉。</p><label>每周记录目标</label><select onchange="setWeeklyTarget(this.value)">${[2,3,4,5].map(n=>`<option value="${n}" ${n===S.growth.target?'selected':''}>任意 ${n} 天</option>`).join('')}</select><p class="cloud-help">累计奖励：早餐、分享、任务各达到 10 / 30 / 60 次，分别获得 +1 / +2 / +3 玉。</p></details>`);
};
function setWeeklyTarget(value){let next=Math.max(2,Math.min(5,+value||GROWTH_DEFAULT_TARGET));if(next===S.growth.target)return;if(!confirm('改为每周任意 '+next+' 天后，升级以来的周奖励会按新目标重新核算。继续？'))return renderScore();S.growth.target=next;rebuildStreakAndAwards();save()}

recordForm=function(id){let a=S.activities.find(x=>x.id===id);open(`<h2>${a?esc(a.name):'自定义奖励'}</h2><p class="muted">记录一次值得鼓励的小事；当天有正向记录，就会计入本周活跃。</p><label>日期</label><input id="fdate" type="date" value="${D()}"><label>获得相相币</label><input id="fcoin" type="number" value="${a?.coin||0}"><label>额外相相玉</label><input id="fjade" type="number" value="0"><label>备注</label><textarea id="fnote" placeholder="例如：分享了可爱的照片"></textarea><div class="actions" style="margin-top:16px"><button class="primary" onclick="submitRecord('${id}')">记入账本</button><button class="outline" onclick="close()">取消</button></div>`)};
delRecord=function(id){if(confirm('删除这条记录？余额与相关成长奖励会自动回溯核算。')){S.records=S.records.filter(r=>r.id!==id);rebuildStreakAndAwards();save()}};

const growthBaseDrawReport=drawReport;
renderReport=function(){report.innerHTML=`<div class="card"><h2 style="margin-top:0">成长回顾</h2><label>选择日期</label><input id="reportDate" type="date" value="${D()}" onchange="drawReport()"><canvas id="canvas" width="640" height="860" class="report" style="margin-top:14px"></canvas><p class="report-help">手机端点击“保存 / 分享 PNG”，可在系统菜单中选择存储到照片、存储到文件或发送给好友。</p><div class="actions" style="margin-top:12px"><button class="primary" onclick="downloadReport()">保存 / 分享 PNG</button><button class="secondary" onclick="previewReport()">图片预览</button><button class="outline" onclick="drawReport()">刷新回顾</button></div></div>`;setTimeout(drawReport,0)};
drawReport=function(){
  growthBaseDrawReport();let c=document.getElementById('canvas');if(!c)return;let d=document.getElementById('reportDate').value,ctx=c.getContext('2d'),week=growthWeekInfo(d),x=420;
  ctx.fillStyle='#fff7e9';ctx.strokeStyle='#e5d6cc';ctx.lineWidth=1.5;ctx.beginPath();ctx.roundRect(x,298,176,116,20);ctx.fill();ctx.stroke();ctx.fillStyle='#8b7368';ctx.font='18px "PingFang SC",sans-serif';ctx.fillText('本周活跃',x+18,332);ctx.fillStyle='#a77458';ctx.font='700 30px Georgia,"PingFang SC",serif';ctx.fillText(week.days.length+'/'+S.growth.target+' 天',x+18,381);
};
function reportPngFile(){
  let c=document.getElementById('canvas'),name='相相成长回顾-'+document.getElementById('reportDate').value+'.png',data=c.toDataURL('image/png'),raw=atob(data.split(',')[1]),bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  return new File([bytes],name,{type:'image/png',lastModified:Date.now()});
}
downloadReport=async function(){
  let file;try{file=reportPngFile()}catch{return alert('图片生成失败，请先刷新回顾后重试。')}
  if(navigator.share&&navigator.canShare?.({files:[file]})){
    try{await navigator.share({title:'相相成长回顾',text:'今天的成长小手账 ♡',files:[file]});return}catch(error){if(error?.name==='AbortError')return}
  }
  try{const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name;a.rel='noopener';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}catch{alert('未能直接保存，请使用“图片预览”后长按图片保存。')}
};
function previewReport(){
  let c=document.getElementById('canvas');if(!c)return;
  let src=c.toDataURL('image/png');open(`<h2>图片预览</h2><p class="muted">在手机上长按图片，可选择“存储到照片”；也可以返回后使用系统分享菜单。</p><img class="report-preview" src="${src}" alt="相相成长回顾 PNG 预览"><div class="actions" style="margin-top:14px"><button class="primary" onclick="downloadReport()">保存 / 分享 PNG</button><button class="outline" onclick="close()">返回</button></div>`);
}

const reportNav=document.querySelector('[data-page="report"]');if(reportNav)reportNav.innerHTML='<span class="icon">▣</span>回顾';
document.head.insertAdjacentHTML('beforeend',`<style>.gentle-note{margin-top:12px;padding:11px 13px;border-radius:14px;background:#fff8ec;border:1px dashed #e5cfaf;color:#866f56;font-size:13px}.growth-categories{display:grid;gap:15px}.growth-category .progress{margin:7px 0 5px}.growth-category small{display:block}.cal-day i{font-size:10px}.settings select{background:#fffdf9}.report-help{margin:11px 2px 0;color:var(--muted);font-size:13px}.report-preview{display:block;width:100%;border-radius:18px;border:1px solid var(--line);box-shadow:0 8px 18px #72544712}@media(max-width:430px){.gentle-note{font-size:12px}.grid .stat{padding:13px 11px}.grid .stat b{font-size:22px}.report-help{font-size:12px}}</style>`);

const growthBaseSafetyBoot=safetyBoot;
safetyBoot=function(){growthMigrationChanged=false;growthBaseSafetyBoot();if(growthMigrationChanged&&!storageFault){try{save()}catch{}}};
