const assert=require('node:assert/strict'),{runtime,settled}=require('./agent-smoke.js');
const job={id:'r',title:'采购',company:'合成公司',description:'完整JD',url:'https://www.liepin.com/job/123.shtml'},settings={apiKey:'mock',deepseekConsent:true};
async function run(r){await r.tasks.handle({type:'AGENT_START',kind:'generate',ids:['r']});return settled(r);}
(async()=>{
 const good=runtime({records:[job],settings});let t=await run(good);
 assert.equal(t.stats.updated,1);assert.equal(t.stats.failed,0);assert.equal(good.C.generationProgress(t).saved,1);assert(good.store.records[0].greeting);
 const bad=runtime({records:[job],settings},{generate:async()=>{const e=Error('真实性：经历没有依据');e.result={greeting:'待处理草稿'};throw e;}});
 t=await run(bad);assert.equal(t.stats.failed,1);assert.equal(t.lastError,'');assert.equal(t.failedDraft.message,'真实性：经历没有依据');assert.equal(bad.C.generationProgress(t).review,1);assert(bad.C.generationProgress(t).issues[0].includes('合成公司 · 采购：真实性'));assert(bad.store.records[0].generationDraft);assert(!bad.store.records[0].greeting);
 const saveFail=runtime({records:[job],settings},{},{failSet:d=>d.records?.some(r=>r.greeting==='你好')});t=await run(saveFail);assert.equal(saveFail.C.generationProgress(t).failed,1);assert.equal(saveFail.C.generationProgress(t).review,0);assert(!saveFail.store.records[0].greeting);
 let fail=true;const retried=runtime({records:[job],settings},{generate:async()=>{if(fail)throw Error('模型故障');return {greeting:'已恢复'};}});await run(retried);fail=false;t=await run(retried);assert.equal(t.stats.failed,0);assert.equal(t.stats.updated,1);
 const refreshFail=runtime({records:[job],settings},{},{failSet:d=>!!d.dailySummaries});t=await run(refreshFail);assert.equal(refreshFail.store.records[0].greeting,'你好');assert.equal(t.stats.failed,0);assert.equal(t.stats.updated,1);assert(t.queue[0].warning.includes('话术已保存'));assert.equal(t.status,'paused');
 const historical={kind:'generate',stats:{failed:1},queue:[{type:'generate',recordId:'r',outcome:'saved'}]};assert.equal(good.C.generationProgress(historical).failed,0);
 console.log('PASS saved generation, rejected retained draft, storage failure, retry recovery, committed text with refresh failure, stale counters ignored. No model calls.');
})().catch(e=>{console.error(e);process.exitCode=1;});
