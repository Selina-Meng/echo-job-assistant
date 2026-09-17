const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');const {runtime}=require('./agent-smoke.js');
(async()=>{
 const a={id:'a',url:'https://www.liepin.com/job/123.shtml',title:'采购',company:'甲公司',notes:'我的备注',greeting:'版本A',status:'面试中',sources:[{kind:'favorite',url:'favorite'}],statusHistory:[{status:'面试中',at:1}]};
 const b={...a,id:'b',url:a.url+'?tracking=1',notes:'另一备注',greeting:'版本B',status:'已投递',sources:[{kind:'search',url:'search'}],linkedConversationIds:['c'],statusHistory:[{status:'已投递',at:2}]};
 const other={...a,id:'other',url:'https://www.liepin.com/job/456.shtml'};
 const r=runtime({records:[a,b,other],conversations:[{id:'c',key:'c',linkedRecordId:'b',messages:[]}]});
 const preview=await r.tasks.handle({type:'AGENT_MERGE_RECORDS',ids:[],preview:true});
 assert.deepEqual(JSON.parse(JSON.stringify(preview.groups)),[['a','b']]);assert(preview.summary.includes('notes'));assert.equal(r.store.records.length,3);
 const before=structuredClone(r.store);
 await r.tasks.handle({type:'AGENT_MERGE_RECORDS',ids:[],stamp:preview.stamp});
 assert.equal(r.store.records.length,2);const merged=r.store.records.find(x=>x.id==='a');assert.equal(merged.notes,'我的备注');assert.equal(merged.greeting,'版本A');assert.equal(merged.status,'面试中');assert.equal(merged.sources.length,2);assert.equal(merged.statusHistory.length,2);assert.equal(merged.mergeHistory[0].records[1].greeting,'版本B');assert.equal(r.store.conversations[0].linkedRecordId,'a');
 const sync={};vm.runInNewContext(fs.readFileSync(require.resolve('../sync-data.js'),'utf8'),sync);const snapshot=sync.EchoSyncData.snapshot({...r.store,dailySummaries:[]});assert.equal(snapshot.records[0].mergeHistory[0].records[1].notes,'另一备注');
 await r.tasks.handle({type:'AGENT_UNDO_MERGE'});assert.deepEqual(r.store.records,before.records);assert.deepEqual(r.store.conversations,before.conversations);
 const preview2=await r.tasks.handle({type:'AGENT_MERGE_RECORDS',ids:[],preview:true});r.store.records[0].notes='编辑后';await assert.rejects(()=>r.tasks.handle({type:'AGENT_MERGE_RECORDS',ids:[],stamp:preview2.stamp}),/已变化/);assert.equal(r.store.records.length,3);
 const preview3=await r.tasks.handle({type:'AGENT_MERGE_RECORDS',ids:[],preview:true});await r.tasks.handle({type:'AGENT_MERGE_RECORDS',ids:[],stamp:preview3.stamp});r.store.conversations[0].linkedRecordId='other';await assert.rejects(()=>r.tasks.handle({type:'AGENT_UNDO_MERGE'}),/聊天关联已有修改/);assert.equal(r.store.conversations[0].linkedRecordId,'other');
 assert.throws(()=>r.C.mergeRecords([a,other],[],['a','other']),/标识不同/);assert.equal(r.C.recordKey({...a,platformJobKey:'liepin:456'}),'');
 const failure=runtime({records:[a,b]}, {}, {failSet:d=>!!d.recordsMergeUndo});const p=await failure.tasks.handle({type:'AGENT_MERGE_RECORDS',preview:true});const original=JSON.stringify(failure.store.records);await assert.rejects(()=>failure.tasks.handle({type:'AGENT_MERGE_RECORDS',stamp:p.stamp}),/写入失败/);assert.equal(JSON.stringify(failure.store.records),original);
 console.log('PASS exact IDs only, preview freshness, notes/drafts/history/source preservation, chat relink and undo, changed-link guard, failed storage and sync history. Synthetic tests.');
})().catch(e=>{console.error(e);process.exitCode=1});
