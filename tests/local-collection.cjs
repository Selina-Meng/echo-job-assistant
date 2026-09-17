const assert=require('node:assert/strict'),{runtime,settled}=require('./agent-smoke.js');
(async()=>{
 for(const settings of [{},{apiKey:'mock',deepseekConsent:false}]){
  let calls=0;const r=runtime({settings},{score:async()=>{calls++;},json:async()=>{calls++;}},{activeUrl:'https://www.liepin.com/job/123.shtml',reply:m=>m.type==='EXTRACT_JOB'?{ok:true,job:{title:'采购',company:'合成公司',description:'完整岗位JD'}}:{ok:true}});
  await r.tasks.handle({type:'AGENT_START',kind:'discover',currentJob:true});const task=await settled(r);
  assert.equal(task.status,'completed');assert.equal(r.store.records.length,1);assert.equal(calls,0);assert(task.queue.some(e=>e.outcome==='deferred'));
  await r.tasks.handle({type:'AGENT_UPDATE_RECORD',id:r.store.records[0].id,patch:{notes:'本地编辑'}});assert.equal(r.store.records[0].notes,'本地编辑');
  await assert.rejects(()=>r.tasks.handle({type:'AGENT_ACTION',action:'generate',id:r.store.records[0].id}),/配置模型|授权/);
 }
 console.log('PASS absent key/unconfirmed consent allows collection and manual edits, defers model analysis and rejects generation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
