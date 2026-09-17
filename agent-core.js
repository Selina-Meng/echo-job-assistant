/* Pure rules shared by the worker and runnable tests. */
globalThis.AgentCore = (() => {
  'use strict';
  const day = 86400000;
  function generationProgress(task={}) {
    const entries=(task.queue||[]).filter(e=>e.type==='generate'),saved=entries.filter(e=>e.outcome==='saved').length;
    const failed=entries.filter(e=>e.outcome==='failed'),review=failed.filter(e=>e.failureStage==='quality').length;
    const issues=failed.map(e=>{const error=e.error||(task.errors||[]).filter(x=>x.recordId===e.recordId||x.item===e.name).at(-1)?.message||'旧任务未保存具体原因，请查看该岗位的检验说明';return (e.name||e.recordId||'岗位')+'：'+error;});
    const summary='已保存 '+saved+'，草稿待处理 '+review+'，失败 '+(failed.length-review);
    return {saved,review,failed:failed.length-review,summary,issues,title:failed.length?'有话术需要处理':task.lastError?'话术结果已保留，任务整理异常':'本次话术处理完成'};
  }
  function taskProgress(task={}) {
    const rows=new Map(),queue=Array.isArray(task.queue)?task.queue:[];
    let legacy=false;
    queue.forEach((entry,index)=>{
      if(!['job','reassess'].includes(entry.type))return;
      const key=jobKey(entry.url)||entry.recordId;if(!key)return;
      if(!rows.has(key))rows.set(key,{});
      const row=rows.get(key);
      if(index<(task.cursor||0)&&!entry.outcome)legacy=true;
      if(entry.outcome)row[entry.type]=entry.outcome;
      if(entry.readSaved)row.read=true;
    });
    const values=[...rows.values()];
    return {identified:rows.size,read:legacy?null:values.filter(r=>r.read).length,analyzed:legacy?null:values.filter(r=>r.reassess==='saved').length,failed:legacy?null:values.filter(r=>r.job==='failed'||r.reassess==='failed').length};
  }
  const statuses=['未联系','已准备话术','已投递','待我回复','等待 HR','面试中','Offer','拒绝'];
  const statusAliases={已收藏:'未联系',考虑中:'未联系',已投:'已投递',已读:'等待 HR',已回:'待我回复'};
  const appliedStatuses=new Set(['已投递','待我回复','等待 HR','面试中','Offer','拒绝']),repliedStatuses=new Set(['待我回复','面试中','Offer']);
  const normalizeStatus=status=>statusAliases[status]||statuses.includes(status)&&status||'未联系';
  const isApplied=status=>appliedStatuses.has(normalizeStatus(status)),isReplied=status=>repliedStatuses.has(normalizeStatus(status));
  const managed = records => records.filter(r => r.status!=='不考虑'&&r.discoveryState!=='dismissed'&&(!['pending','candidate','selected','skipped'].includes(r.discoveryState)||r.appliedAt||r.greetingState==='sent'||normalizeStatus(r.status)!=='未联系'));
  const recordTime = r => Math.max(r.updatedAt||0,r.lastJobScanAt||0,r.lastChatMessageAt||0,r.greetingCopiedAt||0,r.greetingSentAt||0,r.statusUpdatedAt||0,r.userDecision?.at||0,r.createdAt||0);
  const decisionLabel = state => ({pending:'待判断',candidate:'候选',skipped:'暂时跳过',dismissed:'暂不考虑',selected:'已选择'})[state]||'—';
  function applyStatus(rec,status,now=Date.now(),automatic=false,evidence){
    status=statusAliases[status]||status;if(!statuses.includes(status))return false;const current=normalizeStatus(rec.status);
    if(automatic&&(current==='拒绝'||current==='Offer'&&status!=='拒绝'||['面试中','Offer'].includes(current)&&!['面试中','Offer','拒绝'].includes(status)||appliedStatuses.has(current)&&!appliedStatuses.has(status)))return false;
    if(status===current)return false;rec.status=status;rec.statusUpdatedAt=now;rec.statusHistory=[...(Array.isArray(rec.statusHistory)?rec.statusHistory:[]),{status,at:now,...(evidence?{evidence}: {})}];if(appliedStatuses.has(status)&&!rec.appliedAt)rec.appliedAt=now;if(repliedStatuses.has(status)&&!rec.repliedAt)rec.repliedAt=now;if(evidence)rec.statusEvidence={...evidence,at:now};return true;
  }
  function conversationStatus(item,rec){
    if(noCommunication(item)||item.analysisError)return null;
    item=effectiveChat(item);if(!item?.activity?.reliable||item.activity.automaticReliable===false)return null;const analysis=item.analysis||{},state=analysis.conversationState||{},hr=(item.messages||[]).filter(m=>m.role==='hr'&&m.roleSource==='explicit').map(m=>String(m.text||'')),mine=(item.messages||[]).filter(m=>m.role==='candidate'&&m.roleSource==='explicit').map(m=>String(m.text||''));
    if(state.rejectionEvidence&&hr.some(t=>t.includes(state.rejectionEvidence)))return {status:'拒绝',evidence:{source:'chat',conversationId:item.id,text:state.rejectionEvidence}};
    const offer=hr.find(x=>/\boffer\b|录用通知|决定录用|正式录用/i.test(x));if(offer&&analysis.status==='Offer')return {status:'Offer',evidence:{source:'chat',conversationId:item.id,text:offer.slice(0,300)}};
    const interview=hr.find(x=>/面试邀请|邀请.{0,8}面试|安排.{0,8}(?:面试|初试|复试|面谈)|参加.{0,8}(?:面试|初试|复试)/.test(x));if(interview&&(/面试/.test(analysis.status||'')||/面试|初试|复试|面谈/.test(state.stage||'')))return {status:'面试中',evidence:{source:'chat',conversationId:item.id,text:interview.slice(0,300)}};
    if(appliedStatuses.has(normalizeStatus(rec.status))&&item.activity.waitingFor==='user'&&hr.length)return {status:'待我回复',evidence:{source:'chat',conversationId:item.id,text:hr.at(-1).slice(0,300)}};
    if(appliedStatuses.has(normalizeStatus(rec.status))&&item.activity.waitingFor==='recruiter')return {status:'等待 HR',evidence:{source:'chat',conversationId:item.id,text:mine.at(-1)?.slice(0,300)||'最后一条可靠消息由求职者发送'}};
    if(appliedStatuses.has(normalizeStatus(rec.status))&&analysis.readStatus==='已读')return {status:'等待 HR',evidence:{source:'chat',conversationId:item.id,text:'页面显示已读'}};
    const applied=mine.find(x=>/已投递|投递了?.{0,8}简历|申请.{0,8}(?:岗位|职位)|应聘.{0,8}(?:岗位|职位)/.test(x));return applied?{status:item.activity.waitingFor==='recruiter'?'等待 HR':'已投递',evidence:{source:'chat',conversationId:item.id,text:applied.slice(0,300)}}:null;
  }
  const unrestricted = p => p.mode==='unrestricted'||/^(?:甲方乙方均可|甲乙方均可|无行业偏好|行业不限|不限行业|无地域偏好|地域不限|无偏好|均可|不限)$/.test(String(p.label||'').replace(/\s/g,''));
  const activePreferences = values => (Array.isArray(values)?values:[]).filter(p=>p&&!unrestricted(p));
  const generationIssue = (r,allowSaved=false) => r.availability?.kind==='unavailable'?'岗位已停止招聘':(['title','company','description'].filter(k=>!String(r[k]||'').trim()).map(k=>({title:'职位名',company:'公司名',description:'JD'}[k])).join('、') ? '请补充：'+['title','company','description'].filter(k=>!String(r[k]||'').trim()).map(k=>({title:'职位名',company:'公司名',description:'JD'}[k])).join('、') : r.availability?.kind==='failed'&&!allowSaved?'更新失败，请确认使用已保存资料':'');
  function uniqueRecords(records){
    // Unmerged rows may contain distinct notes or drafts; do not hide them in views.
    return [...new Map(records.map(r=>[r.id||r,r])).values()];
  }
  function recordKey(r){
    const url=jobKey(r?.url),value=r?.platformJobKey||r?.id,id=/^liepin:(?:a:)?\d+$/.test(value||'')?value:'';
    if(url||id)return url&&id&&url!==id?'':url||id;
    try{const u=new URL(r?.url),host=u.hostname.replace(/^www\./,'');if(u.protocol!=='https:')return '';
      if(host==='zhipin.com'&&/^\/job_detail\/[\w-]+\.html$/.test(u.pathname)||host==='lagou.com'&&/^\/jobs\/\d+\.html$/.test(u.pathname)||host==='jobs.zhaopin.com'&&/^\/[\w-]+\.html?$/.test(u.pathname))return host+u.pathname;
    }catch(_){}return '';
  }
  function duplicateGroups(records){
    const groups=new Map();records.forEach((r,i)=>{const key=recordKey(r);if(key){if(!groups.has(key))groups.set(key,[]);groups.get(key).push(i);}});
    return [...groups.values()].filter(group=>group.length>1).map(group=>({group}));
  }
  function mergeRecords(records,conversations,ids,now=Date.now()){
    const selected=records.filter(r=>ids.includes(r.id));
    if(selected.length!==new Set(ids).size||selected.length<2)throw Error('合并岗位已变化，请重新选择');
    if(!recordKey(selected[0])||selected.some(r=>recordKey(r)!==recordKey(selected[0])))throw Error('岗位标识不同或不可靠；同名只能提示，不能直接合并');
    const keep=selected[0],before=JSON.parse(JSON.stringify(selected)),conflicts=[];
    const unions=['sources','linkedConversationIds','statusHistory','greetingHistory','decisionHistory','events','matchPoints'];
    for(const other of selected.slice(1))for(const [field,value] of Object.entries(other)){
      if(['id','mergeHistory'].includes(field)||value==null||value==='')continue;
      if(unions.includes(field)&&Array.isArray(value)){const values=[...(keep[field]||[]),...value];keep[field]=[...new Map(values.map(v=>[JSON.stringify(v),v])).values()];}
      else if(keep[field]==null||keep[field]==='')keep[field]=value;
      else if(JSON.stringify(keep[field])!==JSON.stringify(value))conflicts.push({id:other.id,field});
    }
    keep.mergeHistory=[{at:now,records:before,conflicts}];
    const links=[];
    for(const c of conversations)if(selected.slice(1).some(r=>r.id===c.linkedRecordId)){links.push({id:c.id,before:c.linkedRecordId,after:keep.id});c.linkedRecordId=keep.id;}
    keep.linkedConversationIds=[...new Set([...(keep.linkedConversationIds||[]),...conversations.filter(c=>c.linkedRecordId===keep.id).map(c=>c.id)])];
    for(const r of selected.slice(1))records.splice(records.indexOf(r),1);
    return {before,after:JSON.parse(JSON.stringify(keep)),links,conflicts};
  }
  function jobKey(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !/(^|\.)liepin\.com$/.test(u.hostname)) return '';
      const id = u.pathname.match(/^\/(job|a)\/(\d+)\.shtml$/);
      return id ? 'liepin:' + (id[1]==='a'?'a:':'') + id[2] : '';
    } catch (_) { return ''; }
  }
  function recordById(records,value) {
    value=String(value||'');const key=jobKey(value)||(/^liepin:(?:a:)?\d+$/.test(value)?value:'');
    return (records||[]).find(r=>r&&r.id===value)||(key?(records||[]).find(r=>r&&(r.platformJobKey===key||jobKey(r.url)===key)):null)||null;
  }
  function searchUrl(url) {
    try { const u = new URL(url); return u.protocol === 'https:' && /(^|\.)liepin\.com$/.test(u.hostname) && /^\/(zhaopin\/?|zhaopin\/.*|.*search.*)$/i.test(u.pathname) ? u.href : ''; } catch (_) { return ''; }
  }
  function listKind(url){try{const u=new URL(url);if(u.protocol!=='https:'||!/(^|\.)liepin\.com$/.test(u.hostname))return '';if(/^\/job\/record\/favorite\/?$/.test(u.pathname)||/favorites?/.test(u.pathname))return 'favorites';if(/^\/job\/record\/apply\/?$/.test(u.pathname))return 'apply';return searchUrl(u.href)?'search':'';}catch(_){return '';}}
  function validateConfig(raw) {
    const directions = (Array.isArray(raw.directions) ? raw.directions : []).map(d => {
      if (!d || !String(d.name || '').trim() || !searchUrl(d.url)) throw new Error('方向需要名称和有效的猎聘 HTTPS 搜索页链接');
      return { name: String(d.name).trim().slice(0, 80), url: searchUrl(d.url) };
    });
    if (directions.length > 5) throw new Error('MVP 最多保存5个方向');
    const followDays = Number(raw.followDays ?? 7), archiveDays = Number(raw.archiveDays ?? 14);
    if (!Number.isInteger(followDays) || followDays < 1 || !Number.isInteger(archiveDays) || archiveDays <= followDays || archiveDays > 365) throw new Error('跟进天数至少1天，归档天数须更大且不超过365天');
    const minSalary = Number(raw.minSalary || 0);
    if (!Number.isFinite(minSalary) || minSalary < 0 || minSalary > 1000) throw new Error('最低月薪须为0–1000之间的数字，单位K');
    const softText=String(raw.softText||'').slice(0,8000);
    const short = (s,n=300) => String(s||'').trim().slice(0,n);
    const list = v => Array.isArray(v)?v.filter(s=>typeof s==='string').slice(0,8).map(s=>short(s,100)):[];
    const softPreferences=(Array.isArray(raw.softPreferences)?raw.softPreferences:[]).filter(p=>p&&typeof p.label==='string'&&typeof p.sourceQuote==='string'&&p.sourceQuote.trim()&&softText.includes(p.sourceQuote)).slice(0,20).map(p=>({...((Number.isFinite(p.createdAt)&&p.createdAt>0)?{createdAt:p.createdAt}:{}),label:short(p.label,24),sourceQuote:short(p.sourceQuote,200),mode:unrestricted(p)?'unrestricted':'requirement',version:p.version===2?2:1,meaning:short(p.meaning),positiveSignals:list(p.positiveSignals),negativeSignals:list(p.negativeSignals),question:unrestricted(p)?'':short(p.question),options:list(p.options),answer:short(p.answer),confirmed:p.confirmed===true}));
    let favoritesUrl='';try{const u=new URL(raw.favoritesUrl);if(u.protocol==='https:'&&/(^|\.)liepin\.com$/.test(u.hostname)&&!jobKey(u.href)&&!searchUrl(u.href))favoritesUrl=u.href;}catch(_){}
    const hardRequirements=(Array.isArray(raw.hardRequirements)?raw.hardRequirements:[]).slice(0,20).filter(p=>p&&typeof p.sourceQuote==='string'&&p.sourceQuote.trim()&&softText.includes(p.sourceQuote)).map(p=>({...((Number.isFinite(p.createdAt)&&p.createdAt>0)?{createdAt:p.createdAt}:{}),label:short(p.label,40),...(unrestricted(p)?{mode:'unrestricted'}:{}),meaning:short(p.meaning),sourceQuote:short(p.sourceQuote,200)}));
    return { ...(raw.confirmedClassification?{confirmedClassification:raw.confirmedClassification}:{}),directions, cities: short(raw.cities), excludes: short(raw.excludes,500), minSalary, followDays, archiveDays, autoArchive: raw.autoArchive === true,softText,softPreferences,hardRequirements,ruleVersion:Number(raw.ruleVersion)||0,favoritesUrl,favoriteCheckedAt:Number(raw.favoriteCheckedAt)||0,favoritePending:false };
  }
  function parseImport(text) {
    const chunks=String(text||'').replace(/\\([&_])/g,'$1').match(/https?:\/\/(?:(?!https?:\/\/)[^\s<>"\]])+/g)||[];
    if(String(text||'').length>30000)throw new Error('请分批粘贴，每次不超过30000字');
    const entries=[],invalid=[],seen=new Set();let duplicates=0;
    for(let value of chunks){value=value.replace(/[),，。；;]+$/g,'');try{
      const u=new URL(value);let key=jobKey(u.href),type='job';
      if(key){u.search='';u.hash='';}else if(searchUrl(u.href)){type='search';u.hash='';u.searchParams.sort();key=u.href;}else throw Error();
      if(seen.has(key)){duplicates++;continue;}seen.add(key);
      entries.push({type,url:u.href,name:type==='search'?'粘贴的搜索条件':'粘贴的岗位',sourceKind:'search',sourceUrl:u.href});
    }catch(_){invalid.push(value.slice(0,200));}}
    if(entries.length>100)throw new Error('每次最多导入100个链接，请分批粘贴');
    return {entries,invalid,duplicates};
  }
  function evidenceSources(job, conversations=[]) {
    const out=[];
    for(const field of ['description','workAddress','benefits','industry','companyDescription','location','salary','experience','education','size','companyType','hrActiveText','publishedText'])if(job[field])out.push({id:field,text:String(job[field]),at:field==='hrActiveText'?job.hrActiveCheckedAt||job.lastJobScanAt||null:field==='publishedText'?job.publishedAt||job.lastJobScanAt||null:job.lastJobScanAt||null});
    for(const c of conversations)if(c.linkedRecordId===job.id && c.activity&&c.activity.reliable && !c.scanError){
      for(const [i,m] of (c.messages||[]).entries())if(m.role==='hr'&&m.roleSource==='explicit')out.push({id:'chat:'+c.id+':'+(m.id||i),text:String(m.text||''),at:m.sentAt||null});
    }
    return out;
  }
  function averageScores(group,keys) {
    const values=keys.map(k=>Number(group&&group[k]&&group[k].score)).filter(v=>Number.isFinite(v)&&v>=1&&v<=5);
    return values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length*10)/10:null;
  }
  function preferenceCheck(value,p,sources,confirmed=true){
    const c=value||{},normalize=t=>String(t||'').replace(/\s+/g,' ').trim();
    const proofs=(Array.isArray(c.evidence)?c.evidence:[]).slice(0,6).flatMap(e=>{const source=sources.find(s=>s.id===e?.source);return source&&normalize(e.quote)&&normalize(source.text).includes(normalize(e.quote))?[{source:source.id,quote:e.quote,at:source.at,stance:source.indirectOnly?'indirect':['positive','negative','indirect'].includes(e.stance)?e.stance:'indirect',...(source.url?{url:source.url,title:source.title}: {})}]:[];});
    const conflict=proofs.some(e=>e.stance==='positive')&&proofs.some(e=>e.stance==='negative');
    let kind=confirmed&&proofs.length&&['meets','conflicts','signal'].includes(c.kind)?c.kind:'unknown';
    if(conflict)kind='unknown';
    if(kind==='meets'&&!proofs.some(e=>e.stance==='positive')||kind==='conflicts'&&!proofs.some(e=>e.stance==='negative'))kind='signal';
    const direction=kind==='signal'?(['meets','conflicts'].includes(c.direction)?c.direction:['meets','conflicts'].includes(c.kind)?c.kind:'unknown'):kind;
    const verification=!value?'missing':!confirmed?'needs_confirmation':conflict?'conflicting':['meets','conflicts'].includes(kind)?'supported':proofs.length?'inferred':'unverified';
    return {label:p.label,kind,direction,verification,score:kind==='meets'?5:kind==='conflicts'?1:null,reason:!confirmed?'请先确认偏好含义':conflict?'存在相互冲突的依据，请确认':String(c.reason||(!value?'本次模型未返回此项分析，可单项重试':'未给出分析理由，可单项重试')).slice(0,350),evidence:proofs,question:confirmed?String(c.question||'').slice(0,200):''};
  }
  function recommendationRating(raw,job,preferences,evidence,sources=evidenceSources(job)) {
    const normalize=(value,label)=>{
      const c=value||{},quote=typeof c.quote==='string'?c.quote.trim():'';
      const valid=typeof c.score==='number'&&Number.isFinite(c.score)&&c.score>=1&&c.score<=5&&quote&&String(job.description||'').includes(quote)&&typeof c.reason==='string'&&c.reason.trim();
      return {label,score:valid?c.score:null,reason:valid?c.reason.slice(0,250):String(c.reason||'本次未得到可核对的岗位分析').slice(0,250),verification:valid?'supported':'unverified',quote:valid?quote:''};
    };
    const core={roleMatch:normalize(raw&&raw.roleMatch,'岗位契合'),skillFit:normalize(raw&&raw.skillFit,'经历匹配')};
    if(!evidence.length)core.skillFit={...core.skillFit,score:null,reason:core.skillFit.reason+'；缺少可核对的经历对应证据',verification:'unverified'};
    const concerns=activePreferences(preferences).map(p=>preferenceCheck((raw&&Array.isArray(raw.concerns)?raw.concerns:[]).find(c=>c&&c.label===p.label),p,sources,p.version===2&&p.confirmed&&(!p.question||p.answer)));
    const base=averageScores(core,Object.keys(core)),soft=averageScores(concerns,concerns.map((_,i)=>i));
    const overall=core.roleMatch.score===null||core.skillFit.score===null?null:soft===null?base:Math.round((base*0.6+soft*0.4)*10)/10;
    return {overall,candidateFit:core.roleMatch.score===null||core.skillFit.score===null?null:base,preferenceFit:soft,core,concerns,known:concerns.filter(c=>c.score!==null).length,total:concerns.length};
  }
  function directionFromPage(url) {
    if (!searchUrl(url)) throw new Error('请先在猎聘搜索页选好岗位和城市，再点击使用当前条件');
    const source = new URL(url), target = new URL(url);
    if (!/^\/zhaopin\/?$/.test(source.pathname)) throw new Error('请使用猎聘岗位搜索列表页');
    // Preserve platform filters, including new ones; remove only known tracking parameters.
    for (const key of ['ckId','skId','fkId','sfrom','suggestId']) target.searchParams.delete(key);
    target.hash=''; target.searchParams.set('currentPage','0'); target.searchParams.sort();
    return {name:source.searchParams.get('key') || '当前猎聘筛选',url:target.href};
  }
  function filter(job, config) {
    const rejected = [], unknown = [];
    const words = value => String(value || '').split(/[,，、\n]/).map(x => x.trim()).filter(Boolean);
    const text = [job.title, job.company, job.description].join(' ');
    for (const word of words(config.excludes)) if (text.includes(word)) rejected.push('排除项：' + word);
    const cities = words(config.cities);
    if (cities.length) {
      if (!job.location) unknown.push('地点待确认');
      else if (!cities.some(c => job.location.includes(c))) rejected.push('地点不符合');
    }
    if (config.minSalary > 0) {
      const match = String(job.salary || '').match(/(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*([kK千万])/);
      if (!match || /年薪|万\/年/.test(job.salary) || (match[3]==='万' && !/月薪|万\/月/.test(job.salary))) unknown.push('月薪范围待确认');
      else if (Number(match[2]) * (match[3] === '万' ? 10 : 1) < config.minSalary) rejected.push('薪资上限低于要求');
      else if (Number(match[1]) * (match[3] === '万' ? 10 : 1) < config.minSalary) unknown.push('薪资区间跨越最低要求，需确认');
    }
    if (!job.description) unknown.push('缺少JD原文');
    return { rejected, unknown };
  }
  function fingerprint(messages) {
    // ponytail: bounded exact snapshot (100 messages), no hash collision or extra dependency.
    return JSON.stringify((messages || []).slice(-100).map(m => [m.id || '', m.role || 'unknown', m.text || '', m.sentAt || null]));
  }
  const canonicalChatKey=key=>String(key||'').replace(/^(?:www\.|c\.)liepin\.com\|/,'liepin.com|');
  const receiptOnly=text=>/^[【\[（(]?(?:已读|未读|送达|已发送|发送中)[】\]）)]?$/.test(String(text||'').trim());
  function findConversation(items,incoming){
    const keys=c=>[c.key,...(c.aliasKeys||[])].map(canonicalChatKey).filter(Boolean);
    const candidates=items.filter(c=>c!==incoming&&keys(c).some(k=>keys(incoming).includes(k))&&(!c.linkedRecordId||!incoming.linkedRecordId||c.linkedRecordId===incoming.linkedRecordId));
    if(candidates.length)return candidates.length===1?candidates[0]:null;
    const norm=s=>String(s||'').replace(/\s/g,'');
    const messages=c=>(c.messages||[]).filter(m=>m.role!=='system'&&!receiptOnly(m.text)&&!systemNotice(m.text)).map(m=>norm(m.text));
    const fallback=items.filter(c=>c!==incoming&&norm(c.company)&&norm(c.company)===norm(incoming.company)&&norm(c.jobTitle)&&norm(c.jobTitle)===norm(incoming.jobTitle)&&(!c.linkedRecordId||!incoming.linkedRecordId||c.linkedRecordId===incoming.linkedRecordId)&&(!c.counterparty||!incoming.counterparty||norm(c.counterparty)===norm(incoming.counterparty))&&(!c.key?.includes('|display:')||!incoming.key?.includes('|display:'))&&messages(c).filter(t=>t.length>=8&&messages(incoming).includes(t)).length>=2);
    return fallback.length===1?fallback[0]:null;
  }
  function mergeConversationDuplicates(records,items){
    const quality=c=>(c.activity?20:0)+(c.key?.includes('liepin.com|')?20:0)+(c.messages||[]).filter(m=>['candidate','hr'].includes(m.role)&&!receiptOnly(m.text)).length;
    const ordered=[...items].sort((a,b)=>quality(b)-quality(a)||(b.updatedAt||0)-(a.updatedAt||0));let changed=false;
    for(const source of ordered){if(!items.includes(source))continue;const target=findConversation(items,source);if(!target||quality(target)<quality(source))continue;
      // Distinct human decisions need review; an absent decision never cancels an existing one.
      if(source.archive&&target.archive&&source.archive.reason!==target.archive.reason||source.confirmation?.keepOnlyChat&&!target.confirmation?.keepOnlyChat||source.archive&&(target.restoredFingerprint||target.restoredHumanFingerprint)||target.archive&&(source.restoredFingerprint||source.restoredHumanFingerprint))continue;
      target.aliasIds=[...new Set([...(target.aliasIds||[]),source.id,...(source.aliasIds||[])])];target.aliasKeys=[...new Set([...(target.aliasKeys||[]),source.key,...(source.aliasKeys||[])])];
      const history=target.mergedHistory||[];for(const old of [source,...(source.mergedHistory||[])])if(!history.some(c=>c.id===old.id))history.push({...old,mergedHistory:undefined});target.mergedHistory=history;
      if(source.archive&&!target.archive)target.archive=source.archive;
      if(source.confirmation?.identity&&!target.confirmation?.identity)target.confirmation={...target.confirmation,identity:{...source.confirmation.identity,key:target.key}};
      if(source.confirmation?.roles?.length){const roles=new Map((target.confirmation?.roles||[]).map(r=>[r.key,r]));for(const r of source.confirmation.roles)if(!roles.has(r.key)||(r.at||0)>(roles.get(r.key).at||0))roles.set(r.key,r);target.confirmation={...target.confirmation,roles:[...roles.values()]};}
      for(const field of ['lastMessageAt','appointment','routing']){const fix=source.confirmation?.[field];if(fix&&fix.fingerprint===target.activity?.messageFingerprint&&(!target.confirmation?.[field]||(fix.at||0)>(target.confirmation[field].at||0)))target.confirmation={...target.confirmation,[field]:fix};}
      for(const field of ['replyDraft','manualProgress'])if(source[field]&&(!target[field]||(source[field].updatedAt||source[field].at||0)>(target[field].updatedAt||target[field].at||0)))target[field]=source[field];
      for(const rec of records){if(rec.linkedConversationIds)rec.linkedConversationIds=[...new Set(rec.linkedConversationIds.map(id=>id===source.id?target.id:id))];if(rec.communicationArchive?.conversationId===source.id)rec.communicationArchive.conversationId=target.id;}
      items.splice(items.indexOf(source),1);changed=true;
    }
    return changed;
  }
  function compactFingerprint(value) {
    value=String(value||'');let a=2166136261,b=3339675911;
    for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,2246822519);}
    return value.length.toString(36)+':'+(a>>>0).toString(36)+(b>>>0).toString(36);
  }
  function compactSource(job={}) {
    const out=Object.fromEntries(['title','company','companyType','workAddress','benefits','industry','companyDescription','location','salary','url','experience','education','size','hrActive','hrActiveText','publishedText','publishedAt','companyDescriptionFingerprint','applicationStatus','applicationStatusText','availability','availabilityReason','sourceKind','sourceUrl'].filter(k=>job[k]!==undefined).map(k=>[k,job[k]]));
    if(out.companyDescription){out.companyDescriptionFingerprint=compactFingerprint(out.companyDescription);delete out.companyDescription;}
    if(job.description)out.descriptionFingerprint=compactFingerprint(job.description);
    return out;
  }
  function addEvent(target,source,kind,fingerprint,now=Date.now(),evidence={}){
    target.events=Array.isArray(target.events)?target.events:[];
    const key=String(source||'unknown')+'|'+String(fingerprint||'');
    const old=[...target.events].reverse().find(x=>x&&x.key===key);
    if(old){old.lastSeenAt=now;old.count=(old.count||1)+1;return {duplicate:true,event:old};}
    const event={key,source:String(source||'unknown'),kind,at:now,lastSeenAt:now,count:1,evidence};target.events.push(event);target.events=target.events.slice(-50);return {duplicate:false,event};
  }
  function addSource(rec,kind,url,now=Date.now()){
    kind=String(kind||'').slice(0,40);url=String(url||'').slice(0,2000);if(!kind||!url)return false;
    const sources=Array.isArray(rec.sources)?rec.sources:[],old=sources.find(s=>s&&s.kind===kind&&s.url===url);
    if(old){old.lastSeenAt=now;rec.sources=sources;return false;}
    rec.sources=[...sources,{kind,url,firstSeenAt:now,lastSeenAt:now}];return true;
  }
  function linkConversation(rec,id){if(typeof id!=='string'||!id)return false;const before=Array.isArray(rec.linkedConversationIds)?rec.linkedConversationIds:[];rec.linkedConversationIds=[...new Set([...before,id])];return !before.includes(id);}
  function unlinkConversation(rec,id){if(!Array.isArray(rec.linkedConversationIds))return false;const before=rec.linkedConversationIds.length;rec.linkedConversationIds=rec.linkedConversationIds.filter(x=>x!==id);return rec.linkedConversationIds.length!==before;}
  function applyAvailability(rec,kind,now=Date.now(),evidence={}){
    if(!['available','unavailable'].includes(kind))return false;
    if(rec.availability?.kind===kind)return false;
    rec.availability={kind,at:now,reason:String(evidence.reason||''),source:String(evidence.source||''),evidence:String(evidence.text||'')};
    rec.availabilityHistory=[...(rec.availabilityHistory||[]),{...rec.availability}];return true;
  }
  function applyDecision(rec,decision){
    if(!decision||!['pending','candidate','skipped','dismissed'].includes(decision.kind))return false;
    const current=rec.userDecision,signature=d=>JSON.stringify([d?.kind,d?.reason||'',d?.reasons||[],d?.note||'',d?.feedbackState||'none']);
    if(current&&!current.undone&&signature(current)===signature(decision))return false;
    rec.decisionHistory=[...(rec.decisionHistory||[]),decision];rec.discoveryState=decision.kind;rec.userDecision=decision;if(decision.kind==='dismissed'&&decision.source!=='migration')rec.discardAfter=(decision.at||Date.now())+day;else delete rec.discardAfter;return true;
  }
  function undoDecision(rec){
    const history=Array.isArray(rec.decisionHistory)?rec.decisionHistory:[],last=[...history].reverse().find(x=>x&&!x.undone);if(!last)return false;
    delete rec.discardAfter;last.undone=true;if(last.feedbackState==='pending')last.feedbackState='withdrawn';rec.discoveryState=last.previousState||'pending';rec.userDecision=[...history].reverse().find(x=>x&&!x.undone)||null;return true;
  }
  function applyGreeting(rec,state,now=Date.now(),evidence={}){
    if(!['draft','copied','sent'].includes(state))return false;
    const changed=rec.greetingState!==state;rec.greetingState=state;rec.greetingUpdatedAt=now;
    if(state==='copied')rec.greetingCopiedAt=now;if(state==='sent')rec.greetingSentAt=now;
    if(changed)rec.greetingHistory=[...(Array.isArray(rec.greetingHistory)?rec.greetingHistory:[]),{state,at:now,source:String(evidence.source||''),evidence:String(evidence.text||'')}];
    if(normalizeStatus(rec.status)==='未联系')applyStatus(rec,'已准备话术',now,false,{source:String(evidence.source||'greeting'),text:String(evidence.text||'话术已准备')});return changed;
  }
  function applyNextAction(rec,text,now=Date.now(),evidence={}){
    text=String(text||'').trim().slice(0,500);if(!text||rec.nextAction===text)return false;
    rec.nextAction=text;rec.nextActionAt=now;rec.nextActionEvidence={source:String(evidence.source||''),text:String(evidence.text||'').slice(0,500),at:now};return true;
  }
  function archiveConversation(rec,chat,archive,now=Date.now()){
    const old=chat.archive;chat.archive=archive;
    if(!rec)return;
    if(archive){
      applyNextAction(rec,'聊天已归档：'+archive.reason,now,{source:'chat-archive',text:archive.evidence||archive.reason});archive.previousStatus=normalizeStatus(rec.status);rec.communicationArchive={...archive,conversationId:chat.id};
      if(archive.reason==='明确拒绝')applyStatus(rec,'拒绝',now,false,{source:'chat-archive',conversationId:chat.id,text:archive.evidence});
      addEvent(rec,'chat-archive:'+chat.id,'archived',compactFingerprint(JSON.stringify([archive.reason,archive.evidence,archive.at])),now,{reason:archive.reason});
    }else if(rec.communicationArchive?.conversationId===chat.id){
      delete rec.communicationArchive;applyNextAction(rec,'归档已恢复，按最新聊天重新判断',now,{source:'archive-restore',text:'恢复沟通'});
      if(old?.previousStatus&&rec.status==='拒绝'&&rec.statusEvidence?.source==='chat-archive'&&rec.statusEvidence?.conversationId===chat.id&&rec.statusEvidence?.at===old.at)applyStatus(rec,old.previousStatus,now,false,{source:'archive-restore',text:'用户恢复归档'});
      addEvent(rec,'chat-archive:'+chat.id,'restored',String(now),now,{reason:'用户或新消息恢复'});
    }
  }
  function normalizeRecord(rec){
    if(!rec.legacyReview && !statuses.includes(rec.status))rec.legacyReview={originalStatus:rec.status||'',needsConfirmation:!['已投','已收藏','考虑中'].includes(rec.status),reason:'旧版状态已兼容展示，请核对原状态与真实进展'};
    migrateAxes(rec);rec.status=normalizeStatus(rec.status);
    if(Array.isArray(rec.statusHistory))rec.statusHistory=rec.statusHistory.map(h=>h&&({...h,status:normalizeStatus(h.status)}));
    // Keep business history; only disposable scan events are bounded.
    if(Array.isArray(rec.events))rec.events=rec.events.slice(-50);
    rec.linkedConversationIds=[...new Set(Array.isArray(rec.linkedConversationIds)?rec.linkedConversationIds.filter(x=>typeof x==='string'):[])];
const sources=[];for(const s of Array.isArray(rec.sources)?rec.sources:[]){const kind=String(s?.kind||'').slice(0,40),url=String(s?.url||'').slice(0,2000);if(!kind||!url)continue;const old=sources.find(x=>x.kind===kind&&x.url===url),first=Number(s.firstSeenAt),last=Number(s.lastSeenAt);if(old){const times=[old.firstSeenAt,first].filter(x=>Number.isFinite(x)&&x>0);if(times.length)old.firstSeenAt=Math.min(...times);old.lastSeenAt=Math.max(Number(old.lastSeenAt)||0,Number.isFinite(last)?last:0);}else sources.push({...s,kind,url});}rec.sources=sources;return rec;
  }
  function retainMessages(item,incoming=[]){
    const counts=new Map();for(const m of incoming){const key=JSON.stringify(m);counts.set(key,(counts.get(key)||0)+1);}
    const history=Array.isArray(item.messageHistory)?item.messageHistory:[],known=new Map();for(const m of history){const key=JSON.stringify(m);known.set(key,(known.get(key)||0)+1);}
    for(const m of item.messages||[]){const key=JSON.stringify(m);if(counts.get(key)){counts.set(key,counts.get(key)-1);continue;}if(known.get(key)){known.set(key,known.get(key)-1);continue;}history.push(m);}
    item.messageHistory=history;return incoming;
  }
  function timeline(rec){
    const rows=[],seen=new Set(),text=value=>typeof value==='string'?value:value&&typeof value==='object'?String(value.text||value.reason||value.error||(Array.isArray(value.fields)?'更新：'+value.fields.join('、'):'')):'';
    const add=(kind,at,title,evidence,source,key)=>{at=Number(at)||0;if(!at)return;const signature=key||[kind,at,title,text(evidence),source].join('|');if(seen.has(signature))return;seen.add(signature);rows.push({kind,at,title:String(title||''),evidence:text(evidence).slice(0,300),source:String(source||'').slice(0,120)});};
    for(const s of rec?.sources||[])add('source',s.firstSeenAt,'发现岗位',({favorite:'收藏',apply:'应聘记录',search:'搜索',current:'当前岗位',conversation:'聊天'}[s.kind]||s.kind)+' · '+s.url,s.kind,'source|'+s.kind+'|'+s.url);
    for(const e of rec?.events||[])add('event',e.at,({"job-observed":'岗位资料变化',"record-updated":'岗位资料修改',"read-failed":'岗位读取失败',archived:'沟通归档',restored:'恢复沟通'}[e.kind]||'岗位事件'),e.evidence,e.source,e.key);
    for(const h of rec?.availabilityHistory||[])add('availability',h.at,h.kind==='unavailable'?'岗位停止招聘':'岗位恢复可用',h.evidence||h.reason,h.source);
    for(const h of rec?.decisionHistory||[])add('decision',h.at,(h.undone?'已撤销：':'')+'用户判断为'+decisionLabel(h.kind),h.reason||h.evidence,h.source,'decision|'+(h.id||[h.at,h.kind].join('|')));
    for(const h of rec?.greetingHistory||[])add('greeting',h.at,({draft:'话术已准备',copied:'话术已复制',sent:'话术已发送'}[h.state]||'话术更新'),h.evidence,h.source);
    for(const h of rec?.statusHistory||[])add('status',h.at,'招聘进度：'+normalizeStatus(h.status),h.evidence,h.evidence?.source);
    if(rec?.nextActionAt)add('action',rec.nextActionAt,'下一步行动更新',rec.nextActionEvidence?.text||rec.nextAction,rec.nextActionEvidence?.source);
    return rows.sort((a,b)=>b.at-a.at).slice(0,100);
  }
  function migrateAxes(rec,now=Date.now()){
    if(rec.status!=='不考虑')return false;const at=rec.statusUpdatedAt||now;
    if(rec.discoveryState!=='dismissed')applyDecision(rec,{id:'legacy-decision-'+rec.id,kind:'dismissed',previousState:rec.discoveryState||'pending',reason:'',reasons:[],note:'',source:'migration',evidence:'旧版不考虑状态',at,feedbackState:'none'});
    rec.status='未联系';rec.statusUpdatedAt=at;rec.statusHistory=[...(rec.statusHistory||[]),{status:'未联系',at,evidence:{source:'migration',text:'拆分旧版不考虑状态'}}];return true;
  }
  function nextAction(rec,conversations=[]){
    const linked=conversations.filter(c=>c.linkedRecordId===rec.id&&!c.archive),urgent=linked.find(c=>['reply','follow','rejection','archive'].includes(c.patrol?.kind));
    if(rec.availability?.kind==='unavailable')return {id:'toggleDetails',label:'查看停招依据',reason:'岗位已停止招聘'};
    if(rec.lastScanEvent?.kind==='failed'||rec.availability?.kind==='failed')return {id:'toggleDetails',label:'查看采集问题',reason:rec.lastScanEvent?.evidence?.error||rec.availability?.reason||'最近一次读取失败，原状态已保留'};
    if(rec.discoveryState==='dismissed'||rec.status==='不考虑')return {id:'restoreRecommendation',label:'恢复待判断',reason:'你已暂不考虑'};
    const missing=['title','company','description'].filter(k=>!String(rec[k]||'').trim());
    if(missing.length)return {id:'toggleDetails',label:'补充岗位资料',reason:'缺少'+missing.map(k=>({title:'职位名',company:'公司名',description:'JD'}[k])).join('、')};
    if(urgent)return {id:'openChat',targetId:urgent.id,label:urgent.patrol.kind==='reply'?'准备回复':urgent.patrol.kind==='follow'?'准备跟进':'处理沟通结果',reason:urgent.patrol.reason};
    if(rec.recommendation?.group==='excluded'&&!rec.hardConflictResolution)return {id:'toggleConflict',label:'处理条件冲突',reason:'岗位与生效硬条件冲突'};
    if(['已投递','待我回复','等待 HR','面试中','Offer'].includes(normalizeStatus(rec.status)))return {id:'toggleDetails',label:'查看当前进展',reason:'当前阶段：'+normalizeStatus(rec.status)};
    if(rec.generationDraft)return {id:'generate',label:'修改待完善话术',reason:rec.generationDraft.review||'话术质检尚未通过'};
    if(rec.greetingState==='draft'||rec.greeting&&!rec.greetingState)return {id:'generate',label:'查看并修改话术',reason:'已有话术草稿'};
    if(rec.greetingState==='copied')return {id:'openJob',label:'打开岗位并使用话术',reason:'话术已复制，等待你在平台使用'};
    if(rec.greetingState==='sent')return {id:'toggleDetails',label:'查看后续进展',reason:'话术已确认发送'};
    if((rec.discoveryState||'pending')==='pending')return {id:'candidate',label:'加入候选',reason:'等待你的判断'};
    if(rec.discoveryState==='candidate')return {id:'generate',label:'准备话术',reason:'已加入候选'};
    if(rec.discoveryState==='skipped')return {id:'restoreRecommendation',label:'重新判断',reason:'此前已跳过'};
    return {id:'openJob',label:'打开岗位并使用话术',reason:'岗位已进入流程'};
  }
  function feedbackGroups(records){
    const groups=new Map(),aliases={'工资':'薪资','薪水':'薪资','地点':'地域','城市':'地域','岗位停止招聘':'岗位活跃度','HR不活跃':'岗位活跃度'};
    for(const r of records||[])for(const h of r.decisionHistory||[])if(h&&h.feedbackState==='pending'&&!h.undone){
      const values=[...(h.reasons||[]),h.note].filter(Boolean);for(const raw of values){const text=String(raw).trim();if(!text)continue;const preset=aliases[text]||text,key=/^(地域|薪资|能力／岗位不匹配|岗位活跃度|工作安排|其他)$/.test(preset)?preset:'补充：'+text.replace(/\s+/g,'').toLowerCase();const g=groups.get(key)||{key,label:preset,count:0,feedbackIds:[],examples:[],quotes:[]};g.count++;g.feedbackIds.push(h.id);if(g.examples.length<3)g.examples.push([r.company,r.title].filter(Boolean).join(' · '));if(g.quotes.length<3)g.quotes.push(text);groups.set(key,g);}
    }
    return [...groups.values()].sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,'zh-CN'));
  }
  const messageKey=m=>compactFingerprint(JSON.stringify([m.id||'',m.text||'',m.sentAt||null]));
  function systemNotice(text){return receiptOnly(text)||/^(?:\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}\s*)?(?:使用优先沟通，通过短信和邮箱多重提醒|求职过程中如遇收取培训费、考证费、中介费、押金|你已对境外招聘方隐藏简历，若该招聘方当前在境外)/.test(String(text||'').trim());}
  function effectiveChat(item){
    if(!item)return item;
    const confirmation=item.confirmation||{},base=item.activity||{},fingerprint=base.messageFingerprint;
    const identity=!!confirmation.identity&&confirmation.identity.key===item.key;
    const messages=(item.messages||[]).map(m=>{const fix=(confirmation.roles||[]).find(x=>x.key===messageKey(m));return fix?{...m,role:fix.role,roleSource:'user_confirmed'}:systemNotice(m.text)?{...m,role:'system',roleSource:'explicit'}:m;});
    const last=messages.filter(m=>m.role!=='system').at(-1),rolesReliable=!!last&&['candidate','hr'].includes(last.role)&&['explicit','user_confirmed'].includes(last.roleSource);
    const time=confirmation.lastMessageAt&&confirmation.lastMessageAt.fingerprint===fingerprint?confirmation.lastMessageAt.value:null;
    const appointment=confirmation.appointment&&confirmation.appointment.fingerprint===fingerprint?confirmation.appointment:null;
    const manual=messages.some((m,i)=>m.role!==item.messages[i].role)||identity||messages.some(m=>m.roleSource==='user_confirmed')||time||appointment;
    if(!manual&&(!last||base.waitingFor===chatWaitingFor(last)))return item;
    const reliable=(base.identityReliable??base.reliable)||identity;
    const timestamp=Number(time||last?.sentAt),validTime=Number.isFinite(timestamp)&&timestamp>0&&timestamp<=Date.now()?timestamp:null;
    return {...item,messages,activity:{...base,identityReliable:!!base.identityReliable,identityConfirmed:identity,rolesReliable,reliable:!!reliable&&rolesReliable,automaticReliable:!!(base.automaticReliable??base.reliable)&&last?.roleSource==='explicit'&&last?.timeReliable!==false&&!time&&!appointment&&!messages.some(m=>m.roleSource==='user_confirmed'),
      lastMessageAt:validTime,waitingFor:reliable&&rolesReliable?chatWaitingFor(last):'unknown'},
      analysis:{...item.analysis,conversationState:{...item.analysis?.conversationState,...(appointment?{appointmentUncertain:false,nextContactAt:appointment.value||null}: {})}}};
  }
  function chatWaitingFor(last){
    if(!last)return 'unknown';
    if(last.role==='candidate')return 'recruiter';
    if(last.role!=='hr')return 'unknown';
    const text=String(last.text||'');
    // Only explicit handoff/wait promises qualify; mixed questions still need a reply.
    const requests=/[?？]|请问|麻烦|请.{0,12}(?:提供|发送|发来|补充|回复|确认|告知)|方便.{0,12}(?:吗|么)/.test(text);
    return !requests&&/(?:我|我们|这边).{0,12}(?:将|会|已|帮).{0,18}(?:简历|资料).{0,12}(?:发给|转给|转交|提交)|(?:合适|有消息|有结果|通过).{0,12}(?:联系|通知|回复)你|请.{0,4}(?:耐心)?等待.{0,10}(?:通知|结果)/.test(text)?'recruiter':'user';
  }
  function noCommunication(raw){
    const marker=raw.confirmation?.noCommunication;
    if(!marker||!marker.fingerprint||marker.fingerprint!==raw.activity?.messageFingerprint||raw.scanError)return false;
    const messages=effectiveChat(raw).messages||[];
    return messages.length>0&&messages.every(m=>m.role==='system');
  }
  function chatIssues(raw){
    if(noCommunication(raw))return [];
    if(raw.confirmation?.keepOnlyChat)return [];
    const item=effectiveChat(raw),a=item.activity||{},s=item.analysis?.conversationState||{},issues=[];
    const add=(code,label,help)=>issues.push({code,label,help});
    if(!item.linkedRecordId)add('link','未关联岗位','选择已有岗位，或选择仅保留聊天；不强行创建岗位。');
    if(item.scanError){add('read','聊天读取失败',item.scanError+'；打开原聊天后重新读取。');return issues;}
    if(item.analysisError)add('analysis','聊天分析失败，原消息已保存',item.analysisError+'；核对消息后重试分析，无须重新抓取。');
    if(!item.messages?.length){add('read','未保存原消息','打开原聊天后重新读取，不能凭空确认消息。');return issues;}
    if(!((a.identityReliable??a.reliable)||a.identityConfirmed))add('identity','会话身份待核对',(a.identityEvidence?(a.identityEvidence.reason||'本次读取未提供可核对的身份依据'):'该记录没有保存身份核对依据')+(a.lastScannedAt?'；最后读取：'+new Date(a.lastScannedAt).toLocaleString():'；尚无扫描时间'));
    if(!(a.rolesReliable??a.reliable)){const last=item.messages?.filter(m=>m.role!=='system').at(-1);add('roles',last?'最后有效消息的发送方待核对':'没有已确认的双方消息',last?'待核对原句：'+String(last.text||'（无文字）').slice(0,180)+'。请选择我、招聘方或系统提示。':'全部消息目前被标为系统提示，请修正原消息或重新读取。');}
    if(!a.lastMessageAt&&a.waitingFor!=='user')add('time','最后消息时间待核对','重新读取或填写实际消息时间；保持未知就不判断超时。');
    if(raw.confirmation?.routing&&raw.confirmation.routing.fingerprint===a.messageFingerprint&&raw.confirmation.routing.status==='pending')add('routing','分析后确认归类','核对建议类别，确认后才归入；也可手动选择。');
    if(s.appointmentUncertain)add('appointment','约定日期待核对','填写已确认日期，或明确没有约定；不确定时不自动归档。');
    if(!item.analysisError&&(!item.analysis||!Object.keys(item.analysis).length))add('analysis','聊天尚未分析','使用已保存的消息重新分析，不需要重新抓取岗位。');
    return issues;
  }
  function activity(chat, previous = {}, now = Date.now()) {
    const messages = chat.messages || [], last = messages.filter(m=>m.role!=='system'&&!systemNotice(m.text)).at(-1);
    const changed = fingerprint(messages) !== previous.messageFingerprint;
    const timestamp = last && Number(last.sentAt);
    const rolesReliable=!!last&&['candidate','hr'].includes(last.role)&&last.roleSource==='explicit';
    const reliable = !!chat.identityReliable && rolesReliable && !(previous.lastMessageAt && timestamp && timestamp < previous.lastMessageAt);
    const out = { identityEvidence:{method:chat.identityEvidence?.method||(chat.identityReliable?'platform-id':'unverified'),key:chat.identityEvidence?.key||chat.conversationKey||'',reason:chat.identityEvidence?.reason||(chat.identityReliable?'':'读取结果缺少身份依据：页面脚本或备用读取器未更新'),readerVersion:chat.readerVersion||'',at:now},messageFingerprint: fingerprint(messages), lastScannedAt: now,
      lastMessageAt: Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now ? timestamp : null,
      waitingFor: reliable ? chatWaitingFor(last) : 'unknown',
      identityReliable:!!chat.identityReliable,rolesReliable,automaticReliable:reliable&&last?.timeReliable!==false,reliable, changed, lastChangeObservedAt: changed ? now : (previous.lastChangeObservedAt || null) };
    return out;
  }
  function patrol(item, config, now = Date.now()) {
    item=effectiveChat(item);const a = item.activity || {}, s = item.analysis && item.analysis.conversationState || {};
    if (item.scanError) return { kind: 'unknown', reason: '本次读取失败，暂不判断超时' };
    if (noCommunication(item)) return {kind:'not_started',reason:'已确认只有系统提示，尚未开始沟通'};
    if (item.analysisError) return {kind:'unknown',reason:'聊天分析失败，原消息已保存'};
    if (!a.reliable) return { kind:'unknown',reason:!((a.identityReliable??a.reliable)||a.identityConfirmed)?'会话身份待核对':'最后有效消息的发送方待核对' };
    const route=item.confirmation?.routing;if(route&&route.fingerprint===a.messageFingerprint&&route.status==='pending')return {kind:'unknown',reason:'等待确认分析建议的类别'};
    if(a.waitingFor==='recruiter'&&(item.restoredFingerprint&&item.restoredFingerprint===a.messageFingerprint||item.restoredHumanFingerprint&&item.restoredHumanFingerprint===fingerprint((item.messages||[]).filter(m=>m.role!=='system'))))return {kind:'waiting',reason:'已恢复，等待新的有效沟通'};
    if (s.rejectionEvidence&&(item.messages||[]).some(m=>m.role==='hr'&&['explicit','user_confirmed'].includes(m.roleSource)&&String(m.text||'').includes(s.rejectionEvidence))) return { kind: 'rejection', reason: s.rejectionEvidence };
    if (s.appointmentUncertain) return { kind: 'unknown', reason: '约定时间不明确，请人工确认' };
    if (Number(s.nextContactAt) > now) return { kind: 'waiting', reason: '等待约定日期', dueAt: Number(s.nextContactAt) };
    if(route&&route.fingerprint===a.messageFingerprint&&route.status==='confirmed'&&['reply','follow'].includes(route.kind))return {kind:route.kind,reason:route.reason||'用户确认归类'};
    if (a.waitingFor === 'user') return { kind: 'reply', reason: '最后一条为招聘方消息，请核对是否需要回复' };
    if (!a.lastMessageAt) return { kind: 'unknown', reason: '无法确认最后消息时间' };
    const history=[...(item.messageHistory||[]),...(item.messages||[])].filter(m=>m.role!=='system'&&!systemNotice(m.text)).map(m=>{const latest=item.messages?.find(x=>messageKey(x)===messageKey(m));return latest||m;});
    const inferred=history.at(-1)?.timeReliable===false&&!(item.confirmation?.lastMessageAt?.fingerprint===a.messageFingerprint&&item.confirmation.lastMessageAt.value);
    if(a.reliable&&history.length&&history.every(m=>m.role==='candidate'&&['explicit','user_confirmed'].includes(m.roleSource))&&now-a.lastMessageAt>=2*day&&!['面试中','Offer','拒绝'].includes(item.manualProgress?.status))return {kind:'archive',reason:'打招呼已满48小时，未收到招聘方回复'+(inferred?'；日期为推断，请核对后确认回收':''),policy:inferred?'inferred-time':'greeting-48h'};
    const base = Math.max(a.lastMessageAt, Number(s.nextContactAt) || 0);
    const elapsed = Math.floor((now - base) / day);
    if(['面试中','Offer','拒绝'].includes(item.manualProgress?.status))return {kind:'waiting',reason:'保留已确认招聘阶段，不按普通沟通超时回收'};
    if (a.waitingFor === 'recruiter' && elapsed >= config.archiveDays) return { kind: 'archive', reason: '等待招聘方 ' + elapsed + ' 天，超时未推进'+(inferred?'；日期为推断，请核对后确认回收':'') };
    if (a.waitingFor === 'recruiter' && elapsed >= config.followDays) return { kind: 'follow', reason: '等待招聘方 ' + elapsed + ' 天，建议跟进' };
    if(route&&route.fingerprint===a.messageFingerprint&&route.status==='confirmed'&&['waiting','reply','follow'].includes(route.kind))return {kind:route.kind,reason:route.reason||'用户确认归类'};
    return { kind: 'waiting', reason: '尚未达到跟进期限' };
  }
  function mergeJob(records, job, recommendation, now = Date.now()) {
    const key = jobKey(job.url); if (!key) throw new Error('无有效猎聘岗位链接');
    let rec = uniqueRecords(records).find(r => recordKey(r) === key);
    const added=!rec;
    if (!rec) {const applied=job.sourceKind==='apply',evidence=applied?{source:'apply-list',text:job.applicationStatusText||'应聘记录'}:null;rec={id:key,platformJobKey:key,status:applied?'已投递':'未联系',discoveryState:'pending',createdAt:now,notes:'',statusUpdatedAt:now,statusHistory:[{status:applied?'已投递':'未联系',at:now,...(evidence?{evidence}: {})}],...(applied?{appliedAt:now,statusEvidence:{...evidence,at:now}}:{})};records.unshift(rec);}
    else if(!rec.platformJobKey)rec.platformJobKey=key;
    const rawSourceUrl=job.sourceUrl||job.url,sourceUrl=jobKey(rawSourceUrl)?new URL(rawSourceUrl).origin+new URL(rawSourceUrl).pathname:rawSourceUrl,jobUrl=new URL(job.url).origin+new URL(job.url).pathname,normalizedJob={...job,url:jobUrl,sourceUrl},source='job:'+(job.sourceKind||'unknown')+':'+sourceUrl,snapshot=compactSource(normalizedJob),fingerprint=compactFingerprint(JSON.stringify(snapshot)),event=addEvent(rec,source,'job-observed',fingerprint,now,{url:jobUrl});job=normalizedJob;
    rec.lastScanEvent={source,kind:event.duplicate?'duplicate':added?'added':'updated',fingerprint,at:now,evidence:{url:job.url}};
    rec.lastJobScanAt=now;
    if(event.duplicate){if(job.sourceKind){rec.sources=Array.isArray(rec.sources)?rec.sources:[];const seen=rec.sources.find(s=>s&&s.kind===job.sourceKind&&s.url===sourceUrl);if(seen)seen.lastSeenAt=now;}return rec;}
    // Keep user-edited fields; newest source snapshot remains available for inspection.
    const previousSource=rec.sourceSnapshot||{};
    for (const field of ['title','company','companyType','workAddress','benefits','industry','companyDescription','location','salary','description','url','experience','education','size','hrActive','hrActiveText','publishedText','publishedAt']) if (job[field] && (!rec[field] || (previousSource[field] && rec[field]===previousSource[field] || field==='companyDescription'&&previousSource.companyDescriptionFingerprint===compactFingerprint(rec[field]||'')))) rec[field] = job[field];
    if(job.hrActive||job.hrActiveText)rec.hrActiveCheckedAt=now;
    if(job.sourceKind==='apply'||['已投','已投递'].includes(job.applicationStatus))applyStatus(rec,'已投递',now,true,{source:job.sourceKind==='apply'?'apply-list':'job-page',text:job.applicationStatusText||'应聘记录'});
    if(job.title&&job.company&&job.description)rec.lastCompleteJobAt=now;
    if(job.sourceKind)addSource(rec,job.sourceKind,sourceUrl,now);
    rec.sourceSnapshot = snapshot;if(job.availability==='unavailable'||job.title&&job.company&&job.description)applyAvailability(rec,job.availability==='unavailable'?'unavailable':'available',now,{source,text:job.availabilityReason||'岗位详情可读取',reason:job.availabilityReason});
    if(recommendation)rec.recommendation=recommendation;
    else staleMatch(rec,'岗位资料变化');
    return rec;
  }
  function matchRecord(records, item) {
    const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const title = norm(item.jobTitle || item.analysis && item.analysis.jobTitle), company = norm(item.company || item.analysis && item.analysis.company);
    if (!title || !company || /^(未知|待确认|不详|unknown|null)$/.test(title) || /^(未知|待确认|不详|unknown|null)$/.test(company)) return null;
    // ponytail: unique exact title + company only; ambiguous matches remain manual.
    const matches = records.filter(r => norm(r.title) === title && norm(r.company) === company);
    return matches.length === 1 ? matches[0] : null;
  }
  function staleMatch(rec,reason,labels){
    rec.recommendation={...rec.recommendation,stale:true,staleReason:reason,analysisStatus:'waiting',staleLabels:labels||null};
  }
  function requirementMatch(recommendation={},config) {
    const rating=recommendation.rating||{};
    const pair=(checks,requirements)=>{
      const saved=activePreferences(Array.isArray(checks)?checks:[]);
      return (requirements===undefined?saved:activePreferences(requirements)).map(p=>{
        const c=saved.find(x=>x.label===p.label)||{label:p.label,kind:'unknown',evidence:[]};
        return {...c,stale:!!recommendation.stale&&(!Array.isArray(recommendation.staleLabels)||recommendation.staleLabels.includes(p.label)),userRequirement:p.meaning||c.userRequirement||p.label};
      });
    };
    const hardChecks=pair(recommendation.hardChecks,config?(config.hardRequirements||[]):undefined),concerns=pair(rating.concerns,config?(config.softPreferences||[]):undefined);
    const checks=[...hardChecks,...concerns],known=checks.filter(c=>!c.stale&&['meets','conflicts'].includes(c.kind));
    const preferenceFit=!known.length?null:Math.round(known.reduce((sum,c)=>sum+(c.kind==='meets'?5:1),0)/known.length*10)/10;
    const coreStale=!!recommendation.stale&&!Array.isArray(recommendation.staleLabels);
    return {hardChecks,rating:{...rating,core:Object.fromEntries(Object.entries(rating.core||{}).map(([key,c])=>[key,{...c,stale:coreStale}])),...(coreStale?{candidateFit:null}:{}),concerns,preferenceFit,known:known.length,total:checks.length},requirementRules:config?{hard:hardChecks.map(c=>c.label),soft:concerns.map(c=>c.label)}:null};
  }
  function cards(records, conversations, runs = {}, config) {
    const feedbackCount=records.flatMap(r=>Array.isArray(r.decisionHistory)?r.decisionHistory:[]).filter(h=>h&&h.feedbackState==='pending'&&!h.undone).length;
    records=uniqueRecords(records);
    conversations=conversations.map(c=>{const effective=effectiveChat(c);return {...effective,patrol:c.activity?patrol(c,config?validateConfig(config):validateConfig({})):c.patrol};});
    const names=new Map();for(const r of records){const name=[r.title,r.company].join('|');if(r.title&&r.company){const group=names.get(name)||[];group.push(r);names.set(name,group);}}
    const context=c=>{const r=records.find(r=>r.id===c.linkedRecordId)||{};return {...requirementMatch(r.recommendation||{},config),stale:r.recommendation&&r.recommendation.stale,stage:c.analysis&&c.analysis.conversationState&&c.analysis.conversationState.stage,waitingFor:c.activity&&c.activity.waitingFor,lastMessageAt:c.activity&&c.activity.lastMessageAt,nextAction:r.nextAction,legacyAnalysis:c.analysis};};
    const chatCard=c=>({issues:chatIssues(c),keepOnlyChat:!!c.confirmation?.keepOnlyChat,failureKey:c.lastScanEvent?.kind==='failed'?'chat:'+c.id+':'+c.lastScanEvent.at:undefined,id:c.id,recordId:c.linkedRecordId,title:c.jobTitle||c.counterparty,company:c.company,lastScanEvent:c.lastScanEvent,...context(c),...(c.handledFingerprint&&c.handledFingerprint===c.activity?.messageFingerprint?{kind:'waiting',reason:'已处理，等待下一次消息扫描'}:c.patrol||{kind:'unknown',reason:'尚未巡检'}),archive:c.archive||null});
    const card=r=>({failureKey:r.lastScanEvent?.kind==='failed'?'record:'+r.id+':'+r.lastScanEvent.at:undefined, hardFilterConflicts:config?filter(r,config).rejected:[],id:r.id,hasDescription:!!r.description,title:r.title,company:r.company,companyType:r.companyType,url:r.url,location:r.location,salary:r.salary,communicationArchive:r.communicationArchive,hrActive:r.hrActive,hrActiveText:r.hrActiveText,publishedText:r.publishedText,status:normalizeStatus(r.status),notes:r.notes||'',waitingSummary:conversations.filter(c=>c.linkedRecordId===r.id&&!c.archive).map(c=>[({recruiter:'等待HR',user:'待我回复',unknown:'等待对象待确认'})[c.activity?.waitingFor],c.patrol?.reason,c.activity?.lastMessageAt?'最后消息 '+new Date(c.activity.lastMessageAt).toLocaleString():null].filter(Boolean).join(' · ')).join('；'),score:r.scores?.overall,scores:r.scores,scoreError:r.scoreError,scoreStatus:r.scoreStatus,scoreStage:r.scoreStage,scoreInputSignature:r.scoreInputSignature,scoreCheckedAt:r.scoreCheckedAt,scoreInfo:scoreInfo(r),nextAction:r.nextAction,primaryAction:nextAction(r,conversations),discoveryState:r.discoveryState,decisionAt:r.userDecision?.at,availability:r.availability,sources:r.sources,lastScanEvent:r.lastScanEvent,analysisMetrics:r.recommendation?.analysisMetrics,captureDurationMs:r.captureDurationMs,analysisStatus:r.recommendation?.analysisStatus,analysisError:r.recommendation?.analysisError,researchError:r.recommendation?.researchError,staleReason:r.recommendation?.staleReason,staleLabels:r.recommendation?.staleLabels,stale:r.recommendation?.stale,brief:r.recommendation?.brief,group:r.recommendation?.group,reasons:r.recommendation?.reasons,evidence:r.recommendation?.evidence,gaps:r.recommendation?.gaps,unknown:r.recommendation?.unknown,hardConflictResolution:r.hardConflictResolution,...requirementMatch(r.recommendation||{},config) });
    const recentIds=runs.discover?.resultIds||[],failedIds=new Set((runs.discover?.failedResultIds||[]).filter(id=>{const r=records.find(r=>r.id===id);return !r?.lastScanEvent||r.lastScanEvent.kind==='failed';}));
    const labels={location:'地点',salary:'薪资',experience:'经验',education:'学历',size:'规模',companyType:'公司类型',hrActiveText:'HR活跃度'};
    const duplicateJobs=[...names.entries()].filter(([,group])=>group.length>1).flatMap(([key,group])=>{const sorted=[...group].sort((a,b)=>recordTime(b)-recordTime(a)),latest=sorted[0],existing=sorted[sorted.length-1];if(latest.duplicateIgnoredKey===key)return[];const differences=Object.keys(labels).flatMap(field=>String(latest[field]||'')===String(existing[field]||'')?[]:[{label:labels[field],before:existing[field]||'未记录',after:latest[field]||'未记录'}]);if(compactFingerprint(latest.description)!==compactFingerprint(existing.description))differences.push({label:'JD',before:'原记录',after:'抓取内容有变化'});return [{...card(latest),duplicateOfId:existing.id,duplicateOfTitle:existing.title,differences}];});
    const chatIds=runs.patrol?.resultConversationIds||[],chatFailed=new Set(runs.patrol?.failedConversationIds||[]),recentChats=chatIds.map(id=>conversations.find(c=>c.id===id)).filter(Boolean);
    const ignored=new Set(Object.values(runs).flatMap(r=>r?.ignoredFailureKeys||[]));
    const taskFailures=Object.entries(runs).flatMap(([taskKind,run])=>(run?.failures||[]).map(f=>({...f,taskKind,failureKey:taskKind+':'+compactFingerprint(JSON.stringify([f.at,f.item,f.url,f.stage,f.message]))}))).filter(f=>!ignored.has(f.failureKey));
    return { generatedAt: Date.now(), runs,taskFailures,feedbackCount,possibleDuplicates:duplicateJobs.map(r=>r.id),duplicateJobs,
      recentJobs:recentIds.map(id=>records.find(r=>r.id===id)).filter(Boolean).map(card),recentFailures:recentIds.filter(id=>failedIds.has(id)).map(id=>records.find(r=>r.id===id)).filter(r=>r&&!ignored.has('record:'+r.id+':'+r.lastScanEvent?.at)).map(card),
      recentSuccesses:recentIds.filter(id=>!failedIds.has(id)).map(id=>records.find(r=>r.id===id)).filter(r=>r&&r.availability?.kind==='available'&&r.title&&r.company&&r.description&&r.recommendation?.group!=='confirm'&&!r.recommendation?.stale&&!['failed','partial'].includes(r.recommendation?.analysisStatus)).map(card),
      confirmationJobs:records.filter(r=>r.discoveryState!=='dismissed'&&r.lastScanEvent?.kind!=='failed'&&(!r.title||!r.company||!r.description)).map(card),
      recentConfirmations:recentIds.map(id=>records.find(r=>r.id===id)).filter(r=>r&&!failedIds.has(r.id)&&(!r.title||!r.company||!r.description)).map(card),
      recentChatSuccesses:recentChats.filter(c=>!chatFailed.has(c.id)&&c.linkedRecordId&&c.patrol?.kind!=='unknown').map(chatCard),
      recentChatFailures:recentChats.filter(c=>(chatFailed.has(c.id)||c.lastScanEvent?.kind==='failed')&&!ignored.has('chat:'+c.id+':'+c.lastScanEvent?.at)).map(chatCard),
      recentChatConfirmations:recentChats.filter(c=>!chatFailed.has(c.id)&&chatIssues(c).length>0).map(chatCard),
      standaloneChats:conversations.filter(c=>c.confirmation?.keepOnlyChat||noCommunication(c)).map(chatCard),
      lastDecision:records.filter(r=>r.userDecision).sort((a,b)=>b.userDecision.at-a.userDecision.at).map(r=>({id:r.id,at:r.userDecision.at}))[0]||null,
      dismissedRecommendations: records.filter(r=>r.discoveryState==='dismissed').map(r=>({id:r.id,title:r.title,company:r.company,salary:r.salary,reason:r.userDecision?.reason,discardAfter:r.discardAfter,url:r.url})),
      activeJobs: records.filter(r=>r.discoveryState!=='dismissed'&&!['拒绝','不考虑'].includes(r.status)&&!r.communicationArchive&&(normalizeStatus(r.status)!=='未联系'||r.greeting||r.generationDraft||r.greetingState||conversations.some(c=>c.linkedRecordId===r.id&&!c.archive&&c.patrol?.kind==='waiting'))).sort((a,b)=>recordTime(b)-recordTime(a)).map(card),
      recommendations: records.filter(r => ['pending','candidate','skipped'].includes(r.discoveryState) && normalizeStatus(r.status)==='未联系' && !r.communicationArchive && !(r.greeting||r.generationDraft||r.greetingState)).map(card),
      actions: conversations.filter(c => c.patrol && ['reply','follow','rejection'].includes(c.patrol.kind) && c.handledFingerprint !== (c.activity && c.activity.messageFingerprint) && !c.archive).map(chatCard),
      waiting: conversations.filter(c => c.archive || !c.patrol || !['reply','follow','rejection'].includes(c.patrol.kind) || c.handledFingerprint === (c.activity && c.activity.messageFingerprint)).map(chatCard) };
  }
  function scoreFacts(rec){return Object.fromEntries(['id','title','company','description','location','salary','size'].filter(k=>rec[k]!==undefined).map(k=>[k,rec[k]]));}
  function scoreInfo(rec){
    if(rec.scoreError)return {message:rec.scoreError,retry:true};
    if(rec.scoreStatus==='running')return {message:'评分尚未完成；长时间无结果可重试',retry:true};
    if(rec.scoreJobSignature&&rec.scoreJobSignature!==compactFingerprint(JSON.stringify(scoreFacts(rec))))return {message:'岗位资料已变化，保留原评分，待更新',retry:true};
    if(!rec.scores)return {message:'未保存多维评分；历史执行阶段未记录',retry:true};
    if(!rec.scoreInputSignature)return {message:'保留历史评分，可重新核对',retry:true};
    return {message:'评分已保存',retry:false};
  }
  return { generationProgress,recordKey,duplicateGroups,mergeRecords,receiptOnly,canonicalChatKey,findConversation,mergeConversationDuplicates,noCommunication,taskProgress,messageKey,effectiveChat,chatIssues,retainMessages,archiveConversation,staleMatch,requirementMatch,scoreFacts,scoreInfo,statuses,normalizeStatus,isApplied,isReplied,applyStatus,applyAvailability,applyDecision,undoDecision,applyGreeting,applyNextAction,normalizeRecord,migrateAxes,addEvent,addSource,linkConversation,unlinkConversation,nextAction,feedbackGroups,conversationStatus,unrestricted,activePreferences,generationIssue,uniqueRecords,parseImport,evidenceSources,averageScores,preferenceCheck,recommendationRating,directionFromPage,matchRecord,recordById,timeline,managed,recordTime,decisionLabel,jobKey,searchUrl,listKind,validateConfig,filter,fingerprint,compactFingerprint,compactSource,activity,patrol,mergeJob,cards };
})();

