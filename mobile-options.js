/* global chrome */
(() => {
  const $=id=>document.getElementById(id);
  async function status() {
    const {mobileSyncStatus:s}=await chrome.storage.local.get('mobileSyncStatus');
    $('mobileStatus').textContent=s ? (s.ok ? '本机镜像已同步 · '+(s.syncedAt?new Date(s.syncedAt).toLocaleString():'暂无新变化') : s.error) : '尚未同步';
  }
  chrome.storage.local.get('mobileSync').then(({mobileSync:s})=> { $('mobileEnabled').checked=!!s?.enabled; $('mobileToken').value=s?.token || ''; });
  $('mobileConnect').addEventListener('click',async()=> {
    const token=$('mobileToken').value.trim(), enabled=$('mobileEnabled').checked;
    if(enabled && !/^[a-f0-9]{64}$/.test(token)) { $('mobileStatus').textContent='请粘贴电脑服务生成的完整同步凭据'; return; }
    await chrome.storage.local.set({mobileSync:{enabled,token}});
    if(!enabled) { $('mobileStatus').textContent='同步已关闭，本机已有镜像保留'; return; }
    $('mobileStatus').textContent='正在同步…';
    try { const r=await chrome.runtime.sendMessage({type:'MOBILE_SYNC_NOW'}); if(!r?.ok) $('mobileStatus').textContent=r?.error || '同步失败'; else await status(); }
    catch { $('mobileStatus').textContent='后台无响应，请重新加载扩展'; }
  });
  $('mobileBackup').addEventListener('click',async()=> {
    const {mobileInitialBackup:b}=await chrome.storage.local.get('mobileInitialBackup');
    if(!b) { $('mobileStatus').textContent='首次同步后会保存业务备份'; return; }
    const url=URL.createObjectURL(new Blob([JSON.stringify(b,null,2)],{type:'application/json'}));
    try { await chrome.downloads.download({url,filename:'echo-before-mobile-sync.json',saveAs:true}); }
    finally { setTimeout(()=>URL.revokeObjectURL(url),10000); }
  });
  chrome.storage.onChanged.addListener((c,area)=> { if(area==='local' && c.mobileSyncStatus) status(); }); status();
})();
