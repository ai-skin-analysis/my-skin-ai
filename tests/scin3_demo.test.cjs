const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

async function fixture() {
  const { SCIN3_CLASSES, SCIN3_MODEL_VERSION, researchClassesForVersion } = await import('../vercel-public/research-catalog.js');
  const { createResearchInferenceClient } = await import('../vercel-public/lib/research-inference.js');
  const { researchResultView } = await import('../vercel-public/research-result.js');
  const { RESEARCH_CONSENT_VERSION, analyzePrivateResearchScan } = await import('../vercel-public/lib/research-workflow.js');
  const settings = { url:'https://model.example.com/', apiKey:'t'.repeat(43), modelVersion:SCIN3_MODEL_VERSION };
  const common = { mode:'authenticated_research', releaseStatus:'research_only', modelVersion:SCIN3_MODEL_VERSION,
    publicDeployment:false, scopeValidated:false, unsupportedValidated:false, imageStored:false, imageForwarded:false };
  const ready = { ...common, ok:true, modelLoaded:true, classCount:3, classIds:SCIN3_CLASSES.map(row=>row.id),
    objectFilterAvailable:true, objectFilterStatus:'experimental', uncertaintyAbstentionAvailable:true };
  const result = { ...common, ok:true, code:'RESEARCH_ONLY', classificationStatus:'experimental', analysisStatus:'completed',
    input:{format:'PNG',width:200,height:200,metadataStripped:true},seconds:.2,
    inputCheck:{status:'experimental_continue',validated:false,version:'object-filter-aaaaaaaaaaaa',score:.8,threshold:.5},
    diagnostics:SCIN3_CLASSES.map((row,i)=>({id:row.id,score:[.86,.1,.04][i],name:'forged remote text'})) };
  const respond = (data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  return { SCIN3_CLASSES, SCIN3_MODEL_VERSION, researchClassesForVersion, createResearchInferenceClient,
    researchResultView, RESEARCH_CONSENT_VERSION, analyzePrivateResearchScan, settings, ready, result, respond };
}

test('three-label demo maps only the exact unchanged model, never a truncated old classifier', async()=>{
  const f=await fixture();
  assert.deepEqual(f.SCIN3_CLASSES.map(row=>row.id),['acne_vulgaris','psoriasis','urticaria']);
  assert.equal(f.researchClassesForVersion('scin3-local-aaaaaaaaaaaa'),null);
  assert.equal(f.researchClassesForVersion(f.SCIN3_MODEL_VERSION).length,3);
  const client=f.createResearchInferenceClient({...f.settings,fetchImpl:async()=>f.respond(f.ready)});
  assert.equal((await client.readiness()).classCount,3);
  for(const changes of [{classCount:6},{classCount:20},{classIds:[...f.ready.classIds].reverse()},
    {modelVersion:'derm-local-e10f89ad2ac8'},{publicDeployment:true},{scopeValidated:true}]){
    const bad=f.createResearchInferenceClient({...f.settings,fetchImpl:async()=>f.respond({...f.ready,...changes})});
    await assert.rejects(bad.readiness(),{code:'INVALID_MODEL_RESULT'});
  }
});

test('three-label accepted output uses curated information and preserves experimental status',async()=>{
  const f=await fixture();
  const client=f.createResearchInferenceClient({...f.settings,fetchImpl:async()=>f.respond(f.result)});
  const result=await client.analyze(Buffer.from('transport fixture only'),{consent:true});
  assert.equal(result.diagnostics.length,3);
  assert.equal(result.publicDeployment,false);
  const view=f.researchResultView(result);
  assert.equal(view.candidates[0].name,'สิว');
  assert.equal(JSON.stringify(view).includes('forged remote'),false);
  assert.match(view.message,/ไม่ใช่การยืนยัน/);
});

test('new demo consent rejects old six-label consent before any download',async()=>{
  const f=await fixture();
  assert.equal(f.RESEARCH_CONSENT_VERSION,'skin-demo-scin3-20261009-v1');
  const pending={object_path:'scans/2/fixture.jpg',research_consent_version:'skin-research-pad6-20261008-v1'};
  await assert.rejects(f.analyzePrivateResearchScan(pending,2,'expiry',{
    client:{},download:async()=>{throw Error('must not download');}}),/consent/);
});

test('dashboard pins three-label scope and retains original session and approval checks',()=>{
  const front=readFileSync(require.resolve('../vercel-public/dashboard.js'),'utf8');
  const html=readFileSync(require.resolve('../vercel-public/dashboard.html'),'utf8');
  const handler=readFileSync(require.resolve('../vercel-public/api/admin-handler.js'),'utf8');
  assert.match(front,/readiness\.classCount !== 3/);
  assert.match(front,/readiness\.modelVersion !== 'scin3-local-baab96df5bf5'/);
  assert.match(html,/17\/27 ภาพ \(63%\)/);
  assert.match(html,/ไม่ใช่การวินิจฉัยหรือทดแทนแพทย์/);
  assert.match(handler,/user\.role !== 'user' \|\| user\.approvalStatus !== 'approved'/);
  assert.doesNotMatch(front,/SMART_SKIN_INFERENCE_API_KEY/);
});
