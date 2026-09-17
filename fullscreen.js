/* global chrome */
// fullscreen.js — 全屏记录编辑页（自适应窗口，记录功能与侧栏一致）
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STATUS = AgentCore.statuses;
  const HR_ORDER = ['未知', '刚刚活跃', '今日活跃', '3日内活跃', '本周活跃', '半年前活跃', '活跃', '在线', '不活跃'];
  const THEMES = ['light', 'tech'];
  const THEME_COLOR = { light: '#19c8b9', tech: '#2fae8e' };
  const BACKUP_KEYS = ['records', 'recycleJobKeys', 'dismissedJobKeys', 'settings', 'uiState', 'collection', 'conversations', 'dailySummaries', 'profiles', 'usage', '_seenIntro', 'agentConfig', 'agentRuns', 'agentTask', 'agentNeedsDraft', 'agentSearchPlan'];
  let cache = [], selectedIds = new Set(), sortKey = 'createdAt', sortDir = 'desc';
  const searchFilters = { title: '', company: '' };
  function matchesDomain(url, domain) {
    try { const host = new URL(url).hostname.toLowerCase(); return host === domain || host.endsWith('.' + domain); }
    catch (e) { return false; }
  }
  function platformOf(rec) {
    const u = rec && rec.url || '';
    if (matchesDomain(u, 'zhipin.com')) return 'Boss直聘';
    if (matchesDomain(u, 'liepin.com')) return '猎聘';
    if (matchesDomain(u, 'zhaopin.com')) return '智联招聘';
    if (matchesDomain(u, 'lagou.com')) return '拉勾';
    return u ? '其他来源' : '—';
  }
  const timelineText=rec=>AgentCore.timeline(rec).map(x=>new Date(x.at).toLocaleString()+'｜'+x.title+(x.evidence?'｜'+x.evidence:'')).join('\n')||'暂无处理历史';
  let mockIdx = 0, mockAnswers = [], mockTimer = null, mockQuestions = [], mockStart = 0, mockRecId = null, mockCurStart = 0;
  const normalizeStatus = AgentCore.normalizeStatus;

  const loadRecords = EchoRecordClient.loadRecords;
  const recordRequest = EchoRecordClient.request;
  const recordClient = EchoRecordClient.create({
    source: 'fullscreen.js', getRecords: () => cache, onRecords: records => { cache = records; },
    undoButton: () => $('undoBtnFs')
  });
  const { recordDrafts, rememberDraft, updateRecord, refreshUndoButton,
    deleteRecordsWithUndo, restoreUndo, migrateRecordStatuses } = recordClient;
  const loadSettings = () => new Promise((r) => chrome.storage.local.get(['settings'], (x) => r(x.settings || {})));
  const loadState = () => new Promise((r) => chrome.storage.local.get(['uiState'], (x) => r(x.uiState || {})));
  const saveState = (p) => new Promise((r) => chrome.storage.local.get(['uiState'], (s) => chrome.storage.local.set({ uiState: Object.assign(s.uiState || {}, p) }, r)));
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function setFs(msg) { const el = $('fsStatus'); if (!el) return; el.textContent = msg || ''; if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500); }
  function fmtDur(s) { const m = Math.floor(s / 60); return (m > 0 ? m + ' 分 ' : '') + (s % 60) + ' 秒'; }

  // ---------- 评分文本 ----------
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

  // ---------- 排序 ----------
  function sortVal(rec, k) {
    if (k === 'overall') return (rec.scores && rec.scores.overall != null) ? rec.scores.overall : -1;
    if (k === 'status') return STATUS.indexOf(normalizeStatus(rec.status));
    if (k === 'hrActive') return HR_ORDER.indexOf(rec.hrActive || '未知');
    if (k === 'createdAt') return AgentCore.recordTime(rec);
    if (k === 'platform') return platformOf(rec);
    return (rec[k] || '').toString();
  }
  // 按时间排序：默认 新→旧，点击切换
  function updateSortTimeBtn() {
    const btn = $('sortTimeBtnFs'); if (!btn) return;
    if (sortKey === 'createdAt') btn.textContent = '🕘 最近更新 ' + (sortDir === 'desc' ? '新→旧' : '旧→新');
    else btn.textContent = '🕘 最近更新';
  }
  function updateSortArrows() {
    $('fsTable').querySelectorAll('th.sortable').forEach((th) => {
      const k = th.getAttribute('data-sort');
      const base = th.getAttribute('data-label') || th.textContent.replace(/[▲▼]/g, '').trim();
      th.setAttribute('data-label', base);
      th.innerHTML = base + (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    });
  }
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

  // ---------- 渲染表格 ----------
  function render() {
    if(document.activeElement?.closest('#fsBody')&&document.activeElement.matches('input:not([type=checkbox]),textarea,select'))return;
    const body = $('fsBody'); body.innerHTML = '';
    let rows = cache.slice();
    if (searchFilters.title) rows = rows.filter((r) => (r.title || '').includes(searchFilters.title));
    if (searchFilters.company) rows = rows.filter((r) => (r.company || '').includes(searchFilters.company));
    if (sortKey) {
      rows.sort((a, b) => {
        const av = sortVal(a, sortKey), bv = sortVal(b, sortKey);
        let c; if (typeof av === 'number' && typeof bv === 'number') c = av - bv; else c = String(av).localeCompare(String(bv), 'zh');
        return sortDir === 'asc' ? c : -c;
      });
    }
    $('fsEmpty').textContent=cache.length?'当前筛选没有匹配记录。双击岗位或公司表头可清除筛选。':'还没有记录，请先在侧栏采集岗位。';$('fsEmpty').hidden=rows.length>0;$('fsTable').hidden=rows.length===0;
    let seq = 0;
    const fragment=document.createDocumentFragment();
    rows.forEach((rec) => { const savedRec=rec;rec={...rec,...recordDrafts[rec.id]};
      seq++;
      const tr = document.createElement('tr');
      if (selectedIds.has(rec.id)) tr.classList.add('row-selected');
      const tdChk = document.createElement('td'); tdChk.className = 'col-check';
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = selectedIds.has(rec.id);
      chk.addEventListener('change', () => { if (chk.checked) selectedIds.add(rec.id); else selectedIds.delete(rec.id); tr.classList.toggle('row-selected', chk.checked); });
      tdChk.appendChild(chk); tr.appendChild(tdChk);
      const tdIdx = document.createElement('td'); tdIdx.className = 'col-idx'; tdIdx.textContent = seq; tr.appendChild(tdIdx);

      const mk = (val, key) => { const td = document.createElement('td'); const i = document.createElement('input'); i.value = val || ''; i.addEventListener('change', () => updateRecord(rec.id, { [key]: i.value },false,savedRec)); td.appendChild(i); return td; };
      tr.appendChild(mk(rec.title, 'title'));
      tr.appendChild(mk(rec.company, 'company'));
      tr.appendChild(mk(rec.location, 'location'));
      tr.appendChild(mk(rec.salary, 'salary'));
      tr.appendChild(mk(rec.size, 'size'));
      const tdS = document.createElement('td'); const s = document.createElement('select');
      STATUS.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; if (v === normalizeStatus(rec.status)) o.selected = true; s.appendChild(o); });
      s.addEventListener('change', () => updateRecord(rec.id, { status: s.value },false,savedRec)); tdS.appendChild(s); tr.appendChild(tdS);
      const tdDecision=document.createElement('td'),decision=document.createElement('span');decision.className='decision-badge decision-'+(rec.discoveryState||'none');decision.textContent=rec.communicationArchive?'回收站 · '+rec.communicationArchive.reason:AgentCore.decisionLabel(rec.discoveryState);tdDecision.appendChild(decision);tr.appendChild(tdDecision);
      const tdSc = document.createElement('td');
      if (rec.scores && rec.scores.overall != null) { const p = document.createElement('span'); p.className = 'score-pill'; p.textContent = '★' + rec.scores.overall; p.title = '点击查看评分详情'; p.addEventListener('click', () => alert(scoreText(rec.scores))); tdSc.appendChild(p); }
      else tdSc.textContent = '—';
      const scoreInfo=AgentCore.scoreInfo(rec),scoreHint=document.createElement('small');scoreHint.textContent=scoreInfo.message;tdSc.appendChild(scoreHint);
      if(scoreInfo.retry){const retry=document.createElement('button');retry.textContent='重试多维评分';retry.addEventListener('click',async()=>{retry.disabled=true;scoreHint.textContent='正在评分…';try{const reply=await chrome.runtime.sendMessage({type:'AGENT_SCORE_RECORD',id:rec.id});if(!reply?.ok)throw new Error(reply?.error||'评分失败');cache=await loadRecords();render();}catch(error){scoreHint.textContent=error.message;retry.disabled=false;}});tdSc.appendChild(retry);}
      tr.appendChild(tdSc);
      const tdH = document.createElement('td'); const hb = document.createElement('span'); hb.className = 'hr-badge'; hb.textContent = (rec.hrActive || '未知'); tdH.appendChild(hb); tr.appendChild(tdH);
      const tdN = document.createElement('td'); tdN.className = 'notes-cell';
      const taN = document.createElement('textarea'); taN.value = rec.notes || ''; taN.rows = 2; taN.className = 'fill'; taN.addEventListener('change', () => updateRecord(rec.id, { notes: taN.value },false,savedRec)); tdN.appendChild(taN); tr.appendChild(tdN);
      const tdG = document.createElement('td'); const ta = document.createElement('textarea'); ta.rows = 3; ta.value = rec.greeting || '';
      ta.addEventListener('change', () => updateRecord(rec.id, { greeting: ta.value },false,savedRec));
      const cp = document.createElement('button'); cp.className = 'mini'; cp.textContent = '复制';
      cp.addEventListener('click', async () => { try { await navigator.clipboard.writeText(ta.value);await updateRecord(rec.id,{greeting:ta.value,greetingState:'copied',greetingCopiedAt:Date.now()});cp.textContent = '已复制'; setTimeout(() => (cp.textContent = '复制'), 1000); } catch (e) {alert('未保存：'+e.message);} });
      const w = document.createElement('div'); w.className = 'greeting-cell'; w.appendChild(ta); w.appendChild(cp); tdG.appendChild(w); tr.appendChild(tdG);
      const tdJ = document.createElement('td'); const tj = document.createElement('textarea'); tj.rows = 4; tj.className = 'jd-cell'; tj.value = rec.description || '';
      tj.addEventListener('change', () => updateRecord(rec.id, { description: tj.value },false,savedRec)); tdJ.appendChild(tj); tr.appendChild(tdJ);
      const tdU = document.createElement('td');
      if (rec.url) {
        const a = document.createElement('a'); a.href = rec.url; a.target = '_blank'; a.textContent = '打开'; a.className = 'src-link'; tdU.appendChild(a);
        const pf = document.createElement('div'); pf.className = 'src-platform'; pf.textContent = platformOf(rec); pf.title = '点击按平台排序';
        pf.addEventListener('click', () => { if (sortKey !== 'platform') { sortKey = 'platform'; sortDir = 'asc'; } else { sortDir = (sortDir === 'asc' ? 'desc' : 'asc'); } render(); });
        tdU.appendChild(pf);
      } else tdU.textContent = '—';
      tr.appendChild(tdU);
      const tdOp = document.createElement('td'); const mb = document.createElement('button'); mb.className = 'mini primary'; mb.textContent = '模拟面试';
      mb.addEventListener('click', () => openMockInterview(rec)); tdOp.appendChild(mb);const history=document.createElement('button');history.className='mini';history.textContent='岗位时间线';history.addEventListener('click',()=>alert(timelineText(AgentCore.recordById(cache,rec.id)||rec)));tdOp.appendChild(history);if(rec.mergeHistory?.length){const merged=document.createElement('button');merged.textContent='合并历史';merged.addEventListener('click',()=>alert(JSON.stringify(rec.mergeHistory,null,2)));tdOp.appendChild(merged);}tr.appendChild(tdOp);
      fragment.appendChild(tr);
    });
    body.appendChild(fragment);
    updateSortArrows();
    updateSortTimeBtn();
    enableColResize($('fsTable'));
  }

  // 按时间排序按钮
  $('sortTimeBtnFs').addEventListener('click', () => {
    if (sortKey !== 'createdAt') { sortKey = 'createdAt'; sortDir = 'desc'; }
    else { sortDir = (sortDir === 'desc' ? 'asc' : 'desc'); }
    updateSortTimeBtn();
    render();
  });

  // ---------- AI 评分 / 生成（勾选；未勾选则全部）----------
  async function batchScore(){
    const settings=await loadSettings();if(!settings.apiKey){alert('未配置 API Key');return;}
    const recs=await loadRecords(),targets=selectedIds.size?recs.filter(r=>selectedIds.has(r.id)):recs;if(!targets.length){setFs('没有可评分记录');return;}
    let done=0;const failures=[];
    for(const rec of targets){try{const reply=await chrome.runtime.sendMessage({type:'AGENT_SCORE_RECORD',id:rec.id});if(!reply?.ok)throw new Error(reply?.error||'评分失败');}catch(error){failures.push((rec.company||'')+' · '+rec.title+'：'+error.message);}done++;setFs('评分中 '+done+'/'+targets.length);}
    cache=await loadRecords();render();setFs('评分完成：成功 '+(done-failures.length)+'，失败 '+failures.length+(failures.length?'；'+failures.join('；'):''));
  }
  async function batchGreet() {
    const settings = await loadSettings(); if (!settings.apiKey) { alert('未配置 API Key'); return; }
    const ids = [...selectedIds]; const recs = await loadRecords();
    const targets = ids.length ? recs.filter((r) => ids.includes(r.id)) : recs;
    if (!targets.length) { setFs('没有可生成记录'); return; }
    let done = 0; const failures = [];
    for (const rec of targets) {
      const job = { title: rec.title, company: rec.company, location: rec.location, salary: rec.salary, size: rec.size, description: rec.description, url: rec.url };
      try {
        const r = await chrome.runtime.sendMessage({ type:'AGENT_ACTION',action:'generate',id:rec.id });
        if (!r || !r.ok){if(r?.result?.greeting)rememberDraft(rec.id,{greeting:r.result.greeting});throw new Error((r && r.error) || '后台无响应');}
      } catch (e) { failures.push((rec.title || rec.id) + '：' + e.message); }

      done++; setFs('生成中 ' + done + '/' + targets.length);
    }
    cache = await loadRecords(); render(); setFs('生成完成：' + (done - failures.length) + ' 条；未保存：' + failures.length + ' 条'); if (failures.length) alert(failures.join('\n'));
  }
  // ---------- 导出 XLS / 备份 / 导入 ----------
  function exportXls() {
    const cols = [['description','JD'],['title','岗位名称'],['company','公司名称'],['location','地点'],['salary','薪资'],['size','规模'],['status','沟通情况'],['hrActive','HR活跃'],['notes','备注'],['greeting','打招呼语'],['url','来源链接']];
    let html = '<html><head><meta charset="UTF-8"></head><body><table border="1">';
    html += '<tr>' + cols.map((c) => '<th>' + c[1] + '</th>').join('') + '</tr>';
    cache.forEach((rec) => { html += '<tr>' + cols.map((c) => '<td>' + esc(rec[c[0]] || (c[0] === 'hrActive' ? (rec.hrActive || '未知') : '')) + '</td>').join('') + '</tr>'; });
    html += '</table></body></html>';
    const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '求职记录_' + new Date().toISOString().slice(0, 10) + '.xls';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('exportFs').addEventListener('click', exportXls);
  function maskKey(k) {
    if (!k || typeof k !== 'string') return k;
    if (k.length <= 8) return '***';
    return k.slice(0, 4) + '****' + k.slice(-4);
  }
  $('exportBackupFs').addEventListener('click', async () => {
    const data = await new Promise((r) => chrome.storage.local.get(BACKUP_KEYS, (x) => r(x)));
    delete data.lastBackup;
    delete data.lastBackupAt;
    delete data.baiduToken;
    if (data.settings) {
      if (data.settings.apiKey) data.settings.apiKey = maskKey(data.settings.apiKey);
      if (data.settings.ocrApiKey) data.settings.ocrApiKey = maskKey(data.settings.ocrApiKey);
      if (data.settings.ocrSecretKey) data.settings.ocrSecretKey = maskKey(data.settings.ocrSecretKey);
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'ai-job-assistant-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('importBackupFs').addEventListener('click', () => $('importFileFs').click());
  $('importFileFs').addEventListener('change', (e) => {
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
        for(const key of ['agentConfig','agentNeedsDraft','agentSearchPlan','agentRuns'])if(data[key]!==undefined)setObj[key]=data[key];
        if(data.agentTask){setObj.agentTask={...data.agentTask,status:['running','starting','finalizing'].includes(data.agentTask.status)?'interrupted':data.agentTask.status};for(const key of ['workerTabId','listTabId','chatTabId','chatFrameId','ownedTabIds'])delete setObj.agentTask[key];for(const key of ['queue','deferred'])setObj.agentTask[key]=(setObj.agentTask[key]||[]).map(({tabId,frameId,...entry})=>entry);}
        if (data.usage !== undefined) setObj.usage = data.usage;
        await recordRequest('AGENT_COMPARE_STORAGE',{values:setObj,expected:importBaseline});
        cache = recs; render(); setFs('导入完成：' + recs.length + ' 条');
      } catch (err) { alert('导入失败：' + (err && err.message ? err.message : err)); }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  // ---------- 主题（点击循环 + 底色）----------
  function applyThemeColor() {
    const fab = $('themeFabFs'); if (!fab) return;
    const t = document.documentElement.getAttribute('data-theme') || 'light';
    fab.style.background = THEME_COLOR[t] || THEME_COLOR.light;
  }
  $('themeFabFs').addEventListener('click', async () => {
    const st = await loadState(); const cur = THEMES.includes(st.theme) ? st.theme : 'light';
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    document.documentElement.setAttribute('data-theme', next); await saveState({ theme: next }); applyThemeColor(); setFs('主题：' + ({ light: '动森', tech: '科技风' }[next] || next));
  });
  // 侧边栏 / 设置页切换皮肤时，全屏页实时跟随
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.recordsUndo || changes.recordsMergeUndo) refreshUndoButton();
    if(changes.records){cache=changes.records.newValue||[];render();}
    if (!changes.uiState) return;
    const t = (changes.uiState.newValue || {}).theme;
    if (THEMES.includes(t) && t !== (document.documentElement.getAttribute('data-theme') || 'light')) {
      document.documentElement.setAttribute('data-theme', t);
      applyThemeColor(); setFs('主题：' + ({ light: '动森', tech: '科技风' }[t] || t));
    }
  });
  $('closeFs').addEventListener('click', () => window.close());

  // ---------- 批量下拉 ----------
  function setupDropdown(btnId, menuId) {
    const btn = $(btnId), menu = $(menuId); if (!btn || !menu) return;
    btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target !== btn) menu.classList.add('hidden'); });
  }
  setupDropdown('batchMenuBtnFs', 'batchMenuFs');
  setupDropdown('exportMenuBtnFs', 'exportMenuFs');
  $('selUnscoredFs').addEventListener('click', async () => { const recs = await loadRecords(); selectedIds = new Set(recs.filter((r) => !(r.scores && r.scores.overall != null)).map((r) => r.id)); render(); });
  $('selUngreetedFs').addEventListener('click', async () => { const recs = await loadRecords(); selectedIds = new Set(recs.filter((r) => !r.greeting).map((r) => r.id)); render(); });
  $('selConsiderFs').addEventListener('click', async () => { const recs = await loadRecords(); selectedIds = new Set(recs.filter((r) => !r.discoveryState||['pending','skipped'].includes(r.discoveryState)).map((r) => r.id)); render(); });
  $('batchConsiderBtnFs').addEventListener('click', async () => {
    const ids = [...selectedIds]; if (!ids.length) { alert('请先勾选岗位。'); return; }
    if (!confirm('将把勾选岗位的用户判断改为“暂不考虑”？招聘进度不会改变。')) return;
    const response=await chrome.runtime.sendMessage({type:'AGENT_ACTION',action:'bulkDismiss',ids});if(!response?.ok){alert(response?.error||'保存失败');return;}cache=await loadRecords();
    render(); alert('已将勾选岗位标记为“暂不考虑”，招聘进度保持不变。');
  });
  $('batchScoreBtnFs').addEventListener('click', batchScore);
  $('batchGreetBtnFs').addEventListener('click', batchGreet);
  async function selectDeliveredDaysFs(n) {
    if (isNaN(n) || n < 0) { selectedIds.clear(); render(); return; }
    const cutoff = Date.now() - n * 86400000;
    const recs = await loadRecords();
    selectedIds = new Set(recs.filter((r) => normalizeStatus(r.status) === '已投递' && (r.appliedAt || r.createdAt || 0) <= cutoff).map((r) => r.id));
    render();
  }
  $('daysInputFs').addEventListener('input', async () => {
    const n = parseInt($('daysInputFs').value, 10);
    await selectDeliveredDaysFs(n);
  });
  $('selDeliveredDaysFs').addEventListener('click', async () => {
    const n = parseInt($('daysInputFs').value, 10);
    if (isNaN(n) || n < 0) { alert('请先在上方输入天数 N（如 7 表示「7 天前已投递」）。'); return; }
    await selectDeliveredDaysFs(n);
    $('batchMenuFs').classList.add('hidden');
  });
  $('batchRejectBtnFs').addEventListener('click', async () => {
    const ids = [...selectedIds]; if (!ids.length) { alert('请先勾选记录（或用「全选N天前已投递」）。'); return; }
    if (!confirm('将把勾选的 ' + ids.length + ' 条记录标记为「拒绝」？')) return;
    const recs = await loadRecords();
    for (const id of ids) { const rec = recs.find((r) => r.id === id); if (rec) await updateRecord(id, { status: '拒绝' }); }
    cache = await loadRecords(); render(); alert('已标记 ' + ids.length + ' 条为「拒绝」。');
  });
  $('selDupFs').addEventListener('click', async () => {
    const records = await loadRecords(); if (records.length < 2) { alert('记录少于 2 条'); return; }
    setFs('识别重复中…');
    chrome.runtime.sendMessage({ type: 'DEDUP', records: records }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) { setFs('识别失败'); return; }
      const groups = resp.groups || []; const ids = new Set();
      groups.forEach((g) => (g.group || []).forEach((i) => { if (records[i]) ids.add(records[i].id); }));
      selectedIds = ids; render(); setFs(groups.length ? ('已勾选 ' + ids.size + ' 条重复记录（平台岗位标识相同）') : '未发现相同平台岗位标识；同名不会合并');
    });
  });
  $('batchDedupBtnFs').addEventListener('click', async () => {
    try {
      if (!await recordClient.mergeSelected([...selectedIds])) return;
      selectedIds.clear(); render();
      alert('合并完成，资料和聊天关联已保存。');
    } catch (error) { alert(error.message); }
  });

  // ---------- 选择下拉（全选 / 取消全选）----------
  $('selMenuBtnFs').addEventListener('click', (e) => { e.stopPropagation(); $('selMenuFs').classList.toggle('hidden'); });
  $('selAllBtnFs').addEventListener('click', async () => { const recs = await loadRecords(); selectedIds = new Set(recs.map((r) => r.id)); $('selMenuFs').classList.add('hidden'); render(); });
  $('selNoneBtnFs').addEventListener('click', () => { selectedIds.clear(); $('selMenuFs').classList.add('hidden'); render(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#selMenuBtnFs') && !e.target.closest('#selMenuFs')) $('selMenuFs').classList.add('hidden'); });
  $('undoBtnFs').addEventListener('click', async () => {
    try { const undo = await restoreUndo(); if (!undo) { await refreshUndoButton(); return; }
    selectedIds.clear(); render(); setFs('已撤销：' + (undo.label || '上一次记录操作')); }catch(e){alert(e.message||'撤销失败');}
  });
  $('deleteSelBtnFs').addEventListener('click', async () => {
    const ids = [...selectedIds]; if (!ids.length) { alert('请先勾选要删除的记录（用最左选择下拉「全选」）。'); return; }
    if (!confirm('确定删除选中的 ' + ids.length + ' 条记录？')) return;
    const all = await loadRecords(); const set = new Set(ids);
    let remaining;try{remaining=await deleteRecordsWithUndo(all,set,'删除 '+ids.length+' 条记录');}catch(e){setFs('无法保存删除操作，岗位未删除：'+e.message);return;}
    if(!remaining)return;cache = remaining; selectedIds.clear(); render();
  });

  // ---------- 排序表头 ----------
  $('fsTable').querySelectorAll('th.sortable').forEach((th) => th.addEventListener('click', () => {
    const k = th.getAttribute('data-sort');
    if (sortKey === k) sortDir = (sortDir === 'asc' ? 'desc' : 'asc'); else { sortKey = k; sortDir = 'asc'; }
    render();
  }));

  // ---------- 模拟面试 ----------
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
  function openMockInterview(rec) {
    mockRecId = rec ? rec.id : null;
    mockQuestions = buildQuestions(rec ? { title: rec.title, description: rec.description } : { title: '', description: '' });
    mockIdx = 0; mockAnswers = []; mockStart = Date.now();
    $('mockModalFs').classList.remove('hidden'); renderMockModal();
  }
  function renderMockModal() {
    const body = $('mockBodyFs'); body.innerHTML = '';
    if (mockIdx >= mockQuestions.length) {
      const total = Math.round((Date.now() - mockStart) / 1000);
      const wrap = document.createElement('div');
      wrap.innerHTML = '<div class="mock-q">已完成全部 ' + mockQuestions.length + ' 题。</div>' +
        '<div class="mock-total">总用时：' + fmtDur(total) + '（' + total + ' 秒）</div>';
      const regen = document.createElement('button'); regen.className = 'primary'; regen.textContent = '再生成一次';
      regen.addEventListener('click', () => { mockIdx = 0; mockAnswers = []; mockStart = Date.now(); renderMockModal(); });
      wrap.appendChild(regen); body.appendChild(wrap); return;
    }
    const q = document.createElement('div'); q.className = 'mock-q';
    q.innerHTML = '<span class="idx">第 ' + (mockIdx + 1) + '/' + mockQuestions.length + ' 题：</span>' + esc(mockQuestions[mockIdx]);
    const a = document.createElement('textarea'); a.rows = 4; a.id = 'mockAnsFs'; a.placeholder = '请输入具体回答（含事例/数据）';
    if (mockAnswers[mockIdx] != null) a.value = mockAnswers[mockIdx];
    const timer = document.createElement('div'); timer.className = 'mock-timer';
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
    mockCurStart = Date.now(); const el = document.getElementById('mockTimerFs') || document.querySelector('#mockBodyFs .mock-timer');
    if (!el) return;
    el.id = 'mockTimerFs';
    if (mockTimer) clearInterval(mockTimer);
    mockTimer = setInterval(() => { const s = Math.round((Date.now() - mockCurStart) / 1000); if (el) el.textContent = '本题用时：' + fmtDur(s); }, 1000);
  }
  function saveMockAnswer(a) { if (mockIdx >= 0 && mockIdx < mockQuestions.length) { mockAnswers[mockIdx] = a.value; } }
  function commitMockAnswer(a) { const v = a.value.trim(); mockAnswers[mockIdx] = v; return true; }
  function collectMock(q, a) {
    const note = '【模拟面试 Q】' + q + '\nA：' + a;
    if (mockRecId) updateRecord(mockRecId, { notesAppend: note });
    else alert('已记录（当前无关联记录，请手动复制）：\n' + note);
  }
  async function finishMock() {
    if (mockTimer) clearInterval(mockTimer); saveMockAnswer(document.getElementById('mockAnsFs'));
    const total = Math.round((Date.now() - mockStart) / 1000);
    const answered = mockAnswers.map((m) => (m || '').trim()).filter(Boolean);
    const body = $('mockBodyFs'); body.innerHTML = '';
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
      regen.addEventListener('click', () => { mockIdx = 0; mockAnswers = []; mockStart = Date.now(); renderMockModal(); });
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
  $('mockCloseFs').addEventListener('click', () => { if (mockTimer) clearInterval(mockTimer); $('mockModalFs').classList.add('hidden'); });
  $('mockModalFs').addEventListener('click', (e) => { if (e.target === $('mockModalFs')) { if (mockTimer) clearInterval(mockTimer); $('mockModalFs').classList.add('hidden'); } });

  // ---------- init ----------
  (async () => {
    await migrateRecordStatuses();
    await refreshUndoButton();
    const st = await loadState(); const t = THEMES.includes(st.theme) ? st.theme : 'light';
    document.documentElement.setAttribute('data-theme', t); applyThemeColor();
    cache = await loadRecords(); render();
    document.querySelectorAll('#fsTable th.searchable').forEach((th) => th.addEventListener('dblclick', () => {
      const key = th.getAttribute('data-sort');
      const name = th.textContent.replace(/[▲▼]/g, '').trim();
      const val = prompt('搜索「' + name + '」包含的关键词（留空 = 清除该列筛选）：', searchFilters[key] || '');
      if (val === null) return;
      searchFilters[key] = val.trim(); render();
    }));
  })();
})();
