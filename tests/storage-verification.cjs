const assert=require('node:assert/strict');
const {runtime,settled}=require('./agent-smoke.js');
const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,reorder(value[k])])):value;
(async()=>{
 const job={title:'测试采购',company:'虚构招标代理公司',description:'招标项目管理',url:'https://www.liepin.com/job/123456.shtml',salary:'8-13k',hrActiveText:'在线',publishTimeText:'90天前更新'};
 let scores=0,matches=0;
 const r=runtime({settings:{apiKey:'mock',deepseekConsent:true,profile:'招标代理经历'}},{score:async()=>{scores++;return {job:{total:4},company:{total:4}};},json:async()=>{matches++;return {brief:'有依据的相关经历'};}},{activeUrl:job.url,storedTransform:reorder,reply:m=>m.type==='EXTRACT_JOB'?{ok:true,job}:{ok:true}});
 await r.tasks.handle({type:'AGENT_START',kind:'discover',currentJob:true});const task=await settled(r);
 assert.equal(task.status,'completed');assert.equal(task.stats.failed,0);
 assert.equal(r.store.records.length,1);assert.equal(scores,1);assert.equal(matches,1);assert(r.store.records[0].scores);
 const id=r.store.records[0].id;
 await r.tasks.handle({type:'AGENT_UPDATE_RECORD',id,patch:{notes:'保存备注'}});assert.equal(r.store.records[0].notes,'保存备注');
 await r.tasks.handle({type:'AGENT_START',kind:'discover',currentJob:true});await settled(r);assert.equal(r.store.records.length,1);assert.equal(scores,1);assert.equal(r.store.records[0].notes,'保存备注');
 const damaged=runtime({records:[{id:'r',title:'测试',company:'公司',notes:'原备注'}]},{},{storedTransform:d=>{if(d.records)d.records.forEach(x=>delete x.notes);return reorder(d);}});
 await assert.rejects(()=>damaged.tasks.handle({type:'AGENT_UPDATE_RECORD',id:'r',patch:{notes:'不可丢失'}}),e=>e.stage==='save'&&e.message.includes('保存后内容不一致'));
 const reversed=runtime({records:[{id:'a',title:'甲'},{id:'b',title:'乙'}]},{},{storedTransform:d=>{if(d.records)d.records.reverse();return d;}});
 await assert.rejects(()=>reversed.tasks.handle({type:'AGENT_UPDATE_RECORD',id:'a',patch:{notes:'测试'}}),/保存后内容不一致/);
 console.log('PASS reordered nested keys capture -> save -> automatic score/match, repeated capture cached, notes retained; real data loss and array order changes rejected. Synthetic page/model.');
})().catch(e=>{console.error(e);process.exitCode=1;});
