/* global chrome */
// options.js
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  $('restartOnboarding').onclick=async()=>{
    const button=$('restartOnboarding');button.disabled=true;
    try {
      await new Promise((resolve,reject)=>chrome.storage.local.set({onboardingLocal:{step:0,startedAt:Date.now(),paused:false}},()=>chrome.runtime.lastError?reject(Error(chrome.runtime.lastError.message)):resolve()));
      await chrome.tabs.create({url:chrome.runtime.getURL('sidepanel.html')});
      $('restartOnboardingStatus').textContent='已打开新手引导，原设置与岗位保留。';
    }catch(e){$('restartOnboardingStatus').textContent=e.message;}finally{button.disabled=false;}
  };
  function showSettings(){
    const links=[...document.querySelectorAll('[data-setting-link]')],requested=location.hash.slice(1),selected=links.some(x=>x.dataset.settingLink===requested)?requested:'profile';
    document.querySelectorAll('[data-setting-panel]').forEach(x=>x.hidden=x.dataset.settingPanel!==selected);
    links.forEach(x=>{if(x.dataset.settingLink===selected)x.setAttribute('aria-current','page');else x.removeAttribute('aria-current');});
  }
  window.addEventListener('hashchange',showSettings);showSettings();


  // ---------- 皮肤跟随（与扩展主程序共用 uiState.theme）----------
  const THEMES = ['light', 'tech'];
  function applyTheme(t) {
    if (!THEMES.includes(t)) t = 'light';
    document.documentElement.setAttribute('data-theme', t);
    document.querySelectorAll('.theme-chip').forEach((c) => {
      c.classList.toggle('active', c.getAttribute('data-theme') === t);
    });
  }
  function readTheme() {
    chrome.storage.local.get(['uiState'], (r) => {
      const t = (r.uiState && THEMES.includes(r.uiState.theme)) ? r.uiState.theme : 'light';
      applyTheme(t);
    });
  }
  function setTheme(t) {
    if (!THEMES.includes(t)) return;
    chrome.storage.local.get(['uiState'], (r) => {
      const ui = r.uiState || {};
      ui.theme = t;
      chrome.storage.local.set({ uiState: ui }, () => applyTheme(t));
    });
  }
  document.querySelectorAll('.theme-chip').forEach((c) => {
    c.addEventListener('click', () => setTheme(c.getAttribute('data-theme')));
  });
  // 主程序切换皮肤时，设置页实时同步
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.uiState) {
      const nv = changes.uiState.newValue;
      const t = (nv && THEMES.includes(nv.theme)) ? nv.theme : 'light';
      applyTheme(t);
    }
  });
  readTheme();

  const DEFAULT_GREETING_PROMPT = `你是一名资深求职顾问，擅长写高回复率的打招呼语。要求：
1) 先理解「我的能力档案」，提炼与 JD 最相关的 2-4 个匹配点；
2) 自动抽取 JD 中的关键技能/行业关键词，并自然融入话术（ATS 优化：让招聘系统/HR 一眼看到匹配关键词，但绝不堆砌）；
3) 用 STAR 法则的精髓组织语言：用一句话点出「情境/任务→我的行动→可量化结果」，突出与岗位的直接相关性；
4) 80 字左右、口语自然、不套话、不用「尊敬的领导」等空话、不用夸张修辞；
5) 只输出 JSON：{"matchPoints":["..."],"greeting":"...","keywords":["关键词1","关键词2"]}。`;

  function load() {
    chrome.storage.local.get(['settings'], (r) => {
      const s = r.settings || {};
      $('apiKey').value = s.apiKey || '';
      $('profile').value = s.profile || '';
      $('greetingPrompt').value = s.greetingPrompt || DEFAULT_GREETING_PROMPT;
      $('ocrApiKey').value = s.ocrApiKey || '';
      $('ocrSecretKey').value = s.ocrSecretKey || '';
      $('deepseekConsent').checked = s.deepseekConsent === true;
      $('ocrConsent').checked = s.ocrConsent === true;
      $('autoBackup').checked = s.autoBackup !== false;
      $('backupFolder').value = s.backupFolder || 'ai-job-backup';
    });
  }

  function save() {
    const settings = {
      apiKey: $('apiKey').value.trim(),
      profile: $('profile').value.trim(),
      greetingPrompt: $('greetingPrompt').value.trim(),
      ocrApiKey: $('ocrApiKey').value.trim(),
      ocrSecretKey: $('ocrSecretKey').value.trim(),
      deepseekConsent: $('deepseekConsent').checked,
      ocrConsent: $('ocrConsent').checked,
      autoBackup: $('autoBackup').checked,
      backupFolder: $('backupFolder').value.trim() || 'ai-job-backup'
    };
    chrome.storage.local.set({ settings: settings }, () => {
      const needsConsent = settings.apiKey && !settings.deepseekConsent;
      $('status').textContent = needsConsent ? '已保存；DeepSeek 授权未开启，AI 功能暂不可用' : '已保存 ✓';
      $('status').classList.toggle('warning', needsConsent);
      setTimeout(() => { $('status').textContent = ''; $('status').classList.remove('warning'); }, needsConsent ? 5000 : 2000);
      // 打开自动备份时立即触发一次，避免等下次闹钟（最长 5 分钟）才生效
      if (settings.autoBackup) {
        chrome.runtime.sendMessage({ type: 'FORCE_BACKUP' }, (r) => {
          if (r && r.ok) console.log('[AI求职助手] 已立即执行一次自动备份');
          else console.warn('[AI求职助手] 立即备份失败', r && r.error);
        });
      }
    });
  }

  // 文档导入：解析 txt/csv/tsv/粘贴文本，追加到档案
  function parseDoc(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const bullets = [];
    lines.forEach((line) => {
      // 按逗号或 Tab 拆成多列时，用「：」或「-」前作为标题更友好；这里统一转成条目
      const parts = line.split(/\t|,|；|;/).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) bullets.push('- ' + parts.join('：'));
      else bullets.push('- ' + line);
    });
    return bullets.join('\n');
  }
  async function importDoc(text) {
    if (!text.trim()) { $('docStatus').textContent = '没有可导入的内容。'; $('docStatus').classList.add('warning'); return; }
    const added = parseDoc(text);
    const cur = await new Promise((r) => chrome.storage.local.get(['settings'], (x) => r(x.settings || {})));
    const base = (cur.profile || '').replace(/\n{3,}/g, '\n\n').trim();
    const merged = (base ? base + '\n\n' : '') + '【导入的补充档案】\n' + added;
    cur.profile = merged;
    chrome.storage.local.set({ settings: cur }, () => {
      $('profile').value = merged;
      $('docStatus').classList.remove('warning');
      $('docStatus').textContent = '已追加 ' + added.split('\n').length + ' 条到档案 ✓';
      setTimeout(() => ($('docStatus').textContent = ''), 3000);
    });
  }
  $('docFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => importDoc(String(reader.result));
    reader.readAsText(f);
  });
  $('docImportBtn').addEventListener('click', () => importDoc($('docPaste').value));

  $('researchProbe').onclick=async()=>{
    const button=$('researchProbe'),box=$('researchProbeResult');button.disabled=true;box.textContent='正在检查联网能力…';
    try{const result=await chrome.runtime.sendMessage({type:'RESEARCH_PROBE',address:$('researchAddress').value}),d=result?.data||{};if(!result?.ok&&d.httpStatus==null){box.textContent=result?.error||'无法读取联网能力';return;}box.textContent=[result?.ok?'已返回实际搜索来源；请逐条核对来源是否支持结论。':'测试未通过：'+(result?.error||'后台未响应'),'HTTP：'+(d.httpStatus??'未发起请求')+'；响应状态：'+(d.responseStatus||'未返回'),'实际搜索记录：'+(d.searches?.length??0)+'；耗时：'+((d.durationMs||0)/1000).toFixed(1)+'秒',...(d.searches||[]).map(x=>'搜索状态：'+x.status+'；查询：'+(x.query||x.queries?.join('；')||'接口未返回查询词')),d.usage?'Token用量：'+JSON.stringify(d.usage):'Token用量：接口未返回',...(d.sources||[]).map((x,i)=>'\n来源 '+(i+1)+'：'+x.title+'\n'+x.url+'\nAI引用摘要（非网页原文）：'+x.text)].join('\n');}
    catch(e){box.textContent='测试失败：'+e.message;}finally{button.disabled=false;}
  };
  document.addEventListener('DOMContentLoaded', () => { load(); $('saveBtn').addEventListener('click', save); });
})();
