/* global chrome */
// app.js — 侧边栏主逻辑
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SUPPORTED = ['zhipin.com', 'liepin.com', 'zhaopin.com', 'lagou.com'];
  const STATUS_LIST = AgentCore.statuses;
  const HR_ACTIVE_LIST = ['未知', '刚刚活跃', '今日活跃', '3日内活跃', '本周活跃', '半年前活跃', '活跃', '在线', '不活跃'];
  const THEMES = ['light', 'tech'];
  const THEME_COLOR = { light: '#19c8b9', tech: '#2fae8e' };
  const BACKUP_KEYS = ['legacyDataBackup', 'records', 'recycleJobKeys', 'dismissedJobKeys', 'settings', 'uiState', 'collection', 'conversations', 'dailySummaries', 'profiles', 'usage', '_seenIntro', 'agentConfig', 'agentRuleHistory', 'agentRuns', 'agentTask', 'agentNeedsDraft', 'agentNeedsInbox', 'agentSearchPlan'];
  const STATUS_ORDER = STATUS_LIST;
  const HR_ORDER = HR_ACTIVE_LIST;
  let currentJob = null, lastResult = null, recordsCache = [], lastParsedChat = null, lastConversationId = null, lastGrabWarning = '';
  let chatLinkRecords = [];
  let currentRecId = null, selectedIds = new Set(), sortKey = 'createdAt', sortDir = 'desc';
  const searchFilters = { title: '', company: '' };
  let flow = { grabbed: false, scored: false, generated: false };
  let mockIdx = 0, mockAnswers = [], mockTimer = null, mockRecId = null, mockCurStart = 0;

  const normalizeStatus = AgentCore.normalizeStatus;

  // ---------- 存储 ----------
  const loadSettings = () => new Promise((r) => chrome.storage.local.get(['settings'], (x) => r(x.settings || {})));
  function aiSettingsError(settings) {
    if (!settings.apiKey) return '未配置 DeepSeek API Key，请打开设置后填写并保存。';
    if (settings.deepseekConsent !== true) return '已填写 API Key，但尚未勾选 DeepSeek 数据授权，请打开设置 → 外部 AI 与隐私后保存。';
    return '';
  }
  const loadRecords = EchoRecordClient.loadRecords;
  const loadConversations = () => new Promise((r) => chrome.storage.local.get(['conversations'], (x) => r(x.conversations || [])));
  const saveConversations=(items,expected)=>recordRequest('AGENT_COMPARE_STORAGE',{values:{conversations:items},expected:{conversations:expected}});
  const recordRequest = EchoRecordClient.request;
  const recordClient = EchoRecordClient.create({
    source: 'app.js', getRecords: () => recordsCache, onRecords: records => { recordsCache = records; },
    undoButton: () => $('undoBtn')
  });
  const { recordDrafts, rememberDraft, updateRecord, refreshUndoButton,
    deleteRecordsWithUndo, restoreUndo, migrateRecordStatuses } = recordClient;
  const loadState = () => new Promise((r) => chrome.storage.local.get(['uiState'], (x) => r(x.uiState || {})));
  const saveState = (patch) => new Promise((r) => chrome.storage.local.get(['uiState'], (s) => chrome.storage.local.set({ uiState: Object.assign(s.uiState || {}, patch) }, r)));

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function currentTab() { return new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => res(t[0]))); }
  function tabMessage(tabId, message) {
    return new Promise((resolve) => chrome.tabs.sendMessage(tabId, message, (response) => {
      resolve({ response: response || null, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : '' });
    }));
  }
  async function contentMessage(tabId, message) {
    const first = await tabMessage(tabId, message);
    if (first.response) return first.response;
    try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] }); }
    catch (e) { return null; }
    return (await tabMessage(tabId, message)).response;
  }
  function matchesDomain(url, domain) {
    try { const host = new URL(url).hostname.toLowerCase(); return host === domain || host.endsWith('.' + domain); }
    catch (e) { return false; }
  }
  function isSupportedUrl(url) { return SUPPORTED.some((domain) => matchesDomain(url, domain)); }
  // 根据来源链接推断平台名称（用于记录「来源/平台」列展示与排序）
  function platformOf(rec) {
    const u = rec && rec.url || '';
    if (matchesDomain(u, 'zhipin.com')) return 'Boss直聘';
    if (matchesDomain(u, 'liepin.com')) return '猎聘';
    if (matchesDomain(u, 'zhaopin.com')) return '智联招聘';
    if (matchesDomain(u, 'lagou.com')) return '拉勾';
    return u ? '其他来源' : '—';
  }
  function fmtDateTime(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function recordTimelineHtml(rec) {
    const rows=AgentCore.timeline(rec);if(!rows.length)return '<p>暂无处理历史。</p>';
    return '<ol class="record-timeline">'+rows.map(x=>'<li><time>'+esc(fmtDateTime(x.at))+'</time><b>'+esc(x.title)+'</b>'+(x.evidence?'<span>'+esc(x.evidence)+'</span>':'')+(x.source?'<small>'+esc(x.source)+'</small>':'')+'</li>').join('')+'</ol>';
  }

  // 用 AI 清洗 JD：只保留岗位职责 / 任职要求 / 公司福利（去掉 HR 名、公司简介等）
  async function cleanJd(text) {
    const settings = await loadSettings();
    if (!settings.apiKey || !text) return text || '';
    return await new Promise((res) => chrome.runtime.sendMessage({ type: 'CLEAN_JD', apiKey: settings.apiKey, text: text }, (r) => res((r && r.ok && r.text) ? r.text : (text || ''))));
  }
  function populateStatusSelect(sel) {
    if (!sel) return;
    sel.innerHTML = '';
    STATUS_LIST.forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
  }
  // 生成与评分只是投递准备；复制仅记录复制状态，发送须用户确认。
  function flowStatusValue() { return '未联系'; }
  function applyFlowStatus() {
    const ready = flow.grabbed && flow.scored && flow.generated;
    const fs = $('flowStatus'); if (fs) fs.textContent = '准备进度：抓取' + (flow.grabbed ? '✓' : '·') + ' 评分' + (flow.scored ? '✓' : '·') + ' 生成' + (flow.generated ? '✓' : '·') + (ready ? ' → 已准备，实际发送后手动确认' : ' → 准备中');
    ['grabBtn', 'scoreBtn', 'genBtn'].forEach((id, i) => { const el = $(id); if (el) el.classList.toggle('step-done', [flow.grabbed, flow.scored, flow.generated][i]); });
  }
  // 纯文本清洗：去掉 markdown 标题/加粗/代码围栏/制表符/段首缩进（用于 JD、招呼语等 AI 产出）
  function sanitizePlain(s) {
    return String(s == null ? '' : s)
      .replace(/\t/g, ' ')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*/g, '').replace(/__/g, '')
      .replace(/`{1,3}/g, '')
      .replace(/^[ \t 　]+/gm, '')
      .trim();
  }

  // ---------- 主题（点击循环切换：light → dark → green，按钮底色=当前主题色）----------
  async function getTheme() { const s = await loadState(); return THEMES.includes(s.theme) ? s.theme : 'light'; }
  async function setTheme(t) {
    if (!THEMES.includes(t)) t = 'light';
    document.documentElement.setAttribute('data-theme', t);
    await saveState({ theme: t });
    applyThemeColor();
  }
  function applyThemeColor() {
    const fab = $('themeToggle'); if (!fab) return;
    const t = document.documentElement.getAttribute('data-theme') || 'light';
    fab.style.background = THEME_COLOR[t] || THEME_COLOR.light;
    fab.title = '主题：' + ({ light: '动森', tech: '科技风' }[t] || t) + '（点击切换）';
  }
  function initTheme() {
    loadState().then((s) => { const t = THEMES.includes(s.theme) ? s.theme : 'light'; document.documentElement.setAttribute('data-theme', t); applyThemeColor(); });
    const fab = $('themeToggle');
    if (fab) fab.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
      document.documentElement.setAttribute('data-theme', next);
      saveState({ theme: next });
      applyThemeColor();
      renderSummaryList(); renderProfileList(); // 饼图配色随皮肤切换
    });
    // 全屏页 / 设置页切换皮肤时，侧边栏实时跟随
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.recordsUndo || changes.recordsMergeUndo) refreshUndoButton();
      if (!changes.uiState) return;
      const t = (changes.uiState.newValue || {}).theme;
      if (THEMES.includes(t) && t !== (document.documentElement.getAttribute('data-theme') || 'light')) {
        document.documentElement.setAttribute('data-theme', t);
        applyThemeColor();
        renderSummaryList(); renderProfileList();
      }
    });
  }

  let processingOrigin={tab:'sum',scroll:0},returning=false;
  // ---------- Tabs ----------
  document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const oldTab=document.querySelector('.tab.active')?.dataset.tab;
      if(['gen','chat'].includes(btn.dataset.tab)&&!['gen','chat'].includes(oldTab))processingOrigin={tab:oldTab||'sum',scroll:window.scrollY,card:document.activeElement?.closest('[data-card-id]')?.dataset.cardId,table:document.querySelector('.table-wrap')?.scrollTop||0};
      document.querySelectorAll('.tab[data-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      ['needs','agent','judge','gen','chat','rec','sum'].forEach((t) => $(t).classList.toggle('hidden', t !== tab));
      if (tab === 'chat') renderChatInbox();
      if (tab === 'judge') renderDecisionCards();
      if (tab === 'rec'&&!returning) renderRecords();
      if (tab === 'sum'&&!returning) { renderSummaryList(); renderProfileList(); }
      saveState({ activeTab: tab });
    });
  });
  $('openOptions').addEventListener('click', () => { if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); });

  // ---------- 抓取当前页并存入记录 ----------
  function showDebug(job) { $('debugPre').textContent = JSON.stringify(job || {}, null, 2); }
  function fillJob(job) {
    currentJob = job;
    $('jobTitle').value = job.title || ''; $('jobCompany').value = job.company || '';
    $('jobLocation').value = job.location || ''; $('jobSalary').value = job.salary || '';
    $('jobSize').value = job.size || ''; $('jobDesc').value = job.description || '';
    showDebug(job);
    saveState({ lastJob: { title: job.title || '', company: job.company || '', location: job.location || '', salary: job.salary || '', size: job.size || '', description: job.description || '', url: job.url || '' } });
  }
  function applyParsedFields(job, fields) {
    const f = Object.assign({}, fields || {});
    if (job.extractionScope === 'liepin-main-v1') {
      for (const key of Object.keys(f)) if (job[key]) delete f[key];
    }
    const DENY_LOCATION = /无障碍|专区|反馈|帮助|客服|登录|注册|首页|导航|关于|隐私|职位|搜索|城市|选择|分享|举报|投诉|违法/;
    if (f.company) job.company = f.company;
    if (f.companyType && f.companyType !== '未知') job.companyType = f.companyType;
    if (f.size) job.size = f.size;
    if (f.location && !DENY_LOCATION.test(f.location)) job.location = f.location;
    if (f.title) job.title = f.title;
    if (f.salary) job.salary = f.salary;
    if (f.hrActive && f.hrActive !== '未知') job.hrActive = f.hrActive;
    return job;
  }
  // 单页抓取查重：仅使用可靠的平台岗位标识，不按相似名称合并。
  function normKey(s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); }
  function findDupRecord(records, job) {
    const key=AgentCore.recordKey(job);return key?records.find(r=>AgentCore.recordKey(r)===key)||null:null;
  }
  function chooseDuplicateAction(dup) {
    const choice = prompt('该岗位已抓取过：\n' + (dup.company || '—') + ' · ' + (dup.title || '—') + ' · ' + (dup.salary || '—') +
      '\n\n输入 1：使用已有记录（保留已保存资料；如需更新请使用采集页抓取当前岗位）' +
      '\n输入 2：仍保留为一条新记录' +
      '\n点“取消”：取消本次抓取', '1');
    return choice === '1' ? 'merge' : (choice === '2' ? 'new' : 'cancel');
  }
  // 抓取当前页：返回 Promise，resolve(记录) —— 快速模式依赖此顺序，避免招呼语写入竞态丢失
  function grabCurrent() {
    $('siteStatus').classList.remove('ok');
    return new Promise(async (resolve) => {
      currentRecId = null;
      const tab = await currentTab();
      if (!tab || !isSupportedUrl(tab.url)) { $('siteStatus').textContent = '当前不是支持的招聘站点，可手动粘贴 JD 或使用 OCR。'; resolve(null); return; }
      lastGrabWarning = '';
      $('siteStatus').textContent = '正在抓取当前页面 JD…';
      contentMessage(tab.id, { type: 'EXTRACT_JOB' }).then(async (resp) => {
        if (!resp || !resp.ok) { $('siteStatus').textContent = (resp && resp.error) || '无法连接当前页面，已自动重试；请刷新岗位页后再试。'; resolve(null); return; }
        const job = resp.job; job.url = tab.url;
        if(job.availability==='unavailable'){$('siteStatus').textContent='岗位已不可用：'+job.availabilityReason;resolve(null);return;}
        const settings = await loadSettings();
        const settingsError = aiSettingsError(settings);
        if (!settingsError) {
          const pageResp = await contentMessage(tab.id, { type: 'EXTRACT_PAGE_TEXT' });
          const pageText = pageResp && pageResp.ok ? pageResp.text : '';
          if (pageText) {
            await new Promise((res) => chrome.runtime.sendMessage({ type: 'PARSE_FIELDS', apiKey: settings.apiKey, rawText: pageText, hrActiveText: job.hrActive || '' }, (resp2) => {
              if (resp2 && resp2.ok && resp2.fields) {
                applyParsedFields(job, resp2.fields);
              } else lastGrabWarning = '字段补全失败：' + ((resp2 && resp2.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || '未知错误');
              res();
            }));
          }
        } else lastGrabWarning = settingsError;
        fillJob(job);
        if (job.description) job.description = sanitizePlain(await cleanJd(job.description));
        $('jobDesc').value = job.description || '';
        flow = { grabbed: true, scored: false, generated: false };
        // 抓取前查重：稳定岗位 URL 优先，重复时可合并、另存或取消。
        const existing = await loadRecords();
        const dup = findDupRecord(existing, job);
        if (dup) {
          const action = chooseDuplicateAction(dup);
          if (action === 'merge') {
            const merged = dup;
            currentRecId = dup.id;
            fillJob(Object.assign(recToJob(merged), { companyType: merged.companyType || '', hrActive: merged.hrActive || '未知' }));
            applyFlowStatus();
            $('siteStatus').textContent = '已使用已有记录，后续评分/生成将写入该记录。' + (lastGrabWarning ? ' ' + lastGrabWarning : '');
            $('siteStatus').classList.add('ok');
            resolve(merged); return;
          }
          if (action === 'cancel') {
            flow.grabbed = false; applyFlowStatus();
            $('siteStatus').textContent = '已取消本次抓取，未新增或修改记录。';
            resolve(null); return;
          }
        }
        const rec = await persistRecord(job, '', [], '未联系');
        currentRecId = rec.id;
        applyFlowStatus();
        $('siteStatus').textContent = lastGrabWarning ? '已抓取并存入记录；' + lastGrabWarning : '已抓取、补全字段并存入记录。';
        $('siteStatus').classList.add('ok');
        resolve(rec);
      });
    });
  }
  $('grabBtn').addEventListener('click', () => { grabCurrent(); });

  // 手动编辑同步
  ['jobTitle', 'jobCompany', 'jobLocation', 'jobSalary', 'jobSize', 'jobDesc'].forEach((id) => {
    $(id).addEventListener('input', () => { currentJob = currentJob || {};
      currentJob.title = $('jobTitle').value; currentJob.company = $('jobCompany').value; currentJob.location = $('jobLocation').value;
      currentJob.salary = $('jobSalary').value; currentJob.size = $('jobSize').value; currentJob.description = $('jobDesc').value; showDebug(currentJob); });
  });

  // ---------- OCR 收起 ----------
  $('ocrToggle').addEventListener('click', () => { $('ocrPanel').classList.toggle('hidden'); });
  $('ocrFile').addEventListener('change', () => {
    const file = $('ocrFile').files && $('ocrFile').files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] || '';
      $('ocrStatus').textContent = '正在识别…'; $('ocrBtn').disabled = true;
      loadSettings().then((s) => chrome.runtime.sendMessage({ type: 'OCR_RECOGNIZE', imageBase64: base64, ocrApiKey: s.ocrApiKey || '', ocrSecretKey: s.ocrSecretKey || '' }, (resp) => {
        $('ocrBtn').disabled = false;
        if (chrome.runtime.lastError || !resp || !resp.ok) { $('ocrStatus').textContent = 'OCR 失败：' + ((resp && resp.error) || '未知'); return; }
        const text = resp.text || '';
        $('jobDesc').value = text; currentJob = currentJob || {}; currentJob.description = text;
        const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
        if (lines[0] && lines[0].length <= 30) { $('jobTitle').value = lines[0]; currentJob.title = lines[0]; }
        $('ocrStatus').textContent = 'OCR 完成，已填入 JD（' + text.length + ' 字）。';
      }));
    };
    reader.readAsDataURL(file);
  });
  $('ocrBtn').addEventListener('click', () => { if (!$('ocrFile').files || !$('ocrFile').files[0]) { $('ocrStatus').textContent = '请先选择 JD 截图。'; return; } $('ocrFile').dispatchEvent(new Event('change')); });

  // ---------- AI 评分并可视化 ----------
  async function renderScoreViz(scores) {
    const box = $('scoreViz'); box.innerHTML = '';
    const dims = [
      ['岗位评分', scores.job, ['roleMatch', 'skillFit', 'salary', 'location', 'company', 'techStack', 'growth', 'interviewDifficulty', 'time', 'wlb']],
      ['公司评分', scores.company, ['industryScale', 'prosCons', 'salary', 'overtime']]
    ];
    const grid = document.createElement('div'); grid.className = 'score-grid';
    dims.forEach(([title, grp, keys]) => {
      const t = document.createElement('div'); t.className = 'score-group-title'; t.textContent = title; grid.appendChild(t);
      keys.forEach((k) => {
        const d = (grp && grp[k]) || {}; const score = (d.score == null) ? null : d.score; const reason = d.reason || '数据不足';
        const row = document.createElement('div'); row.className = 'score-dim';
        const cell = document.createElement('div'); cell.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%';
        cell.innerHTML = '<span class="name">' + k + '</span>' +
          '<span class="bar"><i style="width:' + (score == null ? 0 : (score / 5 * 100)) + '%"></i></span>' +
          '<span class="val">' + (score == null ? '数据不足' : (score + '/5')) + '</span>';
        const tip = document.createElement('div'); tip.style.cssText = 'font-size:11px;color:var(--text-2);width:100%;margin-top:2px'; tip.textContent = reason;
        const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column'; wrap.appendChild(cell); wrap.appendChild(tip);
        row.appendChild(wrap); grid.appendChild(row);
      });
      if (grp && grp.total != null) { const tt = document.createElement('div'); tt.className = 'score-total'; tt.textContent = title + ' 综合：' + grp.total + ' / 5'; grid.appendChild(tt); }
    });
    if (scores.overall != null) { const o = document.createElement('div'); o.className = 'score-total'; o.textContent = '总评：' + scores.overall + ' / 5'; grid.appendChild(o); }
    if (scores.source) { const s = document.createElement('div'); s.className = 'score-source'; s.textContent = '依据：' + scores.source; grid.appendChild(s); }
    box.appendChild(grid);
    $('scoreBox').classList.remove('hidden');
  }
  async function callScore(job,settings){
    const id=job.id||await ensureCurrentRecord(job);
    if(!job.id){const record=(await loadRecords()).find(r=>r.id===id),patch=Object.fromEntries(['title','company','description','location','salary','size'].filter(k=>job[k]!==undefined&&job[k]!==record?.[k]).map(k=>[k,job[k]]));if(Object.keys(patch).length)await updateRecord(id,patch);}
    const reply=await chrome.runtime.sendMessage({type:'AGENT_SCORE_RECORD',id});
    if(!reply?.ok||!reply.data)throw new Error(reply?.error||'评分未返回结果');return reply.data;
  }
  async function callGenerate(job, settings) {
    const resp = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GENERATE', apiKey: settings.apiKey, profile: settings.profile || '', job: job, greetingPrompt: settings.greetingPrompt || '' }, (value) => {
      resolve(value || { ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : '后台无响应' });
    }));
    if (!resp.ok || !resp.result) { const error = new Error(resp.error || '生成未返回结果'); error.result = resp.result; throw error; }
    return resp.result;
  }
  $('scoreBtn').addEventListener('click', async () => {
    $('siteStatus').classList.remove('ok');
    const job = readJobFromForm();
    if (!job.title && !job.description) { $('siteStatus').textContent = '请先抓取或填写岗位再评分。'; return; }
    const settings = await loadSettings();
    const settingsError = aiSettingsError(settings);
    if (settingsError) { $('siteStatus').textContent = settingsError; return; }
    $('siteStatus').textContent = '正在评分…'; $('scoreBtn').disabled = true;
    let scores;
    try { scores = await callScore(job, settings); }
    catch (e) { $('siteStatus').textContent = '评分失败：' + e.message; return; }
    finally { $('scoreBtn').disabled = false; }
    renderScoreViz(scores);
    currentJob = currentJob || {}; currentJob.scores = scores;
    
    flow.scored = true; applyFlowStatus();
    $('siteStatus').textContent = '评分完成，已写入记录。'; $('siteStatus').classList.add('ok');
  });

  function readJobFromForm() {
    return {
      title: $('jobTitle').value.trim(), company: $('jobCompany').value.trim(), location: $('jobLocation').value.trim(),
      salary: $('jobSalary').value.trim(), size: $('jobSize').value.trim(), description: $('jobDesc').value.trim(),
      url: (currentJob && currentJob.url) || ''
    };
  }
  function recToJob(rec) {
    return { id:rec.id,title: rec.title || '', company: rec.company || '', location: rec.location || '', salary: rec.salary || '', size: rec.size || '', description: rec.description || '', url: rec.url || '' };
  }
  async function ensureCurrentRecord(job) {
    if(currentRecId&&(await loadRecords()).some(r=>r.id===currentRecId))return currentRecId;
    const records=await loadRecords(),key=AgentCore.recordKey(job);
    const matches=records.filter(r=>key&&AgentCore.recordKey(r)===key);
    const rec=matches.length===1?matches[0]:await persistRecord(job,'',[],'未联系');currentRecId=rec.id;return rec.id;
  }

  // ---------- 生成招呼语 ----------
  $('genBtn').addEventListener('click', async () => {
    if(generationIds.includes(currentRecId)){
      const recordId=currentRecId;
      $('genBtn').disabled=true;
      try{const fields=readJobFromForm(),allowSaved=$('agentUseSaved').checked;await updateRecord(recordId,fields);const r=await chrome.runtime.sendMessage({type:'AGENT_ACTION',action:'generate',id:recordId,allowSaved});if(!r?.ok){showGenerationError(r);return;}if(currentRecId===recordId)await viewGeneration(recordId);}
      catch(e){$('siteStatus').textContent=e.message;}finally{$('genBtn').disabled=false;}return;
    }
    $('siteStatus').classList.remove('ok');
    const job = readJobFromForm();
    if (!job.description && !job.title) { $('siteStatus').textContent = '请先填写岗位名称或 JD 再生成。'; return; }
    const settings = await loadSettings();
    const settingsError = aiSettingsError(settings);
    if (settingsError) { $('siteStatus').textContent = settingsError; return; }
    $('siteStatus').textContent = '正在生成…'; $('genBtn').disabled = true;
    chrome.runtime.sendMessage({ type: 'GENERATE', apiKey: settings.apiKey, profile: settings.profile || '', job: job, greetingPrompt: settings.greetingPrompt || '' }, async (resp) => {
      $('genBtn').disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) { showGenerationError(resp); return; }
      lastResult = resp.result || {};currentJob=job;renderResult(lastResult,false);try{await ensureCurrentRecord(job);await updateRecord(currentRecId,{greeting:lastResult.greeting||'',matchPoints:lastResult.matchPoints||[],workflow:lastResult.workflow,greetingState:'draft'});}catch(e){showGenerationError({error:e.message,result:lastResult});return;}saveState({lastResult});
      flow.generated = true; applyFlowStatus();
      $('siteStatus').textContent = '生成完成，已写入记录。'; $('siteStatus').classList.add('ok');
    });
  });
  function showGenerationError(resp) {
    const draft = resp && resp.result;
    if (draft && draft.greeting) {
      renderResult(draft, false);
      $('massGreeting').value = draft.greeting;
      $('massResult').classList.remove('hidden');
    }
    $('siteStatus').classList.remove('ok');
    $('siteStatus').textContent = (draft && draft.greeting ? '草稿已生成，待修改：' : '生成失败：') + ((resp && (resp.error || resp.message)) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || '后台无响应');
  }
  function renderResult(result, persist = false) {
    result = result || {};
    if (result.greeting) result.greeting = sanitizePlain(result.greeting);
    const kw = $('kwBox'); kw.innerHTML = '';
    (result.keywords || []).forEach((k) => { const s = document.createElement('span'); s.className = 'kw'; s.textContent = k; kw.appendChild(s); });
    const ul = $('matchPoints'); ul.innerHTML = '';
    (result.matchPoints || []).forEach((p) => { const li = document.createElement('li'); li.textContent = p; ul.appendChild(li); });
    $('workflowReview').textContent = workflowText(result);
    $('massWorkflowReview').textContent = workflowText(result);
    $('greeting').value = result.greeting || '（模型未返回打招呼语，请重试或更换模型）';
    $('result').classList.remove('hidden');
    if (persist && currentRecId) { updateRecord(currentRecId, { greeting: result.greeting || '', matchPoints: result.matchPoints || [], workflow: result.workflow }); }
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { return document.execCommand('copy'); } catch (_) { return false; } finally { document.body.removeChild(ta); }
    }
  }
  async function copyGreetingAndMark(button, text) {
    if (!text) return false;
    if (!await copyText(text)) { $('siteStatus').classList.remove('ok'); $('siteStatus').textContent = '复制失败，记录状态未修改。'; return false; }
    const original = button.textContent; button.textContent = '已复制'; setTimeout(() => (button.textContent = original), 1200);
    if (currentRecId) {
      await updateRecord(currentRecId, { greeting: text, greetingState: 'copied', greetingCopiedAt: Date.now() });
      $('siteStatus').textContent = '当前话术已复制并保存到岗位记录。'; $('siteStatus').classList.add('ok');
      if($('agentGenerationStatus'))$('agentGenerationStatus').textContent='当前话术已复制并保存到岗位记录。';
    } else { $('siteStatus').classList.remove('ok'); $('siteStatus').textContent = '话术已复制；尚未关联岗位记录。'; }
    return true;
  }
  $('copyBtn').addEventListener('click', async () => {
    await copyGreetingAndMark($('copyBtn'), $('greeting').value);
  });
  $('regenBtn').addEventListener('click', async () => {
    $('siteStatus').classList.remove('ok');
    const job = currentJob || readJobFromForm();
    const settings = await loadSettings();
    const settingsError = aiSettingsError(settings);
    if (settingsError) { alert(settingsError); return; }
    $('regenBtn').disabled = true; $('siteStatus').textContent = '正在重新生成…';
    chrome.runtime.sendMessage({ type: 'GENERATE', apiKey: settings.apiKey, profile: settings.profile || '', job: job, greetingPrompt: settings.greetingPrompt || '' }, async (resp) => {
      $('regenBtn').disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) { showGenerationError(resp); return; }
      lastResult=resp.result||{};await ensureCurrentRecord(job);renderResult(lastResult,false);saveState({lastResult});
      await updateRecord(currentRecId,{greeting:lastResult.greeting||'',matchPoints:lastResult.matchPoints||[],workflow:lastResult.workflow,greetingState:'draft'});
      $('siteStatus').textContent = '已重新生成并同步到记录。'; $('siteStatus').classList.add('ok');
    });
  });
  $('greetingGear').addEventListener('click', () => { if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); });

  // ---------- 保存记录 ----------
  async function persistRecord(job, greeting, matchPoints, statusOverride) {
    const rec=await recordRequest('AGENT_PERSIST_RECORD',{job,greeting,matchPoints,status:normalizeStatus(statusOverride||'未联系')});recordsCache=await loadRecords();return rec;
  }

  // ---------- 聊天扫描（脚本注入兜底）----------
  async function extractChatViaScript(tab) {
    if(matchesDomain(tab.url||'','liepin.com')){
      const frames=await chrome.scripting.executeScript({target:{tabId:tab.id,allFrames:true},files:['content.js','agent-page.js']});
      const chats=[];
      for(const frame of frames||[]){try{const response=await chrome.tabs.sendMessage(tab.id,{type:'EXTRACT_CHAT'},{frameId:frame.frameId});if(response?.ok&&response.chat?.messages?.length&&response.chat.conversationKey)chats.push(response.chat);}catch(_) {}}
      const keys=new Set(chats.map(c=>c.conversationKey));
      if(keys.size>1)throw Error('页面内发现多个不同会话，无法确定当前聊天，请关闭多余聊天窗口后重试');
      const chat=chats.sort((a,b)=>b.messages.length-a.messages.length)[0];
      if(chat&&!chat.identityEvidence)throw Error('猎聘页面仍在使用旧读取脚本，请刷新猎聘页面后重试；本次未覆盖聊天记录');
      return chat||null;
    }
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: extractChatInPage });
      let best = null;
      (results || []).forEach((r) => { if (r && r.result && r.result.text && (!best || r.result.text.length > best.text.length)) best = r.result; });
      return best;
    } catch (e) { return null; }
  }
  function conversationKey(chat, analysis, sourceUrl) {
    const supplied = String(chat && chat.conversationKey || '').trim();
    if (supplied && !supplied.endsWith('|')) return supplied;
    const identity = [normKey(chat && chat.counterparty), normKey(analysis && analysis.company), normKey(analysis && analysis.jobTitle)].filter(Boolean).join('|');
    // ponytail: 无会话 ID 时用首段消息兜底；真实页面确认稳定 ID 后应优先改为平台会话 ID。
    return platformOf({ url: sourceUrl }) + '|' + (identity || ('unknown|' + normKey(chat && chat.text).slice(0, 160)));
  }
  async function saveConversationScan(chat, analysis, sourceUrl) {
    if (matchesDomain(sourceUrl,'liepin.com') || chat.conversationKey && /liepin\.com\|/.test(chat.conversationKey)) {
      const response = await chrome.runtime.sendMessage({type:'AGENT_SAVE_SCAN',chat:{...chat,conversationKey:conversationKey(chat,analysis,sourceUrl)},analysis,sourceUrl});
      if (!response || !response.ok) throw new Error(response && response.error || '聊天保存失败');
      return response.data;
    }
    const items = await loadConversations(); const before=JSON.parse(JSON.stringify(items)); const now = Date.now(); const key = conversationKey(chat, analysis, sourceUrl);
    let item = items.find((x) => x.key === key);
    const records = await loadRecords(); const candidates = chatMatchCandidates(records, analysis);
    const suggested = candidates.length === 1 && candidates[0].score >= 7 ? candidates[0].rec.id : null;
    if (!item) {
      item = { id: now.toString(36) + Math.random().toString(36).slice(2, 6), key: key, createdAt: now, linkedRecordId: null };
      items.unshift(item);
    }
    Object.assign(item, {
      platform: platformOf({ url: sourceUrl }), sourceUrl: sourceUrl || '', counterparty: chat.counterparty || '',
      jobTitle: analysis.jobTitle || '', company: analysis.company || '', roleQuality: chat.roleQuality || analysis.roleConfidence || 'none',
      messages: AgentCore.retainMessages(item,chat.messages||[]), rawText: String(chat.text || '').slice(0, 8000), analysis: analysis,
      suggestedRecordId: item.linkedRecordId ? null : suggested,
      matchState: item.linkedRecordId ? 'linked' : (suggested ? 'suggested' : 'unlinked'), updatedAt: now
    });
    await saveConversations(items,before);
    const linked = await chrome.runtime.sendMessage({type:'AGENT_AUTO_LINK',conversationId:item.id});
    if (!linked || !linked.ok) throw new Error(linked && linked.error || '聊天已保存，自动关联失败');
    return linked.data || item;
  }
  async function linkConversation(conversationId, recordId) {
    const result=await chrome.runtime.sendMessage({type:'AGENT_LINK',conversationId,recordId});
    if(!result||!result.ok)throw new Error(result&&result.error||'关联保存失败');
    await renderChatInbox();
  }
  function replyLabel(value) { return value === true ? 'HR 已回复' : (value === false ? 'HR 未回复' : '回复情况未知'); }
  function speakerLabel(value) { return value === 'candidate' ? '求职者' : (value === 'hr' ? 'HR' : '未知'); }
  function normalizeChatAnalysis(chat, analysis) {
    const out = Object.assign({}, analysis || {}); const messages = Array.isArray(chat.messages) ? chat.messages : [];
    const known = messages.filter((m) => m.role === 'candidate' || m.role === 'hr');
    const quality = !messages.length || !known.length ? 'none' : (known.length === messages.filter(m=>m.role!=='system').length ? 'high' : 'partial');
    const last = messages.filter(m=>m.role!=='system').at(-1); const hasHr = known.some((m) => m.role === 'hr');
    out.roleConfidence = quality; out.lastSpeaker = last && (last.role === 'candidate' || last.role === 'hr') ? last.role : 'unknown';
    out.replied = hasHr ? true : (quality === 'high' ? false : null);
    out.status = AgentCore.normalizeStatus(out.status);
    if (out.replied !== true && AgentCore.isReplied(out.status)) out.status = out.readStatus === '已读' ? '等待 HR' : '未联系';
    return out;
  }
  async function renderChatInbox() {
    const box = $('chatInbox'); if (!box) return;
    const items = (await loadConversations()).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    $('chatInboxStatus').textContent = items.length ? ('共 ' + items.length + ' 个本地聊天；未关联聊天不会进入投递统计。') : '暂无聊天。扫描结果会先保存在这里。';
    const query=$('chatInboxSearch').value.trim().toLowerCase();
    box.innerHTML = items.filter(item=>[item.company,item.counterparty,item.jobTitle].join(' ').toLowerCase().includes(query)).map((item) => {
      const a = item.analysis || {}; const state = item.matchState === 'linked' ? '已关联岗位' : (item.matchState === 'suggested' ? '待确认关联' : '仅聊天，未关联');
      return '<div class="chat-inbox-card"><div><b>' + esc(item.company || item.counterparty || '未知对话') + '</b><span class="chat-inbox-badge">' + state + '</span></div>' +
        '<div class="meta">' + esc(item.jobTitle || '岗位未知') + ' · ' + esc(replyLabel(a.replied)) + ' · 最后发言：' + esc(speakerLabel(a.lastSpeaker)) + ' · 角色识别：' + esc(item.roleQuality || 'none') + '</div>' +
        '<button type="button" data-conversation-id="' + esc(item.id) + '">打开 / 关联岗位</button></div>';
    }).join('');
  }
  $('chatInboxSearch').addEventListener('input',()=>void renderChatInbox());
  // 注入页面的提取函数（独立，不依赖外部作用域）
  function extractChatInPage() {
    try {
      function getRoot() {
        const sels = ['.chat-container','.chat-message-list','.chat-msg-list','.message-list','.chat-content','.dialogue','.im-chat','.msg-list','.chat-box','.im-dialog','.msg-box','.message-container','.ant-drawer-content','.ant-modal-content','[role="dialog"]','[class*="chat-panel"]','[class*="message-panel"]','[class*="message-list"]','[class*="msg-list"]','[class*="chat-content"]','[class*="message-container"]'];
        const msgSel = '.message-item,.msg-item,.chat-message,.message-content,.item-myself,.item-friend,[data-message-id],[data-msg-id],[class*="message-item"],[class*="msg-item"],[class*="chat-msg"],[class*="message-bubble"],[class*="msg-bubble"],[class*="chat-bubble"],[class*="message-line"],[class*="talk-item"]';
        const composerSel = 'textarea,[contenteditable="true"],input[placeholder*="消息"],input[placeholder*="沟通"],textarea[placeholder*="消息"],textarea[placeholder*="沟通"]';
        function visible(el) { try { const st = getComputedStyle(el), r = el.getBoundingClientRect(); return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0; } catch (e) { return !!el; } }
        function evidence(el) { const text = String(el && el.innerText || ''); try { return !!(el.querySelector(composerSel) || el.querySelectorAll(msgSel).length || (text.length < 12000 && /(已读|未读|请输入.{0,4}(消息|内容)|发送消息|继续沟通)/.test(text))); } catch (e) { return false; } }
        let first = null;
        for (const s of sels) {
          let nodes = []; try { nodes = Array.from(document.querySelectorAll(s)); } catch (e) {}
          if (!nodes.length) { const one = document.querySelector(s); if (one) nodes = [one]; }
          for (const el of nodes) { if (!first && el.innerText && el.innerText.trim()) first = el; if (visible(el) && evidence(el)) return { el: el, floating: true }; }
        }
        return { el: first || document.querySelector('main') || document.body, floating: false };
      }
      function chatTime(value,now=Date.now()){
    const text=String(value||'').trim(),current=new Date(now);let date,reliable=true;
    if(/^\d{10}(?:\d{3})?$/.test(text))date=new Date(Number(text)*(text.length===10?1000:1));
    else {
      const full=text.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      const short=text.match(/^(?:(\d{1,2})[-/月](\d{1,2})日?|今天|昨天|前天)?\s*(\d{1,2}):(\d{2})$/);
      let y,m,d,h,min,sec=0;
      if(full){[,y,m,d,h,min,sec=0]=full;}
      else if(short){y=current.getFullYear();m=short[1]||current.getMonth()+1;d=short[2]||current.getDate();h=short[3];min=short[4];
        if(short[1]){reliable=false;const candidate=new Date(y,m-1,d,h,min);if(candidate.getTime()>now)y--;}
        else if(/昨天|前天/.test(text)){const day=new Date(y,m-1,d);day.setDate(day.getDate()-(/前天/.test(text)?2:1));y=day.getFullYear();m=day.getMonth()+1;d=day.getDate();}
        else if(!text.startsWith('今天'))reliable=false;
      }else if(/^\d{4}-\d{2}-\d{2}T/.test(text))date=new Date(text);else return null;
      if(!date){date=new Date(Number(y),Number(m)-1,Number(d),Number(h),Number(min),Number(sec));if(date.getFullYear()!==Number(y)||date.getMonth()!==Number(m)-1||date.getDate()!==Number(d)||Number(h)>23||Number(min)>59||Number(sec)>59)return null;}
    }
    const stamp=date.getTime();return Number.isFinite(stamp)&&stamp>0&&stamp<=now?{stamp,reliable,text}:null;
  }
  function messageTime(el,meta,root){
    const own=meta.querySelector?.('time[datetime]');
    const raw=own?.getAttribute('datetime')||meta.getAttribute?.('data-timestamp')||meta.getAttribute?.('data-time');
    let found=chatTime(raw);if(found)return {...found,source:'attribute'};
    const labels=[...(root.querySelectorAll?.('time,[class*="time"],[class*="date"]')||[])];
    for(const node of labels){if(node===root)continue;const owner=node.closest?.('[data-message-id],[data-msg-id],.message-item,.msg-item,.im-ui-message,.chat-message');if(owner&&owner!==meta&&!meta.contains?.(owner))continue;const parsed=chatTime(node.innerText||node.textContent);if(!parsed)continue;
      if(meta.contains?.(node))return {...parsed,source:'visible'};
      if(node.compareDocumentPosition?.(meta)&4)found={...parsed,reliable:parsed.reliable&&node.nextElementSibling===meta,source:'separator'};
    }
    return found;
  }
  function systemNotice(text){return /^(?:\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2}\s*)?(?:使用优先沟通，通过短信和邮箱多重提醒|求职过程中如遇收取培训费、考证费、中介费、押金|你已对境外招聘方隐藏简历，若该招聘方当前在境外)/.test(String(text||'').trim());}
  function getRole(el, root) {
    if(systemNotice(el.innerText||el.textContent))return 'system';
    let node=el;
    for(let i=0;node&&node!==root&&i<4;i++,node=node.parentElement){
      const classes=String(node.className||'');
      if(node.getAttribute?.('data-message-type')==='system'||/(?:^|\s)(?:system-message|message-system|system-tip|im-system-msg|system-notice)(?:\s|$)/i.test(classes))return 'system';
      if(/(^|[\s_-])(my|mine|self|myself|send|sent|sender|geek)([\s_-]|$)/i.test(classes))return 'candidate';
      if(/(^|[\s_-])(friend|other|receive|received|receiver|boss|hr)([\s_-]|$)/i.test(classes))return 'hr';
    }
    try { const a=el.getBoundingClientRect(),b=root.getBoundingClientRect();if(a.width>0&&b.width>0&&a.width<b.width*.85)return a.left+a.width/2>b.left+b.width/2?'candidate':'hr'; }catch(e){}
    return 'unknown';
      }
      function getMessages(root) {
    const CHAT_MESSAGE_SELECTOR = '.im-ui-message,.im-ui-message-content,.im-ui-message-text,.im-ui-message-card,.system-message,.message-system,.system-tip,.im-system-msg,[data-message-type="system"],.message-item,.msg-item,.chat-message,.message-content,.item-myself,.item-friend,[data-message-id],[data-msg-id],[class*="message-item"],[class*="msg-item"],[class*="chat-msg"],[class*="message-bubble"],[class*="msg-bubble"],[class*="chat-bubble"],[class*="message-line"],[class*="talk-item"]';
    const out = [];
    root.querySelectorAll(CHAT_MESSAGE_SELECTOR).forEach((el) => {
      const statusOnly=t=>/^[【\[（(]?(?:已读|未读|送达|已发送|发送中)[】\]）)]?$/.test(String(t||'').trim());
      const nested=[...(el.querySelectorAll?.(CHAT_MESSAGE_SELECTOR)||[])];
      if(nested.some(n=>!statusOnly(n.innerText)&&getRole(n,root)!=='system'&&String(n.innerText||'').trim()))return;
      const copy=el.cloneNode?.(true);
      if(copy)for(const n of copy.querySelectorAll('[class*="read"],.system-tip,.system-message,.message-system,.im-system-msg,[data-message-type="system"]'))if(statusOnly(n.textContent)||n.matches('.system-tip,.system-message,.message-system,.im-system-msg,[data-message-type="system"]'))n.remove();
      const text=String(copy?copy.textContent:el.innerText||'').replace(/\s+/g,' ').trim().replace(/(?:\s+(?:已读|未读)|【(?:已读|未读)】|\[(?:已读|未读)\])$/,'').trim();
      if(!text||statusOnly(text)||text.length>1200||el===root)return;
      const item = { role: getRole(el, root), text: text.slice(0, 1200) };
      let node = el, classes = '';
      for (let i = 0; node && node!==root && i < 4; i++, node = node.parentElement) classes += ' ' + String(node.className || '');
      item.roleSource = item.role==='system'?'explicit':/(^|[\s_-])(my|mine|self|myself|send|sent|sender|geek|friend|other|receive|received|receiver|boss|hr)([\s_-]|$)/i.test(classes) ? 'explicit' : 'position';
      let meta=el;
      for(let i=0;meta.parentElement&&meta.parentElement!==root&&i<3&&!meta.matches?.('[data-message-id],[data-msg-id],[data-time],[data-timestamp],.message-item,.msg-item,.im-ui-message,.chat-message');i++)meta=meta.parentElement;
      item.id=meta.getAttribute?.('data-message-id')||meta.getAttribute?.('data-msg-id')||'';
      const parsedTime=messageTime(el,meta,root);
      item.sentAt=parsedTime?.stamp||null;
      if(parsedTime){item.timeSource=parsedTime.source;item.timeText=parsedTime.text;item.timeReliable=parsedTime.reliable;}
      const prev = out[out.length - 1];
      if (!prev || prev.role !== item.role || prev.text !== item.text) out.push(item);
    });
    return out.slice(-100);
  }
      function getHr() {
        const t = document.body.innerText || '';
        const m = t.match(/(刚刚活跃|今日活跃|今天活跃|3日内活跃|三天内活跃|本周活跃|半年前活跃|\d+\s*分钟前活跃|\d+\s*小时前活跃|\d+\s*小时内活跃|\d+\s*天前活跃|\d+\s*周内活跃|\d+\s*周前活跃|\d+\s*个月前活跃)/);
        if (!m) return '';
        const s = m[1];
        if (/刚刚|分钟前/.test(s)) return '刚刚活跃';
        if (/今日|今天|小时/.test(s)) return '今日活跃';
        if (/3日内|三天内/.test(s)) return '3日内活跃';
        if (/本周|周内/.test(s)) return '本周活跃';
        const dm = s.match(/(\d+)\s*天前/); if (dm) { const d = parseInt(dm[1], 10); if (d <= 1) return '今日活跃'; if (d <= 3) return '3日内活跃'; if (d <= 7) return '本周活跃'; return '半年前活跃'; }
        if (/周前|个月前|半年前/.test(s)) return '半年前活跃';
        return s;
      }
      const picked = getRoot(); const root = picked.el; const text = (root && root.innerText || '').trim(); const messages = getMessages(root);
      const path = (location.pathname || '').toLowerCase();
      const isJob = /\/job(?:_detail)?\//.test(path);
      const isChat = picked.floating || (!isJob && (/(\/im\/|\/web\/im|\/geek\/chat|conversation|message|\/chat|chat\/)/.test(path) || (/(已读|未读|对方正在输入|发消息|聊天)/.test(document.body.innerText || '') && !/职位描述|岗位职责|职位介绍/.test(document.body.innerText || ''))));
      const active = document.querySelector('.friend-item.active,.friend-item.selected,.conv-item.active,.conv-item.selected,.chat-item.active,.chat-item.selected,.dialog-item.active,.dialog-item.selected,.user-item.active,.user-item.selected,.contact-item.active,.contact-item.selected,[class*="conversation"][class*="active"],[class*="conversation"][class*="selected"]');
      const activeId = active && ['data-conversation-id','data-id','data-uid','data-user-id'].map((key) => active.getAttribute(key)).find(Boolean);
      const counterparty = active && active.innerText ? active.innerText.trim().split('\n')[0] : '';
      const knownRoles = messages.filter((m) => m.role !== 'unknown').length;
      const roleQuality = !messages.length ? 'none' : (knownRoles === messages.length ? 'high' : (knownRoles ? 'partial' : 'none'));
      const keyPart = activeId || counterparty;
      return { isChat: isChat, text: text.slice(0, 8000), messages: messages, roleQuality: roleQuality, conversationKey: keyPart ? location.hostname + '|' + keyPart : '', counterparty: counterparty, hrActiveText: getHr() };
    } catch (e) { return { isChat: false, text: '', hrActiveText: '' }; }
  }
  async function captureCurrentChat() {
    const button=$('scanChatBtn');if(button.disabled)return;button.disabled=true;
    try{
    document.querySelector('.tab[data-tab="chat"]').click();
    $('chatScanStatus').classList.remove('ok');
    const state=await chrome.runtime.sendMessage({type:'AGENT_STATUS'});if(!state?.ok)throw Error(state?.error||'无法核对任务状态');if(state.data?.running)throw Error('当前任务正在操作页面，请暂停或完成后抓取当前聊天');
    const tab = await currentTab(); if (!tab) { $('chatScanStatus').textContent = '未找到当前标签页。'; return; }
    $('chatScanStatus').textContent = '正在读取聊天内容…';
    const chatResp = await contentMessage(tab.id, { type: 'EXTRACT_CHAT' });
    let chat = chatResp && chatResp.ok ? chatResp.chat : null;
    if (!chat?.isChat || !chat.messages?.length || matchesDomain(tab.url||'','liepin.com')&&(!chat.identityEvidence||!chat.conversationKey)) chat = await extractChatViaScript(tab) || chat;
    if (!chat || (!chat.text && !chat.isChat)) { $('chatScanStatus').textContent = '读取聊天页失败，请打开招聘平台的消息会话并刷新后重试。'; return; }
    if (!chat.isChat) {
      $('chatScanStatus').textContent = matchesDomain(tab.url || '', 'liepin.com') && /\/job\//i.test(tab.url || '')
        ? '当前是猎聘岗位详情页，只能提取岗位信息；请切回猎聘消息页并打开具体会话后再扫描。'
        : '当前页面不是聊天会话页，请先打开具体聊天。';
      return;
    }
    await runChatAnalysis(chat, tab.url || '');
    }catch(e){$('chatScanStatus').textContent='读取或分析失败：'+e.message;}finally{button.disabled=false;}
  }
  $('scanChatBtn').addEventListener('click',captureCurrentChat);
  async function runChatAnalysis(chat, sourceUrl) {
    const text = chat.text || '', hrActiveText = chat.hrActiveText || '';
    if (text.length < 10) { $('chatScanStatus').textContent = '聊天文本为空。'; return; }
    const previous = AgentCore.findConversation(await loadConversations(),{key:conversationKey(chat, {}, sourceUrl)});
    const unchanged=!previous?.analysisError&&previous?.analysis&&Object.keys(previous.analysis).length&&chat.messages?.length&&previous.activity?.messageFingerprint===AgentCore.fingerprint(chat.messages);
    let a=previous?.analysis;
    if(!unchanged){
      const settings = await loadSettings();
      const settingsError = aiSettingsError(settings); if (settingsError) { $('chatScanStatus').textContent = settingsError; return; }
      $('chatScanStatus').textContent = 'AI 分析中…';
      const resp=await chrome.runtime.sendMessage({ type: 'PARSE_CHAT', previousState: previous?.analysis?.conversationState, apiKey: settings.apiKey, messages: chat.messages || [], roleQuality: chat.roleQuality || 'none', chatText: text, hrActiveText: hrActiveText || '', profile: settings.profile || '' });
      if (!resp?.ok) { const error=resp?.error||'后台未响应';const saved=await saveConversationScan({...chat,analysisError:error},previous?.analysis||{},sourceUrl);await openSavedConversation(saved.id);await renderAgentViews();$('chatScanStatus').textContent='原消息已保存，分析失败：'+error+'；可核对消息后重试分析。';return; }
      a=normalizeChatAnalysis(chat,resp.analysis);
    }
      lastParsedChat = a;
      let saved; try { saved = await saveConversationScan(chat, a, sourceUrl); } catch(e) { $('chatScanStatus').textContent = '保存失败：' + e.message; return; } lastConversationId = saved.id; await renderChatInbox();
      await openSavedConversation(saved.id);
      $('chatResult').classList.remove('hidden'); $('chatScanStatus').classList.add('ok');
      $('chatScanStatus').textContent=unchanged?'消息未变化，已复用保存分析。':'聊天及分析已保存。';
  }
  async function openSavedConversation(id) {
    const linked = await chrome.runtime.sendMessage({type:'AGENT_AUTO_LINK',conversationId:id});
    if (!linked || !linked.ok) $('chatScanStatus').textContent = linked && linked.error || '自动匹配失败，请稍后重试';

    const [items, records] = await Promise.all([loadConversations(), loadRecords()]);
    const item = items.find(x => x.id === id || x.aliasIds?.includes(id));
    if (!item) { $('chatScanStatus').textContent = '该聊天已被删除，请刷新收件箱。'; return; }
    const a = normalizeChatAnalysis(AgentCore.effectiveChat(item),item.analysis || {});
    lastConversationId = item.id; lastParsedChat = a;
    $('chatHeading').textContent=[item.company||item.counterparty,item.jobTitle].filter(Boolean).join(' · ')||'当前沟通';
    $('chatSourceActions').querySelectorAll('[data-agent-action="openChatSource"]').forEach(el=>el.remove());
    $('chatSourceActions').insertAdjacentHTML('afterbegin','<button type="button" data-agent-action="openChatSource" data-id="'+esc(id)+'">打开原聊天</button>');
    const activity=AgentCore.effectiveChat(item).activity||{};
    $('chatSwitcher').open=false;
    $('chatReply').value = item.replyDraft?.text || ''; $('chatReplyReview').textContent = item.replyDraft?.review || '';
    $('applyChatState').checked = false;
    chatLinkRecords = records;
    $('chatRecordSearch').value = '';
    renderChatTargets(records, a, item.linkedRecordId);
    const target = records.find(r=>r.id===item.linkedRecordId);
    $('chatLinkFallback').classList.remove('hidden');
    $('chatKeepUnlinked').hidden=!!target;$('changeChatLink').classList.remove('hidden');$('changeChatLink').textContent=target?'修改岗位关联':'选择对应岗位';
    $('chatLinkStatus').textContent = target ? '已关联：'+(target.company||'')+' · '+(target.title||'') : '未找到唯一匹配，请从下面的选项中选择。';
    chatStatusVal=normalizeStatus(target?.status||item.manualProgress?.status||a.status);
    $('chatHeading').textContent=[target?.company||item.company||item.counterparty,target?.title||item.jobTitle].filter(Boolean).join(' · ')||'当前沟通';
    $('chatAssociation').textContent=target?'已关联':'未关联';$('chatAssociation').dataset.recordId=target?.id||'';
    $('chatOverview').textContent=[chatStatusVal,({user:'等待我回复',recruiter:'等待HR',unknown:'等待对象待确认'})[activity.waitingFor]||'',activity.lastMessageAt?'最后消息 '+new Date(activity.lastMessageAt).toLocaleString():'消息时间未知',item.archive?'已放入回收站':''].filter(Boolean).join(' · ');
    $('chatReplyOverview').innerHTML='<table><tbody><tr><th>沟通情况</th><td>'+esc(a.summary||'暂无已保存的对话分析')+'</td></tr><tr><th>注意事项</th><td>'+esc(a.bottleneck||'暂无')+'</td></tr></tbody></table>';
    $('chatResolve').hidden=false;$('chatResolve').textContent='补充缺失信息';$('chatPrepareReply').hidden=false;
    $('chatReplyDraftArea').hidden=!item.replyDraft?.text;



    $('chatResult').classList.remove('hidden');
    $('chatScanStatus').textContent = '';
    $('chatResult').scrollIntoView({ block: 'nearest' });
  }
  function renderChatTargets(records, analysis, linkedId) {
    const query = $('chatRecordSearch').value.trim().toLowerCase().split(/[\s,，·|]+/).filter(Boolean);
    const suggested = new Set(chatMatchCandidates(records,analysis||{}).map(x=>x.rec.id));
    const matches = records.filter(r=>query.every(q=>normKey([r.company,r.title,r.location].join(' ')).includes(normKey(q))))
      .slice().sort((x,y)=>Number(suggested.has(y.id))-Number(suggested.has(x.id)));
    const select = $('chatRecordSelect'); select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value=''; placeholder.textContent=matches.length?'请选择对应岗位':'没有找到，请先采集岗位详情'; select.appendChild(placeholder);
    for(const rec of matches){const option=document.createElement('option');option.value=rec.id;option.textContent=(suggested.has(rec.id)?'可能匹配 · ':'')+(rec.company||'未知公司')+' · '+(rec.title||'未知岗位')+' · '+(rec.location||'地点未知');select.appendChild(option);}
    select.value=matches.some(r=>r.id===linkedId)?linkedId:'';
    $('applyChatBtn').disabled=!select.value;
    $('chatSearchHint').textContent=matches.length?'找到 '+matches.length+' 个岗位，选择后确认即可。':'没有对应记录：打开岗位详情，在采集页抓取后再回来关联。';
  }
  $('chatRecordSearch').addEventListener('input',()=>renderChatTargets(chatLinkRecords,lastParsedChat,null));
  $('chatRecordSelect').addEventListener('change',()=>{$('applyChatBtn').disabled=!$('chatRecordSelect').value;});
  $('changeChatLink').addEventListener('click',()=>{$('chatLinkDialog').showModal();$('chatRecordSearch').focus();});
  $('closeChatResult').addEventListener('click', () => {
    lastConversationId = null; lastParsedChat = null;
    $('chatReply').value = ''; $('chatReplyReview').textContent = '';
    $('chatResult').classList.add('hidden');
  });
  $('chatInbox').addEventListener('click', async e => {
    const button = e.target.closest('button[data-conversation-id]');
    if (button) await openSavedConversation(button.dataset.conversationId);
  });
  function stateHtml(state) {
    if (!state) return '';
    return '<div class="meta"><b>招聘阶段：</b>'+esc(state.stage||'待确认')+'<p>下一步：'+esc(String(state.nextAction||'待确认').slice(0,70))+'</p><details><summary>关注点、风险与完整行动</summary>' + [['招聘方关注点', (state.recruiterFocus || []).join('；')], ['风险', (state.risks || []).join('；')], ['待确认', (state.openQuestions || []).join('；')], ['下一步', state.nextAction]].map(([k,v]) => '<div><b>' + k + '：</b>' + esc(v || '暂无') + '</div>').join('') + '</details></div>';
  }
  function workflowText(result) {
    const w = result && result.workflow;
    if (!w) return '旧版内容，尚未进行质量检查';
    const labels = { jdMatch: 'JD匹配', personalization: '个性化', truthfulness: '真实性', conciseness: '简洁度', naturalness: '自然度' };
    const s=w.strategy||{},e=w.evaluation||{},checks=e.checks||{};
    return '① Strategy Planner（策略）\n目标：'+(s.goal||'待确认')+(s.highlights?.length?'\n'+s.highlights.map((h,i)=>(i+1)+'. '+h.label+'\n岗位任务：'+h.jobRequirement+'\n个人依据：'+h.candidateEvidence+'\n选材理由：'+h.relevance).join('\n'):'\n重点：'+(s.focus||[]).join('；')+'\n可用事实：'+(s.matchedEvidence||[]).join('；'))+'\n避免夸大：'+(s.avoidClaims||[]).join('；')+'\n语气：'+(s.tone||'自然、简洁、诚实')+
      '\n\n② Content Generator（生成）\n已按上述策略生成下方话术草稿。'+
      '\n\n③ Evaluator（检验）\n'+(e.passed?'质量检查通过':'草稿需要修改')+'\n'+Object.entries(checks).map(([k,v])=>(labels[k]||k)+'：'+(v.pass?'通过':'待修改')+' — '+v.reason+(v.refine?'；必须修改：'+v.refine:'')+(v.polish?'；可选润色：'+v.polish:'')).join('\n')+
      '\n\n④ Refine（修改）\n'+(w.revision?'已自动修改一次。首轮问题：'+(w.revision.suggestions||[]).join('；')+'\n首轮草稿：'+w.revision.originalDraft:(e.refine||[]).length?'建议修改：'+e.refine.join('；'):'无需再次修改')+'\n\n模型检查仅供参考，发送前请核对事实。';
  }
  $('replyBtn').addEventListener('click', async () => {
    const conversationId = lastConversationId;
    if (!conversationId) return;
    const settings = await loadSettings();
    const error = aiSettingsError(settings); if (error) { $('chatReplyReview').textContent = error; return; }
    $('chatReplyDraftArea').hidden=false;$('replyBtn').disabled = true; $('chatReplyReview').textContent = '正在制定策略、生成并检查回复…';
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GENERATE_REPLY', conversationId, apiKey: settings.apiKey, profile: settings.profile || '' });
      if (lastConversationId !== conversationId) return;
      $('chatReplyReview').textContent = resp && resp.result ? workflowText(resp.result) : ((resp && resp.error) || '后台无响应');
      if (resp && resp.result && resp.result.greeting) { $('chatReply').value = resp.result.greeting; await saveReplyDraft('draft'); }
    } catch (e) { $('chatReplyReview').textContent = e.message; }
    finally { $('replyBtn').disabled = false; }
  });
  $('copyReplyBtn').addEventListener('click', async () => {
    if ($('chatReply').value) {const copied=await copyText($('chatReply').value);$('chatReplyReview').textContent=copied?'已复制，请核对后手动发送。':'复制失败';if(copied)await saveReplyDraft('copied');}
  });
  let chatStatusVal = '未联系';
  function chatMatchCandidates(records, analysis) {
    const title = normKey(analysis.jobTitle), company = normKey(analysis.company);
    return records.map((rec) => {
      const rt = normKey(rec.title), rc = normKey(rec.company); let score = 0;
      if (title && rt) score += title === rt ? 4 : (title.includes(rt) || rt.includes(title) ? 2 : 0);
      if (company && rc) score += company === rc ? 3 : (company.includes(rc) || rc.includes(company) ? 1 : 0);
      return { rec: rec, score: score };
    }).filter((x) => x.score >= 2).sort((a, b) => b.score - a.score);
  }
  function chooseChatTarget(records, analysis) {
    const candidates = chatMatchCandidates(records, analysis);
    if (!candidates.length) return null;
    if (candidates[0].score >= 7 && (!candidates[1] || candidates[1].score < 7)) return candidates[0].rec;
    if (candidates.length === 1) {
      const rec = candidates[0].rec;
      return confirm('聊天可能对应：\n' + (rec.company || '—') + ' · ' + (rec.title || '—') + '\n\n确定 = 关联并更新该记录\n取消 = 仅保留在聊天收件箱') ? rec : null;
    }
    const shown = candidates.slice(0, 5);
    const answer = prompt('聊天匹配到多个候选，请输入序号；留空或取消将仅保留在聊天收件箱：\n\n' + shown.map((x, i) => (i + 1) + '. ' + (x.rec.company || '—') + ' · ' + (x.rec.title || '—')).join('\n'), '1');
    const index = Number(answer) - 1;
    return Number.isInteger(index) && shown[index] ? shown[index].rec : null;
  }
  $('applyChatBtn').addEventListener('click', async () => {
    const id = lastConversationId, recordId = $('chatRecordSelect').value;
    if (!id || !recordId) { $('chatScanStatus').textContent = '请先打开聊天并选择要关联的岗位。'; return; }
    $('applyChatBtn').disabled = true;
    try {
      await applyConversationLink(id, recordId, false, chatStatusVal);$('chatLinkDialog').close();
      if(lastConversationId===id)await openSavedConversation(id);
      $('chatScanStatus').textContent = '岗位关联已保存。';
    } catch (e) { $('chatLinkError').textContent = '关联失败：' + e.message; }
    finally { $('applyChatBtn').disabled = false; }
  });
  async function applyConversationLink(id, recordId, applyState, status) {
    const [items, records] = await Promise.all([loadConversations(), loadRecords()]);
    const item = items.find(x => x.id === id), target = records.find(x => x.id === recordId);
    if (!item || !target) throw new Error('聊天或岗位已删除，请重新选择');
    await linkConversation(id, recordId);
    if (applyState) {
      const a = item.analysis || {};
      await updateRecord(target.id, { status: normalizeStatus(status), conversationState: a.conversationState,
        hrActive: a.hrActive || target.hrActive || '未知', notes: (target.notes ? target.notes + '\n' : '') + '卡点：' + (a.bottleneck || '') + '；建议：' + (a.suggestion || '') });
    }
  }
  $('deleteChatRecBtn').addEventListener('click', async () => {
    if (!lastConversationId) { $('chatScanStatus').textContent = '请先扫描一个聊天。'; return; }
    if (!confirm('确定从本地聊天收件箱删除本次聊天分析？岗位记录不会被删除。')) return;
    const items = await loadConversations(); const remaining = items.filter((x) => x.id !== lastConversationId);
    await saveConversations(remaining,items); lastConversationId = null; lastParsedChat = null;
    $('chatResult').classList.add('hidden'); await renderChatInbox(); $('chatScanStatus').textContent = '已删除本次聊天分析，岗位记录未改动。'; $('chatScanStatus').classList.add('ok');
  });

  // ---------- 记录表格（多选/排序/城市筛选）----------
  function sortVal(rec, key) {
    if (key === 'overall') return (rec.scores && rec.scores.overall != null) ? rec.scores.overall : -1;
    if (key === 'status') return STATUS_ORDER.indexOf(normalizeStatus(rec.status));
    if (key === 'hrActive') return HR_ORDER.indexOf(rec.hrActive || '未知');
    if (key === 'createdAt') return AgentCore.recordTime(rec);
    if (key === 'platform') return platformOf(rec);
    return (rec[key] || '').toString();
  }
  // 列宽拖拽调整（行高通过单元格内 textarea 的 resize 实现）
  function enableColResize(table) {
    if (!table) return;
    table.querySelectorAll('thead th').forEach((th) => {
      if (th.classList.contains('col-check') || th.classList.contains('col-idx')) return;
      if (th.querySelector('.col-resizer')) return;
      const rz = document.createElement('span'); rz.className = 'col-resizer'; th.appendChild(rz);
      rz.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX; const startW = th.offsetWidth;
        const onMove = (ev) => { th.style.width = Math.max(48, startW + (ev.clientX - startX)) + 'px'; th.style.minWidth = th.style.width; };
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
      });
    });
  }
  async function renderRecords() {
    if(document.activeElement?.closest('#recBody')&&document.activeElement.matches('input:not([type=checkbox]),textarea,select'))return;
    const records = await loadRecords(); recordsCache = records;
    const {agentConfig}=await chrome.storage.local.get(['agentConfig']);
    let rows = records.slice();
    if (searchFilters.title) rows = rows.filter((r) => (r.title || '').includes(searchFilters.title));
    if (searchFilters.company) rows = rows.filter((r) => (r.company || '').includes(searchFilters.company));
    if (sortKey) {
      rows.sort((a, b) => {
        const av = sortVal(a, sortKey), bv = sortVal(b, sortKey);
        let cmp;
        if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
        else cmp = String(av).localeCompare(String(bv), 'zh');
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    const body = $('recBody'); body.innerHTML = '';
    const ftext = (searchFilters.title ? '｜筛选 岗位含「' + searchFilters.title + '」' : '') + (searchFilters.company ? '｜筛选 公司含「' + searchFilters.company + '」' : '');
    $('recCount').textContent = '共 ' + records.length + ' 条，当前显示 ' + rows.length + ' 条' + (selectedIds.size ? '（已勾选 ' + selectedIds.size + '）' : '') + ftext;
    $('recEmpty').innerHTML=records.length?'当前筛选没有匹配记录。<button type="button" id="clearRecordFilters">清除筛选并显示全部</button>':'还没有记录，请先采集岗位。';
    $('clearRecordFilters')?.addEventListener('click',()=>{searchFilters.title='';searchFilters.company='';renderRecords();});
    $('recEmpty').style.display = rows.length ? 'none' : 'block';
    $('recTable').style.display = rows.length ? 'table' : 'none';
    let seq = 0;
    const fragment=document.createDocumentFragment();
    rows.forEach((rec) => { const savedRec=rec;rec={...rec,...recordDrafts[rec.id]};
      seq++;
      const tr = document.createElement('tr');tr.dataset.cardId=rec.id;
      if (selectedIds.has(rec.id)) tr.classList.add('row-selected');
      const tdChk = document.createElement('td'); tdChk.className = 'col-check';
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = selectedIds.has(rec.id); chk.dataset.id = rec.id;
      chk.addEventListener('change', () => { if (chk.checked) selectedIds.add(rec.id); else selectedIds.delete(rec.id); tr.classList.toggle('row-selected', chk.checked); });
      tdChk.appendChild(chk); tr.appendChild(tdChk);
      const tdIdx = document.createElement('td'); tdIdx.className = 'col-idx'; tdIdx.textContent = seq; tr.appendChild(tdIdx);
      const cell = (val, key, cls) => { const td = document.createElement('td'); const i = document.createElement('input'); i.value = val || ''; if (cls) i.className = cls; i.addEventListener('change', () => updateRecord(rec.id, Object.assign({}, { [key]: i.value }),false,savedRec)); td.appendChild(i); return td; };
      tr.appendChild(cell(rec.title, 'title'));
      const tdComp = document.createElement('td');
      const ci = document.createElement('input'); ci.value = rec.company || ''; ci.addEventListener('change', () => updateRecord(rec.id, { company: ci.value },false,savedRec));
      tdComp.appendChild(ci);
      tr.appendChild(tdComp);
      tr.appendChild(cell(rec.location, 'location'));
      tr.appendChild(cell(rec.salary, 'salary', 'cell-sm'));
      tr.appendChild(cell(rec.size, 'size', 'cell-sm'));
      const tdStatus = document.createElement('td'); const sel = document.createElement('select');
      STATUS_LIST.forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; if (s === normalizeStatus(rec.status)) o.selected = true; sel.appendChild(o); });
      sel.addEventListener('change', () => updateRecord(rec.id, { status: sel.value },false,savedRec)); tdStatus.appendChild(sel); tr.appendChild(tdStatus);
      const tdDecision=document.createElement('td'),decision=document.createElement('span');decision.className='decision-badge decision-'+(rec.discoveryState||'none');decision.textContent=rec.communicationArchive?'回收站 · '+rec.communicationArchive.reason:AgentCore.decisionLabel(rec.discoveryState);tdDecision.appendChild(decision);tr.appendChild(tdDecision);
      const tdScore = document.createElement('td');
      if (rec.scores && rec.scores.overall != null) { const p = document.createElement('span'); p.className = 'score-pill'; p.textContent = '★' + rec.scores.overall; p.title = '点击查看评分详情'; p.addEventListener('click', () => alert(scoreText(rec.scores))); tdScore.appendChild(p); }
      else { tdScore.textContent = '—'; }
      const scoreInfo=AgentCore.scoreInfo(rec),hint=document.createElement('small');hint.textContent=scoreInfo.message;tdScore.appendChild(hint);
      if(scoreInfo.retry){const retry=document.createElement('button');retry.textContent='重试多维评分';retry.addEventListener('click',async()=>{retry.disabled=true;hint.textContent='正在评分…';try{await callScore(recToJob(rec),await loadSettings());await renderRecords();}catch(error){hint.textContent=error.message;retry.disabled=false;}});tdScore.appendChild(retry);}
      tr.appendChild(tdScore);
      const tdHr = document.createElement('td'); const hb = document.createElement('span'); hb.className = 'hr-badge'; hb.textContent = (rec.hrActive || '未知'); tdHr.appendChild(hb); tr.appendChild(tdHr);
      const tdNotes = document.createElement('td'); tdNotes.className = 'notes-cell';
      const taN = document.createElement('textarea'); taN.value = rec.notes || ''; taN.rows = 2; taN.className = 'fill'; taN.addEventListener('change', () => updateRecord(rec.id, { notes: taN.value },false,savedRec));
      tdNotes.appendChild(taN); tr.appendChild(tdNotes);
      const tdG = document.createElement('td'); const wrap = document.createElement('div'); wrap.className = 'greeting-cell';
      const receipt=document.createElement('small');receipt.textContent=rec.generationDraft?.text?'草稿待修改':rec.greeting?({sent:'已确认发送',copied:'已复制',draft:'话术已保存'}[rec.greetingState]||'话术已保存'):'尚未生成话术';wrap.appendChild(receipt);
      if(rec.generationDraft?.text){const draft=document.createElement('details'),label=document.createElement('summary'),text=document.createElement('textarea');label.textContent='查看待修改草稿';text.value=rec.generationDraft.text;text.readOnly=true;draft.append(label,text);wrap.appendChild(draft);}
      const ta = document.createElement('textarea'); ta.value = rec.greeting || ''; ta.rows = 3; ta.addEventListener('change', () => updateRecord(rec.id, { greeting: ta.value },false,savedRec));
      const cp = document.createElement('button'); cp.className = 'mini'; cp.textContent = '复制'; cp.addEventListener('click', async () => { try { await navigator.clipboard.writeText(ta.value);await updateRecord(rec.id,{greeting:ta.value,greetingState:'copied',greetingCopiedAt:Date.now()}); cp.textContent = '已复制'; setTimeout(() => (cp.textContent = '复制'), 1000); } catch (e) {alert('未保存：'+e.message);} });
      wrap.appendChild(ta); wrap.appendChild(cp); tdG.appendChild(wrap); tr.appendChild(tdG);
      const tdJ = document.createElement('td'); const tj = document.createElement('textarea'); tj.value = rec.description || ''; tj.rows = 4; tj.className = 'jd-cell'; tj.addEventListener('change', () => updateRecord(rec.id, { description: tj.value },false,savedRec)); tdJ.appendChild(tj); tr.appendChild(tdJ);
      const tdU = document.createElement('td');
      if (rec.url) {
        const a = document.createElement('a'); a.href = rec.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '打开'; a.className = 'src-link'; tdU.appendChild(a);
        const sourceNames=[...new Set((Array.isArray(rec.sources)?rec.sources:[]).filter(Boolean).map(s=>({favorite:'收藏',apply:'应聘记录',search:'搜索',current:'当前岗位',conversation:'聊天'}[s.kind]||s.kind)).filter(Boolean))];
        const pf = document.createElement('div'); pf.className = 'src-platform'; pf.textContent = [platformOf(rec),...sourceNames].join(' · '); pf.title = '点击按平台排序';
        pf.addEventListener('click', () => { if (sortKey !== 'platform') { sortKey = 'platform'; sortDir = 'asc'; } else { sortDir = (sortDir === 'asc' ? 'desc' : 'asc'); } renderRecords(); });
        tdU.appendChild(pf);
      } else tdU.textContent = '—';
      tr.appendChild(tdU);
      const tdOp = document.createElement('td'); const mockBtn = document.createElement('button'); mockBtn.className = 'mini primary'; mockBtn.textContent = '模拟面试';
      mockBtn.addEventListener('click', () => openMockInterview(rec));
      tdOp.appendChild(mockBtn);
      const prepare=document.createElement('button');prepare.textContent='准备话术';prepare.onclick=()=>openGeneration([rec.id]);tdOp.appendChild(prepare);
      const chat=document.createElement('button');chat.textContent='查看沟通';chat.onclick=async()=>{document.querySelector('.tab[data-tab="chat"]').click();const items=await loadConversations();const c=items.find(c=>c.linkedRecordId===rec.id);if(c)await openSavedConversation(c.id);else $('chatScanStatus').textContent='暂无关联会话，可抓取聊天后自动关联，失败时手动搜索。';};tdOp.appendChild(chat);
      const info=document.createElement('details');info.innerHTML='<summary>岗位时间线与匹配</summary>'+recordTimelineHtml(rec)+EchoAgentUI.matching({...rec.recommendation,id:rec.id,...AgentCore.requirementMatch(rec.recommendation||{},agentConfig)});tdOp.appendChild(info);
      if(rec.mergeHistory?.length){const history=document.createElement('details'),label=document.createElement('summary'),pre=document.createElement('pre');label.textContent='合并历史与冲突原值';pre.textContent=JSON.stringify(rec.mergeHistory,null,2);pre.style.whiteSpace='pre-wrap';history.append(label,pre);tdOp.appendChild(history);}tr.appendChild(tdOp);
      fragment.appendChild(tr);
    });
    body.appendChild(fragment);
    updateSortArrows();
    if (typeof updateSortTimeBtn === 'function') updateSortTimeBtn();
    enableColResize($('recTable'));
  }
  function scoreText(s) {
    if (!s) return '无评分';
    let t = '岗位：\n'; const jk = ['roleMatch','skillFit','salary','location','company','techStack','growth','interviewDifficulty','time','wlb'];
    (s.job ? jk : []).forEach((k) => { const d = s.job[k] || {}; t += '  ' + k + '：' + (d.score == null ? '数据不足' : d.score + '/5') + ' — ' + (d.reason || '') + '\n'; });
    if (s.job && s.job.total != null) t += '  岗位综合：' + s.job.total + '/5\n';
    t += '公司：\n'; const ck = ['industryScale','prosCons','salary','overtime'];
    (s.company ? ck : []).forEach((k) => { const d = s.company[k] || {}; t += '  ' + k + '：' + (d.score == null ? '数据不足' : d.score + '/5') + ' — ' + (d.reason || '') + '\n'; });
    if (s.company && s.company.total != null) t += '  公司综合：' + s.company.total + '/5\n';
    if (s.overall != null) t += '总评：' + s.overall + '/5\n';
    if (s.source) t += '依据：' + s.source;
    return t;
  }

  // 排序表头
  function updateSortArrows() {
    document.querySelectorAll('.rec-table th.sortable').forEach((th) => {
      const k = th.getAttribute('data-sort');
      const base = th.getAttribute('data-label') || th.textContent.replace(/[▲▼]/g, '').trim();
      th.setAttribute('data-label', base);
      th.innerHTML = base + (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    });
  }
  document.querySelectorAll('.rec-table th.sortable').forEach((th) => th.addEventListener('click', () => {
    const k = th.getAttribute('data-sort');
    if (sortKey === k) sortDir = (sortDir === 'asc' ? 'desc' : 'asc'); else { sortKey = k; sortDir = 'asc'; }
    renderRecords();
  }));
  // 按时间排序：默认 新→旧，点击切换 新→旧 / 旧→新
  function updateSortTimeBtn() {
    const btn = $('sortTimeBtn'); if (!btn) return;
    if (sortKey === 'createdAt') btn.textContent = '🕘 最近更新 ' + (sortDir === 'desc' ? '新→旧' : '旧→新');
    else btn.textContent = '🕘 最近更新';
  }
  $('sortTimeBtn').addEventListener('click', () => {
    if (sortKey !== 'createdAt') { sortKey = 'createdAt'; sortDir = 'desc'; }
    else { sortDir = (sortDir === 'desc' ? 'asc' : 'desc'); }
    updateSortTimeBtn();
    renderRecords();
  });
  $('selUnscored').addEventListener('click', async () => { const recs = await loadRecords(); selectedIds = new Set(recs.filter((r) => !(r.scores && r.scores.overall != null)).map((r) => r.id)); renderRecords(); });
  $('selUngreeted').addEventListener('click', async () => { const recs = await loadRecords(); selectedIds = new Set(recs.filter((r) => !r.greeting).map((r) => r.id)); renderRecords(); });
  $('selConsider').addEventListener('click', async () => { const recs = await loadRecords(); selectedIds = new Set(recs.filter((r) => !r.discoveryState||['pending','skipped'].includes(r.discoveryState)).map((r) => r.id)); renderRecords(); });
  $('batchConsiderBtn').addEventListener('click', async () => {
    const ids = [...selectedIds]; if (!ids.length) { alert('请先勾选岗位。'); return; }
    if (!confirm('将把勾选岗位的用户判断改为“暂不考虑”？招聘进度不会改变。')) return;
    const response=await chrome.runtime.sendMessage({type:'AGENT_ACTION',action:'bulkDismiss',ids});if(!response?.ok){alert(response?.error||'保存失败');return;}recordsCache=await loadRecords();
    renderRecords(); alert('已将勾选岗位标记为“暂不考虑”，招聘进度保持不变。');
  });
  // 全选重复项：相同平台岗位标识
  $('selDup').addEventListener('click', async () => {
    const records = await loadRecords();
    if (records.length < 2) { alert('记录少于 2 条，无需去重。'); return; }
    $('recCount').textContent = '识别重复中…';
    chrome.runtime.sendMessage({ type: 'DEDUP', records: records }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) { $('recCount').textContent = '识别失败：' + ((resp && resp.error) || '未知'); return; }
      const groups = resp.groups || [];
      const ids = new Set();
      groups.forEach((g) => (g.group || []).forEach((i) => { if (records[i]) ids.add(records[i].id); }));
      selectedIds = ids; renderRecords();
      $('recCount').textContent = groups.length ? ('已勾选 ' + ids.size + ' 条同平台岗位标识记录，点「批量去重」核对' ) : '未发现相同平台岗位标识；同名不同标识不会合并';
    });
  });
  // 批量去重：沿用同一组严格规则
  $('batchDedupBtn').addEventListener('click', async () => {
    try {
      if (!await recordClient.mergeSelected([...selectedIds])) return;
      selectedIds.clear(); renderRecords();
      alert('合并完成，资料和聊天关联已保存。');
    } catch (error) { alert(error.message); }
  });

  // 下拉菜单（导出 / 批量）
  function setupDropdown(btnId, menuId) {
    const btn = $(btnId), menu = $(menuId);
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target !== btn) menu.classList.add('hidden'); });
  }
  setupDropdown('exportMenuBtn', 'exportMenu');
  setupDropdown('batchMenuBtn', 'batchMenu');

  // 批量
  async function batchRun() {
    const settings = await loadSettings();
    if (!settings.apiKey) { alert('未配置 API Key。'); return; }
    const ids = [...selectedIds]; if (!ids.length) { alert('请先勾选记录（或用「全选未评分/未生成」）。'); return; }
    const records = await loadRecords();
    let done = 0; const failures = [];
    for (const id of ids) {
      const rec = records.find((r) => r.id === id); if (!rec) continue;
      const job = recToJob(rec);
      try { await callScore(job, settings); } catch(error) { failures.push((job.title||id)+'：'+error.message); }
      done++; $('recCount').textContent = '批量评分中 ' + done + '/' + ids.length + '…';
    }
    $('recCount').textContent = '共 ' + records.length + ' 条'; renderRecords();
    alert('批量评分完成：' + (done - failures.length) + ' 条。' + (failures.length ? '\n未保存：\n' + failures.join('\n') : ''));
  }
  $('batchScoreBtn').addEventListener('click', () => batchRun());
  $('batchGreetBtn').textContent='去生成所选岗位话术';
  $('batchGreetBtn').addEventListener('click', () => openGeneration([...selectedIds]).catch(e=>alert(e.message)));

  // 全选 N 天前已投递的岗位。
  async function selectDeliveredDays(n) {
    if (isNaN(n) || n < 0) { selectedIds.clear(); renderRecords(); return; }
    const cutoff = Date.now() - n * 86400000;
    const recs = await loadRecords();
    selectedIds = new Set(recs.filter((r) => normalizeStatus(r.status) === '已投递' && (r.appliedAt || r.createdAt || 0) <= cutoff).map((r) => r.id));
    renderRecords();
  }
  $('daysInput').addEventListener('input', async () => {
    const n = parseInt($('daysInput').value, 10);
    await selectDeliveredDays(n);
  });
  $('selDeliveredDays').addEventListener('click', async () => {
    const n = parseInt($('daysInput').value, 10);
    if (isNaN(n) || n < 0) { alert('请先在上方输入天数 N（如 7 表示「7 天前已投递」）。'); return; }
    await selectDeliveredDays(n);
    $('batchMenu').classList.add('hidden');
  });
  // 批量拒绝：将勾选的记录标记为「拒绝」
  $('batchRejectBtn').addEventListener('click', async () => {
    const ids = [...selectedIds]; if (!ids.length) { alert('请先勾选记录（或用「全选N天前已投递」）。'); return; }
    if (!confirm('将把勾选的 ' + ids.length + ' 条记录标记为「拒绝」？')) return;
    const recs = await loadRecords();
    for (const id of ids) { const rec = recs.find((r) => r.id === id); if (rec) await updateRecord(id, { status: '拒绝' }); }
    renderRecords(); alert('已标记 ' + ids.length + ' 条为「拒绝」。');
  });

  // 全屏编辑
  $('fsBtn').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('fullscreen.html') }); });

  // ---------- 导出 XLS ----------
  $('exportXlsBtn').addEventListener('click', async () => {
    const records = recordsCache.length ? recordsCache : await loadRecords();
    if (!records.length) { alert('还没有记录可导出。'); return; }
    const cols = [['description','JD'],['title','岗位名称'],['company','公司名称'],['location','地点'],['salary','薪资'],['size','规模'],['status','沟通情况'],['hrActive','HR活跃'],['notes','备注'],['greeting','打招呼语'],['url','来源链接']];
    let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="UTF-8"></head><body><table border="1">';
    html += '<tr>' + cols.map((c) => '<th>' + c[1] + '</th>').join('') + '</tr>';
    records.forEach((rec) => { html += '<tr>' + cols.map((c) => '<td>' + esc(rec[c[0]] || (c[0]==='hrActive' ? (rec.hrActive||'未知') : '')) + '</td>').join('') + '</tr>'; });
    html += '</table></body></html>';
    const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '求职记录_' + new Date().toISOString().slice(0, 10) + '.xls';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---------- 备份 / 导入 ----------
  function maskKey(k) {
    if (!k || typeof k !== 'string') return k;
    if (k.length <= 8) return '***';
    return k.slice(0, 4) + '****' + k.slice(-4);
  }
  function sanitizeBackup(raw) {
    const data = JSON.parse(JSON.stringify(raw));
    delete data.lastBackup;
    delete data.lastBackupAt;
    delete data.baiduToken;
    if (data.settings) {
      if (data.settings.apiKey) data.settings.apiKey = maskKey(data.settings.apiKey);
      if (data.settings.ocrApiKey) data.settings.ocrApiKey = maskKey(data.settings.ocrApiKey);
      if (data.settings.ocrSecretKey) data.settings.ocrSecretKey = maskKey(data.settings.ocrSecretKey);
    }
    return data;
  }
  async function collectBackup() { return await new Promise((r) => chrome.storage.local.get(BACKUP_KEYS, (x) => r(x))); }
  $('exportBackupBtn').addEventListener('click', async () => {
    const raw = await collectBackup(); const data = sanitizeBackup(raw);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'ai-job-assistant-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('importBackupBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(String(reader.result));
        const importBaseline=await chrome.storage.local.get([...BACKUP_KEYS,'agentStorageFormat']);
        const existing = await loadRecords();
        let recs = (data.records || []).map(r=>AgentCore.normalizeRecord(r));
        if (existing.length && recs.length && !confirm('现有 ' + existing.length + ' 条，备份 ' + recs.length + ' 条。\n确定=覆盖，取消=合并到现有前面。')) recs = recs.concat(existing);
        const setObj = {};
        if (data.records !== undefined) setObj.records = recs;
        if(Array.isArray(data.recycleJobKeys))setObj.recycleJobKeys=data.recycleJobKeys.filter(x=>x&&typeof x.platformJobKey==='string').map(x=>({id:String(x.id||x.platformJobKey),platformJobKey:x.platformJobKey,title:String(x.title||''),company:String(x.company||''),salary:String(x.salary||'')}));
        if (data.dismissedJobKeys !== undefined) setObj.dismissedJobKeys = [...new Map((Array.isArray(data.dismissedJobKeys)?data.dismissedJobKeys:[]).filter(x=>x&&(x.platformJobKey||x.id)).map(x=>[x.platformJobKey||x.id,x])).values()].slice(-10000);
        setObj.agentStorageFormat=5;
        if (data.settings !== undefined) {
          const currentSettings = await loadSettings();
          const importedSettings = Object.assign({}, data.settings);
          ['apiKey', 'ocrApiKey', 'ocrSecretKey'].forEach((k) => {
            if (importedSettings[k] === '***' || /\*{4}/.test(importedSettings[k] || '')) importedSettings[k] = currentSettings[k] || '';
          });
          setObj.settings = importedSettings;
        }
        if (data.uiState !== undefined) setObj.uiState = data.uiState;
        if (data.collection !== undefined) setObj.collection = data.collection;
        if (data.conversations !== undefined) setObj.conversations = data.conversations;
        if (data.dailySummaries !== undefined) setObj.dailySummaries = data.dailySummaries;
        if (data.profiles !== undefined) setObj.profiles = data.profiles;
        for(const key of ['legacyDataBackup','agentConfig','agentRuleHistory','agentNeedsDraft','agentNeedsInbox','agentSearchPlan','agentRuns'])if(data[key]!==undefined)setObj[key]=data[key];
         if(data.agentTask){setObj.agentTask={...data.agentTask,status:['running','starting','finalizing'].includes(data.agentTask.status)?'interrupted':data.agentTask.status};for(const key of ['workerTabId','listTabId','chatTabId','chatFrameId','ownedTabIds'])delete setObj.agentTask[key];for(const key of ['queue','deferred'])setObj.agentTask[key]=(setObj.agentTask[key]||[]).map(({tabId,frameId,...entry})=>entry);}
        if (data.usage !== undefined) setObj.usage = data.usage;
        await recordRequest('AGENT_COMPARE_STORAGE',{values:setObj,expected:importBaseline});
        recordsCache = recs; renderRecords();
        alert('导入完成：记录 ' + recs.length + ' 条' + (data.settings ? '，配置已恢复' : '') + '。');
      } catch (err) { alert('导入失败：' + (err && err.message ? err.message : err)); }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  // ---------- 记录去重（已迁至「批量 ▾ → 全选重复项 / 批量去重」）----------

  // ---------- 总结 / 画像（markdown，去噪）----------
  function colorFor(label) {
    const pal = ['#185fa5', '#2f7d52', '#c0803a', '#9b59b6', '#e07a7a', '#3aa0c0', '#7a8a3a', '#a3522f'];
    let h = 0; for (const c of (label || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return pal[h % pal.length];
  }
  function truncLabel(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function renderBarChart(title, pairs) {
    if (!pairs || !pairs.length) return '';
    const W = 360, rowH = 26, pad = 8, labelW = 116, valW = 34;
    const max = Math.max(1, ...pairs.map((p) => p[1]));
    const H = pad * 2 + pairs.length * rowH + (title ? 24 : 0);
    let bars = '';
    pairs.forEach((p, i) => {
      const y = pad + (title ? 24 : 0) + i * rowH;
      const w = Math.round(p[1] / max * (W - labelW - valW - pad));
      bars += '<text x="0" y="' + (y + 15) + '" font-size="11" fill="var(--text-2)">' + esc(truncLabel(p[0], 9)) + '</text>';
      bars += '<rect x="' + labelW + '" y="' + (y + 4) + '" width="' + (W - labelW - valW - pad) + '" height="15" rx="3" fill="var(--surface-2)"/>';
      bars += '<rect x="' + labelW + '" y="' + (y + 4) + '" width="' + w + '" height="15" rx="3" fill="var(--brand)"/>';
      bars += '<text x="' + (W - valW) + '" y="' + (y + 15) + '" font-size="11" fill="var(--text-2)" text-anchor="end">' + p[1] + '</text>';
    });
    const t = title ? '<text x="0" y="15" font-size="12" font-weight="600" fill="var(--brand)">' + esc(truncLabel(title, 14)) + '</text>' : '';
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:380px;margin:6px 0">' + t + bars + '</svg>';
  }
  // ---------- 饼图（投递状态分布：按皮肤配色 + 蛋糕块浮起 + 图例联动）----------
  let pieSeq = 0;
  function piePalette() {
    const t = document.documentElement.getAttribute('data-theme') || 'light';
    return t === 'tech'
      ? ['#2fae8e', '#4d9be6', '#f6a06a', '#ffd23f', '#b388eb', '#56c2c0', '#ef6f8e']
      : ['#19c8b9', '#ff8a5b', '#5bc0eb', '#ffd23f', '#b19cd9', '#6ab04c', '#e84393'];
  }
  function lightenHex(hex, t) {
    const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const L = (c) => Math.round(c + (255 - c) * t);
    return 'rgb(' + L(r) + ',' + L(g) + ',' + L(b) + ')';
  }
  function renderPieChart(title, pairs) {
    if (!pairs || !pairs.length) return '';
    const isTech = (document.documentElement.getAttribute('data-theme') || 'light') === 'tech';
    const pal = piePalette();
    const total = pairs.reduce((s, p) => s + p[1], 0) || 1;
    const cx = 90, cy = 90, r = 78, PAD = isTech ? 0 : 0.03; // 动森扇区间留缝
    const seq = ++pieSeq;
    let ang = -Math.PI / 2, slices = '', defs = '';
    pairs.forEach((p, i) => {
      const frac = p[1] / total;
      let a1 = ang + PAD, a2 = ang + frac * 2 * Math.PI - PAD;
      if (a2 < a1) { a1 = ang; a2 = ang + frac * 2 * Math.PI; }
      const mid = (a1 + a2) / 2, ux = Math.cos(mid), uy = Math.sin(mid);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      const large = (a2 - a1) > Math.PI ? 1 : 0;
      const col = pal[i % pal.length];
      let fill;
      if (isTech) {
        defs += '<linearGradient id="pg' + seq + '_' + i + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + lightenHex(col, .38) + '"/><stop offset="1" stop-color="' + col + '"/></linearGradient>';
        fill = 'url(#pg' + seq + '_' + i + ')';
      } else fill = col;
      slices += '<path class="slice" data-i="' + i + '" data-ux="' + ux.toFixed(3) + '" data-uy="' + uy.toFixed(3) + '" d="M' + cx + ',' + cy + ' L' + x1.toFixed(1) + ',' + y1.toFixed(1) + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x2.toFixed(1) + ',' + y2.toFixed(1) + ' Z" fill="' + fill + '"/>';
      ang += frac * 2 * Math.PI;
    });
    let legend = '';
    pairs.forEach((p, i) => {
      legend += '<div class="lg-item" data-i="' + i + '"><span class="lg-dot" style="background:' + pal[i % pal.length] + '"></span><span class="lg-name">' + esc(truncLabel(p[0], 8)) + '</span><span class="lg-val">' + p[1] + '</span></div>';
    });
    const titleHtml = title ? '<div class="chart-title">' + esc(truncLabel(title, 14)) + ' <span class="pipe">｜</span> <span class="total">' + total + ' 总记录</span></div>' : '';
    return '<div class="pie-chart">' + titleHtml + '<div class="chart-row"><div class="pie-wrap"><svg viewBox="0 0 180 180" width="200" height="200"><defs>' + defs + '</defs>' + slices + '</svg></div><div class="pie-legend">' + legend + '</div></div></div>';
  }
  // 饼图悬停交互：扇形浮起（蛋糕块）+ 其余变淡 + 图例高亮；动森阴影朝圆心空位、不压邻块
  function bindPieCharts(scope) {
    (scope || document).querySelectorAll('.pie-chart').forEach((chart) => {
      if (chart._pieBound) return; chart._pieBound = true;
      const slices = [...chart.querySelectorAll('.slice')];
      const legs = [...chart.querySelectorAll('.lg-item')];
      const isTech = (document.documentElement.getAttribute('data-theme') || 'light') === 'tech';
      function activate(i) {
        slices.forEach((s) => {
          const idx = +s.dataset.i;
          if (idx === i) {
            const ux = +s.dataset.ux, uy = +s.dataset.uy;
            s.classList.add('pop');
            s.style.transform = 'translate(' + (ux * 10).toFixed(1) + 'px,' + (uy * 10).toFixed(1) + 'px) scale(1.05)';
            if (!isTech) s.style.filter = 'drop-shadow(' + (-ux * 6).toFixed(1) + 'px ' + (-uy * 6).toFixed(1) + 'px 0 rgba(121,79,39,.38))';
          } else s.classList.add('dim');
        });
        legs.forEach((l) => { if (+l.dataset.i === i) l.classList.add('on'); });
      }
      function reset() {
        slices.forEach((s) => { s.classList.remove('pop', 'dim'); s.style.transform = ''; s.style.filter = ''; });
        legs.forEach((l) => l.classList.remove('on'));
      }
      slices.forEach((s) => { s.addEventListener('mouseenter', () => activate(+s.dataset.i)); s.addEventListener('mouseleave', reset); });
      legs.forEach((l) => { l.addEventListener('mouseenter', () => activate(+l.dataset.i)); l.addEventListener('mouseleave', reset); });
    });
  }
  function sanitizeMd(text) {
    if (!text) return '';
    let t = String(text)
      .replace(/\u00a0/g, ' ').replace(/\u3000/g, ' ') // 不换行空格 / 全角空格 → 普通空格
      .replace(/\t/g, ' ');
    // 去掉 ``` 代码围栏标记（可能在任意位置），保留内部文本
    t = t.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-zA-Z]*\n?/g, ''));
    t = t.replace(/^```.*$/gm, '');
    t = t.replace(/\*\*/g, '').replace(/__/g, '');
    // 逐行去除段首缩进（空格 / 制表符 / 全角空格 / 不换行空格）
    t = t.split('\n').map((l) => l.replace(/^[ \t\u00a0\u3000]+/, '')).join('\n');
    t = t.replace(/[ \t]{2,}/g, ' ').trim();
    return t;
  }
  function md(text) {
    if (!text) return '';
    text = sanitizeMd(text);
    const escMd = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = escMd(text).split('\n'); let html = '', inList = false;
    let tableHeaders = null, tableRows = null;
    const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
    const flushTable = () => {
      if (tableRows) {
        let t = '<table class="md-table"><thead><tr>' + tableHeaders.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>';
        tableRows.forEach((r) => { t += '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>'; });
        t += '</tbody></table>'; html += t; tableHeaders = null; tableRows = null;
      }
    };
    const isTableRow = (l) => l.trim().startsWith('|') && l.trim().endsWith('|');
    const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
    const isSep = (l) => /^\|[\s:|-]+\|$/.test(l.trim()) && l.includes('-');
    for (let raw of lines) {
      let line = raw;
      if (isTableRow(line)) {
        closeList();
        const cells = splitRow(line);
        if (!tableRows && !isSep(line)) { tableHeaders = cells; tableRows = []; }
        else if (tableRows && isSep(line)) { /* 分隔行跳过 */ }
        else if (tableRows) { tableRows.push(cells); }
        continue;
      } else { flushTable(); }
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { closeList(); const lv = m[1].length; html += '<h' + lv + '>' + m[2] + '</h' + lv + '>'; continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { closeList(); html += '<div class="callout">' + (m[1] || '') + '</div>'; continue; }
      if ((m = line.match(/^[-*]\s+(.*)$/))) { if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + m[1] + '</li>'; continue; }
      if ((m = line.match(/^(\d+)\.\s+(.*)$/))) { if (!inList) { html += '<ol>'; inList = true; } html += '<li>' + m[2] + '</li>'; continue; }
      if ((m = line.match(/^\[\[chart:(.+)\]\]$/))) { closeList(); html += renderChartDirective(m[1]); continue; }
      closeList();
      if (line.trim() === '') continue;
      line = line.replace(/`([^`]+?)`/g, '<code>$1</code>');
      html += '<p>' + line + '</p>';
    }
    closeList(); flushTable();
    return html;
  }
  function renderChartDirective(spec) {
    const parts = spec.split('|');
    if (parts.length < 3) return '';
    const type = parts[0].trim(), title = parts[1].trim();
    const pairs = parts[2].split(';').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), parseFloat(p.slice(i + 1)) || 0]; }).filter((p) => p[0]);
    if (!pairs.length) return '';
    if (type === 'pie') return renderPieChart(title, pairs);
    return renderBarChart(title, pairs);
  }
  function summaryCharts(stats) {
    if (!stats || !stats.statusCounts) return '';
    const sc = Object.assign({}, stats.statusCounts);
    sc['未联系'] = (sc['未联系'] || 0) + (sc['考虑中'] || 0) + (sc['已收藏'] || 0); delete sc['考虑中']; delete sc['已收藏'];
    const order = STATUS_LIST;
    const pairs = order.filter((k) => sc[k]).map((k) => [k, sc[k]]);
    return pairs.length ? renderBarChart('沟通状态分布', pairs) : '';
  }
  // 近 7 天折线图（新增岗位 vs 新增回应）
  // 布局：标题在左上、图例在右上同一行区域、网格居中、横轴日期标签独占最底行，互不重叠
  function renderLineChart(title, labels, series) {
    if (!labels || !labels.length) return '';
    const W = 340, H = 200, padL = 26, padR = 10, padT = 40, padB = 26;
    const maxV = Math.max(1, ...series.flatMap((s) => s.values));
    const n = labels.length;
    const x = (i) => padL + (W - padL - padR) * (n === 1 ? 0.5 : i / (n - 1));
    const y = (v) => padT + (H - padT - padB) * (1 - v / maxV);
    let grid = '';
    for (let g = 0; g <= 4; g++) { const gy = padT + (H - padT - padB) * g / 4; const val = Math.round(maxV * (1 - g / 4)); grid += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" stroke="var(--border)" stroke-width="1"/><text x="2" y="' + (gy + 3) + '" font-size="9" fill="var(--text-2)">' + val + '</text>'; }
    let lines = '', dots = '';
    series.forEach((s) => {
      let d = ''; s.values.forEach((v, i) => { d += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(v).toFixed(1) + ' '; });
      lines += '<polyline points="' + d.trim().replace(/[ML]/g, ' ').trim() + '" fill="none" stroke="' + s.color + '" stroke-width="2"/>';
      s.values.forEach((v, i) => { dots += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.5" fill="' + s.color + '"/>'; });
    });
    // 图例：顶部右侧，与标题同带、远离横轴标签
    let legend = '';
    const itemW = 76, lx0 = W - padR - series.length * itemW;
    series.forEach((s, si) => {
      const lx = lx0 + si * itemW;
      legend += '<rect x="' + lx + '" y="18" width="9" height="9" fill="' + s.color + '"/><text x="' + (lx + 13) + '" y="26" font-size="10" fill="var(--text-2)">' + esc(s.name) + '</text>';
    });
    // 横轴日期标签：最底行
    let xlabels = ''; labels.forEach((lb, i) => { xlabels += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" font-size="9" fill="var(--text-2)" text-anchor="middle">' + esc(lb) + '</text>'; });
    const t = '<text x="0" y="13" font-size="12" font-weight="600" fill="var(--brand)">' + esc(title) + '</text>';
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="max-width:360px;margin:6px 0">' + t + legend + grid + lines + dots + xlabels + '</svg>';
  }
  function renderCompare(compare) {
    if (!Array.isArray(compare) || !compare.length) return '';
    const labels = compare.map((d) => d.label);
    const series = [
      { name: '新增岗位', color: 'var(--brand)', values: compare.map((d) => d.新增 || 0) },
      { name: '新增回应', color: '#c0803a', values: compare.map((d) => d.回应 || 0) }
    ];
    return '<div class="cmp-block">' + renderLineChart('近 7 天趋势', labels, series) +
      '<div class="cmp-note">横轴为最近 7 天，含今天。新增回应按记录首次进入「待我回复/面试中/Offer」的时间统计；升级前没有回应时间的旧记录不倒推。</div></div>';
  }
  function profileCharts(records) {
    if (!records || !records.length) return '';
    const sc = {}; records.forEach((r) => { const s = normalizeStatus(r.status); sc[s] = (sc[s] || 0) + 1; });
    let html = renderPieChart('投递状态分布', Object.keys(sc).map((k) => [k, sc[k]]));
    const jobS = records.map((r) => (r.scores && r.scores.job && r.scores.job.total != null) ? r.scores.job.total : null).filter((v) => v != null);
    const compS = records.map((r) => (r.scores && r.scores.company && r.scores.company.total != null) ? r.scores.company.total : null).filter((v) => v != null);
    const avg = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0;
    html += renderBarChart('平均评分（满分 5）', [['岗位', avg(jobS)], ['公司', avg(compS)]]);
    return html;
  }
  // 总结/画像条目：最新 1 条自动展开，第 2、3 条折叠显示标题，其余收入「历史记录」下拉
  function buildSummaryItem(dt, isLatest, open, innerHtml) {
    return '<div class="summary-item' + (open ? ' open' : '') + '">' +
      '<div class="summary-date"><span class="arrow">' + (open ? '▼' : '▶') + '</span><span class="dt">' + esc(dt) + '</span>' + (isLatest ? '<span class="tag-new">· 最新</span>' : '') + '</div>' +
      '<div class="md-inner">' + innerHtml + '</div></div>';
  }
  function renderSummaryBox(box, list, innerFor, emptyText) {
    if (!list.length) { box.innerHTML = '<p class="empty">' + esc(emptyText || '（暂无，点上方按钮生成）') + '</p>'; return; }
    let html = '';
    if (list.length) html += buildSummaryItem(fmtDateTime(list[0].ts) || list[0].date || '', true, false, innerFor(list[0]));
    if (list.length > 1) {
      html += '<div class="history-wrap"><button type="button" class="history-toggle">🗂 历史记录 · ' + (list.length - 1) + ' 条<span class="arrow">▾</span></button><div class="history-list hidden">';
      list.slice(1).forEach((s) => { html += buildSummaryItem(fmtDateTime(s.ts) || s.date || '', false, false, innerFor(s)); });
      html += '</div></div>';
    }
    box.innerHTML = html;
    bindPieCharts(box);
    box.querySelectorAll('.summary-item:not(.open) > .md-inner').forEach((el) => { el.style.display = 'none'; });
    box.querySelectorAll('.summary-item > .summary-date').forEach((d) => d.addEventListener('click', () => {
      const item = d.parentElement; const inner = item.querySelector('.md-inner'); const arrow = d.querySelector('.arrow');
      const show = inner.style.display === 'none';
      inner.style.display = show ? 'block' : 'none';
      if (arrow) arrow.textContent = show ? '▼' : '▶';
    }));
    const ht = box.querySelector('.history-toggle');
    if (ht) ht.addEventListener('click', () => {
      const hl = box.querySelector('.history-list');
      const show = hl.classList.contains('hidden');
      hl.classList.toggle('hidden', !show);
      const ar = ht.querySelector('.arrow'); if (ar) ar.textContent = show ? '▴' : '▾';
    });
  }
  async function renderSummaryList() {
    const list = await new Promise((r) => chrome.storage.local.get(['dailySummaries'], (x) => r(x.dailySummaries || [])));
    const current=$('summaryBox'),scroll=window.scrollY;
    renderSummaryBox(current, list, (s) => md(s.markdown || '') + summaryCharts(s.stats) + renderCompare(s.compare), '（暂无，点上方「生成总结」；每天 23:00 也会自动生成）');
    const latest=current.querySelector('.summary-item > .md-inner');if(latest)latest.style.display='block';window.scrollTo(0,scroll);
  }
  async function renderDecisionCards(){
    const box=$('judgeBox'),left=box.querySelector('.agent-categories')?.scrollLeft||0,focusCategory=!!document.activeElement?.closest('.agent-categories');
    const expanded=new Map([...box.querySelectorAll('[data-card-id]')].map(card=>[card.dataset.cardId,{visible:!card.querySelector('.agent-job-details')?.hidden,open:[...card.querySelectorAll('details')].map(x=>x.open)}])),scroll=document.scrollingElement.scrollTop;
    const d=await chrome.storage.local.get(['records','conversations','agentRuns','agentConfig']);box.innerHTML=EchoAgentUI.cards(AgentCore.cards(d.records||[],d.conversations||[],d.agentRuns||{},d.agentConfig),true);
    for(const card of box.querySelectorAll('[data-card-id]')){const prior=expanded.get(card.dataset.cardId);if(!prior)continue;const details=card.querySelector('.agent-job-details');if(details){details.hidden=!prior.visible;const button=card.querySelector('[data-agent-action="progressDetails"]');if(button){button.textContent=prior.visible?'收起详情':'展开详情';button.setAttribute('aria-expanded',String(prior.visible));}}card.querySelectorAll('details').forEach((x,i)=>x.open=!!prior.open[i]);}
    document.scrollingElement.scrollTop=scroll;
    const bar=box.querySelector('.agent-categories');if(bar)bar.scrollLeft=left;if(focusCategory)bar?.querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
  }
  async function renderAgentViews(){await renderDecisionCards();await renderSummaryList();
    const box=$('chatAnalysis').querySelector('.chat-match-details .agent-matching');
    if(box&&lastConversationId){const d=await chrome.storage.local.get(['records','conversations','agentConfig']),c=d.conversations?.find(x=>x.id===lastConversationId),r=AgentCore.recordById(d.records||[],c?.linkedRecordId);if(r)box.outerHTML=EchoAgentUI.matching({...r.recommendation,id:r.id,...AgentCore.requirementMatch(r.recommendation||{},d.agentConfig)});}
  }
  async function renderProfileList() {
    const list = await new Promise((r) => chrome.storage.local.get(['profiles'], (x) => r(x.profiles || [])));
    const records = await loadRecords();
    renderSummaryBox($('profileBox'), list, (s) => md(s.markdown || '') + (s.funnel ? renderFunnel(s.funnel) : '') + profileCharts(records), '（暂无，点上方「生成画像」）');
  }
  function renderFunnel(f) {
    const sc = Object.assign({}, f.statusCounts || {}); const total = f.total || 1;
    sc['未联系'] = (sc['未联系'] || 0) + (sc['考虑中'] || 0) + (sc['已收藏'] || 0); delete sc['考虑中']; delete sc['已收藏'];
    const order = STATUS_LIST;
    const max = Math.max(1, ...order.map((k) => sc[k] || 0));
    let h = '<div class="funnel" style="margin-top:8px">';
    order.forEach((k) => { const v = sc[k] || 0; const w = Math.round(v / max * 100); h += '<div style="display:flex;align-items:center;gap:6px;margin:3px 0;font-size:11px"><span style="width:48px;color:var(--text-2)">' + k + '</span><span style="flex:1;height:10px;background:var(--surface-2);border-radius:4px;overflow:hidden"><i style="display:block;height:100%;width:' + w + '%;background:var(--brand)"></i></span><span style="width:28px;text-align:right;color:var(--text-2)">' + v + '</span></div>'; });
    h += '</div>'; return h;
  }
  $('genSummaryBtn').addEventListener('click', async () => {
    const records = await loadRecords(); if (!records.length) { $('summaryBox').innerHTML = '<p>还没有记录。</p>'; return; }
    const settings = await loadSettings();
    $('genSummaryBtn').disabled = true; $('summaryBox').innerHTML = '<p>生成中…</p>';
    chrome.runtime.sendMessage({ type: 'GEN_DAILY_SUMMARY', apiKey: settings.apiKey || '', profile: settings.profile || '', records: records }, (resp) => {
      $('genSummaryBtn').disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) { $('summaryBox').innerHTML = '<p>生成失败：' + ((resp && resp.error) || '未知') + '</p>'; return; }
      const list = (resp.text && resp.text.markdown) ? resp.text : { markdown: '（无内容）' };
      const store = { date: new Date().toISOString().slice(0, 10), markdown: list.markdown, usage: list.usage || null, stats: list.stats || null, compare: list.compare || null, actionCards: list.actionCards || null, ts: Date.now() };
      chrome.runtime.sendMessage({type:'AGENT_SAVE_SUMMARY',summary:store}).then(r=>{if(!r||!r.ok)throw new Error(r&&r.error||'保存失败');return renderSummaryList();}).catch(e=>{ $('summaryBox').textContent='总结保存失败：'+e.message; });
    });
  });
  $('analyzeBtn').addEventListener('click', async () => {
    const records = await loadRecords(); if (!records.length) { alert('还没有记录，先保存几条岗位。'); return; }
    const settings = await loadSettings(); if (!settings.apiKey) { alert('未配置 API Key。'); return; }
    $('analyzeBtn').disabled = true; $('profileBox').innerHTML = '<p>分析中…</p>';
    chrome.runtime.sendMessage({ type: 'ANALYZE_PROFILE', apiKey: settings.apiKey, profile: settings.profile || '', records: records }, (resp) => {
      $('analyzeBtn').disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) { $('profileBox').innerHTML = '<p>分析失败：' + ((resp && resp.error) || '未知') + '</p>'; return; }
      const text = resp.text || {};
      const store = { date: new Date().toISOString().slice(0, 10), markdown: text.markdown || '', funnel: text.funnel || null, ts: Date.now() };
      chrome.storage.local.get(['profiles'], (r) => { const arr = r.profiles || []; arr.unshift(store); chrome.storage.local.set({ profiles: arr }); renderProfileList(); });
    });
  });

  // ---------- 生成页：模式切换（圆角皮肤下拉，与导出/批量一致）/ 快速准备 / 清洗 JD / 删除选中 / 模拟面试 ----------
  let genModeVal = 'mass';
  function setGenMode(v) {
    genModeVal = v;
    $('genModeBtn').textContent = (v === 'mass' ? '快速模式' : '精准模式') + ' ▾';
    $('genModeMenu').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.val === v));
    $('genPrecise').classList.toggle('hidden', v === 'mass');
    $('genMass').classList.toggle('hidden', v !== 'mass');
    updateModeHint();
  }
  function updateModeHint() {
    const mass = genModeVal === 'mass';
    const ph = $('preciseHint'), mh = $('massHint');
    if (ph) ph.textContent = mass ? '' : '精准模式：分步完成 ① 抓取入库 → ② AI 评分 → ③ 生成招呼语；实际发送后手动确认。';
    if (mh) mh.textContent = mass ? '快速模式：一键完成抓取、评分和招呼语生成；复制话术不会标记为已投递。' : '';
  }
  setupDropdown('genModeBtn', 'genModeMenu');
  $('genModeMenu').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { setGenMode(b.dataset.val); $('genModeMenu').classList.add('hidden'); }));
  $('cleanJdBtn').addEventListener('click', async () => {
    const t = $('jobDesc').value; if (!t.trim()) { alert('JD 为空。'); return; }
    $('cleanJdBtn').disabled = true; $('cleanJdBtn').textContent = '清洗中…';
    const cleaned = sanitizePlain(await cleanJd(t));
    $('jobDesc').value = cleaned; if (currentJob) currentJob.description = cleaned;
    if (currentRecId) updateRecord(currentRecId, { description: cleaned });
    $('cleanJdBtn').disabled = false; $('cleanJdBtn').textContent = '用 AI 清洗 JD';
  });
  // 快速模式：一键抓取→评分→生成；准备阶段不改状态，发送后手动确认。
  $('massBtn').addEventListener('click', async () => {
    $('siteStatus').classList.remove('ok');
    const tab = await currentTab();
    if (!tab || !isSupportedUrl(tab.url)) { $('siteStatus').textContent = '当前不是支持的招聘站点。'; return; }
    $('siteStatus').textContent = '快速准备：① 抓取中…'; $('massBtn').disabled = true;
    const grabbed = await grabCurrent();
    if (!grabbed && !currentRecId) { $('siteStatus').textContent = '抓取失败，请重试。'; $('massBtn').disabled = false; return; }
    $('siteStatus').textContent = '快速准备：② 评分中…';
    const job = readJobFromForm(); const settings = await loadSettings();
    const failures = lastGrabWarning ? [lastGrabWarning] : [];
    const settingsError = aiSettingsError(settings);
    let scored = false;
    if (settingsError && !failures.includes(settingsError)) failures.push(settingsError);
    else {
      try {
        const sc = await callScore(job, settings);
        currentJob = currentJob || {}; currentJob.scores = sc;
        
        renderScoreViz(sc); scored = true;
      } catch (e) { failures.push('评分失败：' + e.message); }
    }
    $('siteStatus').textContent = '快速准备：③ 生成招呼语中…';
    let genOk = false; let failedDraft = null; let generatedResult = null;
    if (!settingsError) {
      try {
        lastResult = await callGenerate(job, settings); generatedResult=lastResult; renderResult(lastResult);
        if (currentRecId) await updateRecord(currentRecId, { greeting: lastResult.greeting || '', matchPoints: lastResult.matchPoints || [], workflow: lastResult.workflow });
        genOk = true;
      } catch (e) { failedDraft = e.result||generatedResult; showGenerationError({error:e.message,result:failedDraft}); failures.push((failedDraft ? '草稿待修改：' : '招呼语失败：') + e.message); }
    }
    flow = { grabbed: true, scored: scored, generated: genOk }; applyFlowStatus();
    const recs = await loadRecords(); const cur = recs.find((r) => r.id === currentRecId);
    $('massGreeting').value = (failedDraft && failedDraft.greeting) || (cur && cur.greeting) || '';
    if (!genOk && !failedDraft) $('massWorkflowReview').textContent = '本次未生成新话术；如有文本，为之前保存的版本。';
    $('massResult').classList.remove('hidden');
    $('siteStatus').textContent = failures.length ? '岗位已记录；' + failures.join('；') : '投递材料已准备，评分和招呼语已写入记录；实际发送后手动确认。';
    $('siteStatus').classList.toggle('ok', failures.length === 0);
    $('massBtn').disabled = false;
  });
  $('massCopyBtn').addEventListener('click', async () => {
    await copyGreetingAndMark($('massCopyBtn'), $('massGreeting').value);
  });
  $('massRegenBtn').addEventListener('click', async () => {
    $('siteStatus').classList.remove('ok');
    const job = currentJob || readJobFromForm();
    const settings = await loadSettings();
    if (!settings.apiKey) { alert('未配置 API Key，请点 ⚙ 设置。'); return; }
    $('massRegenBtn').disabled = true; $('siteStatus').textContent = '正在重新生成…';
    chrome.runtime.sendMessage({ type: 'GENERATE', apiKey: settings.apiKey, profile: settings.profile || '', job: job, greetingPrompt: settings.greetingPrompt || '' }, async (resp) => {
      $('massRegenBtn').disabled = false;
      if (chrome.runtime.lastError || !resp || !resp.ok) { showGenerationError(resp); return; }
      const g = (resp.result && resp.result.greeting) || '';
      $('massGreeting').value = g;
      $('massWorkflowReview').textContent = workflowText(resp.result);
      try{if (currentRecId) await updateRecord(currentRecId, { greeting: g, matchPoints: (resp.result && resp.result.matchPoints) || [], workflow: resp.result.workflow });}catch(e){showGenerationError({error:e.message,result:resp.result});return;}
      $('siteStatus').textContent = '已重新生成并同步到记录。'; $('siteStatus').classList.add('ok');
    });
  });
  $('massGear').addEventListener('click', () => { if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); });

  // 选择列下拉（全选 / 取消全选）
  $('selMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('selMenu').classList.toggle('hidden'); });
  $('selAllBtn').addEventListener('click', async () => { const recs = await loadRecords(); selectedIds = new Set(recs.map((r) => r.id)); $('selMenu').classList.add('hidden'); renderRecords(); });
  $('selNoneBtn').addEventListener('click', () => { selectedIds.clear(); $('selMenu').classList.add('hidden'); renderRecords(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#selMenuBtn') && !e.target.closest('#selMenu')) $('selMenu').classList.add('hidden'); });
  $('undoBtn').addEventListener('click', async () => {
    try {
    const undo = await restoreUndo(); if (!undo) { await refreshUndoButton(); return; }
    selectedIds.clear(); renderRecords(); alert('已撤销：' + (undo.label || '上一次记录操作') + '。');
    } catch(e) { alert(e.message || '撤销失败，记录未恢复'); }
  });
  // 删除选中
  $('deleteSelBtn').addEventListener('click', async () => {
    const ids = [...selectedIds]; if (!ids.length) { alert('请先勾选要删除的记录（用最左选择下拉「全选」）。'); return; }
    if (!confirm('确定删除选中的 ' + ids.length + ' 条记录？')) return;
    const all = await loadRecords(); const set = new Set(ids);
    let remaining;try{remaining=await deleteRecordsWithUndo(all,set,'删除 '+ids.length+' 条记录');}catch(e){alert('无法保存删除操作，岗位未删除：'+e.message);return;}
    if(!remaining)return;recordsCache = remaining; selectedIds.clear(); renderRecords();
  });

  // ---------- 模拟面试（15 题，宝洁八大问思路，按 JD 生成）----------
  function buildQuestions(job) {
    const jd = (job && job.description) || ''; const title = (job && job.title) || '该岗位';
    const base = [
      '请用 STAR 法则讲一个你解决技术/业务难题的经历（情境/任务/行动/结果，含数据）。',
      '你为什么想投「' + title + '」？你最匹配的三点是什么？',
      '描述一次你和同事/跨团队协作推动项目落地的经历。',
      '你如何处理需求频繁变更？举具体例子。',
      '讲一个你从失败中复盘并改进的例子。',
      '你最大的优点和缺点分别是什么？缺点如何改进？',
      '你主导过最有成就感的项目是什么？你的角色与产出？',
      '遇到技术/方案选型分歧，你如何推动决策？'
    ];
    const jdQ = [
      '根据 JD，这个岗位最核心的 1-2 项能力是什么？你如何用过往经历证明？',
      'JD 提到「' + (jd.slice(0, 36) || '职责要求') + '…」，请结合你的经验展开说明。',
      '如果入职「' + title + '」后前三个月只能做一件事，你会做什么来快速胜任？',
      '你如何看待这个岗位的工作节奏与加班/平衡？',
      '你期望的薪资范围是多少？依据是什么？',
      '你未来 3 年职业规划是什么，与这个岗位如何契合？',
      '你对我们公司/行业了解多少？为什么选择我们？'
    ];
    const extra = [
      '你有什么想问我的？（反向提问也能体现思考深度）',
      '讲一个你主动学习并应用新技能的例子。',
      '当资源/时间受限时，你如何排定优先级？',
      '举例说明你如何在压力下保证交付质量。'
    ];
    return [].concat(base, jdQ, extra).slice(0, 15);
  }
  let mockQuestions = [], mockStart = 0, mockTimes = [];
  function fmtDur(s) { const m = Math.floor(s / 60); return (m > 0 ? m + ' 分 ' : '') + (s % 60) + ' 秒'; }
  function openMockInterview(rec) {
    mockRecId = rec ? rec.id : null;
    mockQuestions = buildQuestions(rec ? recToJob(rec) : (currentJob || { title: '', description: '' }));
    mockIdx = 0; mockAnswers = []; mockTimes = []; mockStart = Date.now();
    $('mockModal').classList.remove('hidden'); renderMockModal();
  }
  function renderMockModal() {
    const body = $('mockBody'); body.innerHTML = '';
    if (mockIdx >= mockQuestions.length) {
      const total = Math.round((Date.now() - mockStart) / 1000);
      const wrap = document.createElement('div');
      wrap.innerHTML = '<div class="mock-q">已完成全部 ' + mockQuestions.length + ' 题。</div>' +
        '<div class="mock-total">总用时：' + fmtDur(total) + '（' + total + ' 秒）</div>';
      const regen = document.createElement('button'); regen.className = 'primary'; regen.textContent = '再生成一次';
      regen.addEventListener('click', () => { mockIdx = 0; mockAnswers = []; mockTimes = []; mockStart = Date.now(); renderMockModal(); });
      wrap.appendChild(regen); body.appendChild(wrap); return;
    }
    const q = document.createElement('div'); q.className = 'mock-q';
    q.innerHTML = '<span class="idx">第 ' + (mockIdx + 1) + '/' + mockQuestions.length + ' 题：</span>' + esc(mockQuestions[mockIdx]);
    const a = document.createElement('textarea'); a.rows = 4; a.id = 'mockAns'; a.placeholder = '请输入具体回答（含事例/数据）';
    if (mockAnswers[mockIdx] != null) a.value = mockAnswers[mockIdx];
    const timer = document.createElement('div'); timer.className = 'mock-timer'; timer.id = 'mockTimer';
    const row = document.createElement('div'); row.className = 'row btn-row';
    const prev = document.createElement('button'); prev.textContent = '上一题'; prev.disabled = mockIdx === 0;
    const next = document.createElement('button'); next.className = 'primary'; next.textContent = (mockIdx === mockQuestions.length - 1) ? '完成' : '下一题';
    const collect = document.createElement('button'); collect.className = 'small'; collect.textContent = '收藏此题到备注';
    prev.addEventListener('click', () => { saveMockAnswer(a); mockIdx--; renderMockModal(); });
    next.addEventListener('click', () => { if (!commitMockAnswer(a)) return; if (mockIdx === mockQuestions.length - 1) finishMock(); else { mockIdx++; renderMockModal(); } });
    collect.addEventListener('click', () => { const ans = a.value.trim(); if (!ans) { alert('先作答再收藏。'); return; } collectMock(mockQuestions[mockIdx], ans); });
    row.appendChild(prev); row.appendChild(next); row.appendChild(collect);
    body.appendChild(q); body.appendChild(timer); body.appendChild(a); body.appendChild(row);
    startMockTimer();
  }
  function startMockTimer() {
    mockCurStart = Date.now(); const el = $('mockTimer'); if (!el) return;
    if (mockTimer) clearInterval(mockTimer);
    mockTimer = setInterval(() => { const s = Math.round((Date.now() - mockCurStart) / 1000); if (el) el.textContent = '本题用时：' + fmtDur(s); }, 1000);
  }
  function saveMockAnswer(a) { if (mockIdx >= 0 && mockIdx < mockQuestions.length) { mockAnswers[mockIdx] = a.value; mockTimes[mockIdx] = Math.round((Date.now() - mockCurStart) / 1000); } }
  function commitMockAnswer(a) { const v = a.value.trim(); mockAnswers[mockIdx] = v; mockTimes[mockIdx] = Math.round((Date.now() - mockCurStart) / 1000); return true; }
  function loadNote(id) { const r = recordsCache.find((x) => x.id === id); return r ? (r.notes || '') : ''; }
  function collectMock(q, a) {
    const note = '【模拟面试 Q】' + q + '\nA：' + a;
    if (mockRecId) updateRecord(mockRecId, { notesAppend: note });
    else alert('已记录（当前无关联记录，请手动复制）：\n' + note);
  }
  async function finishMock() {
    if (mockTimer) clearInterval(mockTimer); saveMockAnswer($('mockAns'));
    const total = Math.round((Date.now() - mockStart) / 1000);
    const answered = mockAnswers.map((m) => (m || '').trim()).filter(Boolean);
    const body = $('mockBody'); body.innerHTML = '';
    const head = document.createElement('div'); head.className = 'mock-q';
    head.textContent = '面试完成！共 ' + mockQuestions.length + ' 题，总用时 ' + fmtDur(total) + '。';
    body.appendChild(head);
    // 无作答 → 记录模式：题目（+ 思路）存备注，无输入则备注为空
    if (answered.length === 0) {
      const qList = mockQuestions.map((q, i) => ((i + 1) + '. ' + q)).join('\n');
      const note = '【模拟面试题目】\n' + qList;
      const fb = document.createElement('div'); fb.className = 'analysis-text';
      fb.textContent = '本次未作答，已将题目记录到备注（可在记录页查看练习）。点「再生成一次」可重新生成 15 题。';
      body.appendChild(fb);
      if (mockRecId) updateRecord(mockRecId, { notesAppend: note });
      const regen = document.createElement('button'); regen.className = 'primary'; regen.textContent = '再生成一次';
      regen.addEventListener('click', () => { mockIdx = 0; mockAnswers = []; mockTimes = []; mockStart = Date.now(); renderMockModal(); });
      body.appendChild(regen);
      return;
    }
    // 有作答 → 资深面试官 300 字内简评（点评 + 提升点 + 鼓励）
    const convo = mockAnswers.map((m, i) => ('Q' + (i + 1) + '：' + mockQuestions[i] + '\nA' + (i + 1) + '：' + (m || ''))).join('\n\n');
    const fb = document.createElement('div'); fb.className = 'analysis-text'; fb.textContent = '正在生成点评…'; body.appendChild(fb);
    const settings = await loadSettings();
    if (!settings.apiKey) { fb.textContent = '未配置 API Key，无法生成点评。总用时 ' + fmtDur(total); return; }
    chrome.runtime.sendMessage({ type: 'MOCK_REVIEW', apiKey: settings.apiKey, profile: settings.profile || '', job: { title: '模拟面试', description: convo } }, (resp) => {
      let review = (resp && resp.ok && resp.review) ? resp.review : ('总用时 ' + fmtDur(total) + '\n（点评生成失败）');
      review = review.replace(/\*\*/g, '').replace(/\t/g, ' ').trim();
      fb.textContent = '总用时 ' + fmtDur(total) + '\n\n' + review;
    });
  }
  $('mockClose').addEventListener('click', () => { if (mockTimer) clearInterval(mockTimer); $('mockModal').classList.add('hidden'); });
  $('mockModal').addEventListener('click', (e) => { if (e.target === $('mockModal')) { if (mockTimer) clearInterval(mockTimer); $('mockModal').classList.add('hidden'); } });

  // ---------- init ----------
  async function initUI() {
    await migrateRecordStatuses();
    await refreshUndoButton();
    initTheme();
    await renderChatInbox();
    setGenMode('mass');
    const st = await loadState();
    if (st.lastJob && (st.lastJob.title || st.lastJob.description)) { fillJob(st.lastJob); if (st.lastResult && (st.lastResult.greeting || st.lastResult.matchPoints)) { lastResult = st.lastResult; renderResult(st.lastResult); } }

    const tab = ['needs','agent','judge','rec','sum'].includes(st.activeTab)?st.activeTab:'agent'; const btn = document.querySelector('.tab[data-tab="' + tab + '"]'); if (btn) btn.click();
    updateModeHint();
    if (typeof updateSortTimeBtn === 'function') updateSortTimeBtn();
    // 记录表头双击搜索（岗位 / 公司）
    document.querySelectorAll('.rec-table th.searchable').forEach((th) => th.addEventListener('dblclick', () => {
      const key = th.getAttribute('data-sort');
      const name = th.textContent.replace(/[▲▼]/g, '').trim();
      const val = prompt('搜索「' + name + '」包含的关键词（留空 = 清除该列筛选）：', searchFilters[key] || '');
      if (val === null) return;
      searchFilters[key] = val.trim(); renderRecords();
    }));
  }
  let generationIds=[],editingGeneration=false;
  const generationPanel=document.createElement('section');generationPanel.id='agentGenerationQueue';generationPanel.className='hidden';
  generationPanel.innerHTML='<h3>批量生成话术</h3><p id="agentQueuePosition"></p><select id="agentGenerationSelect" hidden aria-label="当前岗位"></select><div class="result-actions"><button id="agentPreviousJob" type="button">← 上一个</button><button id="agentNextJob" type="button">下一个 →</button></div><button id="agentGenerateQueue" type="button">一键生成全部话术</button><p id="agentGenerationStatus" role="status"></p>';
  $('gen').prepend(generationPanel);
  generationPanel.insertAdjacentHTML('beforeend','<button id="agentCopyOpen" type="button">复制话术并打开岗位</button><button id="agentViewRecord" type="button">查看对应记录</button><p id="agentRecordReceipt" role="status"></p>');
  $('agentViewRecord').onclick=async()=>{const id=$('agentGenerationSelect').value;if(!id)return;Object.assign(searchFilters,{title:'',company:''});document.querySelector('.tab[data-tab="rec"]').click();await renderRecords();const row=[...$('recBody').rows].find(r=>r.dataset.cardId===id);if(row){row.scrollIntoView({block:'center'});row.classList.add('row-selected');row.querySelector('.greeting-cell textarea')?.focus();}else $('recCount').textContent='该岗位记录已不存在，请返回生成页查看保留的草稿。';};
  generationPanel.insertAdjacentHTML('beforeend','<div hidden><p id="agentSavedInfo"></p><label id="agentUseSavedLabel"><input id="agentUseSaved" type="checkbox">确认使用已保存资料</label><button id="agentSaveJobDetails">保存补充资料</button><button id="agentReloadJob">重新读取该岗位</button></div>');
  generationPanel.append($('result'));
  function drawQueuePosition(){const s=$('agentGenerationSelect'),i=Math.max(0,s.selectedIndex);$('agentQueuePosition').textContent='第 '+(i+1)+' / '+Math.max(1,s.options.length)+' 个 · '+(s.options[i]?.textContent||'岗位');$('agentPreviousJob').disabled=i<=0;$('agentNextJob').disabled=i>=s.options.length-1;}
  for(const [id,step] of [['agentPreviousJob',-1],['agentNextJob',1]])$(id).onclick=()=>{const s=$('agentGenerationSelect');s.selectedIndex=Math.max(0,Math.min(s.options.length-1,s.selectedIndex+step));s.dispatchEvent(new Event('change'));};
  $('agentSaveJobDetails').onclick=async()=>{await updateRecord(currentRecId,readJobFromForm());await viewGeneration(currentRecId);};
  $('agentReloadJob').onclick=async()=>{try{const r=(await loadRecords()).find(r=>r.id===currentRecId);const reply=await chrome.runtime.sendMessage({type:'AGENT_START',kind:'discover',importText:r.url});if(!reply?.ok)throw new Error(reply?.error||'读取失败');$('agentGenerationStatus').textContent='正在后台重新读取；完成后重新选择该岗位查看更新。';}catch(e){$('agentGenerationStatus').textContent=e.message;}};
  async function viewGeneration(id){
    const rec=(await loadRecords()).find(r=>r.id===id);if(!rec)throw new Error('岗位已删除');
    $('agentRecordReceipt').textContent=(rec.generationDraft?.text?'待修改草稿已保存至：':rec.greeting?'话术已保存至：':'岗位资料已保存至：')+(rec.company||'公司待补充')+' · '+(rec.title||'岗位待补充');
    editingGeneration=false;currentRecId=id;lastResult=null;fillJob(recToJob(rec));setGenMode('precise');$('genPrecise').classList.add('hidden');$('genMass').classList.add('hidden');flow={grabbed:true,scored:!!rec.scores,generated:!!rec.greeting};applyFlowStatus();
    $('grabBtn').hidden=true;$('genModeBtn').hidden=true;
    $('preciseHint').textContent='使用已保存岗位资料生成；如资料不足，可在下方补充并保存。';
    $('agentSavedInfo').textContent=(rec.lastCompleteJobAt||rec.lastJobScanAt?'资料保存于 '+new Date(rec.lastCompleteJobAt||rec.lastJobScanAt).toLocaleString():'资料时间未知')+' · '+(AgentCore.generationIssue(rec,true)||'资料已就绪');
    $('agentUseSavedLabel').hidden=rec.availability?.kind!=='failed';$('agentUseSaved').checked=false;
    $('genBtn').disabled=rec.availability?.kind==='unavailable';
    $('result').classList.add('hidden');$('scoreBox').classList.add('hidden');
    if(rec.greeting){lastResult={greeting:rec.greeting,matchPoints:rec.matchPoints||[],workflow:rec.workflow};renderResult(lastResult,false);}
    else if(rec.generationDraft?.text)showGenerationError({error:rec.generationDraft.review,result:{greeting:rec.generationDraft.text}});
  }
  async function openGeneration(ids){
    const records=await loadRecords();generationIds=[...new Set(ids)].filter(id=>records.some(r=>r.id===id));if(!generationIds.length)throw new Error('所选岗位已删除');
    $('agentGenerationSelect').innerHTML=generationIds.map(id=>{const r=records.find(r=>r.id===id);return '<option value="'+esc(id)+'">'+esc((r.company||'')+' · '+r.title)+'</option>';}).join('');
    generationPanel.classList.remove('hidden');$('genPrecise').classList.add('hidden');$('genMass').classList.add('hidden');document.querySelector('.tab[data-tab="gen"]').click();
    drawQueuePosition();$('agentGenerationStatus').textContent='已选择 '+generationIds.length+' 个已有岗位记录。将批量生成，再逐张检查和发送。';
    await viewGeneration(generationIds[0]);
  }
  $('agentGenerationSelect').onchange=()=>{drawQueuePosition();viewGeneration($('agentGenerationSelect').value).catch(e=>{$('agentGenerationStatus').textContent=e.message;});};
  $('agentCopyOpen').onclick=async()=>{try{const rec=(await loadRecords()).find(r=>r.id===$('agentGenerationSelect').value),text=$('greeting').value.trim();if(!rec||!text||text.startsWith('（模型未返回'))throw new Error('请先生成并检查话术');if(!await copyGreetingAndMark($('agentCopyOpen'),text))return;if(rec.url){await chrome.tabs.create({url:rec.url});$('agentGenerationStatus').textContent='当前话术已保存到记录、已复制，并已打开岗位。';}else throw new Error('话术已复制并保存，但岗位链接不可用');}catch(e){$('agentGenerationStatus').textContent=e.message;}};
  $('agentGenerateQueue').onclick=async()=>{
    $('agentGenerateQueue').disabled=true;
    try{const records=await loadRecords();const failed=records.filter(r=>generationIds.includes(r.id)&&r.availability?.kind==='failed');let allowSavedIds=[];if(failed.length&&confirm('以下岗位更新失败，确认使用已保存资料生成？\n'+failed.map(r=>(r.title||r.id)+' · '+(r.lastCompleteJobAt?new Date(r.lastCompleteJobAt).toLocaleString():'时间未知')).join('\n')))allowSavedIds=failed.map(r=>r.id);const request={type:'AGENT_START',kind:'generate',ids:[...generationIds],allowSavedIds};let r=await chrome.runtime.sendMessage(request);if(!r?.ok)throw new Error(r?.error||'后台无响应');}
    catch(e){$('agentGenerationStatus').textContent=e.message;$('agentGenerateQueue').disabled=false;}
  };
  chrome.storage.onChanged.addListener(changes=>{
    if(changes.records&&!$('rec').classList.contains('hidden'))void renderRecords();
    const task=changes.agentTask?.newValue;if(task?.kind!=='generate')return;
    $('agentGenerateQueue').disabled=['running','starting','finalizing'].includes(task.status);
    $('agentGenerationStatus').textContent=(task.status==='completed'?AgentCore.generationProgress(task).summary:['running','starting','finalizing'].includes(task.status)?'正在后台生成':'生成已暂停')+' · '+task.cursor+'/'+task.queue.length+(task.lastError?' · '+task.lastError:'');
    if(!editingGeneration&&!['running','starting','finalizing'].includes(task.status)){
      const id=$('agentGenerationSelect').value;
      if(task.failedDraft?.id===id)showGenerationError({error:task.failedDraft.message||task.lastError||task.errors?.at(-1)?.message||'请查看检验说明',result:task.failedDraft.result});
      else if(id)void viewGeneration(id).catch(e=>{$('agentGenerationStatus').textContent=e.message;});
    }
  });
  async function saveReplyDraft(kind){
    if(!lastConversationId)return;
    const response=await chrome.runtime.sendMessage({type:'AGENT_DRAFT',conversationId:lastConversationId,text:$('chatReply').value,review:$('chatReplyReview').textContent,kind});
    if(!response?.ok)throw new Error(response?.error||'草稿保存失败');
  }
  $('chatReply').addEventListener('change',()=>saveReplyDraft('draft').catch(e=>{$('chatReplyReview').textContent=e.message;}));
  $('greeting').addEventListener('input',()=>{editingGeneration=true;});
  $('greeting').addEventListener('change',()=>{if(currentRecId)updateRecord(currentRecId,{greeting:$('greeting').value,greetingState:'draft'});});
  for(const id of ['gen','chat']){const back=document.createElement('button');back.className='processing-back';back.textContent='← 返回原位置';back.onclick=async()=>{returning=true;document.querySelector('.tab[data-tab="'+processingOrigin.tab+'"]').click();returning=false;if(processingOrigin.tab==='rec'){await renderRecords();const table=document.querySelector('.table-wrap');if(table)table.scrollTop=processingOrigin.table;}window.scrollTo(0,processingOrigin.scroll);if(processingOrigin.card)document.querySelector('#'+processingOrigin.tab+' [data-card-id="'+CSS.escape(processingOrigin.card)+'"]')?.scrollIntoView({block:'nearest'});};$(id).prepend(back);}
  const replySent=document.createElement('button');replySent.id='confirmReplySent';replySent.textContent='确认回复已发送';replySent.onclick=()=>saveReplyDraft('sent').catch(e=>{$('chatReplyReview').textContent=e.message;});$('copyReplyBtn').after(replySent);
  document.body.insertAdjacentHTML('beforeend','<dialog id="chatConfirmation"><h3>核对聊天信息</h3><div id="chatConfirmationBody"></div><p id="chatConfirmationError" role="status"></p><button id="chatConfirmationSave">保存并分析</button><button id="chatConfirmationClose">暂不处理</button></dialog>');
  let confirmationTarget=null,classificationReady=false;
  const routeLabels={waiting:'流程中',reply:'待我回复',follow:'建议跟进',recycle:'回收站'};
  function showChatRoute(proposal){
    const kind=['archive','rejection'].includes(proposal.kind)?'recycle':proposal.kind;
    if(!routeLabels[kind])throw Error('仍无法建议类别：'+(proposal.reason||'消息资料不足'));
    classificationReady=true;
    $('chatConfirmationBody').innerHTML='<p><b>建议归入【'+routeLabels[kind]+'】</b></p><p>'+esc(proposal.reason||'根据已确认的消息判断')+'</p><label>确认类别（可修改）<select id="chatRouteKind">'+Object.entries(routeLabels).map(([key,label])=>'<option value="'+key+'"'+(key===kind?' selected':'')+'>'+label+'</option>').join('')+'</select></label><p>确认后归入所选类别，继续当前列表，不跳转目标类别。归类不代表已发送或已投递。</p>';
    $('chatConfirmationSave').textContent='确认归入';$('chatConfirmationError').textContent='分析完成，请确认建议或手动改选。';
  }
  function showLastChatRole(raw){
    let box=$('chatLastRoleBox');if(!box){box=document.createElement('div');box.id='chatLastRoleBox';$('chatConfirmationBody').prepend(box);}
    const last=AgentCore.effectiveChat(raw).messages?.filter(m=>m.role!=='system').at(-1);
    box.innerHTML=last?'<p><b>当前需要核对的最后一条双方消息</b></p><p>'+esc(last.text||'（消息无文字，请核对原聊天）')+'</p><label>这句话是谁发的？<select id="chatLastRole" data-message-key="'+esc(AgentCore.messageKey(last))+'"><option value="">请选择发送方</option><option value="candidate">我发送的</option><option value="hr">招聘方发送的</option><option value="system">这条是系统提示</option></select></label><p>如果改为系统提示，保存后会继续核对前一条双方消息。</p>':'<p>目前所有消息均被标为系统提示，没有可判断的双方发言。如确实没有发送过消息，可勾选下方“只有系统提示”；否则请修正历史消息或重新读取。</p>';
    if(last&&['explicit','user_confirmed'].includes(last.roleSource)&&['candidate','hr'].includes(last.role))$('chatLastRole').value=last.role;
  }
  $('chatConfirmationBody').addEventListener('change',e=>{
    const target=$('chatLastRole');if(!target)return;
    if(e.target===target){for(const select of $('chatConfirmationBody').querySelectorAll('[data-chat-role]'))if(select.dataset.chatRole===target.dataset.messageKey)select.value=target.value;}
    else if(e.target.dataset.chatRole===target.dataset.messageKey)target.value=e.target.value;
  });
  $('chatConfirmationClose').onclick=()=>$('chatConfirmation').close();
  $('chatResolve').onclick=async()=>{
    const items=await loadConversations(),raw=items.find(x=>x.id===lastConversationId);if(!raw)return;
    const c=AgentCore.effectiveChat(raw);classificationReady=false;
    confirmationTarget={id:c.id,fingerprint:c.activity?.messageFingerprint};const issues=AgentCore.chatIssues(raw),has=code=>issues.some(x=>x.code===code);
    let html='<p>'+esc([c.company,c.counterparty,c.jobTitle].filter(Boolean).join(' · '))+'</p><table><thead><tr><th>需要确认</th><th>处理方式</th></tr></thead><tbody>'+issues.map(x=>'<tr><td>'+esc(x.label)+'</td><td>'+esc(x.help)+'</td></tr>').join('')+'</tbody></table>';
    if(has('link'))html+='<button type="button" id="chatChooseLink">选择已有岗位</button><label><input id="chatKeepOnly" type="checkbox">仅保留聊天，不建立岗位、不参与自动跟进归档</label>';
    if(has('identity'))html+='<label><input id="chatIdentityConfirmed" type="checkbox">我已核对上方联系人及岗位，确认这批消息属于该会话</label>';
    if(c.messages?.some(m=>m.role!=='system'))html+='<details><summary>核对消息（'+c.messages.filter(m=>m.role!=='system').length+'条）</summary><fieldset><legend>已保存的发言方</legend>'+c.messages.filter(m=>m.role!=='system').map(m=>'<label>'+esc(String(m.text||'').slice(0,200))+'<select data-chat-role="'+esc(AgentCore.messageKey(m))+'"><option value="">'+(['explicit','user_confirmed'].includes(m.roleSource)?'已核对：':'位置推测，尚未核对：')+esc(({candidate:'我发送的',hr:'招聘方发送的',system:'系统提示'})[m.role]||'未识别')+'</option><option value="candidate">我发送的</option><option value="hr">招聘方发送的</option><option value="system">系统提示，不是双方发言</option></select></label>').join('')+'</fieldset></details>';
    if(c.messages?.length&&!c.scanError&&c.messages.every(m=>m.role==='system'))html+='<label><input id="chatNoCommunication" type="checkbox">我已核对：只有系统提示，尚未开始沟通</label><p>确认后结束此项待办，不改变岗位进度；后续真实消息将重新分析。</p>';
    html+='<label>最后有效消息的实际时间<input id="chatConfirmedTime" type="datetime-local"></label><p>不确定可留空；未知时间不用于超时判断。</p>';
    if(has('appointment'))html+='<label>是否有明确约定<select id="chatAppointmentKind"><option value="">尚不确定</option><option value="date">有约定日期</option><option value="none">没有约定</option></select></label><label>约定日期<input id="chatConfirmedAppointment" type="datetime-local"></label>';
    if(has('read'))html+='<button type="button" id="chatConfirmRead">重新读取当前聊天</button><p>请先在猎聘打开对应会话。</p>';
    $('chatConfirmationBody').innerHTML=html;$('chatConfirmationError').textContent='';$('chatConfirmationSave').textContent='保存并分析';if(has('roles'))showLastChatRole(raw);$('chatConfirmation').showModal();
    if(c.activity?.lastMessageAt){const date=new Date(c.activity.lastMessageAt);$('chatConfirmedTime').value=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
    $('chatConfirmedTime').dataset.initialValue=$('chatConfirmedTime').value;
    $('chatChooseLink')?.addEventListener('click',()=>{$('chatConfirmation').close();$('chatLinkDialog').showModal();$('chatRecordSearch').focus();});
    $('chatConfirmRead')?.addEventListener('click',()=>{$('chatConfirmation').close();$('chatMore').open=true;$('scanChatBtn').click();});
    const route=raw.confirmation?.routing;if(route?.status==='pending'&&route.fingerprint===confirmationTarget.fingerprint&&route.kind&&!issues.some(x=>x.code!=='routing'))try{showChatRoute(route);}catch(e){$('chatConfirmationError').textContent=e.message;}
  };
  $('chatConfirmationSave').onclick=async()=>{
    const button=$('chatConfirmationSave'),target={...confirmationTarget};button.disabled=true;
    try{
      if(classificationReady){const result=await chrome.runtime.sendMessage({type:'AGENT_ROUTE_CHAT',...target,kind:$('chatRouteKind').value});if(!result?.ok)throw Error(result?.error||'归类保存失败');$('chatConfirmation').close();await openSavedConversation(target.id);await renderAgentViews();$('chatScanStatus').textContent='已归入'+result.data.category+'。';if(processingOrigin.tab==='judge')$('chat').querySelector('.processing-back').click();return;}
      const confirmation={noCommunication:$('chatNoCommunication')?.checked===true,identity:$('chatIdentityConfirmed')?.checked===true,keepOnlyChat:$('chatKeepOnly')?.checked===true,roles:[...$('chatConfirmationBody').querySelectorAll('[data-chat-role]')].filter(x=>x.value).map(x=>({key:x.dataset.chatRole,role:x.value}))};
      if($('chatLastRole')?.value)confirmation.roles.push({key:$('chatLastRole').dataset.messageKey,role:$('chatLastRole').value});
      if(!confirmation.noCommunication&&$('chatConfirmedTime')?.value&&$('chatConfirmedTime').value!==$('chatConfirmedTime').dataset.initialValue)confirmation.lastMessageAt=new Date($('chatConfirmedTime').value).getTime();
      if($('chatAppointmentKind')?.value==='none')confirmation.appointment=0;
      if(!confirmation.noCommunication&&$('chatAppointmentKind')?.value==='date'){if(!$('chatConfirmedAppointment').value)throw Error('请选择约定日期');confirmation.appointment=new Date($('chatConfirmedAppointment').value).getTime();}
      const result=await chrome.runtime.sendMessage({type:'AGENT_CONFIRM_CHAT',...target,confirmation,review:!confirmation.keepOnlyChat&&!confirmation.noCommunication});if(!result?.ok)throw Error(result?.error||'确认保存失败');
      if(confirmation.noCommunication){$('chatConfirmation').close();await openSavedConversation(target.id);await renderAgentViews();$('chatScanStatus').textContent='已确认尚未开始沟通，原岗位进度保留。';if(processingOrigin.tab==='judge')$('chat').querySelector('.processing-back').click();return;}
      if(confirmation.keepOnlyChat){$('chatConfirmation').close();await openSavedConversation(target.id);await renderAgentViews();return;}
      const gaps=(result.data?.issues||[]).filter(x=>!['routing','analysis'].includes(x.code));if(gaps.length){if(gaps.some(x=>x.code==='roles')){const latest=(await loadConversations()).find(x=>x.id===target.id);if(latest&&confirmationTarget.id===target.id){showLastChatRole(latest);$('chatLastRoleBox').scrollIntoView({block:'nearest'});}}throw Error('信息已保存，仍需确认：'+gaps.map(x=>x.label).join('；'));}
      $('chatConfirmationError').textContent='信息已保存，正在根据已确认的发言方与时间重新分析…';
      const analysis=await chrome.runtime.sendMessage({type:'AGENT_REANALYZE_CHAT',id:target.id,preview:true});if(!analysis?.ok)throw Error('信息已保存，分析失败：'+(analysis?.error||'请重试'));
      if(analysis.data?.issues?.length)throw Error('分析已保存，仍需确认：'+analysis.data.issues.map(x=>x.label).join('；'));
      if($('chatConfirmation').open&&confirmationTarget.id===target.id)showChatRoute(analysis.data.proposal);await renderAgentViews();
    }catch(e){$('chatConfirmationError').textContent=e.message;}finally{button.disabled=false;}
  };

  document.body.insertAdjacentHTML('beforeend','<dialog id="chatLinkDialog"><h3>关联岗位</h3><div id="chatLinkBody"></div><button id="chatLinkCancel">取消</button><button id="chatKeepUnlinked">暂不关联，保留聊天</button><p id="chatLinkError" role="status"></p></dialog><dialog id="chatProgressDialog"><h3>更新进度（选择后保存）</h3><div id="chatProgressBody"></div><button id="chatProgressClose">关闭</button></dialog>');
  $('chatLinkBody').append($('chatLinkFallback'));$('applyChatState').closest('label').hidden=true;
  $('chatLinkCancel').onclick=()=>$('chatLinkDialog').close();$('chatProgressClose').onclick=()=>$('chatProgressDialog').close();
  $('chatKeepUnlinked').onclick=async()=>{try{const c=(await loadConversations()).find(c=>c.id===lastConversationId);const response=await chrome.runtime.sendMessage({type:'AGENT_CONFIRM_CHAT',id:c.id,fingerprint:c.activity?.messageFingerprint,confirmation:{keepOnlyChat:true}});if(!response?.ok)throw Error(response?.error||'保存失败');$('chatLinkDialog').close();await openSavedConversation(c.id);await renderAgentViews();}catch(e){$('chatLinkError').textContent=e.message;}};
  document.body.insertAdjacentHTML('beforeend','<dialog id="chatReplyDialog"><h3>对话分析与回复</h3><div id="chatReplyOverview"></div><div id="chatReplyGenerate"></div><div id="chatReplyDraftArea"></div><button id="chatReplyClose">关闭</button></dialog><dialog id="chatAssociatedDialog"><h3>已关联岗位</h3><div id="chatAssociatedBody"></div><button id="chatAssociatedChange">修改关联</button><button id="chatAssociatedClose">关闭</button></dialog>');
  $('chatReplyGenerate').append($('replyBtn'));$('replyBtn').textContent='一键生成回复';
  $('chatReplyDraftArea').append(document.querySelector('label[for="chatReply"]'),$('chatReply'),$('copyReplyBtn'),$('confirmReplySent'),$('chatReplyReview'));
  $('chatReplyClose').onclick=()=>$('chatReplyDialog').close();$('chatAssociatedClose').onclick=()=>$('chatAssociatedDialog').close();
  const badge=document.createElement('button');badge.id='chatAssociation';badge.type='button';badge.textContent='未关联';const heading=document.createElement('div');heading.className='result-actions';$('chatHeading').before(heading);heading.append($('chatHeading'),badge);
  badge.onclick=async()=>{if(!badge.dataset.recordId){$('chatLinkError').textContent='';$('chatLinkDialog').showModal();return;}const r=(await loadRecords()).find(r=>r.id===badge.dataset.recordId);if(!r){$('chatLinkDialog').showModal();return;}$('chatAssociatedBody').innerHTML='<p>'+esc([r.company,r.title].filter(Boolean).join(' · '))+'</p><p>'+esc([r.salary,r.location,normalizeStatus(r.status)].filter(Boolean).join(' · '))+'</p>';$('chatAssociatedDialog').showModal();};
  $('chatAssociatedChange').onclick=()=>{$('chatAssociatedDialog').close();$('chatLinkDialog').showModal();};
  const prepare=document.createElement('button');prepare.id='chatPrepareReply';prepare.type='button';prepare.textContent='准备回复';prepare.onclick=()=>$('chatReplyDialog').showModal();
  $('chatOverview').after($('chatSourceActions'));$('chatSourceActions').append($('chatResolve'),prepare);
  $('chatSourceActions').style.cssText='display:flex;flex-wrap:nowrap;gap:6px;align-items:center';
  // Keep legacy element IDs for existing storage/read handlers; none remain on this page.
  const legacy=document.createElement('div');legacy.hidden=true;legacy.id='chatLegacy';legacy.append($('closeChatResult'),$('chatMessages'),$('chatAnalysis'),$('chatLinkStatus'),$('changeChatLink'),$('chatMore'),$('chatSwitcher'));document.body.append(legacy);

  EchoAgentUI.init({captureCurrentChat,openChat:async id=>{document.querySelector('.tab[data-tab="chat"]').click();await openSavedConversation(id);}, openGeneration, refresh:renderAgentViews});
  initUI().then(()=>EchoOnboarding.init({
    capture:async()=>{
      const tab=await currentTab();if(!tab||!isSupportedUrl(tab.url))throw Error('请先在招聘平台打开岗位详情；也可手动填写岗位。');
      const response=await contentMessage(tab.id,{type:'EXTRACT_JOB'});
      if(!response?.ok)throw Error(response?.error||'未读取到岗位，请刷新详情页或手动填写。');
      const job=response.job;if(!job?.title||!job.company||!job.description)throw Error('岗位资料不完整，请手动补充岗位名称、公司和 JD。');
      return persistRecord({...job,url:tab.url},'',[],'未联系');
    },
    saveJob:job=>persistRecord(job,'',[],'未联系'),
    generate:id=>recordRequest('AGENT_ACTION',{action:'generate',id}),
    goToday:async()=>{document.querySelector('.tab[data-tab="sum"]').click();}
  })).catch(error=>{delete document.documentElement.dataset.onboarding;$('todayActionText').textContent='引导加载失败：'+error.message+'。请在设置中重新开始引导。';});
})();
