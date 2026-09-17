/* Local-only first-use guide. No network or model client. */
globalThis.EchoOnboarding = (() => {
  'use strict';
  const key='onboardingLocal', $=id=>document.getElementById(id);
  const get=keys=>new Promise((resolve,reject)=>chrome.storage.local.get(keys,data=>chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):resolve(data)));
  const put=value=>new Promise((resolve,reject)=>chrome.storage.local.set(value,()=>chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):resolve()));
  document.documentElement.dataset.onboarding='loading';
  const initial=get([key,'settings','records','_seenIntro']).then(d=>({state:d[key]||((d.records?.length||d.settings?.profile||d.settings?.apiKey||d._seenIntro)?{completedAt:Date.now(),legacy:true}:{step:0}),settings:d.settings||{}}));
  initial.catch(()=>{});
  const titles=['欢迎使用回声 Echo','填写 DeepSeek API Key','确认外部 AI 数据授权','填写个人能力档案','设置求职目标','保存第一个岗位','生成第一条招呼语'];
  async function init({capture,saveJob,generate,goToday}) {
    let state={},settings={},busy=false,preview='';
    document.body.insertAdjacentHTML('beforeend','<dialog id="onboardingDialog" aria-labelledby="onboardingTitle"><p id="onboardingProgress"></p><h2 id="onboardingTitle"></h2><div id="onboardingBody"></div><p id="onboardingError" role="alert"></p><div class="onboarding-actions"><button id="onboardingBack" type="button">上一步</button><button id="onboardingNext" type="button" class="primary">下一步</button><button id="onboardingSkip" type="button">暂时跳过</button></div><button id="onboardingLocal" type="button">暂用本地功能，稍后继续</button></dialog>');
    const dialog=$('onboardingDialog');
    async function update(patch){const next={...state,...patch};await put({[key]:next});state=next;}
    async function saveSettings(patch){const d=await get(['settings']);settings={...(d.settings||{}),...patch};await put({settings});}
    async function today(){await goToday();await refreshToday();}
    async function refreshToday(){
      const d=await get(['records',key]),hasJobs=!!d.records?.length;
      $('todayActionText').textContent=hasJobs?'岗位已保存。继续判断、准备话术或查看沟通进展。':'先保存一个岗位，再逐步判断和准备话术。';
      $('todayActionMain').textContent=hasJobs?'查看待判断岗位':'打开招聘平台，保存第一个岗位';
      $('todayActionMain').onclick=()=>hasJobs?document.querySelector('[data-tab="judge"]').click():chrome.tabs.create({url:'https://www.liepin.com/'});
      $('todayGuideResume').hidden=!!d[key]?.completedAt;
    }
    function render(){
      const step=state.step||0;$('onboardingProgress').textContent='第 '+(step+1)+'/7 步';$('onboardingTitle').textContent=titles[step];$('onboardingError').textContent='';
      $('onboardingBack').hidden=step===0;$('onboardingSkip').hidden=step!==4;
      $('onboardingNext').textContent=['开始','保存 Key，下一步','确认授权，下一步','保存档案，下一步','保存目标，下一步','保存当前打开的岗位',state.generated?'完成，进入今日行动':'生成第一条招呼语'][step];
      const body=$('onboardingBody');body.replaceChildren();
      function paragraph(text){const p=document.createElement('p');p.textContent=text;body.append(p);}
      function input(id,label,multiline=false){const l=document.createElement('label');l.textContent=label;const field=document.createElement(multiline?'textarea':'input');field.id=id;if(multiline)field.rows=6;l.append(field);body.append(l);return field;}
      if(step===0)paragraph('回声帮你保存岗位、判断匹配、准备话术并跟进沟通。我们先完成基础设置；不会自动投递或发送消息。');
      if(step===1){
        paragraph('Key 仅保存在本地浏览器或你配置的本机服务中，不上传到回声云端。调用 DeepSeek 时会作为请求凭证发送给 DeepSeek。生成、评分或聊天分析时，必要的岗位 JD、个人档案或聊天内容会发送给 DeepSeek，按其 API 规则计费。');
        const field=input('onboardingKey','DeepSeek API Key');field.type='password';field.autocomplete='off';field.value=settings.apiKey||'';
        const link=document.createElement('a');link.href='https://platform.deepseek.com/api_keys';link.target='_blank';link.rel='noopener noreferrer';link.textContent='前往 DeepSeek 获取 Key';body.append(link);
        paragraph('暂不填写也可保存岗位、查看记录和手动编辑；AI 功能会提示完成配置。保存 Key 不会发起模型请求。');
      }
      if(step===2){paragraph('为生成、评分和聊天分析，必要资料将发送给 DeepSeek。只提交你愿意交由外部 AI 处理的内容，可在设置中撤回授权。');const field=input('onboardingConsent','我理解并同意上述外部 AI 数据处理');field.type='checkbox';field.checked=settings.deepseekConsent===true;}
      if(step===3){paragraph('请写真实的相关经历、承担的职责、技能与成果；没有的数据留空，不必填写姓名或联系方式。');const f=input('onboardingProfile','个人能力档案（至少20字，建议包含经历与技能）',true);f.value=settings.profile||'';const p=document.createElement('p');p.id='onboardingProfileCheck';body.append(p);const count=()=>{p.textContent=f.value.trim().length>=20?'已达到基础填写长度；请自行核对事实与相关性。':'还需补充经历与技能，目前 '+f.value.trim().length+' 字。';};f.oninput=count;count();}
      if(step===4){paragraph('写下岗位方向、城市、薪资或工作方式。保存为待分析需求，稍后可在“需求”页确认硬软要求，不会自动搜索。');input('onboardingGoal','求职目标（可跳过）',true).value=state.goal||'';}
      if(step===5){
        paragraph('先在招聘平台打开一个岗位详情，再回到这里保存。此步只读取页面和保存资料，不调用 AI。');
        const open=document.createElement('button');open.type='button';open.textContent='打开猎聘';open.onclick=()=>chrome.tabs.create({url:'https://www.liepin.com/'});body.append(open);
        const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='无法读取？手动填写岗位';details.append(summary);body.append(details);
        for(const [id,label] of [['onboardingJobTitle','岗位名称'],['onboardingCompany','公司名称'],['onboardingJD','完整 JD']]){const field=input(id,label,id==='onboardingJD');details.append(field.parentElement);}
        const manual=document.createElement('button');manual.type='button';manual.textContent='保存手动填写的岗位';manual.onclick=()=>act(async()=>{const job={title:$('onboardingJobTitle').value.trim(),company:$('onboardingCompany').value.trim(),description:$('onboardingJD').value.trim()};if(!job.title||!job.company||!job.description)throw Error('请填写岗位名称、公司和 JD。');const rec=await saveJob(job);await update({recordId:rec.id,step:6,generated:false});render();});details.append(manual);
      }
      if(step===6){paragraph('前置检查：Key '+(settings.apiKey?'已填写':'未填写')+' · 授权 '+(settings.deepseekConsent?'已确认':'未确认')+' · 档案 '+((settings.profile||'').trim().length>=20?'已填写':'待补充'));paragraph(state.generated?'第一条话术已保存到同一岗位记录。请核对事实后手动使用，生成不代表已投递。':'点击后按策略 → 生成 → 检验处理，必要时修改一次；会调用 DeepSeek 并产生 API 用量。');if(state.generated&&preview){const p=document.createElement('p');p.textContent=preview;body.append(p);}}
    }
    async function act(fn){if(busy)return;busy=true;dialog.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){$('onboardingError').textContent=e.message||'操作失败，请重试；输入仍保留。';}finally{busy=false;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}}
    $('onboardingNext').onclick=()=>act(async()=>{
      const step=state.step||0;
      if(step===1){const value=$('onboardingKey').value.trim();if(!value)throw Error('请填写 Key，或选择暂用本地功能。');await saveSettings({apiKey:value});}
      if(step===2){if(!$('onboardingConsent').checked)throw Error('须主动勾选授权后才能调用 AI，也可选择暂用本地功能。');await saveSettings({deepseekConsent:true});}
      if(step===3){const value=$('onboardingProfile').value.trim();if(value.length<20)throw Error('请补充真实经历与技能，至少20字。');await saveSettings({profile:value});}
      if(step===4){const value=$('onboardingGoal').value.trim();if(value){const d=await get(['agentNeedsInbox']);await put({agentNeedsInbox:[...new Set([...(d.agentNeedsInbox||[]),value])].slice(-50)});await update({goal:value});}}
      if(step===5){const rec=await capture();await update({recordId:rec.id,generated:false});}
      if(step===6){
        settings=(await get(['settings'])).settings||{};
        if(!settings.apiKey||settings.deepseekConsent!==true||(settings.profile||'').trim().length<20)throw Error('请返回完成 Key、授权与个人档案配置，或选择暂用本地功能。');
        if(!state.generated){const result=await generate(state.recordId);await update({generated:true});preview=result.greeting;render();return;}
        await update({completedAt:Date.now(),paused:false});dialog.close();await today();return;
      }
      await update({step:step+1});render();
    });
    $('onboardingSkip').onclick=()=>act(async()=>{await update({step:5,goalSkipped:true});render();});
    $('onboardingBack').onclick=()=>act(async()=>{await update({step:Math.max(0,(state.step||0)-1)});render();});
    const pause=()=>act(async()=>{await update({paused:true});dialog.close();await today();});
    $('onboardingLocal').onclick=pause;dialog.addEventListener('cancel',event=>{event.preventDefault();pause();});
    async function show(){const d=await get([key,'settings']);state=d[key]||{step:0};settings=d.settings||{};await update({paused:false});render();if(!dialog.open)dialog.showModal();}
    $('todayGuideResume').onclick=()=>show().catch(e=>{$('todayActionText').textContent=e.message;});
    chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.records)void refreshToday();});
    try{const data=await initial;state=data.state;settings=data.settings;await put({[key]:state});await refreshToday();if(!state.completedAt&&!state.paused){render();dialog.showModal();}}
    finally{delete document.documentElement.dataset.onboarding;}
  }
  return {init};
})();

