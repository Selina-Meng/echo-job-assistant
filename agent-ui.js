globalThis.EchoAgentUI = (() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const $ = id => document.getElementById(id);
  const list=v=>Array.isArray(v)?v:[];
  async function send(type, extra={}) {
    const r=await chrome.runtime.sendMessage({type,...extra});
    if(!r||!r.ok){const e=new Error(r&&r.error||'后台无响应');e.result=r&&r.result;throw e;}return r.data;
  }
  const button=(action,id,label)=>'<button type="button" data-agent-action="'+action+'" data-id="'+esc(id)+'">'+label+'</button>';
  const progressText=p=>'已识别 '+p.identified+' 个唯一岗位｜已读取 '+(p.read??'未记录')+'｜已分析 '+(p.analyzed??'未记录')+'｜失败 '+(p.failed??'未记录');
  function runStatus(runs={}){
    return ['discover','patrol'].map(k=>{const r=runs[k],failed=Number(r?.stats?.failed)||0,label=k==='discover'&&r?.scopes?.some(x=>x.startsWith('更新匹配'))?'更新匹配':k==='discover'?'岗位采集':'抓取聊天';
      const state=!r?'尚未运行':r.status==='completed'?'本次范围处理完成':r.status==='cancelled'?'已结束，保留已有结果':r.error?'未完成，请处理错误':'处理中 / 可继续';
      return '<article class="agent-run'+(failed||r?.error?' has-failure':'')+'"><b>'+label+'：'+state+'</b>'+(k==='discover'&&r?.progress?'<p>'+progressText(r.progress)+'</p>':'')+(r?.stats&&!(k==='discover'&&r?.progress)?'<p>新增 '+(r.stats.added||0)+' · 更新 '+(r.stats.updated||0)+' · 重复 '+(r.stats.duplicates||0)+' · <strong class="'+(failed?'failure-count':'')+'">失败 '+failed+'</strong></p>':'')+(r?.error?'<p class="failure-count">'+esc(r.error)+'</p>':'')+'</article>';
    }).join('');
  }
  const scoreLabels={roleMatch:'岗位方向',skillFit:'能力匹配',salary:'薪资',location:'地点',company:'公司平台',techStack:'技能工具',growth:'成长空间',interviewDifficulty:'面试难度',time:'时间投入',wlb:'工作生活平衡',industryScale:'行业规模',prosCons:'公司优缺点',overtime:'加班情况'};
  function scoreDetails(r={}){
    const info=r.scoreInfo||AgentCore.scoreInfo(r),s=r.scores||{},rows=[];for(const [group,label] of [['job','岗位'],['company','公司']])for(const [key,value] of Object.entries(s[group]||{}))if(key!=='total'&&value&&typeof value==='object')rows.push('<tr><td>'+label+'</td><td>'+esc(scoreLabels[key]||key)+'</td><td>'+esc(value.score==null?'数据不足':value.score+'/5')+'</td><td>'+esc(String(value.reason||'数据不足').slice(0,90))+'</td></tr>');
    const overall=typeof s.overall==='number'?s.overall:typeof r.score==='number'?r.score:null;
    return '<details class="agent-score"><summary aria-label="显示岗位综合评分表">★ '+esc(overall==null?'待评分':overall.toFixed(1)+'/5')+'</summary>'+('<p>'+esc(info.message)+'</p>'+(info.retry&&r.id?button('retryScore',r.id,'重试多维评分'):''))+(rows.length?'<table><thead><tr><th>类别</th><th>维度</th><th>评分</th><th>简要依据</th></tr></thead><tbody>'+rows.join('')+'</tbody></table>':'<p>暂无多维评分结果。</p>')+'</details>';
  }
  function matching(r={}) {
    const rating=r.rating||{},states={meets:'明确符合',conflicts:'明确冲突',signal:'间接信号',unknown:'暂无依据'};
    const urlLink=e=>{try{const u=new URL(e.url);return ['http:','https:'].includes(u.protocol)?'<a href="'+esc(u.href)+'" target="_blank" rel="noopener noreferrer">'+esc(e.title||u.hostname)+'</a>':'';}catch(_){return '';}};
    const row=(label,state,proof,reason)=>'<tr><td>'+esc(label)+'</td><td>'+proof+'</td><td>'+esc([state,reason].filter(Boolean).join('：')||'暂无可核对依据')+'</td></tr>';
    const checks=[...Object.values(rating.core||{}),...AgentCore.activePreferences(list(r.hardChecks)),...AgentCore.activePreferences(list(rating.concerns))].filter(Boolean);
    const rows=checks.map(c=>{const external=list(c.evidence).filter(e=>e.url),proofs=[c.quote,...list(c.evidence).map(e=>e.quote)].filter(Boolean);
      const proof=esc(proofs.join('；')||'尚无可核对依据')+(external.length?'<details><summary>来源与查询时间（联网摘要）</summary>'+external.map(e=>'<p>'+urlLink(e)+' · '+esc(e.at?new Date(e.at).toLocaleString():'时间未知')+'</p>').join('')+'</details>':'');
      const verification={supported:'有直接依据',inferred:'AI初判',unverified:'未核实',missing:'模型漏项',needs_confirmation:'需求待确认',conflicting:'依据有冲突'}[c.verification]||'';
      const conclusion=c.kind==='signal'?(c.direction==='meets'?'可能符合，需用户判断':c.direction==='conflicts'?'可能不符合，需用户判断':'可能相关，需用户判断'):states[c.kind]||(c.score==null?'暂无依据':c.score+'/5');
      const id=r.recordId||(!Object.hasOwn(r,'recordId')?r.id:null);
      const retry=id&&c.label&&[...list(r.hardChecks),...list(rating.concerns)].includes(c)?'<button type="button" data-agent-action="retryMatch" data-id="'+esc(id)+'" data-label="'+esc(c.label)+'" class="agent-retry" title="重新分析此项" aria-label="重新分析此项">↻</button>':'';
      return row(c.userRequirement||c.label||'岗位匹配',c.stale?'等待分析':[conclusion,verification].filter(Boolean).join(' · '),proof+retry,[c.reason,c.researchError?'联网补充失败：'+c.researchError:'',c.question?'待确认：'+c.question:''].filter(Boolean).join('；'));

    });
    for(const e of list(r.evidence))rows.push(row(e.requirement,'经历对应',esc(e.requirement),e.projectQuote));
    const value=v=>typeof v==='number'?v.toFixed(1)+'/5':'待确认';
    const status=r.analysisStatus==='running'?'分析中':r.analysisStatus==='failed'?'更新失败：'+(r.analysisError||'请重试'):r.researchError?'联网补充失败，保留已有分析：'+r.researchError:r.analysisStatus==='partial'?'部分项目未完成，请查看分项原因并重试':r.stale?'等待分析：'+(r.staleReason||'需求或岗位资料变化'):'';
    const metrics=r.analysisMetrics,diagnostic=metrics?'<details><summary>分析耗时与调用次数</summary><p>匹配模型 '+metrics.modelCalls+' 次 · 模型 '+Math.round(metrics.modelMs/1000)+' 秒 · 联网步骤（含缓存） '+Math.round(metrics.researchMs/1000)+' 秒 · 匹配总计 '+Math.round(metrics.totalMs/1000)+' 秒。原综合评分另行执行。</p></details>':'';
    return '<div class="agent-matching">'+diagnostic+'<p class="agent-dual">我符合岗位吗：'+value(Object.hasOwn(rating,'candidateFit')?rating.candidateFit:AgentCore.averageScores(rating.core||{},['roleMatch','skillFit']))+' · 岗位符合我吗：'+value(rating.preferenceFit)+' · 需求证据：'+esc(rating.known??0)+'/'+esc(rating.total??0)+'</p>'+(status?'<p role="status">'+esc(status)+'</p>':'')+((r.recordId||(!Object.hasOwn(r,'recordId')&&r.id))&&r.analysisStatus!=='running'?button('retryMatch',r.recordId||r.id,status?'重试匹配分析':'更新匹配分析'):'')+'<div class="agent-match-table"><table><thead><tr><th>需求</th><th>岗位依据</th><th>AI解释</th></tr></thead><tbody>'+(rows.join('')||row('匹配结果','暂无依据','岗位未说明','请启动匹配分析'))+'</tbody></table></div></div>';
  }
  function requirementNotice(r){
    const rules=r.requirementRules,hardChecks=AgentCore.activePreferences(list(r.hardChecks)).filter(x=>!rules||list(rules.hard).includes(x.label)),softChecks=AgentCore.activePreferences(list(r.rating?.concerns)).filter(x=>!rules||list(rules.soft).includes(x.label));
    const ignored=r.hardConflictResolution?.kind==='ignored',hard=ignored?[]:hardChecks.filter(x=>x.kind==='conflicts').map(x=>x.label);
    if(!ignored&&!rules&&r.group==='excluded')hard.push(...list(r.reasons).filter(x=>/硬条件冲突：|地点|城市|薪资|工资|排除/.test(x)).map(x=>String(x).replace(/^硬条件冲突：/,'')));
    if(!ignored)hard.push(...list(r.hardFilterConflicts));
    const labels=[...new Set(hard)],soft=softChecks.some(x=>x.kind==='conflicts');
    const state=(checks,expected)=>expected?.length===0?'未设置':checks.some(c=>c.stale)?'等待分析':(expected||checks.map(x=>x.label)).length>0&&(expected||checks.map(x=>x.label)).every(label=>checks.some(x=>x.label===label&&x.kind==='meets'))?'符合':'待核对';
    return {hard:labels.length>0,html:(labels.length?'<p class="agent-hard-warning"><span class="agent-rule hard">硬要求不符合</span>：'+esc(labels.join('、'))+(hardChecks.some(c=>c.stale)?'（等待分析）':'')+'</p>':'<p><span class="agent-rule hard">硬要求</span>：'+(ignored?'本次已忽略冲突':state(hardChecks,rules?list(rules.hard):undefined))+'</p>')+(soft?'<p class="agent-soft-warning"><span class="agent-rule soft">软要求</span>有软要求不符合，请展开确认'+(softChecks.some(c=>c.stale)?'（等待分析）':'')+'</p>':'<p><span class="agent-rule soft">软要求</span>：'+state(softChecks,rules?list(rules.soft):undefined)+'</p>')};
  }
  function inspection(r,extra=''){
    return '<div class="agent-job-details" hidden>'+scoreDetails(r)+matching(r)+extra+'</div>';
  }
  const scoreButton=r=>button('showScore',r.id,'★ '+(typeof r.scores?.overall==='number'?r.scores.overall.toFixed(1):typeof r.score==='number'?r.score.toFixed(1):'待评分'));
  function jobActions(r,actions){return '<div class="progress-actions">'+actions+button('openSource',r.id,'打开来源')+button('progressDetails',r.id,'展开详情')+'</div>'+scoreButton(r);}
  function conversationCard(c,waiting=false){
    const reason=String(c.archive?'已归档：'+c.archive.reason:c.reason||'待确认'),name=[c.company,c.title].filter(Boolean).join(' · ')||'未识别会话';
    return '<article data-card-id="'+esc(c.id)+'"><b>'+esc(name)+'</b><p>'+esc([c.recordId?'':'待补岗位资料',c.stage,({user:'等待我回复',recruiter:'等待招聘方',unknown:'等待对象待确认'})[c.waitingFor],c.lastMessageAt?'最后消息 '+new Date(c.lastMessageAt).toLocaleString():'消息时间未知'].filter(Boolean).join(' · '))+'</p><p>'+esc((c.issues?.length?c.issues.map(x=>x.label).join('；'):reason).slice(0,120))+'</p><div class="progress-actions">'+(c.failureKey?button('ignoreFailure',c.failureKey,'忽略本次失败'):'')+button('openChatSource',c.id,'打开来源')+(c.issues?.length?button('resolveChat',c.id,'处理确认事项'):'')+(!c.archive&&(c.issues?.length||['unknown','archive','rejection'].includes(c.kind))?button('recycleChat',c.id,'放入回收站'):'')+button('openChat',c.id,c.recordId?(c.kind==='reply'?'准备回复':c.kind==='follow'?'准备跟进':'查看沟通'):'补充 / 关联岗位')+'</div><details><summary>分析与其他操作</summary><p>'+esc(reason)+'</p>'+matching(c)+(c.recordId?(waiting?(c.archive?button('restore',c.id,'恢复'):['archive','rejection'].includes(c.kind)?button('archive',c.id,c.kind==='rejection'?'确认拒绝归档':'确认超时归档'):''):button('handled',c.id,'标记已处理')):'')+'</details></article>';
  }
  function progressCard(r){
    const notice=requirementNotice(r);
    return '<article class="agent-job" data-card-id="'+esc(r.id)+'"><b>'+esc(r.title||'岗位资料待确认')+'</b><p>'+esc([r.company,r.salary,r.location].filter(Boolean).join(' · '))+'</p>'+ (cardMode==='list'?'<label><input type="checkbox" data-agent-select="'+esc(r.id)+'"'+(selectedJobs.has(r.id)?' checked':'')+'> 批量选择</label>':'')+notice.html+'<p>状态：'+esc(AgentCore.normalizeStatus(r.status))+'</p><p>'+esc(r.waitingSummary||r.nextAction||r.notes||'')+'</p>'+'<div class="progress-actions">'+(notice.hard?button('toggleConflict',r.id,'处理条件冲突'):'')+button('progressDetails',r.id,'展开详情')+button('editProgress',r.id,'更新进度')+button('dismiss',r.id,'暂不考虑')+button('openSource',r.id,'打开来源')+'</div>'+scoreButton(r)+inspection(r)+'</article>';
  }
  let cardMode='single',cardCategory=0,cardCategoryKey='',snoozedFeedback=0,onlyRecent=false,recycleFilter='all';
  const selectedJobs=new Set(),selectedFailures=new Set(),positions=new Map();
  const failureChoice=(html,key)=>cardMode==='list'&&key?'<section><label><input type="checkbox" data-failure-select="'+esc(key)+'"'+(selectedFailures.has(key)?' checked':'')+'> 选择失败事项</label>'+html+'</section>':html;
  function cards(data,focused=false) {
    if(!data)return '';
    const taskFailure=f=>'<article><b>'+esc(f.item||'未识别项目')+'</b><p>'+esc([f.stage,f.message].filter(Boolean).join('：').slice(0,180))+'</p><div class="progress-actions">'+button(AgentCore.jobKey(f.url)?'openFailure':'collection',f.url||'',AgentCore.jobKey(f.url)?'打开来源':'补充链接 / 返回采集')+(AgentCore.jobKey(f.url)?button('retryFailure',f.url,'只重试该失败岗位'):'')+(f.failureKey?button('ignoreFailure',f.failureKey,'忽略'):'')+'</div></article>';
    const job=r=>{
      const notice=requirementNotice(r),head='<b>'+esc(r.title||'岗位资料待确认')+'</b><p>'+esc([r.company,r.companyType==='猎头'?'猎头岗位':'',r.location,r.salary,r.hrActiveText||r.hrActive,r.publishedText].filter(Boolean).join(' · '))+'</p>'+notice.html+(cardMode==='list'&&cardCategoryKey!=='failures'?'<label><input type="checkbox" data-agent-select="'+esc(r.id)+'"'+(selectedJobs.has(r.id)?' checked':'')+'> 批量选择</label>':'');
      const failed=r.lastScanEvent?.kind==='failed'||r.availability?.kind==='failed';
      const retry=failed?(r.lastScanEvent?.evidence?.stage==='matching'?button('retryMatch',r.id,'重试匹配分析'):AgentCore.jobKey(r.url)?button('retryFailure',r.url,'重新读取该岗位'):button('collection','','补充岗位链接')):'';
      let actions=(r.hasDescription===false||!r.title||!r.company?button('supplementJob',r.id,'补充岗位资料'):'')+retry+(r.failureKey?button('ignoreFailure',r.failureKey,'忽略本次失败'):'')+button('dismiss',r.id,'暂不考虑')+(notice.hard?button('toggleConflict',r.id,'处理冲突'):'');
      if(r.discoveryState==='candidate')actions+=button('generate',r.id,'准备话术');
      else {actions+=button('candidate',r.id,'加入候选');if(r.discoveryState==='skipped')actions+=button('restoreRecommendation',r.id,'重新判断');}
      const extra=(failed?'<p>'+esc(r.lastScanEvent?.evidence?.error||r.availability?.reason||'岗位读取失败')+'</p>':'')+(notice.hard?button('ignoreHard',r.id,'仅本岗位忽略冲突'):'')+(r.discoveryState==='pending'?button('skip',r.id,'暂时跳过'):'');
      const select=cardMode==='single'&&r.discoveryState==='candidate'?'<label><input type="checkbox" data-agent-select="'+esc(r.id)+'"'+(selectedJobs.has(r.id)?' checked':'')+'> 批量选择</label>':'';
      return '<article class="agent-job" data-card-id="'+esc(r.id)+'"'+(r.discoveryState==='pending'?' data-swipe="true" tabindex="0"':'')+'>'+head+select+jobActions(r,actions)+inspection(r,extra)+'</article>';

    };
    const duplicate=r=>'<article class="agent-job" data-card-id="'+esc(r.id)+'"><b>'+esc(r.company||'公司待确认')+' · '+esc(r.title||'岗位待确认')+'</b><p>'+esc([r.location,r.salary].filter(Boolean).join(' · '))+'</p><details><summary>对比区别（'+list(r.differences).length+'）</summary>'+(list(r.differences).map(x=>'<p>'+esc(x.label)+'：'+esc(x.before)+' → '+esc(x.after)+'</p>').join('')||'<p>主要资料相同，平台岗位标识不同。</p>')+'</details><div class="progress-actions">'+button('openSource',r.id,'打开来源')+button('deleteJob',r.id,'删除抓取记录')+button('ignoreDuplicate',r.id,'忽略')+'</div></article>';
    const all=[...new Map([...(data.actions||[]),...(data.waiting||[])].map(c=>[c.id,c])).values()],recs=AgentCore.uniqueRecords(data.recommendations||[]),undecided=recs.filter(r=>!['candidate','skipped'].includes(r.discoveryState)),pending=undecided.filter(r=>r.hasDescription!==false&&r.title&&r.company),uncertain=undecided.filter(r=>r.hasDescription===false||!r.title||!r.company),unlinked=all.filter(c=>!c.recordId);
    const recent=AgentCore.uniqueRecords(data.recentJobs||[]).filter(r=>r.discoveryState!=='dismissed'),confirm=AgentCore.uniqueRecords(data.recentConfirmations||[]).filter(r=>r.discoveryState!=='dismissed'),recentFailed=AgentCore.uniqueRecords(data.recentFailures||[]).filter(r=>r.discoveryState!=='dismissed');
    const linked=c=>!!c.recordId;
    const confirmJobs=AgentCore.uniqueRecords(onlyRecent?confirm:[...list(data.confirmationJobs),...confirm,...uncertain]).filter(r=>r.hasDescription===false||!r.title||!r.company);
    const confirmChats=[...new Map((onlyRecent?list(data.recentChatConfirmations):[...list(data.recentChatConfirmations),...all.filter(c=>!c.archive&&(['archive','rejection'].includes(c.kind)||(c.issues?c.issues.length:!linked(c)||c.kind==='unknown')))]).map(c=>[c.id,c])).values()].filter(c=>!c.archive&&!c.keepOnlyChat&&(['archive','rejection'].includes(c.kind)||(c.issues?c.issues.length:!c.recordId||c.kind==='unknown')));
    const confirmJob=r=>'<section><p>需要确认：'+esc(!r.title||!r.company||r.hasDescription===false?'岗位资料':r.stale?'需求或资料已变化':r.researchError?'外部依据暂缺':'匹配依据或需求')+'</p>'+job(r)+'</section>';
    const knownFailureUrls=new Set(list(data.recentJobs).filter(r=>r.lastScanEvent?.kind==='failed').map(r=>r.url).filter(Boolean)),extraFailures=list(data.taskFailures).filter(f=>!f.url||!knownFailureUrls.has(f.url)).map(f=>failureChoice(taskFailure(f),f.failureKey));
    const groups=[['failures','本次失败',[...recentFailed.map(r=>failureChoice(job(r),r.failureKey)),...list(data.recentChatFailures).map(c=>failureChoice(conversationCard(c),c.failureKey)),...extraFailures],false],['new',cardMode==='single'?'待判断岗位':'新推荐岗位',pending.map(job),false],['candidates','候选清单',recs.filter(r=>r.discoveryState==='candidate').map(job),false],['skipped','暂时跳过',recs.filter(r=>r.discoveryState==='skipped').map(job),true],['progress','流程中',list(data.activeJobs).map(progressCard),false],['reply','待我回复',all.filter(c=>linked(c)&&!c.archive&&c.kind==='reply').map(c=>conversationCard(c)),false],['follow','建议跟进',all.filter(c=>linked(c)&&!c.archive&&c.kind==='follow').map(c=>conversationCard(c)),false],['confirm','需要确认',[...confirmJobs.map(confirmJob),...confirmChats.map(c=>conversationCard(c,['archive','rejection'].includes(c.kind)))],false]];
    const runs=data.runs||{};
    if(data.feedbackCount&&data.feedbackCount!==snoozedFeedback||cardCategoryKey==='feedback')groups.unshift(['feedback','更新求职需求',data.feedbackCount&&data.feedbackCount!==snoozedFeedback?['<p>有 '+data.feedbackCount+' 条判断可用于更新需求。</p>'+button('needsNow','','现在更新')+button('needsLater',String(data.feedbackCount),'稍后')]:[],false]);
    if(data.possibleDuplicates?.length||cardCategoryKey==='duplicates')groups.unshift(['duplicates','疑似同名岗位',list(data.duplicateJobs).map(duplicate),true]);
    groups.unshift(['review','快速判断',[button('cardMode','',cardMode==='single'?'切换批量列表':'切换逐张判断')+'<p>待判断 '+pending.length+' 个 · 左滑暂不考虑，右滑加入候选；也可使用按钮。</p>'+(data.lastDecision?button('undoDecision',data.lastDecision.id,'撤销上次判断'):'')],false]);
    for(const r of Object.values(runs))if(r.error)groups.find(g=>g[0]==='confirm')[2].push('<article><b>扫描需要处理</b><p>'+esc(String(r.error).slice(0,70))+'</p>'+button('collection','','返回采集处理')+'</article>');
    const discarded=data.dismissedRecommendations||[],discardedIds=new Set(discarded.map(r=>r.id)),archives=[...new Map(all.filter(c=>c.archive&&!discardedIds.has(c.recordId)).map(c=>[c.recordId||c.id,c])).values()];
    const recycled=[...discarded.map(r=>({type:'discard',html:'<article class="agent-job" data-card-id="'+esc(r.id)+'"><b>'+esc(r.company+' · '+r.title)+'</b><p>'+esc(r.salary||'薪资未知')+'</p><p>主动放弃 · '+esc(r.reason||'暂不说明')+'</p><p>'+esc(r.discardAfter?'可恢复至 '+new Date(r.discardAfter).toLocaleString():'历史记录保留，未设置自动清理')+'</p>'+button('restoreRecommendation',r.id,'恢复待判断')+'</article>'})),...archives.map(c=>({type:/超时|未回复/.test(c.archive.reason)?'timeout':'other',html:'<article class="agent-job" data-card-id="'+esc(c.id)+'"><b>'+esc([c.company,c.title].filter(Boolean).join(' · '))+'</b><p>'+esc(c.archive.reason)+' · '+esc(new Date(c.archive.at).toLocaleString())+'</p><div class="progress-actions">'+button('restore',c.id,'恢复')+button('openChat',c.id,'查看沟通')+'</div><details><summary>回收依据</summary>'+esc(c.archive.evidence||'旧归档未保存依据')+'</details></article>'}))];
    groups.push(['dismissed','回收站',recycled.filter(r=>recycleFilter==='all'||r.type===recycleFilter).map(r=>r.html),true]);
    if(cardCategoryKey==='archived')cardCategoryKey='dismissed';if(cardCategoryKey==='archive')cardCategoryKey='confirm';
    for(const group of groups)if(!group[2].length)group[3]=true;
    const status=runStatus(runs);
    if(focused){
      const choices=groups.filter(g=>!['review','recent'].includes(g[0]));if(!choices.length)choices.push(['empty','暂无待处理事项',[],false]);
      const keyed=choices.findIndex(g=>g[0]===cardCategoryKey);cardCategory=keyed>=0?keyed:(cardCategory%choices.length+choices.length)%choices.length;
      const [id,title,items]=choices[cardCategory];cardCategoryKey=id;
      const index=Math.min(positions.get(id)||0,Math.max(0,items.length-1));positions.set(id,index);
      const shown=cardMode==='single'?items.slice(index,index+1):items;
      const handled=recs.filter(r=>['candidate','skipped'].includes(r.discoveryState)).length+list(data.activeJobs).filter(r=>r.discoveryState==='selected'&&(r.group||r.rating)).length+list(data.dismissedRecommendations).length;
      const caption=id==='new'&&cardMode==='single'?'待判断 '+items.length+' 个 · 当前第 '+(items.length?handled+index+1:handled)+' / '+(handled+items.length):title+'（'+items.length+'）'+(cardMode==='single'&&items.length?' · 第 '+(index+1)+' / '+items.length:'');
      const tools=id==='failures'&&cardMode==='list'?button('selectFailures','','全选 / 取消全选')+button('ignoreFailures','','忽略所选失败'):id==='dismissed'?'<label>回收原因 <select data-recycle-filter><option value="all"'+(recycleFilter==='all'?' selected':'')+'>全部</option><option value="discard"'+(recycleFilter==='discard'?' selected':'')+'>主动放弃</option><option value="timeout"'+(recycleFilter==='timeout'?' selected':'')+'>超时未回复</option></select></label>':id==='confirm'?button('reviewChats','','批量分析并归类')+button('reviewRecycle','','批量确认回收建议')+'<label><input type="checkbox" data-only-recent'+(onlyRecent?' checked':'')+'>只看本次扫描</label>'+(unlinked.length?button('autoLinkChats','','一键匹配已有岗位'):'')+(data.standaloneChats?.length?button('openChat',data.standaloneChats[0].id,'查看已确认保留的聊天（'+data.standaloneChats.length+'）'):''):'';
      return '<section class="agent-cards" data-confirm-total="'+(groups.find(g=>g[0]==='confirm')?.[2].length||0)+'" data-confirm-unlinked="'+confirmChats.filter(c=>!c.recordId).length+'"><h3>岗位判断</h3>'+button('cardMode','',cardMode==='single'?'切换批量列表':'切换逐张判断')+(data.lastDecision?button('undoDecision',data.lastDecision.id,'撤销上次判断'):'')+'<nav class="agent-categories" aria-label="岗位类别">'+choices.map(g=>'<button type="button" data-agent-action="category" data-id="'+g[0]+'" aria-pressed="'+(g[0]===id)+'">'+esc(g[1])+'（'+g[2].length+'）</button>').join('')+'</nav><div class="result-actions"><b>'+esc(caption)+'</b></div>'+tools+(shown.join('')||'<p>本类暂无待处理事项，请点击上方类别继续。</p>')+(cardMode==='single'&&items.length>1?button('prevItem','','上一条')+button('nextItem',String(items.length),'下一条'):'')+(id!=='failures'&&cardMode==='list'&&items.some(x=>x.includes('data-agent-select'))?'<button data-agent-action="batch">为勾选岗位准备话术</button>':'')+'</section>';
    }
    return '<section class="agent-cards"><h3>本次行动验收</h3>'+status+'<details><summary>实际范围与诊断</summary>'+Object.values(runs).map(r=>'<p>'+esc((r.scopes||[]).join('；'))+'</p><p>'+esc(r.error||'')+'</p>').join('')+'</details>'+groups.map(([id,title,items,fold])=>'<details data-group="'+id+'"'+(fold?'':' open')+'><summary>'+title+'（'+items.length+'）</summary>'+(items.join('')||'<p>当前没有此类事项。</p>')+'</details>').join('')+'<button data-agent-action="batch">为勾选岗位准备话术</button></section>';
  }
  function init({openChat,openGeneration,refresh,captureCurrentChat}) {
    const panel=$('agentControls');
    panel.innerHTML=`<div class="result-actions"><button id="agentCurrentJob" title="读取当前打开的岗位并保存到记录">抓取当前</button><button id="agentCurrent" title="读取当前收藏、应聘记录或搜索列表，并继续翻页">抓取列表</button><button id="agentCurrentChat" title="只读取猎聘当前打开的会话，保存并分析，不遍历聊天列表">抓取当前聊天</button><button id="agentPatrol" title="抓取当前猎聘聊天列表，本批最多21条，可继续剩余聊天">抓取聊天</button><button id="agentResume" title="重试失败步骤或从保存位置继续任务" aria-label="重试或继续任务" disabled>↻</button><button id="agentCancel" title="当前步骤保存后结束任务，保留已有结果" aria-label="结束任务" disabled>■</button></div>
      
      <div id="agentPreferences"><div id="agentNeedsInbox"></div><label class="sr-only" for="agentSoftText">需求输入</label><textarea id="agentSoftText" maxlength="800" rows="3"></textarea><button id="agentParseSoft">分析</button><div id="agentSoftChoices"></div></div>
      <dialog id="agentFavoriteDialog"><h3>补充来源链接</h3><p>请先打开收藏、应聘记录或搜索列表，再使用“抓取列表”。读取失败时可粘贴岗位或搜索链接补救。</p><p id="agentFavoriteStatus" role="status"></p><button id="agentFavoriteClose">关闭</button><details id="agentImportFallback"><summary>读取失败？粘贴岗位或搜索链接导入</summary><textarea id="agentImportText" rows="3" maxlength="30000" aria-label="搜索页或多个岗位链接"></textarea><button id="agentImportPreview">预览链接</button><div id="agentImportResult"></div><button id="agentImportStart" disabled>导入预览中的岗位</button></details></dialog>
      <dialog id="agentConflictDialog"><h3>你希望如何调整这个条件？</h3><p>提交到待分析需求，确认新标签后才生效。</p><label>你的想法<textarea id="agentConflictText" maxlength="500"></textarea></label><button id="agentConflictSave">提交到需求</button><button id="agentConflictClose">取消</button></dialog><dialog id="agentDecisionDialog"><h3>为什么暂不考虑？</h3><p>进入回收站后24小时内可恢复；到期仅保留岗位名称、公司、薪资和唯一编码。历史备份不受影响。</p><fieldset id="agentDecisionReason"><legend>可以多选，也可以暂不说明</legend>${['地域','工资','能力／岗位不匹配','HR不活跃','岗位停止招聘','工作安排','其他'].map(x=>'<label><input type="checkbox" value="'+x+'">'+x+'</label>').join('')}</fieldset><label>你还有什么想法？<textarea id="agentDecisionText" maxlength="300"></textarea></label><label><input id="agentDecisionGlobal" type="checkbox">加入下次需求问答（确认后才生效）</label><button id="agentDecisionSave">确认暂不考虑</button><button id="agentDecisionClose">取消</button></dialog>
      <dialog id="agentTaskNotice"><h3 id="agentTaskNoticeTitle">任务结果</h3><p id="agentTaskNoticeText"></p><details><summary>任务步骤诊断</summary><p id="agentTaskNoticeSteps"></p></details><button id="agentTaskNoticeConfirm">确认</button></dialog>`;
    $('needsControls').append($('agentPreferences'));
    $('agentNeedsInbox').insertAdjacentHTML('afterend','<p id="agentFeedbackNotice" role="status"></p><button id="agentFeedbackNow" hidden>现在更新需求</button><button id="agentFeedbackLater" hidden>稍后</button>');
    const show=e=>alert(e.message||String(e));
    const run=fn=>async(...args)=>{try{await fn(...args);await status();}catch(e){show(e);}};
    const start=(type,extra={})=>send(type,extra);
    for(const id of ['agentFavoriteDialog','agentDecisionDialog','agentTaskNotice','agentConflictDialog'])document.body.append($(id));
    document.body.insertAdjacentHTML('beforeend','<dialog id="agentProgressDialog"><h3>更新岗位进度</h3><label>备注<textarea id="agentProgressNote" maxlength="4000"></textarea></label><label>状态<select id="agentProgressStatus">'+AgentCore.statuses.map(x=>'<option>'+esc(x)+'</option>').join('')+'</select></label><p id="agentProgressError" role="alert"></p><button id="agentProgressSave">保存</button><button id="agentProgressClose">取消</button></dialog>');
    document.body.insertAdjacentHTML('beforeend','<dialog id="agentRetryNotice"><h3>重试结果</h3><p id="agentRetryText" role="status"></p><button id="agentRetryConfirm" type="button">确定</button></dialog>');
    $('agentRetryConfirm').onclick=()=>$('agentRetryNotice').close();
    $('agentRetryNotice').addEventListener('cancel',e=>e.preventDefault());
    document.body.insertAdjacentHTML('beforeend','<dialog id="agentJobFacts"><h3>补充岗位资料</h3><label>岗位名称<input id="agentFactTitle"></label><label>公司<input id="agentFactCompany"></label><label>岗位内容<textarea id="agentFactDescription" rows="6"></textarea></label><p id="agentFactError" role="alert"></p><button id="agentFactSave">保存</button><button id="agentFactClose">取消</button></dialog>');
    let factId='';$('agentFactClose').onclick=()=>$('agentJobFacts').close();
    $('agentFactSave').onclick=async()=>{const button=$('agentFactSave');button.disabled=true;try{const patch={title:$('agentFactTitle').value.trim(),company:$('agentFactCompany').value.trim(),description:$('agentFactDescription').value.trim()};if(Object.values(patch).some(v=>!v))throw new Error('请补全岗位名称、公司和岗位内容');await send('AGENT_UPDATE_RECORD',{id:factId,patch,source:'manual-confirmation'});$('agentJobFacts').close();await refresh();}catch(e){$('agentFactError').textContent=e.message;}finally{button.disabled=false;}};
    let progressId='';
    $('agentProgressClose').onclick=()=>$('agentProgressDialog').close();
    $('agentProgressSave').onclick=async()=>{const b=$('agentProgressSave');b.disabled=true;try{await send('AGENT_ACTION',{action:'updateProgress',id:progressId,notes:$('agentProgressNote').value,status:$('agentProgressStatus').value});$('agentProgressDialog').close();await refresh();}catch(e){$('agentProgressError').textContent=e.message;}finally{b.disabled=false;}};
    document.body.insertAdjacentHTML('beforeend','<dialog id="agentNeedsDialog"><h3>确认求职需求</h3><p>选择具体范围和硬／软要求，核对标签后保存。</p><div id="agentNeedsDialogBody"></div><p id="agentNeedsError" role="alert"></p><button id="agentNeedsClose" type="button">取消</button></dialog>');
    const cancelNeeds=async()=>{await chrome.storage.local.set({agentNeedsDraft:null});const d=await chrome.storage.local.get(['agentConfig']);const c=AgentCore.validateConfig(d.agentConfig||{});drawDraft({editingCurrent:true,questions:[],hardRequirements:c.hardRequirements,preferences:c.softPreferences,previousHardRequirements:c.hardRequirements,previousPreferences:c.softPreferences});};
    $('agentNeedsClose').onclick=()=>{if(!$('agentParseSoft').disabled&&!savingTags){$('agentNeedsDialog').close();void cancelNeeds();}};
    $('agentNeedsDialog').addEventListener('cancel',e=>{if($('agentParseSoft').disabled||savingTags)e.preventDefault();else void cancelNeeds();});
    let batchTaskId='',recycleProposals=[];
    document.body.insertAdjacentHTML('beforeend','<dialog id="agentBatchDialog"><h3>批量分析并归类</h3><p id="agentBatchText" role="status"></p><div id="agentBatchRows"></div><button id="agentBatchClose">关闭（后台继续）</button></dialog>');
    $('agentBatchClose').onclick=()=>$('agentBatchDialog').close();
    const batchProgress=t=>{if(!t||t.id!==batchTaskId)return;$('agentBatchText').textContent=(t.status==='completed'?'处理完成':t.status==='cancelled'?'已结束':t.status==='paused'||t.status==='interrupted'?'已暂停，可到采集页继续':'正在处理')+' · '+t.cursor+'/'+t.queue.length+' · 已归类 '+(t.stats?.updated||0)+' · 仍需补充 '+(t.stats?.duplicates||0)+' · 失败 '+(t.stats?.failed||0)+(t.lastError?' · '+t.lastError:'');$('agentBatchRows').innerHTML=t.queue.filter(e=>e.result||e.outcome==='failed').map(e=>'<p>'+esc(e.name||e.id)+'：'+esc(e.result?.reason||({waiting:'流程中',reply:'待我回复',follow:'建议跟进',archive:'建议回收',recycled:'已放入回收站',rejection:'建议回收'})[e.result?.kind]||t.errors?.find(x=>x.item===e.name)?.message||'仍需补充信息')+'</p>').join('');};

    document.body.insertAdjacentHTML('beforeend','<dialog id="agentRecycleDialog"><h3>确认回收建议</h3><div id="agentRecycleRows"></div><p id="agentRecycleError" role="status"></p><button id="agentRecycleSave">确认回收所选</button><button id="agentRecycleCancel">取消</button></dialog>');
    $('agentRecycleCancel').onclick=()=>$('agentRecycleDialog').close();
    $('agentRecycleSave').onclick=async()=>{const b=$('agentRecycleSave');b.disabled=true;try{const ids=[...$('agentRecycleRows').querySelectorAll('input:checked')].map(x=>x.dataset.recycleId);await send('AGENT_RECYCLE_SELECTED',{items:recycleProposals.filter(c=>ids.includes(c.id)).map(c=>({id:c.id,fingerprint:c.activity?.messageFingerprint}))});$('agentRecycleDialog').close();await refresh();}catch(e){$('agentRecycleError').textContent=e.message;}finally{b.disabled=false;}};
    let draft=null,feedbackGroups=[],selectedFeedbackIds=new Set(),needsInbox=[],importSource='',decisionId='',conflictId='',shownError='',noticeKey='',dirtyNeeds=false;
    $('agentPreferences').addEventListener('input',()=>{dirtyNeeds=true;});
    $('agentFeedbackLater').onclick=()=>{$('agentFeedbackNow').hidden=$('agentFeedbackLater').hidden=true;};
    const openNeeds=async()=>{document.querySelector('.tab[data-tab="needs"]').click();await status(true);$('agentSoftText').focus();show('点击待分析标签填入，可修改后统一分析。');};
    $('agentFeedbackNow').onclick=run(openNeeds);
    const renderInbox=()=>{$('agentNeedsInbox').innerHTML='<p>点击标签填入修改，也可直接输入。</p>'+needsInbox.map((x,i)=>'<button type="button" class="agent-inbox-item" data-fill-inbox="'+i+'">'+esc(x)+'</button>').join('')+feedbackGroups.map((g,i)=>'<button type="button" class="agent-inbox-item" data-fill-feedback="'+i+'" title="'+esc(g.examples.join('；'))+'">'+esc(g.label)+' · '+g.count+'次</button>').join('');};
    function drawDraft(d){
      draft=d;if(!d)return;
      if(d.editingCurrent){$('agentPreferences').append($('agentParseSoft'),$('agentSoftChoices'));if($('agentNeedsDialog').open)$('agentNeedsDialog').close();}
      else{$('agentNeedsDialogBody').append($('agentSoftChoices'),$('agentParseSoft'));$('agentNeedsError').textContent='';if(!$('agentNeedsDialog').open)$('agentNeedsDialog').showModal();}
      const questions=list(d.questions).map((q,i)=>'<fieldset data-question="'+i+'"><legend>'+esc(q.question)+'</legend>'+q.options.map(o=>'<label><input type="'+(q.multiple?'checkbox':'radio')+'" name="question-'+i+'" value="'+esc(o)+'">'+esc(o)+'</label>').join('')+'<label>补充说明（选填）<input data-answer="'+i+'" maxlength="500"></label></fieldset>').join('');
      const previous=[...(d.previousHardRequirements||[]).map(x=>({...x,_kind:'hard'})),...(d.previousPreferences||[]).map(x=>({...x,_kind:'soft'}))],seen=new Set(),tags=[];
      for(const [kind,items] of [['hard',d.hardRequirements||[]],['soft',d.preferences||[]]])for(const item of items){
        const key=item.label+'|'+item.sourceQuote;if(seen.has(key))continue;seen.add(key);
        const prior=previous.find(x=>x.label===(item.replaces||item.label));
        const chosen=list(d.classifications).find(x=>x.sourceQuote===item.sourceQuote&&x.label===item.label);
        tags.push({...item,_kind:chosen?.kind||(prior?prior._kind:''),_ask:!d.editingCurrent&&!chosen&&!prior});
      }
      tags.sort((a,b)=>({hard:0,soft:1,'':2}[a._kind]-{hard:0,soft:1,'':2}[b._kind])||((b.createdAt||0)-(a.createdAt||0)));d.tags=tags;
      $('agentSoftChoices').innerHTML='<p>硬要求直接排除岗位；软要求供你判断。不限制说明不评分。</p><div class="agent-tag-editor">'+tags.map((x,i)=>'<div class="agent-requirement-tag '+(x._kind||'unclassified')+'" data-need-row="'+i+'" data-kind="'+x._kind+'"><span title="'+esc(x.meaning||'')+'">'+esc(x.label)+'</span>'+(x._ask?'<fieldset><legend>“'+esc(x.label)+'”属于哪类要求？</legend>'+['hard','soft'].map(k=>'<label><input type="radio" name="need-kind-'+i+'" data-need-kind="'+k+'"'+(x._kind===k?' checked':'')+'>'+ (k==='hard'?'硬要求：不满足就排除':'软要求：提醒后自行判断')+'</label>').join('')+'</fieldset>':'<small>'+(x._kind==='hard'?'硬要求':'软要求')+(AgentCore.unrestricted(x)?' · 不限制，不评分':'')+'</small>')+'<button type="button" data-remove-need aria-label="删除 '+esc(x.label)+'">×</button></div>').join('')+'</div>'+(!d.editingCurrent?'<button type="button" id="agentConfirmNeeds">确认更新需求</button><p>确认前不会修改生效规则。</p>':'');
      if(questions){
        const fallback=!d.inputKind&&!tags.some(x=>x._ask)&&!list(d.classifications).length?'<fieldset data-input-kind><legend>本次补充属于哪类要求？若包含多项，可在整理后的标签中分别调整。</legend>'+['hard','soft'].map(k=>'<label><input type="radio" name="input-kind" value="'+k+'"'+(d.inputKind===k?' checked':'')+'>'+(k==='hard'?'硬要求：不满足就排除':'软要求：提醒后自行判断')+'</label>').join('')+'</fieldset>':'';
        $('agentSoftChoices').insertAdjacentHTML('afterbegin',questions+fallback);
        $('agentConfirmNeeds')?.remove();
      }
      const confirm=$('agentConfirmNeeds');if(confirm){confirm.textContent=d.noChanges?'确认保留原需求':'确认并保存';if(d.noChanges)$('agentSoftChoices').insertAdjacentHTML('afterbegin','<p>未整理出新增标签，以下仅为原需求。请补充后重新分析。</p>');}
      $('agentParseSoft').textContent=questions?'提交选择并整理标签':'分析';$('agentParseSoft').hidden=!d.editingCurrent&&!questions;
    }
    async function status(load=false){const d=await send('AGENT_STATUS'),t=d.agentTask;batchProgress(t);feedbackGroups=list(d.feedbackGroups);renderInbox();
      $('agentFeedbackNotice').textContent=d.feedbackCount?'有 '+d.feedbackCount+' 条判断可用于更新需求':'';
      $('agentFeedbackNow').hidden=$('agentFeedbackLater').hidden=!d.feedbackCount;
      const pending=t&&['paused','interrupted'].includes(t.status);
      const retryFailed=t?.status==='completed'&&t.kind==='discover'&&t.errors?.some(f=>['job','reassess'].includes(f.type)&&AgentCore.jobKey(f.url));
      $('agentResume').disabled=!(pending||retryFailed);$('agentCancel').disabled=!(pending||d.running);
      $('agentResume').title=t?.pauseReason==='chat-batch-limit'?'从保存位置继续巡检剩余聊天':'重试失败步骤或从保存位置继续任务';
      const state=await chrome.storage.local.get(['agentTaskNoticeAck']);
      const terminal=t&&(['completed','failed','error'].includes(t.status)||pending);
      const key=terminal?JSON.stringify([t.id,t.status,t.cursor,t.lastError||'',t.stats?.failed||0,t.errors?.at(-1)?.at||0]):'';
      if(key&&key!==state.agentTaskNoticeAck&&key!==noticeKey){noticeKey=key;$('agentTaskNoticeTitle').textContent=(t.reviewSaved?'批量分析并归类':t.kind==='patrol'?'抓取聊天':t.kind==='generate'?'话术生成':t.queue?.length&&t.queue.every(e=>e.type==='reassess')?'更新匹配':'岗位采集')+'：'+(t.lastError||t.stats?.failed?'有失败项':pending?'已暂停，可继续':'本次范围处理完成');$('agentTaskNoticeText').textContent=[t.lastError||t.pendingMessage|| (pending?'可点击↻继续保存的任务':''),t.reviewSaved?'已分析归类 '+(t.stats?.updated||0)+'，仍需补充 '+(t.stats?.duplicates||0)+'，失败 '+(t.stats?.failed||0):t.kind==='discover'?progressText(AgentCore.taskProgress(t)):t.stats?'新增 '+t.stats.added+'，更新 '+t.stats.updated+'，重复 '+t.stats.duplicates+'，失败 '+t.stats.failed:'已保存处理结果',(t.queue?.some(e=>e.outcome==='deferred')?'岗位已保存；请在设置 → AI与授权完成配置后进行评分和匹配。':'请在判断页查看已保存结果及具体失败项；保存失败的岗位尚未完成后续分析。')].filter(Boolean).join('；');if(t.kind==='generate'){const p=AgentCore.generationProgress(t);$('agentTaskNoticeTitle').textContent='话术生成：'+p.title;$('agentTaskNoticeText').textContent=[p.summary,...p.issues,...(t.queue||[]).map(e=>e.warning).filter(Boolean),t.lastError].filter(Boolean).join('；');}$('agentTaskNoticeSteps').textContent='内部步骤 '+t.cursor+'/'+t.queue.length+'（含读取列表、翻页、详情及分析，不等于岗位数）';if(t.kind==='generate')$('agentTaskNoticeSteps').textContent='已处理 '+t.cursor+'/'+t.queue.length+' 个岗位；显示文本不代表已通过质检或已保存，请以上方结果为准。';if(!$('agentTaskNotice').open&&!$('agentBatchDialog').open)$('agentTaskNotice').showModal();}
      for(const [id,label] of [['agentCurrentJob','抓取当前'],['agentCurrent','抓取列表'],['agentPatrol','抓取聊天']])$(id).textContent=d.running&&(t.kind==='patrol'?id==='agentPatrol':id==='agentCurrentJob')?label+' · '+(t.phase||'处理中')+' · '+(t.kind==='discover'?progressText(AgentCore.taskProgress(t)):'已处理 '+t.cursor+' 个步骤'):label;
      for(const id of ['agentCurrentJob','agentCurrent','agentPatrol','agentCurrentChat'])$(id).disabled=!!d.running;
      if(t?.lastError&&t.queue?.[t.cursor]?.type==='favorites'){$('agentFavoriteStatus').textContent=t.lastError+'。完成登录后重试，或结束本次任务后更换地址。';if(shownError!==t.id+':'+t.lastError){shownError=t.id+':'+t.lastError;if(!$('agentFavoriteDialog').open)$('agentFavoriteDialog').showModal();}$('agentImportFallback').open=true;}
      if(load){const c=AgentCore.validateConfig(d.agentConfig||{});const saved=await chrome.storage.local.get(['agentNeedsDraft','agentNeedsInbox']);needsInbox=list(saved.agentNeedsInbox);renderInbox();drawDraft(saved.agentNeedsDraft&&!saved.agentNeedsDraft.confirmedAt?saved.agentNeedsDraft:{editingCurrent:true,questions:[],hardRequirements:c.hardRequirements,preferences:c.softPreferences,previousHardRequirements:c.hardRequirements,previousPreferences:c.softPreferences});}return d;
    }
    $('agentFavoriteClose').onclick=()=>$('agentFavoriteDialog').close();
    $('agentImportText').oninput=()=>{$('agentImportStart').disabled=true;};
    $('agentImportPreview').onclick=run(async()=>{importSource=$('agentImportText').value;const p=await send('AGENT_IMPORT_PREVIEW',{text:importSource});$('agentImportResult').innerHTML='<p>有效 '+p.entries.length+' · 重复 '+p.duplicates+' · 无效 '+p.invalid.length+'</p><details><summary>查看来源</summary>'+p.entries.map(e=>'<p>'+esc(e.url)+'</p>').join('')+'<p>'+esc(p.invalid.join('；'))+'</p></details>';$('agentImportStart').disabled=!p.entries.length;});
    $('agentImportStart').onclick=run(async()=>{if(importSource!==$('agentImportText').value)throw new Error('请重新预览');await start('AGENT_START',{kind:'discover',importText:importSource});$('agentFavoriteDialog').close();});
    $('agentNeedsInbox').onclick=e=>{const b=e.target.closest('[data-fill-inbox],[data-fill-feedback]');if(!b)return;const g=b.hasAttribute('data-fill-feedback')?feedbackGroups[Number(b.dataset.fillFeedback)]:null;const text=g?g.quotes.join('；'):needsInbox[Number(b.dataset.fillInbox)];if(!text)return;if(g)g.feedbackIds.forEach(id=>selectedFeedbackIds.add(id));$('agentSoftText').value=[$('agentSoftText').value.trim(),text].filter(Boolean).join('\n');dirtyNeeds=true;$('agentSoftText').focus();};
    $('agentParseSoft').onclick=async()=>{const b=$('agentParseSoft');b.disabled=true;try{const answers={};for(const [i,q] of (draft?.questions||[]).entries()){const values=[...$('agentSoftChoices').querySelectorAll('[data-question="'+i+'"] input:checked')].map(x=>x.value);const more=$('agentSoftChoices').querySelector('[data-answer="'+i+'"]')?.value;if(!values.length)throw new Error('请先选择：'+q.question);if(more)values.push(more);if(values.length)answers[q.id]=values.join('；');}const classifications=[...$('agentSoftChoices').querySelectorAll('[data-need-row]')].filter(row=>row.dataset.kind).map(row=>{const item=draft.tags[Number(row.dataset.needRow)];return {label:item.label,sourceQuote:item.sourceQuote,kind:row.dataset.kind};});const inputKind=$('agentSoftChoices').querySelector('[data-input-kind] input:checked')?.value;if($('agentSoftChoices').querySelector('[data-input-kind]')&&!inputKind)throw new Error('请选择本次补充属于硬要求还是软要求');if(draft?.questions?.length&&[...$('agentSoftChoices').querySelectorAll('[data-need-row]')].some(row=>!row.dataset.kind))throw new Error('请选择新标签属于硬要求还是软要求');const text=draft?.questions?.length?'':$('agentSoftText').value.trim();drawDraft(await send('AGENT_NEEDS',{text,answers,classifications,inputKind,feedbackIds:[...selectedFeedbackIds]}));renderInbox();show(draft.questions?.length?'还有范围需要确认，请完成选择题和硬软分类；尚未保存。':draft.noChanges?'未整理出新增标签，当前仅显示原需求，请补充后重新分析。':'请核对标签及硬软分类，点击“确认并保存”。');}catch(e){show(e);$('agentNeedsError').textContent=e.message;}finally{b.disabled=false;}};
    const commitTags=async()=>{const rows=[...$('agentSoftChoices').querySelectorAll('[data-need-row]')];if(rows.some(x=>!x.dataset.kind)){throw new Error('请先给所有新标签选择硬要求或软要求。');}const hardRequirements=[],preferences=[];for(const row of rows){const item=draft.tags[Number(row.dataset.needRow)];if(row.dataset.kind==='hard')hardRequirements.push({...item});else preferences.push({...item,confirmed:true,version:2});}const before=await chrome.storage.local.get(['agentConfig']);const editingCurrent=draft.editingCurrent===true;const saved=await send('AGENT_NEEDS_CONFIRM',{preferences,hardRequirements,editCurrent:editingCurrent});dirtyNeeds=false;if(!editingCurrent){$('agentSoftText').value='';needsInbox=[];}if($('agentNeedsDialog').open)$('agentNeedsDialog').close();const state=await status(true),blocked=state.running||['paused','interrupted','running','starting'].includes(state.agentTask?.status);if(saved.ruleVersion!==(before.agentConfig?.ruleVersion||0)&&state.counts.stale&&!blocked){await start('AGENT_START',{kind:'discover',refreshRecommendations:true,onlyStale:true});show('已保存需求，正在更新 '+state.counts.stale+' 个已有岗位的匹配，不抓取新岗位。');}else show('需求标签已更新。');};
    let savingTags=false;
    $('agentSoftChoices').onclick=run(async e=>{
      if(e.target.closest('#agentConfirmNeeds')){if(!savingTags){savingTags=true;try{await commitTags();selectedFeedbackIds.clear();}finally{savingTags=false;}}return;}const row=e.target.closest('[data-need-row]');if(!row||savingTags)return;
      const html=$('agentSoftChoices').innerHTML;
      if(e.target.closest('[data-remove-need]')){row.remove();if(!draft.editingCurrent)return;}
      else {const b=e.target.closest('[data-need-kind]');if(!b)return;row.dataset.kind=b.dataset.needKind;row.className='agent-requirement-tag '+b.dataset.needKind;return;}
      savingTags=true;for(const b of $('agentSoftChoices').querySelectorAll('button'))b.disabled=true;
      try{await commitTags();}catch(error){$('agentSoftChoices').innerHTML=html;throw error;}
      finally{savingTags=false;for(const b of $('agentSoftChoices').querySelectorAll('button'))b.disabled=false;}
    });
    $('agentTaskNoticeConfirm').onclick=run(async()=>{await chrome.storage.local.set({agentTaskNoticeAck:noticeKey});$('agentTaskNotice').close();const d=await send('AGENT_STATUS');if(d.agentTask?.status==='completed'&&d.agentTask.kind!=='generate'&&!(d.agentTask.queue?.length&&d.agentTask.queue.every(e=>e.type==='reassess'))&&$('gen').classList.contains('hidden')&&$('chat').classList.contains('hidden')&&!document.querySelector('#agentNeedsDialog[open],#agentProgressDialog[open]'))document.querySelector('.tab[data-tab="judge"]').click();});
    $('agentTaskNotice').addEventListener('cancel',e=>{e.preventDefault();$('agentTaskNoticeConfirm').click();});
    for(const [id,type,extra] of [['agentCurrentJob','AGENT_START',{kind:'discover',currentJob:true}],['agentCurrent','AGENT_START',{kind:'discover',currentPage:true}],['agentPatrol','AGENT_START',{kind:'patrol'}],['agentResume','AGENT_RESUME'],['agentCancel','AGENT_CANCEL']])$(id).onclick=run(()=>type==='AGENT_START'?start(type,extra):send(type,extra));
    $('agentCurrentChat').onclick=run(async()=>{if((await send('AGENT_STATUS')).running)throw Error('当前任务正在操作页面，请暂停或完成后抓取当前聊天');await captureCurrentChat();});
    $('agentResume').onclick=run(async()=>{const d=await send('AGENT_STATUS');await send(['paused','interrupted'].includes(d.agentTask?.status)?'AGENT_RESUME':'AGENT_RETRY_FAILED');});
    $('agentDecisionClose').onclick=()=>$('agentDecisionDialog').close();
    $('agentConflictClose').onclick=()=>$('agentConflictDialog').close();
    $('agentConflictSave').onclick=run(async()=>{const b=$('agentConflictSave');b.disabled=true;try{await send('AGENT_CONFLICT_FEEDBACK',{id:conflictId,text:$('agentConflictText').value});$('agentConflictDialog').close();$('agentConflictText').value='';const d=await chrome.storage.local.get(['agentNeedsInbox']);needsInbox=list(d.agentNeedsInbox);renderInbox();show('已保存到待分析需求；点击标签填入后分析，确认前规则不变。');}finally{b.disabled=false;}});
    $('agentDecisionSave').onclick=run(async()=>{const reasons=[...$('agentDecisionReason').querySelectorAll('input:checked')].map(x=>x.value),note=$('agentDecisionText').value,addToNeeds=$('agentDecisionGlobal').checked;await send('AGENT_ACTION',{action:'dismiss',id:decisionId,reasons,note,addToNeeds});$('agentDecisionDialog').close();selectedJobs.delete(decisionId);await refresh();if(addToNeeds)show('已加入下次需求问答；当前筛选规则未改变。');});
    const cardRoots=[$('summaryBox'),$('judgeBox'),$('recBody'),$('chatAnalysis'),$('chatSourceActions')].filter(Boolean);
    const cardClick=async e=>{const b=e.target.closest('[data-agent-action]');if(!b)return;b.disabled=true;try{const id=b.dataset.id,action=b.dataset.agentAction;
      if(action==='collection'){document.querySelector('.tab[data-tab="agent"]').click();$('agentImportFallback').open=true;$('agentFavoriteDialog').showModal();}
      else if(action==='needsNow')await openNeeds();
      else if(action==='needsLater'){snoozedFeedback=Number(id);await refresh();}
      else if(action==='supplementJob'){const d=await chrome.storage.local.get(['records']),r=AgentCore.recordById(d.records||[],id);if(!r)throw new Error('岗位已删除');factId=r.id;$('agentFactTitle').value=r.title||'';$('agentFactCompany').value=r.company||'';$('agentFactDescription').value=r.description||'';$('agentFactError').textContent='';$('agentJobFacts').showModal();}
      else if(action==='editProgress'){const d=await chrome.storage.local.get(['records']),r=AgentCore.recordById(d.records||[],id);if(!r)throw new Error('岗位记录不存在');progressId=id;$('agentProgressNote').value=r.notes||'';$('agentProgressStatus').value=AgentCore.normalizeStatus(r.status);$('agentProgressError').textContent='';$('agentProgressDialog').showModal();}
      else if(action==='progressDetails'||action==='showScore'){const root=b.closest('[data-card-id]'),box=root.querySelector('.agent-job-details');box.hidden=action==='showScore'?false:!box.hidden;const toggle=root.querySelector('[data-agent-action="progressDetails"]');toggle.textContent=box.hidden?'展开详情':'收起详情';toggle.setAttribute('aria-expanded',String(!box.hidden));box.querySelector('.agent-score').open=!box.hidden;}
      else if(action==='prevItem'||action==='nextItem'){positions.set(cardCategoryKey,action==='prevItem'?Math.max(0,(positions.get(cardCategoryKey)||0)-1):Math.min(Number(id)-1,(positions.get(cardCategoryKey)||0)+1));await refresh();}
      else if(action==='cardMode'){cardMode=cardMode==='single'?'list':'single';await refresh();}
      else if(action==='category'){cardCategoryKey=id;await refresh();}
      else if(action==='retryMatch'||action==='retryScore'){
        const dialog=$('agentRetryNotice'),label=b.dataset.label|| (action==='retryScore'?'岗位综合评分':'双向匹配');
        $('agentRetryText').textContent=label+'：正在重试，请稍候…';$('agentRetryConfirm').disabled=true;dialog.showModal();
        try{await send(action==='retryScore'?'AGENT_SCORE_RECORD':'AGENT_RETRY_MATCH',{id,label:b.dataset.label||''});await refresh();const d=await chrome.storage.local.get(['records']);const r=AgentCore.recordById(d.records||[],id),rec=r?.recommendation;if(!r)throw new Error('该岗位已删除，无法回查重试结果');
          const checks=[...list(rec?.hardChecks),...list(rec?.rating?.concerns)].filter(c=>!b.dataset.label||c.label===b.dataset.label),unfinished=checks.filter(c=>c.verification==='missing'||c.researchError);
          $('agentRetryText').textContent=label+'：'+(action==='retryScore'?AgentCore.scoreInfo(r||{}).message:rec?.stale?'资料或需求在分析期间变化，仍需更新匹配':rec?.analysisStatus==='failed'?'重试失败：'+rec.analysisError:unfinished.length?'已保存结果，仍有未完成项：'+unfinished.map(c=>c.label+'（'+(c.researchError||c.reason||'模型漏项')+'）').join('；'):'分析结果已保存。暂无依据的项目仍需确认。');
        }catch(e){$('agentRetryText').textContent=label+'：重试失败，'+e.message;}finally{$('agentRetryConfirm').disabled=false;}
      }
      else if(action==='selectFailures'){const boxes=[...b.closest('.agent-cards').querySelectorAll('[data-failure-select]')],check=boxes.some(x=>!x.checked);for(const box of boxes){box.checked=check;check?selectedFailures.add(box.dataset.failureSelect):selectedFailures.delete(box.dataset.failureSelect);}}
      else if(action==='ignoreFailures'){const keys=[...b.closest('.agent-cards').querySelectorAll('[data-failure-select]:checked')].map(x=>x.dataset.failureSelect);if(!keys.length)throw Error('请先勾选失败事项');if(confirm('确认忽略所选 '+keys.length+' 项失败？可能仍缺少岗位资料或分析结果；保留记录与招聘状态。')){await send('AGENT_IGNORE_FAILURE',{keys});keys.forEach(key=>selectedFailures.delete(key));await refresh();}}
      else if(action==='ignoreFailure'){if(confirm('确认忽略？\n忽略后将不再提示这次失败，该岗位的信息或匹配结果可能仍不完整。已有记录和状态不会改变，之后可重新扫描或重试。')){await send('AGENT_IGNORE_FAILURE',{key:id});await refresh();}}
      else if(action==='retryFailure'){await send('AGENT_RETRY_FAILED',{urls:[id]});show('仅重试所选失败岗位，已处理成功的岗位不会重复执行。');}
      else if(action==='openChat')await openChat(id);
      else if(action==='reviewChats'){batchTaskId='';$('agentBatchText').textContent='正在检查已保存聊天…';$('agentBatchRows').innerHTML='';$('agentBatchDialog').showModal();try{const t=await start('AGENT_START',{kind:'patrol',reviewSaved:true});batchTaskId=t.id;await status();}catch(e){$('agentBatchText').textContent=e.message;}}
      else if(action==='reviewRecycle'){$('agentRecycleRows').textContent='正在计算回收建议…';$('agentRecycleError').textContent='';$('agentRecycleDialog').showModal();try{
        const d=await chrome.storage.local.get(['conversations','agentConfig']);recycleProposals=(d.conversations||[]).filter(c=>!c.archive&&['archive','rejection'].includes(AgentCore.patrol({...c,confirmation:{...c.confirmation,routing:c.confirmation?.routing?.status==='pending'?null:c.confirmation?.routing}},AgentCore.validateConfig(d.agentConfig||{})).kind));
        $('agentRecycleRows').innerHTML=recycleProposals.map(c=>'<label><input type="checkbox" data-recycle-id="'+esc(c.id)+'">'+esc([c.company,c.jobTitle,c.counterparty].filter(Boolean).join(' · '))+'<br>'+esc(AgentCore.patrol({...c,confirmation:{...c.confirmation,routing:c.confirmation?.routing?.status==='pending'?null:c.confirmation?.routing}},AgentCore.validateConfig(d.agentConfig||{})).reason)+'</label>').join('')||'<p>暂无回收建议。</p>';$('agentRecycleError').textContent='';}catch(e){$('agentRecycleError').textContent=e.message;}
      }
      else if(action==='recycleChat'){if(confirm('确认将这条聊天放入回收站？之后可以恢复。')){await send('AGENT_ACTION',{action,id});await refresh();}}
      else if(action==='resolveChat'){await openChat(id);$('chatResolve').click();}
      else if(action==='toggleDetails'){const details=b.closest('[data-card-id]')?.querySelector('.agent-job-details');if(details)details.open=!details.open;}
      else if(action==='toggleConflict'){conflictId=id;$('agentConflictText').value='';$('agentConflictDialog').showModal();}
      else if(action==='autoLinkChats'){const result=await send('AGENT_AUTO_LINK_ALL');cardCategoryKey='confirm';await refresh();const root=$('judgeBox').querySelector('[data-confirm-total]'),total=Number(root?.dataset.confirmTotal)||0,unlinked=Number(root?.dataset.confirmUnlinked)||0;show('本次自动关联 '+result.linked+' 条；当前筛选下需要确认 '+total+' 项，其中未关联聊天 '+unlinked+' 条，其他事项 '+(total-unlinked)+' 项。');}
      else if(action==='openSource'||action==='openJob'){const d=await chrome.storage.local.get(['records']);const r=(d.records||[]).find(r=>r.id===id);if(!AgentCore.jobKey(r?.url))throw new Error('岗位链接不可用');await chrome.tabs.create({url:r.url});}
      else if(action==='openChatSource')await send('AGENT_OPEN_CHAT_SOURCE',{id});
      else if(action==='openFailure'){if(!AgentCore.jobKey(id))throw new Error('失败项目没有可用岗位链接');await chrome.tabs.create({url:id});}
      else if(action==='generate')await openGeneration([id]);
      else if(action==='updateHard'){conflictId=id;$('agentConflictText').value='';$('agentConflictDialog').showModal();}
      else if(action==='ignoreHard'){await send('AGENT_ACTION',{action,id});await refresh();show('本次已忽略该岗位的硬条件冲突。');}
      else if(action==='deleteJob'){if(confirm('确定删除这个岗位？删除后可在记录页撤销。')){await send('AGENT_ACTION',{action,id});await refresh();}}
      else if(action==='mergeDuplicate'){show('请在记录页核对平台岗位标识后合并。');}
      else if(action==='ignoreDuplicate'){await send('AGENT_ACTION',{action,id});await refresh();show('已忽略这条重复提醒。');}
      else if(action==='batch'){const ids=[...b.closest('.agent-cards').querySelectorAll('[data-agent-select]:checked')].map(x=>x.dataset.agentSelect);if(!ids.length)throw new Error('请先选择岗位');await openGeneration(ids);}
      else if(action==='dismiss'){decisionId=id;$('agentDecisionText').value='';$('agentDecisionGlobal').checked=false;for(const x of $('agentDecisionReason').querySelectorAll('input'))x.checked=false;$('agentDecisionDialog').showModal();}
      else if(action==='undoDecision'){await send('AGENT_ACTION',{action,id});await refresh();}
      else if(['candidate','skip','restoreRecommendation'].includes(action)){await send('AGENT_ACTION',{action,id});await refresh();}
      else{await send('AGENT_ACTION',{action,id});await refresh();}
    }catch(e){show(e);}finally{b.disabled=false;}};
    for(const root of cardRoots)root.addEventListener('click',cardClick);
    for(const root of cardRoots)root.addEventListener('change',e=>{if(e.target.matches('[data-failure-select]')){e.target.checked?selectedFailures.add(e.target.dataset.failureSelect):selectedFailures.delete(e.target.dataset.failureSelect);return;}if(e.target.matches('[data-recycle-filter]')){recycleFilter=e.target.value;positions.set('dismissed',0);void refresh();return;}if(e.target.matches('[data-only-recent]')){onlyRecent=e.target.checked;positions.set('confirm',0);void refresh();return;}const box=e.target.closest('[data-agent-select]');if(box)box.checked?selectedJobs.add(box.dataset.agentSelect):selectedJobs.delete(box.dataset.agentSelect);});
    let swipe=null;
    for(const root of cardRoots){root.addEventListener('pointerdown',e=>{if(e.target.closest('button,a,input,textarea,summary,.agent-matching'))return;const card=e.target.closest('[data-swipe="true"]');if(card)swipe={card,x:e.clientX,y:e.clientY,id:e.pointerId};});root.addEventListener('pointerup',e=>{const s=swipe;swipe=null;if(!s||s.id!==e.pointerId)return;const dx=e.clientX-s.x,dy=e.clientY-s.y;if(Math.abs(dx)>80&&Math.abs(dx)>Math.abs(dy)*1.5)s.card.querySelector('[data-agent-action="'+(dx>0?'candidate':'dismiss')+'"]').click();});root.addEventListener('pointercancel',()=>{swipe=null;});}
    chrome.storage.onChanged.addListener(changes=>{if(changes.agentConfig&&!dirtyNeeds&&!savingTags)status(true).catch(show);else if(changes.agentTask)status().catch(show);if(changes.records||changes.dailySummaries)refresh().catch(show);});
    status(true).catch(show);
  }
  return {cards,matching,init};
})();


