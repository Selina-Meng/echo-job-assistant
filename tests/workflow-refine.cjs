const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const scope = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../workflow.js'), 'utf8'), scope);
const context = {job:{description:'内容 Agent 产品，重视用户理解和内容质量'},profile:'我定义需求和验收标准，与 AI 协作实现求职助手。'};
const strategy = {goal:'用协作项目说明产品判断',highlights:[{label:'产品实践',jobRequirement:context.job.description,candidateEvidence:context.profile,relevance:'需求定义及验收对应用户理解和内容质量'}]};
const draft = {greeting:'我独立完成了整个系统的开发。'};
const corrected = {greeting:'我与 AI 协作实现求职助手，负责需求定义、内容判断与验收，希望交流。'};
const checks = Object.fromEntries(['jdMatch','personalization','truthfulness','conciseness','naturalness'].map(k=>[k,{pass:true,reason:'模拟通过',refine:''}]));
const rejected = {checks:{...checks,truthfulness:{pass:false,reason:'档案只支持协作开发',refine:'把独立开发改为与 AI 协作，明确负责需求与验收'}}};
function model(responses) {
  const calls=[];
  return {calls,json:async(system,user)=>{calls.push({system,user});const r=responses[calls.length-1];if(r instanceof Error)throw r;assert(r,'unexpected extra model call');return JSON.parse(JSON.stringify(r));}};
}
async function main(){
  for (const invalid of [{goal:'空策略'}, {...strategy,highlights:Array(4).fill(strategy.highlights[0])}, {...strategy,highlights:[{label:'没有依据'}]}]) {
    const rejected=model([invalid]);
    await assert.rejects(()=>scope.ContentWorkflow.run(rejected.json,context),/策略/);
    assert.equal(rejected.calls.length,1);
  }
  const paired=model([strategy,corrected,{checks:{...checks,naturalness:{pass:true,reason:'真实自然',polish:'也可改个结尾'}}}]);
  const pairedResult=await scope.ContentWorkflow.run(paired.json,context);
  assert.equal(paired.calls.length,3);
  assert.equal(pairedResult.workflow.strategy.focus[0],context.job.description);
  assert(paired.calls[1].user.includes('需求定义及验收对应'));
  assert(paired.calls[2].user.includes('待核对的选材计划（非事实来源）'));
  assert.equal(pairedResult.workflow.evaluation.refine.length,0);
  assert.equal(pairedResult.workflow.evaluation.checks.naturalness.polish,'也可改个结尾');
  const old={greeting:'旧草稿',workflow:{strategy:{goal:'旧策略',matchedEvidence:[context.profile]},evaluation:{refine:['改自然']}}};
  const legacy=model([corrected,{checks}]);
  assert((await scope.ContentWorkflow.run(legacy.json,context,'greeting',{previous:old})).greeting);
  assert.equal(legacy.calls.length,2);
  const legacyPreference='只输出 JSON：{"greeting":"旧版成品","keywords":[]}';
  for (const mode of ['greeting','reply']) {
    const isolated=model([strategy,corrected,{checks}]);
    await scope.ContentWorkflow.run(isolated.json,{...context,preferences:legacyPreference},mode,{autoRefine:false});
    assert(!isolated.calls[0].user.includes('旧版成品'));
    assert(isolated.calls[1].user.includes('旧版成品'));
    assert(!isolated.calls[2].user.includes('旧版成品'));
  }
  const fixed=model([strategy,draft,rejected,corrected,{checks}]);
  const result=await scope.ContentWorkflow.run(fixed.json,context);
  assert.equal(fixed.calls.length,5);
  assert.equal(result.workflow.evaluation.passed,true);
  assert.equal(result.workflow.revision.originalDraft,draft.greeting);
  assert.equal(result.workflow.revision.outcome,'passed');
  assert(fixed.calls[3].user.includes(draft.greeting));
  assert(fixed.calls[3].user.includes('把独立开发改为与 AI 协作'));
  assert(fixed.calls[4].user.includes(corrected.greeting));
  assert(!fixed.calls[4].user.includes(draft.greeting)); // Evaluator checks the current draft.
  const stillBad=model([strategy,draft,rejected,draft,rejected]);
  await assert.rejects(()=>scope.ContentWorkflow.run(stillBad.json,context),error=>{
    assert.equal(error.result.workflow.evaluation.passed,false);
    assert.equal(error.result.workflow.revision.attempts,1);
    return /已尝试修改一次/.test(error.message);
  });
  assert.equal(stillBad.calls.length,5);
  const offline=model([strategy,draft,rejected,new Error('网络断开')]);
  await assert.rejects(()=>scope.ContentWorkflow.run(offline.json,context),error=>{
    assert.equal(error.result.greeting,draft.greeting);
    assert.equal(error.result.workflow.evaluation.passed,false);
    return /网络断开/.test(error.message);
  });
  const incomplete=model([strategy,draft,{checks:{}}]);
  await assert.rejects(()=>scope.ContentWorkflow.run(incomplete.json,context),/质量检查格式不完整/);
  assert.equal(incomplete.calls.length,3);
  const missing=model([strategy,draft,{checks}]);
  await assert.rejects(()=>scope.ContentWorkflow.run(missing.json,{...context,job:{}}),/补充 JD/);
  assert.equal(missing.calls.length,3);
  const exposed={greeting:'想进一步了解出差频率及工作地点是否可协调，期待您的回复。'};
  const guarded=model([strategy,exposed,{checks},corrected,{checks}]);
  const guardedResult=await scope.ContentWorkflow.run(guarded.json,context);
  assert.equal(guardedResult.workflow.evaluation.passed,true);assert.equal(guarded.calls.length,5);
  assert(guarded.calls[3].user.includes('删除地点、加班、出差协商'));
  const reply=model([strategy,draft,rejected,corrected,{checks}]);
  await scope.ContentWorkflow.run(reply.json,{...context,messages:[{role:'hr',text:'项目中哪些是你负责的？'}]},'reply');
  assert(reply.calls[3].system.includes('当前聊天的回复'));
  assert(reply.calls[3].user.includes('项目中哪些是你负责的'));
  console.log('workflow refinement passed: corrected draft, bounded failure, retained draft, missing data, greeting guard, evaluator failure, reply context');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
