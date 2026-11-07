/* State/async regression tests: real client functions, no browser or network. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function setup(fetcher=async()=>({}), storage={getItem(){return '';}}) {
  const nodes=new Map();
  function element() {
    const attrs=new Map(),listeners=new Map();
    return {value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,checked:false,scrollTop:0,
      readyState:0,duration:100,currentTime:0,paused:false,plays:0,listeners,
      dataset:{},classList:{add(){},remove(){},toggle(){},contains(){return false;}},
      setAttribute(k,v){attrs.set(k,v);},getAttribute(k){return attrs.get(k) ?? null;},removeAttribute(k){attrs.delete(k);},
      get src(){return attrs.get('src');},set src(v){attrs.set('src',v);},
      pause(){this.paused=true;},load(){},async play(){this.plays++;this.paused=false;},
      addEventListener(k,v){listeners.set(k,v);},removeEventListener(k,v){if(listeners.get(k)===v)listeners.delete(k);},
      scrollIntoView(){},querySelector(){return element();},showModal(){},reset(){}};
  }
  const doc={body:element(),querySelector(selector){if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);},querySelectorAll(){return [];}};
  const context=vm.createContext({document:doc,window:{},sessionStorage:storage,
    fetch:async url=>({ok:true,json:async()=>fetcher(url)}),setTimeout(){return 1;},clearTimeout(){},
    matchMedia(){return {matches:true};},console});
  const source=fs.readFileSync(path.join(__dirname,'../frontend/app.js'),'utf8').split("document.addEventListener('click'")[0];
  vm.runInContext(source+'\nglobalThis.hooks={api,state,offsetSeconds,selectConversation,filterConversations,loadData,seekProof,resetAudio,openAppeal,collectEditor,renderDetail,analyticsSummary,evaluationDeductions,setWorkspaceView,readUploadFile,showJsonConversation,rememberJsonConversation,openUpload};',context);
  const h=context.hooks;
  h.state.checklist={version:1,criteria:[]};h.state.budget={remaining:0,limit:3,configured:true};
  return {h,doc,nodes,context};
}
function record(id='a',language='RU',audio=null) {
  return {conversation_id:id,language,channel:audio?'voice call':'agent chat',audio_url:audio,status:'Pending',evaluation:null,appeals:[],
    transcript:[{timestamp:'00:30',text:'Question',speaker:'client'},{timestamp:'00:40',text:'Answer',speaker:'operator'}]};
}
function item(r) {return {id:r.conversation_id,language:r.language,channel:r.channel,status:r.status,preview:'Question',pending_appeals:0};}
function deferred() {let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('audio offsets are relative for both timestamp formats',()=>{
  const {h}=setup();
  assert.equal(h.offsetSeconds('01:10','00:30'),40);
  assert.equal(h.offsetSeconds('01:00:10','01:00:00'),10);
  assert.equal(h.offsetSeconds('2026-11-03T13:00:30Z','2026-11-03T13:00:00Z'),30);
  assert.equal(h.offsetSeconds('99:99','00:00'),0);
});
test('empty filter clears the previous voice, title, and assessment',async()=>{
  const {h,doc}=setup();const r=record('a','RU','/audio');h.state.items=[item(r)];h.state.detail=r;h.state.selected='a';
  doc.querySelector('#audio').src='/audio';doc.querySelector('#language').value='EN';
  await h.filterConversations();
  assert.equal(h.state.detail,null);assert.equal(h.state.selected,null);
  assert.equal(doc.querySelector('#audio').paused,true);assert.equal(doc.querySelector('#audio').getAttribute('src'),null);
  assert.equal(doc.querySelector('#conversation-title').textContent,'Выберите диалог');
  assert.equal(doc.querySelector('#score-panel').innerHTML,'');
});
test('filter selects a matching conversation automatically',async()=>{
  const en=record('english','EN');const {h,doc}=setup(async()=>en);
  h.state.items=[item(record()),item(en)];h.state.detail=record();h.state.selected='a';
  doc.querySelector('#language').value='EN';await h.filterConversations();
  assert.equal(h.state.selected,'english');assert.equal(h.state.detail.language,'EN');
});
test('late conversation response cannot replace the newest selection',async()=>{
  const a=deferred(),b=deferred();const {h,doc}=setup(url=>url.endsWith('/a')?a.promise:b.promise);
  h.state.items=[item(record('a')),item(record('b'))];
  const first=h.selectConversation('a');const second=h.selectConversation('b');
  assert.equal(h.state.detail,null);assert.equal(doc.querySelector('#conversation-title').textContent,'Загрузка…');
  b.resolve(record('b'));await second;a.resolve(record('a'));await first;
  assert.equal(h.state.detail.conversation_id,'b');assert.equal(h.state.selected,'b');
});
test('refresh reruns an active transcript search instead of using old matching IDs',async()=>{
  const r=record('new');const list={items:[item(r)],total:1,evaluated:0,group:'TEST',budget:{remaining:0,limit:3,configured:true}};
  const {h,doc}=setup(async url=>url==='/api/conversations'?list:url.startsWith('/api/conversations?')?{items:[item(r)]}:
    url==='/api/checklist'?{version:1,criteria:[]}:url==='/api/health'?{auth_mode:'local-demo'}:r);
  h.state.searchIds=new Set(['old']);doc.querySelector('#search').value='needle';
  await h.loadData();assert.equal(h.state.selected,'new');
});
test('pending audio seek is cancelled when another conversation is selected',async()=>{
  const {h,doc}=setup();h.state.detail=record('a','RU','/audio');
  await h.seekProof(1);const audio=doc.querySelector('#audio'),callback=audio.listeners.get('loadedmetadata');
  assert.ok(callback);h.resetAudio();h.state.detail=record('b','RU','/other');await callback();
  assert.equal(audio.plays,0);assert.equal(audio.listeners.has('loadedmetadata'),false);
});
test('only the latest proof click can start audio',async()=>{
  const {h,doc}=setup();h.state.detail=record('a','RU','/audio');
  const audio=doc.querySelector('#audio');await h.seekProof(0);const old=audio.listeners.get('loadedmetadata');
  await h.seekProof(1);const latest=audio.listeners.get('loadedmetadata');await old();assert.equal(audio.plays,0);
  await latest();assert.equal(audio.currentTime,10);assert.equal(audio.plays,1);
});
test('appeal remains attached to the assessment shown when the form opened',()=>{
  const {h}=setup();const r=record('a');r.evaluation={id:'eval-a',criteria:[{criterion_id:'01',name:'Contact'}]};h.state.detail=r;
  h.openAppeal('01');h.state.detail=record('b');
  assert.equal(h.state.appealTarget.conversation_id,'a');assert.equal(h.state.appealTarget.evaluation_id,'eval-a');
});
test('manual decision is shown first and previous explanation is collapsed',()=>{
  const {h,doc}=setup();const r=record();r.status='Evaluated';
  r.evaluation={id:'e',final_score:90,criteria:[{criterion_id:'01',type:'binary',name:'Contact',value:0,is_na:false,
    reason:'OLD REASON',override_comment:'CURRENT DECISION',weight:10,normalized_weight:10,earned_score:0,proof_message_index:0,proof_timestamp:'00:30',proof_quote:'Question'}]};
  h.state.detail=r;h.renderDetail();const html=doc.querySelector('#criteria').innerHTML;
  assert.ok(html.indexOf('CURRENT DECISION')<html.indexOf('OLD REASON'));
  assert.ok(html.includes('<summary>Предыдущее обоснование</summary>'));
});
test('late search results do not replace newer search results',async()=>{
  const a=deferred(),b=deferred(),ra=record('a'),rb=record('b');
  const {h,doc}=setup(url=>url.includes('search=first')?a.promise:url.includes('search=second')?b.promise:rb);
  h.state.items=[item(ra),item(rb)];doc.querySelector('#search').value='first';const first=h.filterConversations();
  doc.querySelector('#search').value='second';const second=h.filterConversations();
  b.resolve({items:[item(rb)]});await second;a.resolve({items:[item(ra)]});await first;
  assert.equal(h.state.selected,'b');assert.equal(h.state.filtered.length,1);assert.equal(h.state.filtered[0].id,'b');
});
test('turning off N/A does not erase its condition from the editor',()=>{
  const {h,doc}=setup();const values={id:'01',name:'Criterion',description:'Rule',type:'binary',weight:'10',max_scale:'1',levels:'',na_condition:'Keep this condition'};
  const fields=Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value}]));fields.allow_na={checked:false};
  doc.querySelectorAll=selector=>selector==='.editor-criterion'?[{querySelector:s=>fields[s.match(/data-field="(.*?)"/)[1]]}]:[];
  h.collectEditor();assert.equal(h.state.edit[0].allow_na,false);assert.equal(h.state.edit[0].na_condition,'Keep this condition');
});
test('blocked browser storage does not prevent client startup',()=>{
  const {h}=setup(async()=>({}),{getItem(){throw new Error('storage blocked');}});
  assert.equal(h.state.token,'');
});
test('form errors are readable and do not expose English validation internals',async()=>{
  const {h,context}=setup();
  context.fetch=async()=>({ok:false,status:422,json:async()=>({detail:[{msg:'Input should be a valid number'}]})});
  await assert.rejects(h.api('/api/checklist'),{message:'Проверьте заполненные поля.'});
  context.fetch=async()=>({ok:false,status:422,json:async()=>({detail:[{msg:'Value error, Укажите ступени шкалы'}]})});
  await assert.rejects(h.api('/api/checklist'),{message:'Укажите ступени шкалы'});
});
test('network failures give a recoverable message',async()=>{
  const {h,context}=setup();context.fetch=async()=>{throw new TypeError('Failed to fetch');};
  await assert.rejects(h.api('/api/conversations'),{message:'Нет соединения с сервером. Попробуйте ещё раз.'});
});
test('analytics separates unevaluated, stale and scoreless records',()=>{
  const {h}=setup();
  const summary=h.analyticsSummary([
    {language:'RU',channel:'agent chat',status:'Evaluated',score:80},
    {language:'KZ',channel:'agent chat',status:'Evaluated',score:92.31},
    {language:'EN',channel:'agent chat',status:'Pending',score:null},
    {language:'RU',channel:'voice call',status:'Stale',score:10,has_gross_violation:true},
    {language:'EN',channel:'voice call',status:'Evaluated',score:0,has_gross_violation:true},
    {language:'KZ',channel:'agent chat',status:'Evaluated',score:null}
  ]);
  assert.equal(summary.total,6);assert.equal(summary.checked,4);assert.equal(summary.violations,1);
  assert.ok(Math.abs(summary.average-172.31/3)<1e-9);
  assert.deepEqual(Array.from(summary.buckets,r=>r.count),[1,0,2]);
  assert.equal(summary.languages[1].checked,2);assert.equal(summary.languages[1].average,92.31);
  assert.equal(summary.languages[2].average,0);
});
test('no evaluations do not produce a fake zero average',()=>{
  const {h}=setup();const summary=h.analyticsSummary([{language:'RU',channel:'agent chat',status:'Pending',score:null}]);
  assert.equal(summary.average,null);assert.equal(summary.checked,0);
  assert.deepEqual(Array.from(summary.buckets,r=>r.count),[0,0,0]);
});
test('deduction summary excludes N/A, full points, zero weights and flags',()=>{
  const {h}=setup();const summary=h.evaluationDeductions({criteria:[
    {criterion_id:'1',type:'binary',is_na:false,normalized_weight:10,earned_score:0},
    {criterion_id:'2',type:'scale',is_na:false,normalized_weight:30,earned_score:21},
    {criterion_id:'3',type:'scale',is_na:true,normalized_weight:0,earned_score:0},
    {criterion_id:'4',type:'binary',is_na:false,normalized_weight:20,earned_score:20},
    {criterion_id:'5',type:'flag',is_na:false,normalized_weight:0,earned_score:0},
    {criterion_id:'6',type:'binary',is_na:false,normalized_weight:0,earned_score:0}
  ]});
  assert.deepEqual(Array.from(summary,r=>r.loss),[10,9]);
});
test('operator navigation cannot open supervisor analytics',async()=>{
  const {h,doc}=setup();h.state.role='operator';await h.setWorkspaceView('analytics');
  assert.equal(h.state.view,'conversations');assert.equal(doc.querySelector('#page-title').textContent,'Диалоги');
});


function uploadForm(doc) {
  const form=doc.querySelector('#upload-form');
  form.elements=Object.fromEntries(['title','text','language','channel'].map(key=>[key,{value:''}]));
  return form;
}
test('JSON selection preserves explicit evidence until the user edits the text',async()=>{
  const transcript=[{speaker:'client',text:'A\nOperator: quoted words',timestamp:'00:01'},{speaker:'operator',text:'B',timestamp:'00:04'}];
  const items=[{title:'First',text:'Client: A\nOperator: B',language:'RU',channel:'agent chat',transcript},
               {title:'Second',text:'Client: C\nOperator: D',language:'EN',channel:'voice call',transcript}];
  const {h,doc}=setup(async()=>({conversations:items}));const form=uploadForm(doc);
  await h.readUploadFile({name:'file.json',size:100});
  assert.equal(form.elements.title.value,'First');assert.equal(doc.querySelector('#upload-json-choice').hidden,false);
  h.rememberJsonConversation();assert.deepEqual(items[0].transcript,transcript);
  form.elements.text.value='Client: Edited\nOperator: B';form.elements.title.value='Renamed';h.rememberJsonConversation();
  assert.equal(items[0].transcript,undefined);
  h.showJsonConversation(1);assert.equal(form.elements.language.value,'EN');
  h.showJsonConversation(0);assert.equal(form.elements.title.value,'Renamed');assert.match(form.elements.text.value,/Edited/);
});
test('opening a new upload rejects a late response from the previous file',async()=>{
  const pending=deferred();const {h,doc}=setup(()=>pending.promise);const form=uploadForm(doc);
  const reading=h.readUploadFile({name:'old.json',size:100});h.openUpload();form.elements.text.value='New draft';
  pending.resolve({conversations:[{title:'Old',text:'Old data',language:'RU',channel:'agent chat'}]});await reading;
  assert.equal(form.elements.text.value,'New draft');
});
