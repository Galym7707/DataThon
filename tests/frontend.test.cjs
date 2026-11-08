/* State/async regression tests: real client functions, no browser or network. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

test('evaluation API preserves the safe validation reason instead of a generic 502',async()=>{
  const {h,context}=setup();
  const reason='Цитата ИИ не совпала с текстом указанных реплик. Оценка не сохранена.';
  context.fetch=async()=>response({detail:reason},502);
  await assert.rejects(h.api('/api/evaluate/a'),error=>error.message===reason&&error.status===502);
});

test('failed evaluation keeps a visible reason and retry action after refresh',()=>{
  const {h,doc}=setup(),r=record();r.status='Error';r.evaluation_error={code:'evidence_quote_mismatch',message:'Цитата <script>private</script> не совпала'};
  h.state.detail=r;h.state.role='supervisor';h.state.budget={configured:true,unlimited:true};h.renderDetail();
  const panel=doc.querySelector('#score-panel').innerHTML;
  assert.match(panel,/Последняя проверка не завершена/);assert.match(panel,/Повторить проверку/);
  assert.match(panel,/Оценка не выставлена/);assert.doesNotMatch(panel,/Готов к проверке|<script>/);
  assert.match(panel,/&lt;script&gt;/);
});

test('evaluation error explanation translates while previous valid score remains available',()=>{
  const {h,doc,context}=setup(),{i18n}=localization('en');context.window.CQA_I18N=i18n;
  const r=practiceRecord();r.evaluation_error={code:'evidence_quote_mismatch',message:'Цитата ИИ не совпала с текстом указанных реплик. Оценка не сохранена.'};h.state.detail=r;h.renderDetail();
  const panel=doc.querySelector('#score-panel').innerHTML;
  assert.match(panel,/The last evaluation did not complete/);assert.match(panel,/The AI quote did not match/);
  assert.match(panel,/score-ring/);assert.equal(r.evaluation.final_score,practiceRecord().evaluation.final_score);
});

function setup(fetcher=async()=>({}), storage={getItem(){return '';}}, {realReview=false}={}) {
  const nodes=new Map();
  function element() {
    const attrs=new Map(),listeners=new Map();
    return {value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,checked:false,scrollTop:0,
      readyState:0,duration:100,currentTime:0,paused:false,plays:0,listeners,
      elements:{comment:{value:'',disabled:false,focus(){}}},focus(){},dataset:{},classList:{add(){},remove(){},toggle(){},contains(){return false;}},
      setAttribute(k,v){attrs.set(k,v);},getAttribute(k){return attrs.get(k) ?? null;},removeAttribute(k){attrs.delete(k);},
      get src(){return attrs.get('src');},set src(v){attrs.set('src',v);},
      pause(){this.paused=true;},load(){},async play(){this.plays++;this.paused=false;},
      addEventListener(k,v){listeners.set(k,v);},removeEventListener(k,v){if(listeners.get(k)===v)listeners.delete(k);},
      scrollIntoView(){},querySelector(){return element();},showModal(){this.open=true;},close(){this.open=false;},reset(){}};
  }
  const doc={body:element(),querySelector(selector){if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);},querySelectorAll(){return [];}};
  const context=vm.createContext({document:doc,window:{},sessionStorage:storage,
    fetch:async url=>({ok:true,json:async()=>fetcher(url)}),setTimeout(){return 1;},clearTimeout(){},
    matchMedia(){return {matches:true};},console});
  const source=fs.readFileSync(path.join(__dirname,'../frontend/app.js'),'utf8').split("document.addEventListener('click'")[0];
  vm.runInContext(source+'\nglobalThis.hooks={api,state,selectDatasetGroup,renderDatasetTabs,renderAnalytics,applyDatasetScope,offsetSeconds,selectConversation,filterConversations,loadData,seekProof,resetAudio,openAppeal,collectEditor,renderDetail,analyticsSummary,evaluationDeductions,setWorkspaceView,readUploadFile,showJsonConversation,rememberJsonConversation,openUpload,showGrossConversations,importUpload,displayTime,ui,renderCoaching,openPractice,submitPractice,clearPractice,updatePracticeControls,applyRole,submitAppeal,selectAppealCriterion,closeAppealSession,appealableCriteria,criterionAppealAction,updateBudget,actions,hasAiBudget,reviewAI,prepareAIReview,confirmAIReview,endAIReview,renderAIReview,applyPrivacy,externalBlocked,evaluateSelected,submitBatch,submitAssistant,applyAssistantResult,refreshAssistantFilter,clearFilter,clearAllFilters,renderAssistant,renderAssistantResult,normalAssistantFilters,openAssistantSource,setDetailView};',context);
  // Legacy action tests isolate the review step; dedicated tests below exercise its real implementation.
  if(!realReview)vm.runInContext("reviewAI=async()=>({preview_id:'test-approved',requests:[]})",context);
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
  const {h}=setup();const r=practiceRecord('a');h.state.role='operator';h.state.detail=r;
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


test('gross-error filter uses current flags, clears stale detail and keeps zero scores',async()=>{
  const a=record('gross'),b=record('old'),c=record('pending');a.status='Evaluated';
  const {h,doc}=setup(()=>a);
  h.state.items=[{...item(a),has_gross_violation:true,score:0},{...item(b),status:'Stale',has_gross_violation:true},
                 {...item(c),has_gross_violation:true}];
  doc.querySelector('#gross-only').checked=true;
  await h.filterConversations();
  assert.deepEqual(Array.from(h.state.filtered,r=>r.id),['gross']);assert.equal(h.state.selected,'gross');
  doc.querySelector('#language').value='EN';await h.filterConversations();
  assert.equal(h.state.selected,null);assert.equal(h.state.detail,null);
  assert.match(doc.querySelector('#conversation-list').innerHTML,/По выбранным условиям/);
});
test('gross-error summary puts exact reason and evidence before all criteria',()=>{
  const {h,doc}=setup();const r=record();r.status='Evaluated';
  r.evaluation={final_score:80,has_gross_violation:true,criteria:[{criterion_id:'08',name:'Грубые ошибки',type:'flag',value:1,
    reason:'TEST REASON',override_comment:'MANUAL REASON',proof_message_index:1,proof_timestamp:'00:40',proof_quote:'Answer'}]};
  h.state.detail=r;h.renderDetail();
  assert.equal(doc.querySelector('#violations').hidden,false);
  assert.match(doc.querySelector('#violations').innerHTML,/MANUAL REASON/);
  assert.match(doc.querySelector('#violations').innerHTML,/data-proof="1"/);
  r.evaluation.criteria[0].value=0;h.renderDetail();assert.equal(doc.querySelector('#violations').hidden,true);
});


function localization(initial='ru') {
  const saved=new Map([['freedom-cqa-language',initial]]);
  const context=vm.createContext({window:{dispatchEvent(){}},document:{documentElement:{},querySelectorAll(){return[];}},
    localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},Event:class{}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../frontend/i18n.js'),'utf8'),context);
  return {i18n:context.window.CQA_I18N,saved};
}
test('every translation has all three languages and never modifies HTML structure',()=>{
  const {i18n}=localization();
  for(const [key,value] of Object.entries(i18n.dictionary)) {
    assert.ok(key.trim());for(const locale of ['ru','kk','en'])assert.equal(typeof value[locale],'string');
  }
  i18n.set('en');assert.equal(i18n.t('<div class="empty">Диалоги не найдены</div>'),'<div class="empty">No conversations found</div>');
  assert.equal(i18n.t('/api/conversations?filename=test.png'),'/api/conversations?filename=test.png');
  i18n.set('kk');assert.equal(i18n.t('Диалоги'),'Диалогтар');
});
test('language switch persists and trusted templates preserve conversation evidence',()=>{
  const {i18n,saved}=localization();const {h,context,doc}=setup();context.window.CQA_I18N=i18n;
  i18n.set('en');assert.equal(saved.get('freedom-cqa-language'),'en');
  const evidence='Клиент сказал: Нет оценки ИИ';
  assert.equal(h.ui(['<span>Клиент</span><p>','</p>'],evidence),'<span>Customer</span><p>'+evidence+'</p>');
  h.state.detail=record();h.state.detail.transcript[0].text=evidence;h.renderDetail();
  assert.match(doc.querySelector('#transcript').innerHTML,/Клиент сказал: Нет оценки ИИ/);
  assert.match(doc.querySelector('#transcript').innerHTML,/Customer/);
  assert.equal(h.displayTime('Реплика 3'),'Message 3');
  i18n.set('kk');assert.equal(h.displayTime('Реплика 3'),'Реплика 3');
});
test('image import requires review and submits the corrected text without a model call',async()=>{
  const {h,doc,context}=setup(async()=>({text:'raw image text',source:'image',ocr:{review_required:true}}));const form=uploadForm(doc);
  await h.readUploadFile({name:'chat.png',size:100});
  assert.equal(form.elements.text.value,'raw image text');assert.equal(doc.querySelector('#upload-ocr-notice').hidden,false);
  let requests=0;context.fetch=async(url,options)=>{requests++;assert.equal(url,'/api/conversations/import');
    const payload=JSON.parse(options.body);assert.equal(payload.text,'Client: corrected\nOperator: reply');assert.equal(payload.language,'KZ');
    return{ok:false,status:422,json:async()=>({detail:'test-stop'})};};
  await h.importUpload(form);assert.equal(requests,0);
  assert.match(doc.querySelector('#upload-error').textContent,/Подтвердите/);
  form.elements.text.value='Client: corrected\nOperator: reply';form.elements.language.value='KZ';doc.querySelector('#upload-reviewed').checked=true;
  await h.importUpload(form);assert.equal(requests,1);
});
test('common image and JSON errors are localized without obscuring message numbers',()=>{
  const {i18n}=localization('en');
  assert.equal(i18n.t('Строка 12: начните реплику с «Клиент:» или «Оператор:».'),'Line 12: start each message with “Client:” or “Operator:”.');
  assert.doesNotMatch(i18n.t('Не удалось прочитать JSON. Проверьте скобки, запятые и кодировку файла.'),/[А-Яа-я]/);
  assert.doesNotMatch(i18n.t('На изображении не найден текст. Загрузите чёткий скриншот переписки.'),/[А-Яа-я]/);
});


function practiceRecord(id='a') {
  const r=record(id);r.status='Evaluated';
  r.evaluation={id:'eval-'+id,final_score:70,criteria:[{criterion_id:'01',name:'Установление контакта',type:'binary',value:0,is_na:false,
    normalized_weight:10,earned_score:0,reason:'Original issue',proof_message_index:1,proof_timestamp:'00:40',proof_quote:'Answer'}]};
  r.coaching=[{criterion_id:'01',name:'Установление контакта',source:'rule',recommendation:'Начните ответ с приветствия на языке клиента и представьтесь.',
    task:'Напишите первое сообщение клиенту: поздоровайтесь и представьтесь.'}];
  return r;
}
function exercise(id='a',attempts=[]) {
  return {exercise_key:id.repeat(64),evaluation_id:'eval-'+id,criterion:{id:'01',name:'Установление контакта',description:'Original rule'},
    recommendation:'Начните ответ с приветствия на языке клиента и представьтесь.',task:'Напишите первое сообщение клиенту: поздоровайтесь и представьтесь.',
    source:'rule',issue:'Original issue',target_message_index:1,
    context:[{index:0,speaker:'client',text:'Original customer text',timestamp:'00:30'},{index:1,speaker:'operator',text:'Original agent text',timestamp:'00:40'}],
    attempts,budget:{remaining:3,limit:3,configured:true}};
}
function practiceAttempt(answer='Hello, I am Aida.') {
  return {id:'attempt-1',answer,status:'NEEDS_WORK',worked:['Clear wording'],improve:['Introduce your role'],why:'The rule requires an introduction.',
    created_at:'2026-11-07T08:00:00Z',feedback_language:'ru'};
}
test('both roles see recommendations but only the operator sees the practice action',()=>{
  const {h,doc}=setup();h.state.detail=practiceRecord();
  h.state.role='operator';h.renderDetail();assert.doesNotMatch(doc.querySelector('#criteria').innerHTML,/Отработать навык/);
  assert.match(doc.querySelector('#deductions').innerHTML,/Отработать навык/);
  assert.match(doc.querySelector('#deductions').innerHTML,/Начните ответ с приветствия/);
  h.state.role='supervisor';h.renderDetail();assert.doesNotMatch(doc.querySelector('#deductions').innerHTML,/Отработать навык/);
  assert.match(doc.querySelector('#deductions').innerHTML,/Начните ответ с приветствия/);
  assert.doesNotMatch(doc.querySelector('#criteria').innerHTML,/Отработать навык/);
  const c=h.state.detail.evaluation.criteria[0];c.value=1;assert.equal(h.renderCoaching(c),'');
  c.value=0;c.is_na=true;assert.equal(h.renderCoaching(c),'');
  c.is_na=false;h.state.detail.status='Stale';assert.equal(h.renderCoaching(c),'');
});
test('fallback advice is visibly labelled as rule based and translated',()=>{
  const {h,context}=setup();h.state.detail=practiceRecord();h.state.role='supervisor';
  const criterion=h.state.detail.evaluation.criteria[0];
  assert.match(h.renderCoaching(criterion),/На основе правил/);
  context.window.CQA_I18N=localization('en').i18n;
  assert.doesNotMatch(h.renderCoaching(criterion),/[А-Яа-я]/);
  h.state.detail.coaching[0].source='ai';context.window.CQA_I18N=undefined;
  assert.doesNotMatch(h.renderCoaching(criterion),/На основе правил/);
});
test('opening practice only reads data and late responses cannot replace the newest exercise',async()=>{
  const a=deferred(),b=deferred(),paths=[];
  const {h,doc}=setup(url=>{paths.push(url);return url.includes('/a/')?a.promise:b.promise;});
  h.state.detail=practiceRecord('a');const first=h.openPractice('01');
  h.state.detail=practiceRecord('b');const second=h.openPractice('01');
  b.resolve(exercise('b'));await second;a.resolve(exercise('a'));await first;
  assert.equal(h.state.practice.conversationId,'b');assert.equal(h.state.practice.data.exercise_key,'b'.repeat(64));
  assert.deepEqual(paths,['/api/practice/a/01','/api/practice/b/01']);
  assert.equal(doc.querySelector('#practice-submit').disabled,true);
});
test('closed practice and a role change ignore pending GET responses',async()=>{
  const pending=deferred();const {h,doc}=setup(()=>pending.promise);h.state.detail=practiceRecord();
  const loading=h.openPractice('01');h.clearPractice();pending.resolve(exercise());await loading;assert.equal(h.state.practice,null);
  const next=deferred();const other=setup(()=>next.promise);other.h.state.detail=practiceRecord();
  const opening=other.h.openPractice('01');other.h.state.role='operator';other.h.applyRole();next.resolve(exercise());await opening;
  assert.equal(other.h.state.practice,null);assert.equal(other.doc.querySelector('#practice-dialog').open,false);
});
test('practice keeps target IDs, blocks double submission and leaves the original evaluation unchanged',async()=>{
  const {h,doc,context}=setup(()=>exercise());h.state.detail=practiceRecord();await h.openPractice('01');
  const originalScore=h.state.detail.evaluation.final_score,pending=deferred(),requests=[];
  context.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return pending.promise;};
  doc.querySelector('#practice-answer').value='Hello, I am Aida.';
  const first=h.submitPractice(),second=h.submitPractice();await second;
  assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/practice/a/01');
  assert.equal(requests[0].body.evaluation_id,'eval-a');assert.equal(requests[0].body.exercise_key,'a'.repeat(64));
  assert.match(requests[0].body.request_id,/^[a-f0-9-]{36}$/);
  h.state.selected='b';pending.resolve({ok:true,json:async()=>({attempt:practiceAttempt(),cached:false,budget:{remaining:2,limit:3,configured:true}})});await first;
  assert.equal(h.state.practice.data.attempts.length,1);assert.equal(h.state.detail.evaluation.final_score,originalScore);
  assert.equal(h.state.busy,false);assert.equal(h.state.budget.remaining,2);
  assert.match(doc.querySelector('#practice-feedback').innerHTML,/Что получилось/);assert.match(doc.querySelector('#practice-feedback').innerHTML,/Hello, I am Aida/);
});
test('closing while a check runs preserves draft and avoids attaching feedback to another exercise',async()=>{
  const {h,doc,context}=setup(()=>exercise());h.state.detail=practiceRecord();await h.openPractice('01');
  const pending=deferred();context.fetch=async()=>pending.promise;doc.querySelector('#practice-answer').value='Draft remains';
  const checking=h.submitPractice();await new Promise(resolve=>setImmediate(resolve));h.clearPractice();pending.resolve({ok:true,json:async()=>({attempt:practiceAttempt('Draft remains'),cached:false,budget:{remaining:2,limit:3,configured:true}})});await checking;
  assert.equal(h.state.practice,null);assert.equal(h.state.budget.remaining,2);assert.equal(h.state.busy,false);
  context.fetch=async()=>({ok:true,json:async()=>exercise()});await h.openPractice('01');assert.equal(doc.querySelector('#practice-answer').value,'Draft remains');
});
test('practice refuses stale evaluation responses and whitespace-only answers',async()=>{
  const data=exercise();data.evaluation_id='new-evaluation';const {h,doc,context}=setup(()=>data);h.state.detail=practiceRecord();
  await h.openPractice('01');assert.equal(h.state.practice.locked,true);assert.equal(doc.querySelector('#practice-submit').disabled,true);
  let posts=0;context.fetch=async()=>{posts++;return {ok:true,json:async()=>exercise()};};await h.submitPractice();assert.equal(posts,0);
  h.clearPractice();await h.openPractice('01');posts=0;doc.querySelector('#practice-answer').value='  \n';await h.submitPractice();assert.equal(posts,0);
});
test('cached answers remain available at zero budget, while new responses cannot submit',async()=>{
  const data=exercise('a',[practiceAttempt()]);data.budget.remaining=0;const {h,doc,context}=setup(()=>data);h.state.detail=practiceRecord();await h.openPractice('01');
  assert.equal(doc.querySelector('#practice-answer').value,'Hello, I am Aida.');assert.equal(doc.querySelector('#practice-submit').disabled,false);
  assert.match(doc.querySelector('#practice-cost').textContent,/не расходует/);
  doc.querySelector('#practice-answer').value='A different answer';h.updatePracticeControls();assert.equal(doc.querySelector('#practice-submit').disabled,true);
  let posts=0;context.fetch=async()=>{posts++;};await h.submitPractice();assert.equal(posts,0);
});
test('network retry reuses request ID, definite failed check gets a new ID and refreshes budget',async()=>{
  const {h,doc,context}=setup(()=>exercise());h.state.detail=practiceRecord();await h.openPractice('01');doc.querySelector('#practice-answer').value='My draft';
  const ids=[];let mode='network';
  context.fetch=async(url,options)=>{
    if(url==='/api/health')return {ok:true,json:async()=>({budget:{remaining:2,limit:3,configured:true}})};
    ids.push(JSON.parse(options.body).request_id);
    if(mode==='network')throw new TypeError('lost response');
    if(mode==='failed')return {ok:false,status:502,json:async()=>({detail:'Не удалось проверить упражнение. Попытка учтена в лимите; ответ сохранён в форме.'})};
    return {ok:true,json:async()=>({attempt:practiceAttempt('My draft'),cached:false,budget:{remaining:1,limit:3,configured:true}})};
  };
  await h.submitPractice();mode='failed';await h.submitPractice();assert.equal(ids[0],ids[1]);
  assert.equal(h.state.budget.remaining,2);assert.equal(doc.querySelector('#practice-answer').value,'My draft');
  assert.match(doc.querySelector('#practice-error').textContent,/Попытка учтена/);
  mode='success';await h.submitPractice();assert.notEqual(ids[1],ids[2]);
});
test('practice rule guidance translates but source messages and AI feedback retain exact wording',async()=>{
  const data=exercise('a',[practiceAttempt('Клиент: исходный ответ')]);data.context[0].text='Диалоги: исходная цитата';
  const {h,doc,context}=setup(()=>data),{i18n}=localization('en');context.window.CQA_I18N=i18n;h.state.detail=practiceRecord();await h.openPractice('01');
  assert.match(doc.querySelector('#practice-task').textContent,/Write your first message/);
  assert.match(doc.querySelector('#practice-context').innerHTML,/Диалоги: исходная цитата/);
  assert.match(doc.querySelector('#practice-feedback').innerHTML,/Клиент: исходный ответ/);
  assert.match(doc.querySelector('#practice-feedback').innerHTML,/What worked/);
});


function appealRecord(id='a') {
  const r=practiceRecord(id);r.title='Conversation '+id;
  r.evaluation.criteria=[
    {criterion_id:'01',name:'Passed criterion',type:'binary',value:1,reason:'Passed',normalized_weight:20,earned_score:20},
    {criterion_id:'02',name:'Failed criterion',type:'binary',value:0,reason:'Needs attention',normalized_weight:20,earned_score:0},
    {criterion_id:'03',name:'Not applicable criterion',type:'scale',value:null,is_na:true,max_scale:3,reason:'Not applicable'},
    {criterion_id:'04',name:'No violation criterion',type:'flag',value:0,reason:'No violation'}];
  return r;
}
function response(value,status=200) {return {ok:status<400,status,json:async()=>value};}
test('submitting a closed appeal or one with no session is a safe no-op',async()=>{
  const {h,context}=setup();let calls=0;context.fetch=async()=>{calls++;throw new Error('unexpected request');};
  await h.submitAppeal();h.state.role='operator';h.state.detail=appealRecord();h.openAppeal('02');h.closeAppealSession();await h.submitAppeal();
  assert.equal(calls,0);assert.equal(h.state.appealTarget,null);
});
test('operator has a prominent appeal entry and can select passing and N/A criteria',()=>{
  const {h,doc}=setup();h.state.role='operator';h.state.detail=appealRecord();h.renderDetail();
  assert.match(doc.querySelector('#assessment-actions').innerHTML,/class="button primary appeal-primary" data-appeal=""/);
  assert.match(doc.querySelector('#deductions').innerHTML,/class="button subtle appeal-secondary" data-appeal="02"/);
  assert.equal(doc.querySelector('#assessment-conversation').textContent,'Conversation a');
  h.openAppeal('');assert.equal(h.state.appealTarget.criterion_id,'02');
  assert.equal(h.state.appealSession.criteria.length,4);
  h.selectAppealCriterion('01');assert.equal(h.state.appealTarget.criterion_id,'01');
  h.selectAppealCriterion('03');assert.equal(h.state.appealTarget.criterion_id,'03');
  assert.equal(Object.isFrozen(h.state.appealTarget),true);
  h.openAppeal('04');assert.equal(h.state.appealTarget.criterion_id,'04');
});
test('pending appeals have status/navigation, no duplicate action, and disabled selector options',()=>{
  const {h,doc}=setup();const r=appealRecord();r.appeals=[{id:'pending',status:'PENDING',criterion_id:'02',comment:'Existing appeal'}];
  h.state.role='operator';h.state.detail=r;h.renderDetail();
  assert.doesNotMatch(doc.querySelector('#deductions').innerHTML,/data-appeal="02"/);
  assert.match(doc.querySelector('#deductions').innerHTML,/Апелляция на рассмотрении/);
  assert.match(doc.querySelector('#deductions').innerHTML,/data-action="pending-appeals"/);
  h.openAppeal('');assert.equal(h.state.appealTarget.criterion_id,'01');
  assert.match(doc.querySelector('#appeal-select').innerHTML,/<option value="02" disabled>/);
  h.selectAppealCriterion('02');assert.equal(h.state.appealTarget.criterion_id,'01');
});
test('criterion disclosure orders failures first for operators without changing rule identity',()=>{
  const {h,doc}=setup();const r=appealRecord(),original=r.evaluation.criteria.map(c=>c.criterion_id);
  h.state.detail=r;h.state.role='operator';h.renderDetail();let html=doc.querySelector('#criteria').innerHTML;
  assert.match(html,/<details class="criterion criterion-disclosure has-issue" data-criterion="02"/);
  assert.ok(html.indexOf('data-criterion="02"')<html.indexOf('data-criterion="01"'));
  assert.match(html,/<summary><span class="criterion-summary-name">Failed criterion/);
  assert.doesNotMatch(html,/<details[^>]* open/);
  assert.deepEqual(r.evaluation.criteria.map(c=>c.criterion_id),original);
  doc.querySelectorAll=selector=>selector==='#criteria details.criterion[open]'?[{dataset:{criterion:'03'}}]:[];
  h.renderDetail();assert.match(doc.querySelector('#criteria').innerHTML,/<details[^>]*data-criterion="03" open>/);
  h.state.role='supervisor';h.renderDetail();html=doc.querySelector('#criteria').innerHTML;
  assert.ok(html.indexOf('data-criterion="01"')<html.indexOf('data-criterion="02"'));
});
test('appeal submit keeps captured conversation/evaluation and prevents a double click',async()=>{
  const r=appealRecord(),pending=deferred(),calls=[];const {h,doc,context}=setup();h.state.role='operator';h.state.detail=r;
  h.openAppeal('01');doc.querySelector('#appeal-form').elements.comment.value='Please review this criterion';
  context.fetch=async(url,options)=>{calls.push({url,options});return options.method==='POST'?response({detail:'test-stop'},422):pending.promise;};
  const first=h.submitAppeal();await h.submitAppeal();assert.equal(calls.length,1);
  h.state.detail=appealRecord('b');pending.resolve(response(r));await first;
  assert.equal(calls.length,2);assert.equal(calls[0].url,'/api/conversations/a');
  const payload=JSON.parse(calls[1].options.body);
  assert.deepEqual(payload,{conversation_id:'a',evaluation_id:'eval-a',criterion_id:'01',comment:'Please review this criterion'});
  assert.equal(doc.querySelector('#appeal-form').elements.comment.value,'Please review this criterion');
});
test('stale or newly pending assessment aborts appeal before POST and retains the explanation',async()=>{
  for(const mode of ['stale','pending']) {
    const r=appealRecord(),latest=appealRecord(),calls=[];if(mode==='stale')latest.evaluation.id='new-evaluation';
    else latest.appeals=[{id:'pending',status:'PENDING',criterion_id:'02',comment:'Already submitted'}];
    const {h,doc,context}=setup();h.state.role='operator';h.state.detail=r;h.openAppeal('02');
    doc.querySelector('#appeal-form').elements.comment.value='My explanation';
    context.fetch=async(url,options)=>{calls.push({url,options});return response(latest);};
    await h.submitAppeal();assert.equal(calls.length,1);assert.equal(calls[0].options.method,undefined);
    assert.equal(doc.querySelector('#appeal-submit').disabled,true);assert.equal(doc.querySelector('#appeal-error').hidden,false);
    assert.equal(doc.querySelector('#appeal-form').elements.comment.value,'My explanation');
    if(mode==='stale')assert.equal(h.state.appealSession.locked,true);else assert.equal(h.state.appealSession.pending.has('02'),true);
  }
});
test('changing role during the appeal preflight prevents the POST',async()=>{
  const r=appealRecord(),pending=deferred(),calls=[];const {h,doc,context}=setup();h.state.role='operator';h.state.detail=r;
  h.openAppeal('02');doc.querySelector('#appeal-form').elements.comment.value='My explanation';
  context.fetch=async(url)=>{calls.push(url);return pending.promise;};
  const checking=h.submitAppeal();h.state.role='supervisor';h.applyRole();pending.resolve(response(r));await checking;
  assert.deepEqual(calls,['/api/conversations/a']);assert.equal(h.state.appealSession,null);assert.equal(doc.querySelector('#appeal-dialog').open,false);
});
test('late successful appeal cannot close a newer form or erase its draft',async()=>{
  const r=appealRecord(),pending=deferred();const {h,doc,context}=setup();h.state.role='operator';h.state.detail=r;h.state.selected='a';
  h.openAppeal('01');doc.querySelector('#appeal-form').elements.comment.value='First explanation';
  context.fetch=async(url,options)=>{
    if(options.method==='POST')return pending.promise;
    if(url==='/api/conversations/a')return response(r);
    if(url==='/api/conversations')return response({items:[item(r)],total:1,evaluated:1,group:'TEST',budget:{remaining:0,limit:3,configured:true}});
    if(url==='/api/checklist')return response({version:1,criteria:[]});
    return response({auth_mode:'local-demo'});
  };
  const sending=h.submitAppeal();await new Promise(resolve=>setImmediate(resolve));
  h.closeAppealSession();h.openAppeal('02');doc.querySelector('#appeal-form').elements.comment.value='Second draft remains';
  const newSession=h.state.appealSession;
  pending.resolve(response({id:'appeal-1',conversation_id:'a',evaluation_id:'eval-a',criterion_id:'01',status:'PENDING',comment:'First explanation'}));await sending;
  assert.equal(h.state.appealSession,newSession);assert.equal(doc.querySelector('#appeal-dialog').open,true);
  assert.equal(doc.querySelector('#appeal-form').elements.comment.value,'Second draft remains');
  assert.equal(h.state.appealTarget.criterion_id,'02');assert.equal(r.appeals.length,1);
});
test('new appeal and assessment controls are translated in Kazakh and English',()=>{
  const {i18n}=localization();for(const language of ['en','kk']) {
    i18n.set(language);for(const label of ['Мои апелляции','На рассмотрении:','Что требует внимания','Рекомендация','К оценке','Полный комментарий','Отправляем…'])assert.notEqual(i18n.t(label),label);
  }
});


test('unlimited budget enables evaluation and offers every pending conversation in a batch',()=>{
  const {h,doc}=setup();
  h.updateBudget({remaining:null,limit:null,unlimited:true,configured:true,attempts:100});
  h.state.detail=record();h.renderDetail();
  assert.match(doc.querySelector('#budget').textContent,/Лимит проверок отключён/);
  assert.doesNotMatch(doc.querySelector('#score-panel').innerHTML,/<button[^>]*id="evaluate-button"[^>]*disabled/);
  h.state.filtered=[item(record('a')),item(record('b')), {...item(record('c')),status:'Evaluated'}];
  doc.querySelector('#batch-form').elements.count={};h.actions.batch();
  assert.equal(doc.querySelector('#batch-form').elements.count.max,2);
  assert.equal(doc.querySelector('#batch-dialog').open,true);
});
test('unlimited practice allows a new answer and displays translated availability',async()=>{
  const data=exercise();data.budget={remaining:null,limit:null,unlimited:true,configured:true,attempts:100};
  const {h,doc,context}=setup(()=>data);context.window.CQA_I18N=localization('en').i18n;
  h.state.detail=practiceRecord();await h.openPractice('01');
  doc.querySelector('#practice-answer').value='Hello, how can I help?';h.updatePracticeControls();
  assert.equal(doc.querySelector('#practice-submit').disabled,false);
  assert.equal(doc.querySelector('#practice-availability').textContent,'Evaluation limit disabled');
  h.state.budget.configured=false;h.updatePracticeControls();
  assert.equal(doc.querySelector('#practice-submit').disabled,true);
});

function preparedPreview(id='preview-one',requests=[{provider:'OpenAI',target:'a',mask_personal_data:true,request:{model:'mock',messages:[{role:'system',content:'Only use supplied evidence.'},{role:'user',content:'{"dialogue":"[PERSON_1] asks a question"}'}],store:false}}]) {
  return {preview_id:id,requests,cached:!requests.length,expires_at:new Date(Date.now()+600000).toISOString()};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('AI review prepares locally, requires explicit confirmation, and returns the exact preview ID',async()=>{
  const {h,doc,context}=setup(undefined,undefined,{realReview:true}),calls=[];
  context.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return response(preparedPreview());};
  let approved=false;const checking=h.reviewAI({purpose:'evaluation',conversation_id:'a',force:false,language:'en'}).then(value=>{approved=true;return value;});
  await tick();assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/ai/prepare');assert.equal(approved,false);
  assert.match(doc.querySelector('#ai-review-content').innerHTML,/\[PERSON_1\]/);assert.match(doc.querySelector('#ai-review-content').innerHTML,/&quot;store&quot;: false/);
  assert.equal(doc.querySelector('#ai-review-confirm').disabled,false);h.confirmAIReview();
  assert.equal((await checking).preview_id,'preview-one');assert.equal(calls.length,1);
});
test('additional redactions invalidate confirmation until a fresh preview returns',async()=>{
  const {h,doc,context}=setup(undefined,undefined,{realReview:true}),calls=[];let version=0;
  context.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return response(preparedPreview('preview-'+(++version)));};
  const waiting=h.reviewAI({purpose:'assistant_search',query:'A question',language:'ru',filters:{}});await tick();
  doc.querySelector('#ai-redactions').value='Exact company name\nPrivate reference';h.state.aiReview.dirty=true;h.renderAIReview();h.confirmAIReview();
  assert.ok(h.state.aiReview);assert.equal(doc.querySelector('#ai-review-confirm').disabled,true);
  await h.prepareAIReview();assert.deepEqual(calls[1].redactions,['Exact company name','Private reference']);
  h.confirmAIReview();assert.equal((await waiting).preview_id,'preview-2');
});
test('closing or changing role during preparation ignores late preview and sends nothing',async()=>{
  for(const close of [true,false]) {
    const pending=deferred(),calls=[];const {h,context}=setup(undefined,undefined,{realReview:true});
    context.fetch=async(url)=>{calls.push(url);return pending.promise;};
    const waiting=h.reviewAI({purpose:'evaluation',conversation_id:'a'});
    if(close)h.endAIReview();else{h.state.role='operator';h.applyRole();}
    pending.resolve(response(preparedPreview()));await tick();assert.equal(await waiting,null);assert.equal(h.state.aiReview,null);
    assert.deepEqual(calls,['/api/ai/prepare']);
  }
});
test('expired or failed previews cannot authorize an external request',async()=>{
  const {h,doc,context}=setup(undefined,undefined,{realReview:true});const preview=preparedPreview();preview.expires_at='2020-01-01T00:00:00Z';
  context.fetch=async()=>response(preview);const waiting=h.reviewAI({purpose:'evaluation',conversation_id:'a'});await tick();h.confirmAIReview();
  assert.equal(h.state.aiReview.prepared,null);assert.equal(doc.querySelector('#ai-review-confirm').disabled,true);h.endAIReview();await waiting;
  context.fetch=async()=>response({detail:'Не удалось безопасно подготовить запрос. Отправка заблокирована; оригинал не отправлен.'},422);
  const failing=h.reviewAI({purpose:'evaluation',conversation_id:'a'});await tick();assert.equal(doc.querySelector('#ai-review-confirm').disabled,true);assert.match(doc.querySelector('#ai-review-error').textContent,/оригинал не отправлен/);h.endAIReview();await failing;
});
test('external AI block disables every new AI action while preserving local navigation and cache',async()=>{
  const {h,doc,context}=setup(undefined,undefined,{realReview:true});let calls=0;context.fetch=async()=>{calls++;throw new Error('must not send');};
  h.state.detail=practiceRecord();h.state.budget={configured:true,unlimited:true,remaining:null};h.applyPrivacy({mask_personal_data:true,block_external_ai:true,revision:2});
  await assert.rejects(h.reviewAI({purpose:'evaluation',conversation_id:'a'}),/запрещена/);
  await h.evaluateSelected();await h.submitAssistant();await h.submitBatch({elements:{count:{value:'1'}}});
  assert.equal(calls,0);assert.equal(h.hasAiBudget(),false);assert.equal(doc.querySelector('#assistant-submit').disabled,true);
  h.setDetailView('transcript');assert.equal(doc.querySelector('#transcript-pane').hidden,false);
});
test('evaluation and force sends use the captured target only after explicit preview confirmation',async()=>{
  for(const force of [false,true]) {
    const {h,context}=setup(undefined,undefined,{realReview:true}),r=practiceRecord('a'),calls=[];
    if(!force){r.status='Pending';r.evaluation=null;}h.state.detail=r;h.state.selected='a';h.state.budget={configured:true,unlimited:true};
    context.fetch=async(url,options)=>{calls.push({url,options});if(url==='/api/ai/prepare')return response(preparedPreview());return response({detail:'stop'},422);};
    const checking=h.evaluateSelected();await tick();assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].options.body).force,force);
    h.state.selected='b';h.confirmAIReview();await assert.rejects(checking);
    const send=calls.find(call=>call.url.startsWith('/api/evaluate/'));assert.equal(send.url,'/api/evaluate/a'+(force?'?force=true':''));assert.equal(send.options.headers['X-AI-Preview'],'preview-one');
  }
});
test('batch and practice carry the confirmed preview through their existing API contracts',async()=>{
  const batch=setup(undefined,undefined,{realReview:true}),calls=[];batch.h.state.budget={configured:true,unlimited:true};batch.h.state.filtered=[item(record('a')),item(record('b'))];
  batch.context.fetch=async(url,options)=>{calls.push({url,options});return url==='/api/ai/prepare'?response(preparedPreview()):response({detail:'stop'},422);};
  const checking=batch.h.submitBatch({elements:{count:{value:'2'}}});await tick();assert.equal(calls.length,1);batch.h.confirmAIReview();await assert.rejects(checking);
  const sent=calls.find(call=>call.url==='/api/evaluate-batch');assert.deepEqual(JSON.parse(sent.options.body).conversation_ids,['a','b']);assert.equal(sent.options.headers['X-AI-Preview'],'preview-one');
  const practice=setup(()=>exercise(),undefined,{realReview:true});practice.h.state.detail=practiceRecord();await practice.h.openPractice('01');practice.doc.querySelector('#practice-answer').value='A corrected reply';
  const paths=[];practice.context.fetch=async(url,options)=>{paths.push({url,options});return url==='/api/ai/prepare'?response(preparedPreview()):url==='/api/health'?response({}):response({detail:'stop'},422);};
  const submitting=practice.h.submitPractice();await tick();assert.equal(paths.length,1);practice.h.confirmAIReview();await submitting;
  const payload=JSON.parse(paths.find(call=>call.url==='/api/practice/a/01').options.body);assert.equal(payload.preview_id,'preview-one');assert.equal(payload.answer,'A corrected reply');
});
test('assistant sends directly without a preview dialog and recommendations remain a separate action',async()=>{
  const {h,doc,context}=setup(undefined,undefined,{realReview:true});h.state.budget={configured:true,unlimited:true};h.state.assistantBudget={remaining:20,limit:20};doc.querySelector('#assistant-query').value='What needs attention?';const calls=[];
  context.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return url==='/api/ai/prepare'?response(preparedPreview()):response({kind:'recommendations_available',filters:{},assistant_budget:{remaining:19,limit:20}});};
  await h.submitAssistant();assert.notEqual(doc.querySelector('#ai-review-dialog').open,true);assert.equal(h.state.aiReview,null);
  assert.deepEqual(calls.map(call=>call.url),['/api/ai/prepare','/api/assistant']);assert.equal(h.state.assistantHistory[0].response.kind,'recommendations_available');
  assert.match(doc.querySelector('#assistant-history').innerHTML,/data-assistant-recommendations/);assert.ok(!calls.some(call=>/evaluate/.test(call.url)));
});
test('assistant filters retain manual filters, use only local refresh, and can be reset',async()=>{
  const r=record('a','KZ');r.status='Evaluated';const {h,doc,context}=setup(()=>r);h.state.items=[item(r),item(record('b','RU'))];
  await h.applyAssistantResult({filters:{language:'KZ',gross_only:false,score_below:80},items:[{conversation_id:'a'}]});
  assert.equal(doc.querySelector('#language').value,'KZ');assert.equal(h.state.filtered.length,1);assert.equal(h.state.filtered[0].id,'a');
  const calls=[];doc.querySelector('#channel').value='agent chat';context.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return response({filters:{language:'KZ',channel:'agent chat',score_below:80},items:[{conversation_id:'a'}]});};
  await h.refreshAssistantFilter();assert.equal(calls[0].url,'/api/assistant/filter');assert.equal(calls[0].body.filters.score_below,80);assert.equal(calls[0].body.filters.channel,'agent chat');
  await h.clearAllFilters();assert.equal(h.state.assistantIds,null);assert.equal(doc.querySelector('#language').value,'');assert.equal(h.state.filtered.length,2);
});
test('gross filter replaces a conflicting status and a new status replaces the gross filter',async()=>{
  const r=record('flagged');r.status='Evaluated';const pending=record('pending');
  const {h,doc}=setup(url=>url.endsWith('/flagged')?r:pending);
  h.state.items=[{...item(r),has_gross_violation:true},item(pending)];
  doc.querySelector('#status').value='Pending';doc.querySelector('#gross-only').checked=true;
  doc.querySelector('#language').value='RU';doc.querySelector('#channel').value='agent chat';
  await h.refreshAssistantFilter('gross-only');
  assert.equal(doc.querySelector('#status').value,'');assert.equal(h.state.filtered[0].id,'flagged');
  assert.equal(doc.querySelector('#language').value,'RU');assert.equal(doc.querySelector('#channel').value,'agent chat');
  doc.querySelector('#status').value='Pending';await h.refreshAssistantFilter('status');
  assert.equal(doc.querySelector('#gross-only').checked,false);assert.equal(h.state.filtered[0].id,'pending');
});
test('assistant search updates the main list with normalized conditions and preserves refinements',async()=>{
  const r=record('flagged');r.status='Evaluated';const {h,doc,context}=setup(undefined,undefined,{realReview:true});
  h.state.budget={configured:true,unlimited:true};h.state.items=[{...item(r),has_gross_violation:true}];
  doc.querySelector('#status').value='Pending';doc.querySelector('#assistant-query').value='Покажи грубые ошибки';
  const calls=[];let filters={gross_only:true,status:null};
  context.fetch=async(url,options)=>{
    calls.push({url,body:options.body?JSON.parse(options.body):null});
    if(url==='/api/ai/prepare')return response(preparedPreview());
    if(url==='/api/assistant')return response({kind:'search',filters,items:[{conversation_id:'flagged',issues:[]}],result_count:1});
    return response(r);
  };
  await h.submitAssistant();assert.equal(doc.querySelector('#status').value,'');
  assert.equal(doc.querySelector('#gross-only').checked,true);assert.equal(h.state.filtered.length,1);
  doc.querySelector('#assistant-query').value='Только на русском';filters={...filters,language:'RU'};
  await h.submitAssistant();const requests=calls.filter(c=>c.url==='/api/ai/prepare');
  assert.equal(requests[0].body.filters.status,'Pending');assert.equal(requests[1].body.filters.gross_only,true);
  assert.equal(doc.querySelector('#language').value,'RU');assert.equal(h.state.filtered.length,1);
  assert.notEqual(doc.querySelector('#ai-review-dialog').open,true);
});
test('direct assistant sends nothing when preparation fails and retains the typed question',async()=>{
  for(const invalid of [false,true]) {
    const {h,doc,context}=setup(undefined,undefined,{realReview:true}),calls=[];
    h.state.budget={configured:true,unlimited:true};doc.querySelector('#assistant-query').value='My question';
    context.fetch=async url=>{calls.push(url);return url==='/api/health'?response({}):invalid?response({}):response({detail:'Не удалось безопасно подготовить запрос. Отправка заблокирована; оригинал не отправлен.'},422);};
    await h.submitAssistant();assert.deepEqual(calls,['/api/ai/prepare','/api/health']);
    assert.match(h.state.assistantError,/Отправка заблокирована/);assert.equal(h.state.assistantBusy,false);
    assert.equal(doc.querySelector('#assistant-query').value,'My question');
  }
});
test('direct assistant rechecks role, privacy and budgets after preparation and prevents double send',async()=>{
  for(const change of ['role','privacy','common-budget','assistant-budget','none']) {
    const {h,doc,context}=setup(undefined,undefined,{realReview:true}),pending=deferred(),calls=[];
    h.state.budget={configured:true,unlimited:true};doc.querySelector('#assistant-query').value='My question';
    context.fetch=async url=>{calls.push(url);return url==='/api/ai/prepare'?pending.promise:response({kind:'clarification',clarification:'Clarify'});};
    const sending=h.submitAssistant();await tick();await h.submitAssistant();
    assert.deepEqual(calls,['/api/ai/prepare']);assert.equal(doc.querySelector('#assistant-loading').hidden,false);
    assert.notEqual(doc.querySelector('#ai-review-dialog').open,true);
    if(change==='role'){h.state.role='operator';h.applyRole();}
    if(change==='privacy')h.applyPrivacy({block_external_ai:true,mask_personal_data:true});
    if(change==='common-budget')h.state.budget={configured:true,unlimited:false,remaining:0};
    if(change==='assistant-budget')h.state.assistantBudget={remaining:0,limit:20};
    pending.resolve(response(preparedPreview()));await sending;
    assert.deepEqual(calls,change==='none'?['/api/ai/prepare','/api/assistant']:['/api/ai/prepare']);
    assert.equal(h.state.assistantBusy,false);
  }
});
test('assistant renders bounded factual recommendations, sources and DEV caveat safely',()=>{
  const {h}=setup();const recommendation={action:'<script>untrusted</script>',observation:'2 of 4 observations',count:2,sample_size:4,goal:'Review evidence',sources:[{conversation_id:'a',messages:[{conversation_id:'a',message_index:1,timestamp:'00:40',quote:'Original words'}]}]};
  const html=h.renderAssistantResult({kind:'recommendations',coverage:{evaluated:4,total:65},dataset:{synthetic:true},recommendations:[recommendation,recommendation,recommendation,recommendation]},0);
  assert.equal((html.match(/class="assistant-recommendation"/g)||[]).length,3);assert.match(html,/Синтетический DEV-набор/);assert.match(html,/data-message-index="1"/);assert.match(html,/Original words/);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
});
test('privacy and assistant controls translate while original prepared request content is preserved',async()=>{
  const {h,context,doc}=setup(undefined,undefined,{realReview:true}),{i18n}=localization('en');context.window.CQA_I18N=i18n;
  const value=preparedPreview();value.requests[0].request.messages[1].content='Исходные слова: Диалоги';context.fetch=async()=>response(value);
  const waiting=h.reviewAI({purpose:'assistant_search',query:'query'});await tick();assert.match(doc.querySelector('#ai-review-content').innerHTML,/Исходные слова: Диалоги/);
  for(const language of ['en','kk']){i18n.set(language);for(const text of ['Помощник руководителя','Что получит AI','Скрывать персональные данные перед отправкой AI','Запретить внешнюю AI-обработку','Обновить предпросмотр','Подтвердить и отправить'])assert.notEqual(i18n.t(text),text);}
  h.endAIReview();await waiting;
});

test('assistant evidence opens the transcript at the cited message without a subsequent scroll reset',async()=>{
  const r=record('a'),{h,doc}=setup(()=>r);let proofScrolls=0,workspaceScrolls=0;
  doc.querySelector('#message-1').scrollIntoView=()=>proofScrolls++;doc.querySelector('.dialogue-workspace').scrollIntoView=()=>workspaceScrolls++;
  await h.openAssistantSource('a',1);assert.equal(h.state.detailView,'transcript');assert.equal(proofScrolls,1);assert.equal(workspaceScrolls,0);
  await h.openAssistantSource('a',null);assert.equal(h.state.detailView,'assessment');assert.equal(workspaceScrolls,1);
});
test('gross-violation search promotes relevant evidence and retains other findings in a disclosure',()=>{
  const {h}=setup();const html=h.renderAssistantResult({kind:'search',filters:{gross_only:true},items:[{conversation_id:'a',status:'Evaluated',score:40,issues:[
    {type:'binary',reason:'Closing issue',evidence:{conversation_id:'a',message_index:3}},
    {type:'flag',reason:'Gross violation',evidence:{conversation_id:'a',message_index:1}}]}]},0);
  assert.ok(html.indexOf('Gross violation')<html.indexOf('Closing issue'));assert.match(html,/assistant-more-issues/);assert.match(html,/data-message-index="3"/);
});
test('assistant reports remaining requests explicitly in all interface languages',()=>{
  const {h,doc,context}=setup(),{i18n}=localization('ru');context.window.CQA_I18N=i18n;
  h.state.assistantBudget={remaining:16,limit:20};
  for(const [language,label] of [['ru','Осталось запросов:'],['kk','Қалған сұраулар:'],['en','Requests remaining:']]) {
    i18n.set(language);h.renderAssistant();const text=doc.querySelector('#assistant-budget').textContent;
    assert.ok(text.startsWith(label));assert.match(text,/16/);assert.match(text,/20/);
  }
});
test('unlimited assistant search and recommendations send with default protection and no extra confirmation',async()=>{
  for(const purpose of ['assistant_search','assistant_recommendations']) {
    const {h,doc,context}=setup(undefined,undefined,{realReview:true}),calls=[],recommendations={disabled:true};
    h.state.budget={configured:true,unlimited:true};h.state.assistantBudget={unlimited:true,remaining:null,limit:null,attempts:35};
    doc.querySelector('#assistant-query').value='Show relevant conversations';
    doc.querySelectorAll=selector=>selector==='[data-assistant-recommendations]'?[recommendations]:[];
    h.renderAssistant();assert.equal(doc.querySelector('#assistant-submit').disabled,false);assert.equal(recommendations.disabled,false);
    assert.equal(doc.querySelector('#assistant-budget').textContent,'Запросы без ограничений');
    context.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return url==='/api/ai/prepare'?response(preparedPreview()):response({kind:'clarification',clarification:'Please clarify',assistant_budget:{unlimited:true,remaining:null,limit:null,attempts:36}});};
    await h.submitAssistant(purpose);assert.equal(calls[0].body.purpose,purpose);
    assert.deepEqual(calls[1].body,{preview_id:'preview-one'});assert.notEqual(doc.querySelector('#ai-review-dialog').open,true);
    assert.deepEqual(calls.map(call=>call.url),['/api/ai/prepare','/api/assistant']);assert.equal(h.state.assistantHistory.length,1);
  }
});
test('assistant finite caps and privacy block still disable sending in unlimited-capable client',async()=>{
  const {h,doc,context}=setup();let calls=0;context.fetch=async()=>{calls++;return response({});};
  h.state.budget={configured:true,unlimited:true};doc.querySelector('#assistant-query').value='Question';
  h.state.assistantBudget={unlimited:false,remaining:1,limit:20};h.renderAssistant();assert.equal(doc.querySelector('#assistant-submit').disabled,false);
  h.state.assistantBudget.remaining=0;h.renderAssistant();assert.equal(doc.querySelector('#assistant-submit').disabled,true);await h.submitAssistant();
  h.state.assistantBudget={unlimited:true,remaining:null,limit:null};h.applyPrivacy({block_external_ai:true,mask_personal_data:true});await h.submitAssistant();
  assert.equal(doc.querySelector('#assistant-submit').disabled,true);assert.equal(calls,0);
});
test('AI assistant names and unlimited availability translate in all interface languages',()=>{
  const {h,doc,context}=setup(),{i18n}=localization('ru');context.window.CQA_I18N=i18n;
  h.state.assistantBudget={unlimited:true,remaining:null,limit:null};
  for(const [language,label] of [['ru','Запросы без ограничений'],['kk','Сұраулар шектеусіз'],['en','Unlimited requests']]) {
    i18n.set(language);h.renderAssistant();assert.equal(doc.querySelector('#assistant-budget').textContent,label);
    for(const text of ['AI-помощник','Открыть AI-помощника','Закрыть AI-помощника'])assert.equal(/[А-Яа-яЁё]/.test(i18n.t(text)),language!=='en');
  }
});
test('assistant omits duplicate coverage but retains a distinct filtered scope',()=>{
  const {h}=setup(),coverage={evaluated:2,total:5,statuses:{Evaluated:2,Pending:3}};
  const html=subset=>h.renderAssistantResult({kind:'search',items:[],coverage,filtered_coverage:subset},0);
  assert.doesNotMatch(html({...coverage,statuses:{Pending:3,Evaluated:2}}),/В текущей выборке/);
  assert.match(html({...coverage}),/Оценено: 2 из 5 диалогов/);
  assert.match(html({evaluated:1,total:2,statuses:{Evaluated:1,Pending:1}}),/В текущей выборке оценено: 1 из 2/);
  assert.match(html({...coverage,statuses:{Evaluated:2,Stale:3}}),/В текущей выборке/);
});
test('manual review shows its reason without a fake zero score or current coaching',async()=>{
  const r=record('review');r.status='Review';r.manual_review={code:'insufficient_evidence',reason:'<script>Original review reason</script>'};
  const {h,doc}=setup(()=>r);h.state.items=[{...item(r),manual_review:r.manual_review,score:0}];doc.querySelector('#status').value='Review';
  await h.filterConversations();assert.equal(h.state.selected,'review');assert.match(doc.querySelector('#conversation-list').innerHTML,/Нужен ручной разбор/);
  assert.match(doc.querySelector('#conversation-list').innerHTML,/class="item-score">—/);
  for(const role of ['supervisor','operator']) {
    h.state.role=role;h.renderDetail();const html=doc.querySelector('#score-panel').innerHTML;
    assert.match(html,/Оценка не выставлена/);assert.match(html,/&lt;script&gt;Original review reason&lt;\/script&gt;/);
    assert.doesNotMatch(html,/score-ring|<script>|Готов к проверке|Проверьте обоснования/);
    assert.equal(doc.querySelector('#evaluation-status').textContent,'Нужен ручной разбор');
  }
  assert.equal(h.analyticsSummary([{status:'Review',score:0,language:'RU',channel:'agent chat'}]).average,null);
});
test('manual review retains a previous assessment but never presents it as current',()=>{
  const {h,doc}=setup(),r=practiceRecord();r.status='Review';r.manual_review={reason:'Context is incomplete',code:'missing_context'};
  h.state.detail=r;h.state.role='operator';h.renderDetail();const html=doc.querySelector('#score-panel').innerHTML;
  assert.match(html,/Предыдущая оценка/);assert.match(html,/Context is incomplete/);assert.doesNotMatch(html,/Итоговая оценка/);
  assert.doesNotMatch(doc.querySelector('#assessment-actions').innerHTML,/data-appeal/);assert.doesNotMatch(doc.querySelector('#deductions').innerHTML,/data-practice/);
  assert.equal(h.analyticsSummary([{status:'Review',score:80,language:'RU',channel:'agent chat'}]).checked,0);
});
test('manual review responses and mixed batches report review separately from scored evaluations',async()=>{
  const {h,doc,context}=setup();h.state.detail=record();h.state.budget={configured:true,unlimited:true};h.state.filtered=[item(record())];
  vm.runInContext('loadData=async()=>{}',context);
  context.fetch=async url=>response(url==='/api/evaluate-batch'?{completed:[],reviews:[{id:'a',reason:'Review',code:'missing_context'}]}:{status:'Review',evaluation:null,manual_review:{reason:'Review',code:'missing_context'},budget:{configured:true,unlimited:true}});
  await h.evaluateSelected();assert.equal(doc.querySelector('#toast').textContent,'Нужен ручной разбор');
  await h.submitBatch({elements:{count:{value:'1'}}});assert.equal(doc.querySelector('#toast').textContent,'Оценено: 0. Нужен ручной разбор: 1.');
});
test('additional evidence keeps original one-based turns across customer, bot, operator and system messages',async()=>{
  const {h,doc}=setup(),r=practiceRecord();r.transcript=['client','bot','operator','system'].map((speaker,index)=>({speaker,text:'Original '+speaker,timestamp:`00:0${index}`}));
  const criterion=r.evaluation.criteria[0];criterion.proof_message_index=2;criterion.evidence_turns=[1,2,3,4,4,0,99,'2'];h.state.detail=r;h.renderDetail();
  const html=doc.querySelector('#criteria').innerHTML;assert.match(html,/Другие подтверждающие реплики/);
  for(const index of [0,1,2,3])assert.equal((html.match(new RegExp(`data-proof="${index}"`,'g')) || []).length,1);
  assert.match(html,/Реплика 2<span>Бот/);assert.match(html,/Реплика 4<span>Система/);assert.doesNotMatch(html,/data-proof="98"/);
  let target=null;doc.querySelector('#message-3').scrollIntoView=()=>target=3;await h.seekProof(3);
  assert.equal(doc.querySelector('#show-context').checked,true);assert.equal(target,3);assert.equal(h.state.detailView,'transcript');
});
test('manual review labels and supporting evidence translate without translating the source reason',()=>{
  const {h,doc,context}=setup(),{i18n}=localization('en');context.window.CQA_I18N=i18n;const r=record();r.status='Review';r.manual_review={reason:'Исходная причина'};h.state.detail=r;
  for(const [language,label] of [['en','Manual review needed'],['kk','Қолмен талдау қажет']]) {
    i18n.set(language);h.renderDetail();assert.equal(doc.querySelector('#evaluation-status').textContent,label);assert.match(doc.querySelector('#score-panel').innerHTML,/Исходная причина/);
    assert.notEqual(i18n.t('Другие подтверждающие реплики'),'Другие подтверждающие реплики');
  }
});

test('assistant frequency summary shows counted outcomes, applicability and evidence safely',()=>{
  const {h}=setup(),result={kind:'summary',filters:{language:'RU',gross_only:true},coverage:{evaluated:3,total:7},filtered_coverage:{evaluated:1,total:1},issues_summary:[{name:'Грубые ошибки',type:'flag',count:1,sample_size:1,sources:[{reason:'Reason <script>bad</script>',evidence:{conversation_id:'a',message_index:1,quote:'Evidence'}}]}]};
  const html=h.renderAssistantResult(result,0);
  assert.match(html,/Какие ошибки повторяются чаще/);assert.match(html,/Язык: RU/);assert.match(html,/Грубые ошибки/);
  assert.match(html,/1<\/strong> из 1 применимых оценок/);assert.match(html,/data-message-index="1"/);
  assert.match(html,/assistant-frequency-critical/);assert.doesNotMatch(html,/<script>/);
  assert.match(html,/&lt;script&gt;/);assert.match(html,/N\/A/);
  const empty=h.renderAssistantResult({...result,filtered_coverage:{evaluated:0,total:2},issues_summary:[]},0);
  assert.match(empty,/нет актуальных оценок/);assert.doesNotMatch(empty,/замечаний не найдено/);
});
test('assistant new summary and error copy translate in Russian Kazakh and English',()=>{
  const {i18n}=localization('ru');
  for(const lang of ['kk','en']){
    i18n.set(lang);
    for(const text of ['Какие ошибки повторяются чаще','Запрос отправляется по текущим настройкам защиты данных.','В этой выборке нет актуальных оценок. Сводка ошибок пока недоступна.','AI вернул некорректную команду поиска. Фильтры и оценки не изменены; автоматический повтор не выполнялся.'])assert.notEqual(i18n.t(text),text);
  }
});

test('dataset tabs change list and analytics without changing stored grades or making AI calls',async()=>{
  const dev={...record('dev'),dataset_group:'DEV',status:'Evaluated',evaluation:{id:'dev-e',final_score:80,criteria:[]}};
  const control={...record('control'),dataset_group:'FBroker'};
  const swap={...record('swap'),dataset_group:'SWAP',evaluation_enabled:false};
  const records={dev,control,swap},calls=[];
  const {h,doc}=setup(async url=>{calls.push(url);return records[url.split('/').pop()];});
  h.state.allItems=[{...item(dev),dataset_group:'DEV',score:80},{...item(control),dataset_group:'FBroker'},{...item(swap),dataset_group:'SWAP',evaluation_enabled:false}];
  h.state.groups=['DEV','FBroker','SWAP'].map(id=>({id,total:1}));h.state.view='analytics';
  doc.querySelector('#status').value='Evaluated';h.state.assistantIds=new Set(['dev']);
  await h.selectDatasetGroup('FBroker');
  assert.equal(h.state.items.length,1);assert.equal(h.state.selected,'control');assert.equal(doc.querySelector('#status').value,'');
  assert.match(doc.querySelector('#dataset-tabs').innerHTML,/data-dataset-group="FBroker" aria-pressed="true"/);
  assert.match(doc.querySelector('#dataset-context').textContent,/Оценено: 0 из 1/);
  assert.doesNotMatch(doc.querySelector('#analytics-content').innerHTML,/80/);
  await h.selectDatasetGroup(null);
  assert.equal(h.state.items.length,3);assert.match(doc.querySelector('#dataset-context').textContent,/Оценено: 1 из 3/);
  assert.match(doc.querySelector('#analytics-content').innerHTML,/По наборам/);
  assert.equal(dev.evaluation.final_score,80);assert.ok(calls.every(url=>url.startsWith('/api/conversations/')));
});

test('switching datasets prevents a late detail from reopening the old conversation',async()=>{
  const old=deferred(),newest=record('control');const {h}=setup(url=>url.endsWith('/dev')?old.promise:newest);
  h.state.allItems=[{...item(record('dev')),dataset_group:'DEV'},{...item(newest),dataset_group:'FBroker'}];
  h.state.groups=['DEV','FBroker'].map(id=>({id,total:1}));
  const first=h.selectDatasetGroup('DEV');const second=h.selectDatasetGroup('FBroker');
  await second;old.resolve(record('dev'));await first;
  assert.equal(h.state.selected,'control');assert.equal(h.state.detail.conversation_id,'control');
});

test('SWAP remains viewable and is excluded from all-group batches',async()=>{
  const {h,doc}=setup();h.state.budget={configured:true,unlimited:true};
  h.state.detail={...record('swap'),evaluation_enabled:false};h.renderDetail();
  assert.match(doc.querySelector('#score-panel').innerHTML,/Оценка будет доступна/);
  assert.match(doc.querySelector('#score-panel').innerHTML,/id="evaluate-button" disabled/);
  doc.querySelector('#batch-form').elements.count={value:'',max:0};
  h.state.filtered=[{id:'control',status:'Pending'},{id:'swap',status:'Pending',evaluation_enabled:false}];
  h.actions.batch();assert.equal(doc.querySelector('#batch-form').elements.count.max,1);
});

test('assistant request is scoped to the selected group and a late answer cannot switch it back',async()=>{
  const wait=deferred(),{h,doc,context}=setup();const sent=[];
  context.fetch=async(url,options)=>{
    const body=JSON.parse(options?.body || '{}');sent.push({url,body});
    if(url==='/api/ai/prepare')return response({preview_id:'prepared-dataset-ticket'});
    if(url==='/api/assistant')return wait.promise;
    return response(record('swap'));
  };
  h.state.datasetGroup='FBroker';h.state.budget={configured:true,unlimited:true};h.state.assistantBudget={unlimited:true};
  doc.querySelector('#assistant-query').value='Покажи ошибки';
  const request=h.submitAssistant();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent[0].body.dataset_group,'FBroker');
  h.state.allItems=[{...item(record('swap')),dataset_group:'SWAP'}];h.state.groups=[{id:'SWAP',total:1}];
  await h.selectDatasetGroup('SWAP');
  wait.resolve(response({kind:'search',dataset_group:'FBroker',filters:{},items:[{conversation_id:'control'}]}));await request;
  assert.equal(h.state.datasetGroup,'SWAP');assert.equal(h.state.selected,'swap');assert.equal(h.state.assistantHistory.length,0);
  assert.equal(doc.querySelector('#assistant-query').disabled,false);
});

test('dataset controls and waiting notice translate into Kazakh and English',()=>{
  for(const lang of ['kk','en']){
    const {h,doc,context}=setup(),{i18n}=localization(lang);context.window.CQA_I18N=i18n;
    h.state.groups=[{id:'SWAP',total:3}];h.state.datasetGroup='SWAP';h.state.items=[{status:'Pending'}];
    h.renderDatasetTabs();assert.doesNotMatch(doc.querySelector('#dataset-context').textContent,/Оценка будет доступна/);
    assert.doesNotMatch(doc.querySelector('#dataset-tabs').innerHTML,/Все диалоги/);
  }
});
