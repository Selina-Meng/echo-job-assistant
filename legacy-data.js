/* Read-only review of legacy business data. No model calls or automatic merges. */
document.addEventListener('DOMContentLoaded', () => {
  const host=document.getElementById('rec');if(!host)return;
  const panel=document.createElement('details');
  panel.innerHTML='<summary>旧数据整理与备份</summary><p>先检查旧记录，含义不明的状态和同名岗位不自动合并。历史数据不会因暂不考虑满24小时而删除。</p><button type="button">检查旧数据</button><button type="button">下载整理前备份</button><pre style="white-space:pre-wrap" role="status"></pre>';
  host.prepend(panel);
  const [inspect,download]=panel.querySelectorAll('button'),output=panel.querySelector('pre');
  inspect.onclick=async()=>{try{
    const d=await chrome.storage.local.get(['records','conversations','dismissedJobKeys']);const records=d.records||[],ids=new Set(records.map(r=>r.id)),keys=new Map();
    for(const r of records){const key=AgentCore.jobKey(r.url)||r.platformJobKey;if(key)keys.set(key,(keys.get(key)||0)+1);}
    const issues=records.filter(r=>r.legacyReview?.needsConfirmation||!AgentCore.statuses.includes(r.status));
    const missing=records.filter(r=>!r.title||!r.company||!r.description);
    const orphan=(d.conversations||[]).filter(c=>c.linkedRecordId&&!ids.has(c.linkedRecordId));
    output.textContent=['岗位 '+records.length+' 条；会话 '+(d.conversations||[]).length+' 条','相同岗位标识的重复组：'+[...keys.values()].filter(n=>n>1).length,'资料待补：'+missing.length+' 条；失效聊天关联：'+orphan.length+' 条','旧版删除凭据：'+(d.dismissedJobKeys||[]).length+' 条（如缺完整记录，需从旧备份找回）','状态待核对：'+issues.length+' 条',...issues.slice(0,30).map(r=>(r.company||'未知公司')+' · '+(r.title||r.id)+'：原状态 '+(r.legacyReview?.originalStatus||r.status||'未记录')+' → 当前 '+r.status),issues.length>30?'仅展示前30条，完整记录仍保留。':''].filter(Boolean).join('\n');
  }catch(e){output.textContent='检查失败：'+e.message;}};
  download.onclick=async()=>{try{
    const d=await chrome.storage.local.get(['legacyDataBackup']);if(!d.legacyDataBackup)throw new Error('尚无整理前备份，请先导出当前完整数据；此处不会伪造旧备份');
    const url=URL.createObjectURL(new Blob([JSON.stringify(d.legacyDataBackup.data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='echo-before-migration-'+d.legacyDataBackup.at+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);output.textContent='已发起备份下载。恢复前请另行导出当前数据；旧备份可能覆盖后续修改。';
  }catch(e){output.textContent='下载失败：'+e.message;}};
});
