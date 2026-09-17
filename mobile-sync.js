/* global chrome, EchoSyncData */
(() => {
  'use strict';
  const keys = ['records','dismissedJobKeys','conversations','settings','dailySummaries','profiles','agentConfig','agentRuleHistory'];
  let running = null, again = false, timer;
  const get = keys => chrome.storage.local.get(keys);
  const set = data => chrome.storage.local.set(data);
  async function sync() {
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        let { mobileSync: config } = await get(['mobileSync']);
        if (!config?.enabled || !config.token) return { ok: false, error: '请先在设置页启用本机同步' };
        try {
          const raw = await get(keys);
          const data = EchoSyncData.snapshot({ records: raw.records || [], dismissedJobKeys:raw.dismissedJobKeys||[], conversations: raw.conversations || [], dailySummaries: raw.dailySummaries || [], settings: raw.settings || {},profiles:raw.profiles||[],agentConfig:raw.agentConfig||{} });
          const serialized = JSON.stringify(data);
          const bytes = new TextEncoder().encode(serialized);
          if (bytes.length > 15 * 1024 * 1024) throw new Error('同步超过15MB，请先导出归档');
          const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
          const stored = await get(['mobileSyncState','mobileInitialBackup']);
          let state = stored.mobileSyncState || { sourceId:crypto.randomUUID(), sequence:0 };
          if (!stored.mobileInitialBackup) await set({ mobileInitialBackup: { createdAt:Date.now(), data } });
          // Resume the same payload after an uncertain response before taking a newer snapshot.
          if (!state.pending) {
            const unchanged = state.digest === digest && state.batchId;
            state.pending = { sourceId:state.sourceId, sequence:unchanged ? state.sequence : state.sequence+1, batchId:unchanged ? state.batchId : crypto.randomUUID(), data };
            state.pendingDigest = digest;
            await set({mobileSyncState:state});
          }
          const response = await fetch('http://127.0.0.1:4319/api/sync', {
            method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},
            body:JSON.stringify(state.pending), signal:AbortSignal.timeout(12000)
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || '本机服务拒绝同步');
          const wasCurrent = state.pendingDigest === digest;
          state = {sourceId:state.sourceId,sequence:state.pending.sequence,batchId:state.pending.batchId,digest:state.pendingDigest,syncedAt:Date.now(),revision:result.revision};
          await set({mobileSyncState:state,mobileSyncStatus:{ok:true,syncedAt:state.syncedAt}});
          if (!wasCurrent) again = true;
        } catch(e) {
          const error = e.name === 'TimeoutError' || e instanceof TypeError ? '无法连接本机服务，请启动服务；一分钟后自动重试' : e.message;
          await set({mobileSyncStatus:{ok:false,error,at:Date.now()}});
          return {ok:false,error};
        }
      } while (again);
      return {ok:true};
    })();
    try { return await running; } finally { running = null; }
  }
  chrome.runtime.onMessage.addListener((msg,sender,reply)=> {
    if(msg?.type !== 'MOBILE_SYNC_NOW') return;
    sync().then(reply).catch(()=>reply({ok:false,error:'同步失败'})); return true;
  });
  chrome.storage.onChanged.addListener((changes,area)=> {
    if(area !== 'local' || ![...keys,'mobileSync'].some(k=>changes[k])) return;
    clearTimeout(timer); timer=setTimeout(()=>sync().catch(()=>{}),700);
  });
  chrome.alarms.onAlarm.addListener(alarm=> { if(alarm.name==='mobileSync') sync().catch(()=>{}); });
  async function start() { await chrome.alarms.create('mobileSync',{periodInMinutes:1}); await sync(); }
  chrome.runtime.onStartup.addListener(()=>start().catch(()=>{}));
  chrome.runtime.onInstalled.addListener(()=>start().catch(()=>{}));
})();
