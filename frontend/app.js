/* Buildless, framework-free client: suitable for a Dynamics 365 HTML web resource.
   Set window.CQA_API_BASE before loading this file when hosted separately. */
'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const t = (value) => window.CQA_I18N?.t(value) ?? value;
const ui = (parts,...values) => parts.reduce((out,part,i)=>out+t(part)+(i<values.length?values[i]:''),'');
const uiLocale = () => window.CQA_I18N?.locale() || 'ru-RU';
const fmt = (n, digits = 2) => n == null ? '—' : Number(n).toLocaleString(uiLocale(), {maximumFractionDigits: digits});
const labels = new Proxy({Pending:'Нет оценки ИИ', Evaluated:'Есть оценка ИИ', Stale:'Оценка устарела', Error:'Ошибка оценки', Review:'Нужен ручной разбор', Evaluating:'ИИ оценивает', PENDING:'Ожидает решения', APPROVED:'Удовлетворена', REJECTED:'Отклонена', SUPERSEDED:'Предыдущая версия'}, {get:(target,key)=>t(target[key])});
const languageNames = new Proxy({RU:'Русский',KZ:'Қазақша',EN:'English'}, {get:(target,key)=>t(target[key])});
function initialView() { const value=(window.location?.hash || '').slice(1);return ['appeals','analytics'].includes(value)?value:'conversations'; }
function storedToken() { try { return sessionStorage.getItem('cqa-token') || ''; } catch { return ''; } }
const state = {items:[], filtered:[], selected:null, detail:null, detailLoading:false, detailError:false, checklist:null, role:'supervisor', view:initialView(), appealItems:[], budget:{remaining:0}, busy:false, token:storedToken(), edit:[], audit:[], sequence:0, practice:null, appealSession:null, appealTarget:null,detailView:'assessment',privacy:null,aiReview:null,assistantSequence:0,assistantFilterSequence:0,assistantFilters:null,assistantIds:null,assistantHistory:[],assistantBudget:null,assistantBusy:false,assistantError:null,assistantRoleEpoch:0,appliedRole:'supervisor'};
state.allItems=[];state.groups=[];state.datasetGroup=null;
try { state.datasetGroup=sessionStorage.getItem('cqa-dataset-group') || null; } catch {}
let toastTimer, searchTimer, loadSequence=0, filterSequence=0, viewSequence=0, audioSeekSequence=0, pendingAudioSeek, uploadSequence=0, uploadConversations=[], uploadIndex=0, uploadImageURL=null, uploadIsImage=false;

async function api(path, options = {}) {
  let response;
  try { response = await fetch((window.CQA_API_BASE || '') + path, {...options, headers:{'Content-Type':'application/json', 'X-Role':state.role, 'X-Supervisor-Token':state.token, ...options.headers}}); }
  catch { throw new Error(t('Нет соединения с сервером. Попробуйте ещё раз.')); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const validation=Array.isArray(data.detail) ? [...new Set(data.detail.map(x=>/[А-Яа-яЁё]/.test(x.msg || '') ? x.msg.replace(/^Value error,\s*/,'') : t('Проверьте заполненные поля.')))].join(' ') : '';
    const aiRoute = path.startsWith('/api/practice/') || path.startsWith('/api/ai/') || path.startsWith('/api/assistant') || path.startsWith('/api/evaluate/');
    const message = aiRoute && typeof data.detail==='string' ? data.detail : response.status === 403 ? t('Нет доступа. Проверьте роль и пароль в настройках.') : response.status === 429 ? t('Лимит проверок исчерпан.') : response.status === 503 ? (typeof data.detail === 'string' && data.detail.startsWith('Не удалось сохранить') ? data.detail : t('Действие временно недоступно. Попробуйте позже.')) : response.status >= 500 ? t('Не удалось выполнить действие. Попробуйте позже.') : typeof data.detail === 'string' ? data.detail : validation || t('Не удалось выполнить действие.');
    const error=new Error(t(message));error.status=response.status;error.detail=typeof data.detail==='string'?data.detail:'';throw error;
  }
  return data;
}
const post = (path, body) => api(path, {method:'POST', body:JSON.stringify(body)});
function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = t(message);
  node.classList.toggle('error', error);
  node.hidden = false;
  // Promote above native modal dialogs where supported.
  if ('showPopover' in node) {
    node.setAttribute('popover','manual');
    if (!node.matches(':popover-open')) node.showPopover();
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if ('hidePopover' in node && node.matches(':popover-open')) node.hidePopover(); node.hidden = true; }, error ? 10000 : 6500);
}
async function guarded(fn, form) {
  if (form?.classList.contains('busy')) return;
  form?.classList.add('busy');
  try { await fn(); } catch (error) { toast(error.message, true); }
  finally { form?.classList.remove('busy'); }
}
function applyRole() {
  if(state.appliedRole!==state.role){state.appliedRole=state.role;state.assistantRoleEpoch++;}
  if(state.aiReview&&state.aiReview.role!==state.role){endAIReview();$('#ai-review-dialog').close();}
  if(state.role!=='supervisor'){closeAssistant();state.assistantFilters=null;state.assistantIds=null;++state.assistantFilterSequence;state.assistantHistory=[];renderList();}
  if(state.appealSession&&state.role!=='operator'){closeAppealSession();$('#appeal-dialog').close();}
  if(state.practice && state.practice.role!==state.role){clearPractice();$('#practice-dialog').close();}
  document.body.classList.toggle('operator-mode', state.role === 'operator');
  $$('.supervisor-only').forEach(node => node.hidden = state.role !== 'supervisor');
  if(state.role === 'operator' && state.view === 'analytics') void guarded(()=>setWorkspaceView('conversations'));
  orderOperatorWorkspace();
  if (state.detail) renderDetail();
}
function hasAiBudget(budget=state.budget) {
  return Boolean(budget.configured && !budget.external_blocked && !state.privacy?.block_external_ai && (budget.unlimited || budget.remaining > 0));
}
function updateBudget(budget) {
  state.budget = budget;
  $('#budget').textContent = budget.unlimited ? t('Лимит проверок отключён') : ui`Осталось проверок: ${budget.remaining}`;
  $('#settings-budget').textContent = budget.unlimited ? t('Лимит проверок отключён') : ui`Осталось проверок: ${budget.remaining} из ${budget.limit}.`;
  $$('[data-action="batch"]').forEach(button => button.disabled=state.busy || state.datasetGroup==='SWAP' || !hasAiBudget(budget));
  if(state.practice)updatePracticeControls();updateAssistantControls();
}
async function loadData(keepSelection = true) {
  const sequence=++loadSequence;
  let list,checklist,health;
  try { [list, checklist, health] = await Promise.all([api('/api/conversations'), api('/api/checklist'), api('/api/health')]); }
  catch(error) {
    if(sequence !== loadSequence) return;
    if(!state.items.length) {
      $('#conversation-list').innerHTML=t('<div class="empty">Не удалось загрузить диалоги. Нажмите «Обновить».</div>');
      $('#data-status').textContent=t('Нет соединения');
    }
    throw error;
  }
  if(sequence !== loadSequence) return;
  if(health.privacy)state.privacy=health.privacy;if(health.assistant_budget)state.assistantBudget=health.assistant_budget;
  $('#privacy-auth-mode').textContent=t(health.auth_mode==='local-demo'?'Локальное демо: переключение ролей не заменяет полноценную авторизацию.':'Доступ руководителя защищён токеном.');
  $('#settings-token-field').hidden=health.auth_mode==='local-demo';
  state.listSummary=list;
  state.items = list.items;
  state.checklist = checklist;
  updateBudget(list.budget);
  $('#auth-mode').textContent = health.auth_mode === 'local-demo' ? t('Локальное демо · роли без входа') : t('Доступ QA защищён токеном');
  state.allItems=list.items;state.groups=list.groups || [];
  if(state.datasetGroup&&!state.groups.some(group=>group.id===state.datasetGroup))state.datasetGroup=null;
  applyDatasetScope();
  $('#checklist-version').textContent = t('Правила оценки');
  if(state.assistantFilters&&state.role==='supervisor'){const result=await post('/api/assistant/filter',{filters:normalAssistantFilters(),dataset_group:state.datasetGroup});if(sequence!==loadSequence)return;state.assistantFilters=result.filters;syncNormalFilters(result.filters);state.assistantIds=new Set(result.items.map(item=>item.id || item.conversation_id));}
  await filterConversations({keepSelection,refreshDetail:true});
  applyRole();
  if(state.view !== 'conversations') await setWorkspaceView(state.view,{updateHistory:false});
}
function datasetLabel(group) { return group==='UPLOADED'?t('Загруженные'):group || t('Все диалоги'); }
function renderDatasetTabs() {
  const groups=[{id:'',total:state.allItems.length},...state.groups];
  $('#dataset-tabs').innerHTML=groups.map(group=>ui`<button type="button" class="dataset-tab" data-dataset-group="${escapeHTML(group.id)}" aria-pressed="${(state.datasetGroup || '')===group.id}"><span>${escapeHTML(datasetLabel(group.id))}</span><span class="dataset-count">${fmt(group.total,0)}</span></button>`).join('');
  const notice=state.datasetGroup==='SWAP'?'SWAP сохранён для просмотра. Оценка будет доступна после отдельной инструкции организаторов.':
    state.datasetGroup==='DEV'?'DEV · тестовый набор для демонстрации':
    state.datasetGroup==='FBroker'?'FBroker · контрольные чаты по основному чек-листу':
    state.groups.length>1?'Общий обзор наборов хакатона. Это не показатели компании.':'';
  const evaluated=state.items.filter(item=>item.status==='Evaluated').length;
  $('#dataset-context').textContent=ui`Оценено: ${evaluated} из ${state.items.length}`+(notice?' · '+t(notice):'');
  $('#dataset-context').classList.toggle('dataset-awaiting',state.datasetGroup==='SWAP');
}
function applyDatasetScope() {
  state.items=state.allItems.filter(item=>!state.datasetGroup || item.dataset_group===state.datasetGroup);
  const summary=analyticsSummary(state.items),chats=state.items.filter(item=>item.channel==='agent chat').length;
  $('#total-metric').textContent=fmt(summary.total,0);$('#evaluated-metric').textContent=fmt(summary.checked,0);
  $('#score-metric').textContent=fmt(summary.average,1);
  $('#progress-metric').textContent=ui`${summary.total?Math.round(summary.checked/summary.total*100):0}% от всех диалогов`;
  $('#channel-metric').textContent=ui`${chats} чатов · ${summary.total-chats} звонков`;
  const pending=state.items.reduce((sum,item)=>sum+item.pending_appeals,0);
  $('#appeals-metric').textContent=pending;$('#nav-appeals-count').textContent=pending;$('#nav-appeals-count').hidden=!pending;
  $('#gross-count').textContent=summary.violations;$('#data-status').textContent=ui`${summary.total} диалогов`;
  $('#group-badge').textContent=state.datasetGroup || 'DEV';
  renderDatasetTabs();
}
async function selectDatasetGroup(group) {
  group=group || null;
  if(group&&!state.groups.some(item=>item.id===group))return;
  if(group===state.datasetGroup)return;
  state.datasetGroup=group;++state.assistantRoleEpoch;++state.assistantSequence;++state.assistantFilterSequence;++filterSequence;
  state.assistantFilters=null;state.assistantIds=null;state.assistantError=null;state.searchIds=null;clearTimeout(searchTimer);
  for(const id of ['search','language','channel','status'])$(`#${id}`).value='';$('#gross-only').checked=false;
  try { if(group)sessionStorage.setItem('cqa-dataset-group',group);else sessionStorage.removeItem('cqa-dataset-group'); } catch {}
  applyDatasetScope();renderAssistant();
  await filterConversations({keepSelection:false});
  if(state.view==='analytics')renderAnalytics();
  if(state.view==='appeals')renderAppeals();
}
async function filterConversations({keepSelection=true,refreshDetail=false}={}) {
  const sequence=++filterSequence, query=$('#search').value.trim();
  if(query) {
    const matches=await api(ui`/api/conversations?search=${encodeURIComponent(query)}`);
    if(sequence !== filterSequence) return;
    state.searchIds=new Set(matches.items.map(r=>r.id));
  } else state.searchIds=null;
  renderList();
  const target=keepSelection && state.filtered.some(r=>r.id === state.selected) ? state.selected : state.filtered[0]?.id;
  if(!target) {
    ++state.sequence;state.selected=null;state.detail=null;state.detailLoading=false;state.detailError=false;
    resetAudio();renderDetail();
  } else if(refreshDetail || state.detail?.conversation_id !== target) await selectConversation(target);
}
function renderList() {
  renderActiveFilters();
  const language = $('#language').value, channel = $('#channel').value, status = $('#status').value, grossOnly=$('#gross-only').checked;
  const search = $('#search').value.trim().toLocaleLowerCase();
  // Server-side search includes full transcript; otherwise filter the loaded index locally.
  state.filtered = state.items.filter(r => (!state.assistantIds || state.assistantIds.has(r.id)) && (!grossOnly || (r.status === 'Evaluated' && r.has_gross_violation)) && (!language || r.language === language) && (!channel || r.channel === channel) && (!status || (status === 'appeals' ? r.pending_appeals > 0 : r.status === status)) && (!search || state.searchIds?.has(r.id)));
  if(state.assistantIds){const order=[...state.assistantIds];state.filtered.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));}
  $('#filter-count').textContent = ui`${state.filtered.length} из ${state.items.length}`;
  $('#conversation-list').innerHTML = state.filtered.length ? state.filtered.map(r => ui`<button class="conversation-item ${r.id === state.selected ? 'selected' : ''}" data-id="${escapeHTML(r.id)}" aria-pressed="${r.id === state.selected}"><div class="item-top"><span class="item-channel" aria-label="${r.channel === 'voice call' ? t('Звонок') : t('Чат')}"><svg viewBox="0 0 24 24" aria-hidden="true">${r.channel === 'voice call' ? '<path d="M5 3h4l2 5-3 2a16 16 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2Z"/>' : '<path d="M4 4h16v13H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/>'}</svg></span><span class="item-id">${escapeHTML(r.title || r.id)}</span><span class="item-score">${fmt(r.status==='Review'?null:r.score,1)}</span></div><p class="item-preview">${escapeHTML(r.status==='Review'&&r.manual_review?.reason?r.manual_review.reason:r.preview)}</p><div class="item-bottom">${!state.datasetGroup&&r.dataset_group?ui`<span class="dataset-item-tag">${escapeHTML(datasetLabel(r.dataset_group))}</span>`:''}<span class="language-chip">${r.language}</span><span class="status-dot ${r.status.toLowerCase()}"></span><span>${labels[r.status]}</span>${r.pending_appeals ? ui`<span class="appeal-mini">↗ ${r.pending_appeals}</span>` : ''}</div></button>`).join('') : ui`<div class="empty">${grossOnly?t('По выбранным условиям грубые ошибки не найдены.'):t('Диалоги не найдены')}</div>`;
}
async function selectConversation(id) {
  const sequence = ++state.sequence;
  state.selected = id;
  if(state.detail?.conversation_id !== id) {
    state.detail=null;state.detailLoading=true;state.detailError=false;
    resetAudio();renderList();renderDetail();
    $('#transcript').scrollTop=0;$('.inspector-body').scrollTop=0;
  }
  try {
    const detail = await api(ui`/api/conversations/${encodeURIComponent(id)}`);
    if (sequence !== state.sequence) return;
    state.detail = detail;state.detailLoading=false;state.detailError=false;
    renderList(); renderDetail();
  } catch(error) {
    if(sequence !== state.sequence) return;
    state.detail=null;state.detailLoading=false;state.detailError=true;
    renderDetail();throw error;
  }
}
function displayTime(timestamp) {
  if(/^Реплика \d+$/.test(timestamp || ''))return t(timestamp);
  if (timestamp?.includes('T')) {
    const time = new Date(timestamp);
    return Number.isNaN(time.getTime()) ? timestamp : time.toLocaleTimeString(uiLocale(), {timeZone:'UTC',hour12:false});
  }
  return timestamp || '—';
}
function offsetSeconds(timestamp, start) {
  const parse=value=>{
    if(typeof value !== 'string') return NaN;
    if(value.includes('T')) return Date.parse(value)/1000;
    if(!/^(?:\d+:[0-5]\d|\d+):[0-5]\d(?:\.\d+)?$/.test(value)) return NaN;
    return value.split(':').map(Number).reduce((sum,n)=>sum*60+n,0);
  };
  const delta=parse(timestamp)-parse(start);
  return Number.isFinite(delta) ? Math.max(0,delta) : 0;
}
function cancelAudioSeek() {
  ++audioSeekSequence;
  if(pendingAudioSeek) $('#audio').removeEventListener('loadedmetadata',pendingAudioSeek);
  pendingAudioSeek=null;
}
function resetAudio() {
  cancelAudioSeek();const audio=$('#audio');audio.pause();
  if(audio.getAttribute('src')) {audio.removeAttribute('src');audio.load();}
  $('#audio-time').textContent='00:00';$('#audio-panel').hidden=true;
}
function mmss(seconds) {
  return ui`${Math.floor(seconds/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
}
function renderDetail() {
  updateBudget(state.budget);setDetailView(state.detailView);
  const d = state.detail;
  $('#assessment-conversation').textContent=d?(d.title || d.conversation_id):'';
  $('#assessment-conversation').setAttribute('title',d?(d.title || d.conversation_id):'');
  $('[data-action="export"]').disabled=!d;
  if (!d) {
    $('#deductions').hidden=true;$('#deductions').innerHTML='';$('#violations').hidden=true;$('#violations').innerHTML='';
    $('#conversation-title').textContent=state.detailLoading ? t('Загрузка…') : t('Выберите диалог');
    $('#conversation-meta').textContent=t('ПЕРЕПИСКА');$('#message-count').textContent='—';
    $('#evaluation-status').textContent=t('Нет оценки ИИ');$('#evaluation-status').className='badge';
    const text=state.detailLoading ? t('Загрузка диалога…') : state.detailError ? t('Не удалось открыть диалог. Выберите его ещё раз.') : state.items.length ? t('По выбранным условиям диалогов нет.') : t('Нет диалогов. Нажмите «Загрузить диалог».');
    $('#transcript').innerHTML=ui`<div class="${state.detailLoading ? 'loading' : 'empty'}">${text}</div>`;
    $('#score-panel').innerHTML='';$('#assessment-actions').hidden=true;$('#assessment-actions').innerHTML='';$('#criteria').innerHTML='';$('#audio-panel').hidden=true;
    return;
  }
  $('#conversation-title').textContent = d.title || d.conversation_id;
  $('#conversation-meta').textContent = ui`${d.channel === 'voice call' ? t('ЗАПИСЬ ЗВОНКА') : t('ПЕРЕПИСКА')} / ${d.language}${d.transcript[0].timestamp.includes('T') ? t(' / ВРЕМЯ UTC') : ''}`;
  $('#transcript').setAttribute('lang',{RU:'ru',KZ:'kk',EN:'en'}[d.language] || 'ru');
  $('#message-count').textContent = ui`${d.transcript.length} реплик`;
  const audio = $('#audio');
  $('#audio-panel').hidden = !d.audio_url;
  const audioSource = d.audio_url ? (window.CQA_API_BASE || '') + d.audio_url : '';
  if (audioSource && audio.getAttribute('src') !== audioSource) { cancelAudioSeek();audio.pause();audio.src = audioSource;audio.load(); }
  else if (!audioSource && audio.getAttribute('src')) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  renderTranscript();
  const e = d.evaluation, current = d.status === 'Evaluated', manualReview=d.status==='Review';
  renderDeductions(e,current);renderViolations(e,current);
  const status = $('#evaluation-status');
  status.textContent = labels[d.status];
  status.className = ui`badge ${current ? 'green' : ['Stale','Review'].includes(d.status) ? 'amber' : d.status==='Error'?'red':''}`;
  $('#criteria-count').textContent = String(state.checklist.criteria.length).padStart(2,'0');
  const sourceNote=e ? (e.criteria.some(r=>r.overridden_at || r.override_comment) ? t('Оценка ИИ с правками руководителя') : t('Оценка ИИ')) : '';
  const percent = e?.final_score ?? 0;
  const eligible = d.evaluation_enabled!==false && !state.busy && d.status !== 'Evaluating' && !d.appeals.some(a=>a.status === 'PENDING') && hasAiBudget();
  const scoreNote=d.evaluation_enabled===false?t('SWAP сохранён для просмотра. Оценка будет доступна после отдельной инструкции организаторов.'):externalBlocked()?t('Внешняя AI-обработка запрещена в настройках.'):d.appeals.some(a=>a.status === 'PENDING') ? t('Сначала рассмотрите апелляции.') : e && e.final_score == null ? t('Нет применимых критериев с баллами.') : !state.budget.configured ? t('Оценка недоступна. Обратитесь к администратору.') : state.budget.remaining === 0 ? t('Лимит проверок исчерпан.') : e ? t('Проверьте обоснования и цитаты.') : '';
  const reviewNotice=manualReview?ui`<section class="manual-review-notice"><h3>Нужен ручной разбор</h3><p>${escapeHTML(d.manual_review?.reason || t('AI не смог надёжно оценить диалог. Проверьте исходную переписку.'))}</p></section>`:'';
  const failed=Boolean(d.evaluation_error || d.status==='Error');
  const errorNotice=failed?ui`<section class="evaluation-error-notice" role="status"><h3>Последняя проверка не завершена</h3><p>${escapeHTML(t(d.evaluation_error?.message || 'Предыдущая попытка оценки завершилась ошибкой. Подробная причина не была сохранена.'))}</p></section>`:'';
  const scoreMain=(manualReview||failed)&&!e?ui`<div class="score-info review-without-score"><strong>Оценка не выставлена</strong><p>${d.language} · ${d.channel==='voice call'?t('голосовой звонок'):t('чат с оператором')}</p></div>`:
    ui`<div class="score-main"><div class="score-ring" style="--percent:${Math.min(100,Math.max(0,percent))}"><div class="score-value"><strong>${fmt(e?.final_score)}</strong><small>из 100 баллов</small></div></div><div class="score-info">${e ? current ? t('Итоговая оценка') : t('Предыдущая оценка') : t('Готов к проверке')}${e ? ui`<p class="score-source">${sourceNote}</p>` : ''}<p>${e ? ui`${e.criteria.length} критериев` : ui`${d.language} · ${d.channel === 'voice call' ? t('голосовой звонок') : t('чат с оператором')}`}</p><p>${e ? ui`Не учитывается: ${e.criteria.filter(r => r.is_na).length}` : ui`${state.checklist.criteria.length} критериев`}</p></div></div>`;
  $('#score-panel').innerHTML = reviewNotice+errorNotice+ui`${d.status === 'Stale' ? t('<div class="warning">Эту оценку нужно обновить.</div>') : ''}${scoreMain}${state.role === 'supervisor' ? ui`<button class="button primary" id="evaluate-button" ${!eligible ? 'disabled' : ''}>${state.busy ? t('Оценка выполняется…') : manualReview||failed ? t('Повторить проверку') : current ? t('Оценить повторно') : t('Оценить диалог')} <span aria-hidden="true">↗</span></button>` : ''}${!manualReview?ui`<p class="score-note ${d.evaluation_enabled===false?'dataset-hold-note':''}">${state.role==='operator'?'':scoreNote}</p>`:''}`;
  $('#assessment-actions').hidden=state.role!=='operator';$('#assessment-actions').innerHTML=operatorAssessmentActions(d);
  if (!e) {
    $('#criteria').innerHTML = state.checklist.criteria.map(c => ui`<div class="criterion"><div class="criterion-top"><span class="criterion-number">${escapeHTML(c.id)}</span><span class="criterion-name">${escapeHTML(t(c.name))}</span><span class="criterion-answer na">—</span></div><div class="criterion-math"><span>${c.type === 'flag' ? t('Без баллов') : ui`Вес ${fmt(c.weight)}`}</span><span>${c.allow_na ? t('Можно не учитывать') : t('Всегда применим')}</span></div></div>`).join('');
    return;
  }
  $('#criteria').innerHTML = renderEvaluatedCriteria(e,current);
}
function renderTranscript() {
  const show = $('#show-context').checked;
  const scrollTop=$('#transcript').scrollTop;
  const speakers = {client:t('Клиент'), operator:t('Оператор'), bot:t('Бот'), system:t('Система')};
  $('#transcript').innerHTML = state.detail.transcript.map((m,i) => {
    const hidden = !show && ['bot','system'].includes(m.speaker) ? 'hidden' : '';
    if (m.speaker === 'system') return ui`<div id="message-${i}" class="message system" ${hidden}><span>${escapeHTML(m.text)}</span><time>${escapeHTML(displayTime(m.timestamp))}</time></div>`;
    return ui`<article id="message-${i}" class="message ${m.speaker}" ${hidden}><div class="message-meta"><span class="speaker-avatar">${m.speaker === 'bot' ? 'AI' : m.speaker === 'operator' ? t('ОП') : t('КЛ')}</span><strong>${speakers[m.speaker]}</strong><time>${escapeHTML(displayTime(m.timestamp))}</time></div><div class="message-text">${escapeHTML(m.text)}</div></article>`;
  }).join('');
  $('#transcript').scrollTop=scrollTop;
}
async function seekProof(index) {
  setDetailView('transcript');
  const detail=state.detail;if(!detail) return;
  const m = detail.transcript[index];
  if (!m) return;
  if (['bot','system'].includes(m.speaker) && !$('#show-context').checked) { $('#show-context').checked = true; renderTranscript(); }
  const node = $(ui`#message-${index}`);
  node.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block:'center'});
  node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'),1800);
  cancelAudioSeek();
  if (detail.audio_url) {
    const audio = $('#audio');
    const sequence=audioSeekSequence, id=detail.conversation_id;
    const offset = offsetSeconds(m.timestamp,detail.transcript[0].timestamp);
    const seek = async () => {
      if(sequence !== audioSeekSequence || state.detail?.conversation_id !== id) return;
      pendingAudioSeek=null;
      audio.currentTime = Number.isFinite(audio.duration) ? Math.min(offset,audio.duration) : offset;
      try { await audio.play(); } catch { toast(t('Нажмите кнопку воспроизведения в записи.'),true); }
    };
    if (audio.readyState >= 1) await seek();
    else { pendingAudioSeek=seek;audio.addEventListener('loadedmetadata',seek,{once:true});audio.load(); }
  }
}
function dateTime(value) {
  return value ? new Date(value).toLocaleString(uiLocale(), {timeZone:'Asia/Almaty',dateStyle:'short',timeStyle:'short'}) : '—';
}
async function evaluateSelected() {
  if(!state.detail || state.detail.evaluation_enabled===false || state.busy || state.role!=='supervisor' || !hasAiBudget())return;
  const id=state.detail.conversation_id,force=state.detail.status==='Evaluated',role=state.role;
  const preview=await reviewAI({purpose:'evaluation',conversation_id:id,force,language:practiceLanguage()});
  if(!preview || role!==state.role || state.busy)return;
  state.busy=true;renderDetail();toast(t('Проверяем диалог…'));
  try {
    const result=await api(`/api/evaluate/${encodeURIComponent(id)}${force?'?force=true':''}`,{method:'POST',body:'{}',headers:{'X-AI-Preview':preview.preview_id}});
    updateBudget(result.budget);toast(result.status==='Review'?t('Нужен ручной разбор'):ui`Оценка: ${fmt(result.evaluation?.final_score)} из 100.`);
  } finally {state.busy=false;await loadData();}
}
async function submitBatch(form) {
  if(state.busy || state.role!=='supervisor' || !hasAiBudget())return;
  const ids=state.filtered.filter(item=>item.status!=='Evaluated'&&item.evaluation_enabled!==false).slice(0,Number(form.elements.count.value)).map(item=>item.id),role=state.role;
  if(!ids.length)return;
  $('#batch-dialog').close();
  const preview=await reviewAI({purpose:'batch',conversation_ids:ids,language:practiceLanguage()});
  if(!preview || role!==state.role || state.busy)return;
  state.busy=true;renderDetail();toast(ui`Проверяем диалоги: ${ids.length}.`);
  try {
    const result=await api('/api/evaluate-batch',{method:'POST',body:JSON.stringify({conversation_ids:ids}),headers:{'X-AI-Preview':preview.preview_id}});
    const summary=result.reviews?.length?ui`Оценено: ${result.completed.length}. Нужен ручной разбор: ${result.reviews.length}.`:ui`Проверено ${result.completed.length} диалогов.`;
    toast(result.error?summary+' '+t('Остальные диалоги не удалось проверить.'):summary,Boolean(result.error));
  } finally {state.busy=false;await loadData();}
}

function criterionDeficient(criterion) {
  return !criterion.is_na && criterion.value!=null && (criterion.type==='flag'?criterion.value===1:criterion.type==='scale'?criterion.value<criterion.max_scale:criterion.value===0);
}
function criterionAnswer(criterion) {
  return criterion.is_na?t('Не применяется'):criterion.type==='scale'?`${fmt(criterion.value)} / ${fmt(criterion.max_scale)}`:criterion.value===1?t('Да'):t('Нет');
}
function pendingCriterionAppeal(detail,criterionId) {return (detail?.appeals || []).find(appeal=>appeal.criterion_id===criterionId&&appeal.status==='PENDING');}
function appealableCriteria(detail) {
  return detail?.status==='Evaluated'&&detail.evaluation?(detail.evaluation.criteria || []).filter(criterion=>!pendingCriterionAppeal(detail,criterion.criterion_id)):[];
}
function operatorAssessmentActions(detail) {
  if(state.role!=='operator')return '';
  const pending=(detail.appeals || []).filter(appeal=>appeal.status==='PENDING').length;
  const available=appealableCriteria(detail);
  return ui`<div class="assessment-actions">${available.length?ui`<button type="button" class="button primary appeal-primary" data-appeal="">Подать апелляцию</button>`:pending?ui`<button type="button" class="button primary" data-action="pending-appeals">Мои апелляции</button>`:''}<button type="button" class="button subtle" data-action="jump-transcript">К переписке</button></div>${pending?ui`<button class="appeal-status-link" type="button" data-action="pending-appeals">На рассмотрении: ${pending}</button>`:''}`;
}
function criterionAppealAction(criterion,current=true) {
  if(!current || state.detail?.status!=='Evaluated')return '';
  const pending=pendingCriterionAppeal(state.detail,criterion.criterion_id);
  if(pending)return ui`<div class="criterion-appeal-state"><span class="badge amber">Апелляция на рассмотрении</span>${state.role==='supervisor'?ui`<button type="button" class="button subtle" data-resolve="${escapeHTML(pending.id)}">Рассмотреть апелляцию</button>`:ui`<button type="button" class="button subtle" data-action="pending-appeals">Мои апелляции</button>`}</div>`;
  return state.role==='operator'?ui`<button type="button" class="button subtle appeal-secondary" data-appeal="${escapeHTML(criterion.criterion_id)}">Подать апелляцию</button>`:'';
}
function shortExplanation(value,limit=170) {
  const text=String(value || '');
  return text.length<=limit?`<p>${escapeHTML(text)}</p>`:ui`<p>${escapeHTML(text.slice(0,limit).trim())}…</p><details class="explanation-more"><summary>Полный комментарий</summary><p>${escapeHTML(text)}</p></details>`;
}
function additionalEvidenceLinks(criterion) {
  const transcript=state.detail?.transcript || [];
  const turns=[...new Set(criterion.evidence_turns || [])].filter(turn=>Number.isInteger(turn)&&turn>0&&turn<=transcript.length&&turn-1!==criterion.proof_message_index).sort((a,b)=>a-b);
  const speakers={client:t('Клиент'),operator:t('Оператор'),bot:t('Бот'),system:t('Система')};
  return turns.length?ui`<div class="additional-evidence"><span>Другие подтверждающие реплики</span><div class="evidence-turns">${turns.map(turn=>ui`<button type="button" class="button subtle evidence-turn" data-proof="${turn-1}">${escapeHTML(t(`Реплика ${turn}`))}<span>${escapeHTML(speakers[transcript[turn-1].speaker] || transcript[turn-1].speaker)}</span></button>`).join('')}</div></div>`:'';
}
function renderEvaluatedCriteria(evaluation,current) {
  const previous=new Set($$('#criteria details.criterion[open]').map(node=>node.dataset.criterion));
  const criteria=[...evaluation.criteria];
  if(state.role==='operator')criteria.sort((a,b)=>Number(criterionDeficient(b))-Number(criterionDeficient(a)));
  return criteria.map(criterion=>{
    const deficient=criterionDeficient(criterion),pending=pendingCriterionAppeal(state.detail,criterion.criterion_id);
    const appeals=state.detail.appeals.filter(appeal=>appeal.criterion_id===criterion.criterion_id&&appeal.status!=='PENDING');
    return ui`<details class="criterion criterion-disclosure ${deficient?'has-issue':''}" data-criterion="${escapeHTML(criterion.criterion_id)}" ${previous.has(criterion.criterion_id)?'open':''}><summary><span class="criterion-summary-name">${escapeHTML(t(criterion.name))}</span><span class="criterion-answer ${criterion.is_na?'na':deficient?'fail':'pass'}">${criterionAnswer(criterion)}</span><span class="criterion-chevron" aria-hidden="true"></span></summary><div class="criterion-detail"><div class="criterion-math"><span>${criterion.type==='flag'?t('Не влияет на итог'):ui`Вклад в итог: ${fmt(criterion.normalized_weight)}%`}</span><span>${criterion.is_na?t('Не учитывается'):criterion.type!=='flag'?ui`Баллы: ${fmt(criterion.earned_score)}`:t('Отметка о нарушении')}</span></div><p class="criterion-reason">${criterion.override_comment?t('Решение руководителя: '):''}${escapeHTML(criterion.override_comment || criterion.reason)}</p><button type="button" class="proof" data-proof="${criterion.proof_message_index}" title="Перейти к реплике"><span class="proof-time">${escapeHTML(displayTime(criterion.proof_timestamp))}</span><span class="proof-quote">«${escapeHTML(criterion.proof_quote)}»</span></button>${additionalEvidenceLinks(criterion)}${criterion.override_comment?ui`<details class="appeal-history"><summary>Предыдущее обоснование</summary><p>${escapeHTML(criterion.reason)}</p></details>`:''}${pending?ui`<p class="pending-comment">${escapeHTML(pending.comment)}</p>`:''}<div class="criterion-actions">${criterionAppealAction(criterion,current)}</div>${appeals.map(appeal=>ui`<details class="appeal-history"><summary>${labels[appeal.status]} · ${dateTime(appeal.resolved_at)}</summary><p>${escapeHTML(appeal.comment)}</p><p>Решение: ${escapeHTML(appeal.resolution_comment)}</p></details>`).join('')}</div></details>`;
  }).join('');
}
function orderOperatorWorkspace() {setDetailView(state.detailView);}
const appealInFlight=new Set();
let appealSequence=0;
function closeAppealSession() {++appealSequence;state.appealSession=null;state.appealTarget=null;}
function appealSessionCurrent(session) {return Boolean(session && state.appealSession===session && session.sequence===appealSequence && state.role==='operator');}
function renderAppealSelection() {
  const session=state.appealSession;if(!session)return;
  $('#appeal-select').innerHTML=session.criteria.map(criterion=>ui`<option value="${escapeHTML(criterion.criterion_id)}" ${session.pending.has(criterion.criterion_id)?'disabled':''}>${escapeHTML(t(criterion.name))} — ${session.pending.has(criterion.criterion_id)?t('Апелляция на рассмотрении'):criterionAnswer(criterion)}</option>`).join('');
  $('#appeal-select').value=session.selected;
  const criterion=session.criteria.find(item=>item.criterion_id===session.selected);
  $('#appeal-criterion').textContent=ui`Диалог ${session.title || session.conversationId}`;
  $('#appeal-context').innerHTML=criterion?ui`<span class="badge">${criterionAnswer(criterion)}</span>${shortExplanation(criterion.override_comment || criterion.reason,220)}`:'';
  $('#appeal-error').hidden=!session.error;$('#appeal-error').textContent=session.error || '';
  $('#appeal-submit').disabled=session.submitting || session.locked || session.pending.has(session.selected) || !criterion;
  $('#appeal-submit').textContent=t(session.submitting?'Отправляем…':'Отправить апелляцию');
  $('#appeal-select').disabled=session.submitting || session.locked;
  $('#appeal-form').elements.comment.disabled=session.submitting;
  $('#appeal-form').setAttribute('aria-busy',String(session.submitting));
}
function selectAppealCriterion(id) {
  const session=state.appealSession;if(!session || session.submitting || session.locked)return;
  if(!session.criteria.some(criterion=>criterion.criterion_id===id) || session.pending.has(id))return;
  session.selected=id;session.error=null;
  state.appealTarget=Object.freeze({conversation_id:session.conversationId,criterion_id:id,evaluation_id:session.evaluationId});
  renderAppealSelection();
}
function openAppeal(id) {
  const detail=state.detail;
  if(state.role!=='operator' || detail?.status!=='Evaluated' || !detail.evaluation)return;
  const criteria=appealableCriteria(detail);if(!criteria.length)return void guarded(()=>setWorkspaceView('appeals'));
  const requested=id?criteria.find(criterion=>criterion.criterion_id===id):null;
  if(id&&!requested)return toast(t('По критерию уже есть ожидающая апелляция'),true);
  const selected=requested || criteria.find(criterionDeficient) || criteria[0];
  const session={sequence:++appealSequence,conversationId:detail.conversation_id,evaluationId:detail.evaluation.id,title:detail.title,
    criteria:detail.evaluation.criteria.map(criterion=>({...criterion})),pending:new Set(detail.appeals.filter(appeal=>appeal.status==='PENDING').map(appeal=>appeal.criterion_id)),
    selected:selected.criterion_id,submitting:false,locked:false,error:null};
  state.appealSession=session;$('#appeal-form').reset();selectAppealCriterion(session.selected);
  $('#appeal-dialog').showModal();
}
async function submitAppeal() {
  const session=state.appealSession;if(!appealSessionCurrent(session) || session.submitting || session.locked)return;
  const target=state.appealTarget;if(!target || session.pending.has(target.criterion_id))return;
  const form=$('#appeal-form'),comment=form.elements.comment.value.trim();
  if(comment.length<5){session.error=t('Поясните основание апелляции');renderAppealSelection();form.elements.comment.focus?.();return;}
  const key=JSON.stringify(target);
  if(appealInFlight.has(key)){session.error=t('Апелляция уже отправляется. Дождитесь результата.');renderAppealSelection();return;}
  appealInFlight.add(key);session.submitting=true;session.error=null;renderAppealSelection();
  try {
    const latest=await api(`/api/conversations/${encodeURIComponent(target.conversation_id)}`);
    if(!appealSessionCurrent(session))return;
    if(latest.status!=='Evaluated' || latest.evaluation?.id!==target.evaluation_id){session.locked=true;throw new Error(t('Оценка изменилась. Закройте форму и обновите диалог.'));}
    if(pendingCriterionAppeal(latest,target.criterion_id)) {
      session.pending.add(target.criterion_id);
      if(state.detail?.conversation_id===target.conversation_id){state.detail.appeals=latest.appeals;renderDetail();}
      throw new Error(t('По критерию уже есть ожидающая апелляция'));
    }
    if(!latest.evaluation.criteria.some(criterion=>criterion.criterion_id===target.criterion_id)){session.locked=true;throw new Error(t('Критерий не найден'));}
    const result=await post('/api/appeals/submit',{...target,comment});
    if(state.detail?.conversation_id===target.conversation_id&&state.detail.evaluation?.id===target.evaluation_id) {
      state.detail.appeals=[...state.detail.appeals.filter(appeal=>appeal.id!==result.id),result];renderDetail();
    }
    if(appealSessionCurrent(session)){$('#appeal-dialog').close();closeAppealSession();toast(t('Апелляция отправлена.'));}
    await loadData();
  } catch(error) {
    if(appealSessionCurrent(session)){session.error=error.message;if(error.status===409&&/измен|неактуаль/i.test(error.detail || ''))session.locked=true;if(error.status===409&&/ожидающая апелляция/i.test(error.detail || ''))session.pending.add(target.criterion_id);}
  } finally {
    appealInFlight.delete(key);session.submitting=false;
    if(appealSessionCurrent(session)){renderAppealSelection();if(session.error)$('#appeal-error').focus?.();}
  }
}

function openResolve(id) {
  const a = state.detail.appeals.find(a => a.id === id);
  if (!a) return;
  state.resolveAppeal = a;
  const c = state.checklist.criteria.find(c => c.id === a.criterion_id);
  const r = state.detail.evaluation.results.find(r => r.criterion_id === a.criterion_id);
  $('#resolve-form').reset();
  $('#resolve-criterion').textContent = ui`${c.id} · ${c.name}`;
  $('#operator-comment').textContent = a.comment;
  const options = c.type === 'scale' ? c.levels : [0,1];
  $('#resolve-value').innerHTML = options.map(value => ui`<option value="${value}">${c.type === 'scale' ? fmt(value) : value ? t('Да') : t('Нет')}</option>`).join('') + (c.allow_na ? t('<option value="na">Не применяется</option>') : '');
  $('#resolve-value').value = r.is_na ? 'na' : String(r.value);
  $('#resolve-value').disabled = false;
  $('#resolve-dialog').showModal();
}
function collectEditor() {
  state.edit = $$('.editor-criterion').map(node => {
    const v = name => $(ui`[data-field="${name}"]`,node);
    const type = v('type').value, allow_na = type !== 'flag' && v('allow_na').checked;
    return {id:v('id').value.trim(),name:v('name').value.trim(),description:v('description').value.trim(),
      type, weight:type === 'flag' ? 0 : Number(v('weight').value),max_scale:type === 'scale' ? Number(v('max_scale').value) : 1,
      levels:type === 'scale' ? v('levels').value.split(',').filter(s=>s.trim()).map(s => Number(s.trim())) : [],allow_na,na_condition:v('na_condition').value.trim()};
  });
}
function renderEditor() {
  $('#checklist-editor').innerHTML = state.edit.map((c,i) => ui`<section class="editor-criterion" data-index="${i}"><div class="editor-grid${c.type === "scale" ? " with-scale" : ""}"><input type="hidden" data-field="id" value="${escapeHTML(c.id)}"><label>Название<input data-field="name" value="${escapeHTML(c.name)}" required maxlength="160"></label><label>Тип<select data-field="type">${[['binary',t('Да / Нет')],['scale',t('Баллы')],['flag',t('Без баллов')]].map(([v,l]) => ui`<option value="${v}" ${c.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label>Вес<input data-field="weight" type="number" min="0" max="10000" step="any" value="${c.weight}" ${c.type === 'flag' ? 'disabled' : ''} required></label><label ${c.type !== "scale" ? "hidden" : ""}>Макс. балл<input data-field="max_scale" type="number" min="0.01" max="10000" step="any" value="${c.max_scale}" ${c.type !== 'scale' ? 'disabled' : ''} required></label><button type="button" class="icon-button remove-criterion" aria-label="Удалить критерий ${escapeHTML(c.id)}">×</button></div><label ${c.type !== 'scale' ? 'hidden' : ''}>Допустимые баллы (через запятую)<input class="editor-levels" aria-describedby="levels-help-${i}" data-field="levels" value="${escapeHTML(c.levels.join(', '))}" placeholder="0, 5, 10, 15, 20"></label><p id="levels-help-${i}" class="field-help" ${c.type !== 'scale' ? 'hidden' : ''}>Можно поставить только баллы из этого списка.</p><div class="editor-na"><input data-field="allow_na" id="na-${i}" type="checkbox" ${c.allow_na ? 'checked' : ''} ${c.type === 'flag' ? 'disabled' : ''}><label for="na-${i}">Можно не учитывать</label></div><details class="editor-rules"><summary>Правило и исключения</summary><div class="editor-detail"><label>Правило<textarea data-field="description" rows="3" required maxlength="2500">${escapeHTML(c.description)}</textarea></label><label>Когда не учитывать<textarea data-field="na_condition" rows="3" maxlength="1000" ${!c.allow_na || c.type === 'flag' ? 'disabled' : 'required'}>${escapeHTML(c.na_condition)}</textarea></label></div></details></section>`).join('');
  $('#weight-total').textContent = ui`Сумма весов: ${fmt(state.edit.reduce((s,c) => s+c.weight,0))}`;
}
function openChecklist() {
  if (state.busy) return toast(t('Дождитесь завершения оценки.'),true);
  state.edit = structuredClone(state.checklist.criteria);
  state.editVersion = state.checklist.version;
  $('#editor-version').textContent = ui`v${state.editVersion}`;
  renderEditor(); $('#checklist-dialog').showModal();
}
function download(name,data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}));
  const a = document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
async function openAudit() {
  const data = await api('/api/audit'); state.audit = data.events;
  const actions = {external_ai_request:t('Подтверждён запрос к AI'),ai_privacy_updated:t('Изменены настройки защиты данных'),assistant_completed:t('Помощник подготовил ответ'),assistant_failed:t('Ошибка помощника'),conversation_imported:t('Добавлен диалог'),dataset_imported:t('Диалоги загружены'),checklist_updated:t('Правила обновлены'),evaluation_started:t('Начата оценка'),evaluation_completed:t('Оценка завершена'),evaluation_failed:t('Ошибка оценки'),appeal_submitted:t('Подана апелляция'),appeal_resolved:t('Принято решение по апелляции'),test_result_archived:t('Тестовая оценка перенесена в историю')};
  $('#audit-content').innerHTML = [...data.events].reverse().map(e => ui`<article class="audit-event"><time>${dateTime(e.timestamp)}<br>UTC+5</time><div><strong>${actions[e.action] || escapeHTML(e.action)}</strong><p>${escapeHTML(e.conversation_id || e.appeal?.conversation_id || '')}${e.appeal ? ui` · ${escapeHTML(e.appeal.criterion_id)} · ${labels[e.appeal.status]}` : ''}</p>${e.appeal ? ui`<p>${escapeHTML(e.appeal.resolution_comment || e.appeal.comment)}</p>` : ''}${e.before && e.after ? ui`<p>Балл: ${fmt(e.before.final_score)} → ${fmt(e.after.final_score)}</p>` : e.version ? ui`<p>Правила обновлены</p>` : ""}</div></article>`).join('') || t('<div class="empty">Журнал пока пуст</div>');
  $('#audit-dialog').showModal();
}
function evaluationDeductions(evaluation) {
  return (evaluation?.criteria || []).filter(r=>r.type !== 'flag' && !r.is_na && r.normalized_weight-r.earned_score>0.00001)
    .map(r=>({...r,loss:r.normalized_weight-r.earned_score}));
}
function renderDeductions(evaluation,current) {
  const items=(evaluation?.criteria || []).filter(criterion=>criterion.type!=='flag'&&criterionDeficient(criterion)),node=$('#deductions');node.hidden=!items.length;
  node.innerHTML=items.length?ui`<h3>${current?t('Что требует внимания'):t('В предыдущей оценке')}</h3>`+items.map(criterion=>{
    const loss=criterion.normalized_weight-criterion.earned_score;
    return ui`<article class="deduction-row"><div class="deduction-top"><span>${escapeHTML(t(criterion.name))}</span>${loss>0?ui`<span class="deduction-loss" title="Снижение общего балла">−${fmt(loss)}</span>`:''}</div>${shortExplanation(criterion.override_comment || criterion.reason)}${renderCoaching(criterion)}<div class="issue-actions">${criterionAppealAction(criterion,current)}<button type="button" class="button tertiary" data-proof="${criterion.proof_message_index}">К фрагменту</button></div></article>`;
  }).join(''):'';
}
function renderViolations(evaluation,current) {
  const items=(evaluation?.criteria || []).filter(criterion=>criterion.type==='flag'&&criterionDeficient(criterion)),node=$('#violations');node.hidden=!items.length;
  node.innerHTML=items.length?ui`<h3>${current?t('Грубые ошибки'):t('Грубые ошибки в предыдущей оценке')}</h3>`+items.map(criterion=>ui`<article class="deduction-row">${items.length===1&&criterion.name.trim().toLocaleLowerCase()==='грубые ошибки'?'':ui`<div class="deduction-top"><span>${escapeHTML(t(criterion.name))}</span></div>`}${shortExplanation(criterion.override_comment || criterion.reason)}${renderCoaching(criterion)}<div class="issue-actions">${criterionAppealAction(criterion,current)}<button type="button" class="button tertiary" data-proof="${criterion.proof_message_index}">К фрагменту</button></div></article>`).join(''):'';
}
async function showGrossConversations() {
  clearTimeout(searchTimer);++filterSequence;state.searchIds=null;state.assistantFilters=null;state.assistantIds=null;
  for(const id of ['search','language','channel','status']) $(ui`#${id}`).value='';
  $('#gross-only').checked=true;
  await setWorkspaceView('conversations');await filterConversations({keepSelection:false});
  if(matchMedia('(max-width:1190px)').matches)toggleConversationList(true);
}
function toggleConversationList(force) {
  const open=typeof force === 'boolean'?force:!document.body.classList.contains('list-open');
  document.body.classList.toggle('list-open',open);
  $('#conversations-view .queue-backdrop').hidden=!open;
  $('[data-action="toggle-list"]').setAttribute('aria-expanded',String(open));
  if(open) $('#search').focus?.();
}
async function setWorkspaceView(view,{updateHistory=true}={}) {
  if(!['conversations','appeals','analytics'].includes(view)) return;
  if(view === 'analytics' && state.role !== 'supervisor') view='conversations';
  const sequence=++viewSequence;state.view=view;toggleConversationList(false);
  document.body.dataset.view=view;
  for(const name of ['conversations','appeals','analytics']) $(ui`#${name}-view`).hidden=name!==view;
  const title={conversations:t('Диалоги'),appeals:t('Апелляции'),analytics:t('Аналитика')}[view];
  $('#page-title').textContent=title;$('#workspace-crumb').textContent=title;
  $('#page-description').textContent=t({conversations:'Проверяйте диалоги, находите причины снижения оценки и разбирайте апелляции.',appeals:'Прозрачные решения по спорным оценкам. Все обращения команды в одном месте.',analytics:'Общая картина качества: охват проверок, распределение баллов и результаты по каналам.'}[view]);
  $$('[data-workspace-view]').forEach(button=>{
    const active=button.dataset.workspaceView===view;button.classList.toggle('active',active);
    if(active) button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  });
  if(updateHistory && window.history && window.location?.hash!==ui`#${view}`) window.history.pushState(null,'',ui`#${view}`);
  if(view === 'analytics') renderAnalytics();
  if(view === 'appeals') {
    $('#appeals-content').innerHTML=t('<div class="loading">Загрузка апелляций…</div>');
    try {
      const result=await api('/api/appeals');if(sequence!==viewSequence)return;
      state.appealItems=result.items;renderAppeals();
    } catch(error) {
      if(sequence!==viewSequence)return;
      $('#appeals-content').innerHTML=t('<div class="empty">Не удалось загрузить апелляции. Откройте раздел ещё раз.</div>');
      throw error;
    }
  }
}
function renderAppeals() {
  const selected=$('#appeals-filter').value;
  const scoped=state.appealItems.filter(a=>!state.datasetGroup || state.items.some(item=>item.id===a.conversation_id));
  const items=scoped.filter(a=>!selected || (selected==='resolved'?a.status!=='PENDING':a.status===selected));
  const pending=scoped.filter(a=>a.status==='PENDING').length;
  $('#appeals-total').textContent=ui`Всего: ${scoped.length} · Ожидают решения: ${pending}`;
  $('#appeals-content').innerHTML=items.length?ui`<div class="table-scroll"><table class="data-table"><thead><tr><th scope="col">Диалог</th><th scope="col">Критерий</th><th scope="col">Комментарий</th><th scope="col">Статус</th><th scope="col">Создана</th><th scope="col"><span class="sr-only">Действие</span></th></tr></thead><tbody>${items.map(a=>ui`<tr><td><strong>${escapeHTML(a.conversation_id)}</strong><small>${escapeHTML(languageNames[a.language] || t('Диалог недоступен'))}${a.channel?' · '+(a.channel==='voice call'?t('Звонок'):t('Чат')):''}</small></td><td>${escapeHTML(t(a.criterion_name))}</td><td><p class="table-comment">${escapeHTML(a.comment)}</p>${a.resolution_comment?ui`<details class="appeal-history"><summary>Решение</summary><p>${escapeHTML(a.resolution_comment)}</p></details>`:''}</td><td><span class="badge ${a.status==='PENDING'?'amber':a.status==='APPROVED'?'green':''}">${labels[a.status] || escapeHTML(a.status)}</span></td><td>${escapeHTML(dateTime(a.created_at))}</td><td><button class="button subtle" data-open-appeal="${escapeHTML(a.id)}" ${a.conversation_available?'':'disabled'}>${a.status==='PENDING'&&state.role==='supervisor'?t('Рассмотреть'):t('Открыть')}</button></td></tr>`).join('')}</tbody></table></div>`:t('<div class="empty">Апелляций по выбранному условию нет.</div>');
}
async function openAppealConversation(id) {
  const appeal=state.appealItems.find(a=>a.id===id);if(!appeal?.conversation_available)return;
  clearTimeout(searchTimer);++filterSequence;state.searchIds=null;state.assistantFilters=null;state.assistantIds=null;setDetailView('assessment');
  for(const name of ['search','language','channel','status']) $(ui`#${name}`).value='';
  $('#gross-only').checked=false;
  await setWorkspaceView('conversations');await selectConversation(appeal.conversation_id);
  $('.conversation-item.selected')?.scrollIntoView({block:'nearest'});
  const current=state.detail?.appeals.find(a=>a.id===id);
  if(current?.status==='PENDING'&&state.role==='supervisor') openResolve(id);
}
function analyticsSummary(items) {
  const checked=items.filter(r=>r.status==='Evaluated');
  const scores=checked.filter(r=>Number.isFinite(r.score));
  const average=rows=>{const values=rows.filter(r=>Number.isFinite(r.score));return values.length?values.reduce((sum,r)=>sum+r.score,0)/values.length:null;};
  return {total:items.length,checked:checked.length,average:average(scores),violations:checked.filter(r=>r.has_gross_violation).length,
    buckets:[{label:'0–49',count:scores.filter(r=>r.score<50).length},{label:'50–74',count:scores.filter(r=>r.score>=50&&r.score<75).length},{label:'75–100',count:scores.filter(r=>r.score>=75).length}],
    languages:['RU','KZ','EN'].map(language=>({label:languageNames[language],total:items.filter(r=>r.language===language).length,
      checked:checked.filter(r=>r.language===language).length,average:average(checked.filter(r=>r.language===language))})),
    channels:['agent chat','voice call'].map(channel=>({label:channel==='voice call'?t('Звонки'):t('Чаты'),total:items.filter(r=>r.channel===channel).length,
      checked:checked.filter(r=>r.channel===channel).length,average:average(checked.filter(r=>r.channel===channel))}))};
}
function renderAnalytics() {
  if(!state.checklist) {$('#analytics-content').innerHTML=t('<div class="loading">Загрузка данных…</div>');return;}
  const summary=analyticsSummary(state.items),percent=summary.total?summary.checked/summary.total*100:0;
  const maximum=Math.max(1,...summary.buckets.map(b=>b.count));
  const table=rows=>ui`<div class="table-scroll"><table class="data-table compact"><thead><tr><th scope="col">Группа</th><th scope="col" class="numeric">Диалогов</th><th scope="col" class="numeric">С оценкой ИИ</th><th scope="col" class="numeric">Средний балл</th></tr></thead><tbody>${rows.map(r=>ui`<tr><td>${escapeHTML(r.label)}</td><td class="numeric">${fmt(r.total,0)}</td><td class="numeric">${fmt(r.checked,0)}</td><td class="numeric">${fmt(r.average,2)}</td></tr>`).join('')}</tbody></table></div>`;
  const groupBreakdown=!state.datasetGroup&&state.groups.length>1?ui`<section class="insight-section full-width dataset-breakdown"><h2>По наборам</h2><div class="table-scroll"><table class="data-table compact"><thead><tr><th scope="col">Набор</th><th scope="col" class="numeric">Диалогов</th><th scope="col" class="numeric">С оценкой ИИ</th><th scope="col" class="numeric">Средний балл</th><th scope="col">Назначение</th></tr></thead><tbody>${state.groups.map(group=>{
    const row=analyticsSummary(state.allItems.filter(item=>item.dataset_group===group.id));
    const purpose=group.id==='DEV'?'Тестовый набор':group.id==='FBroker'?'Контрольный набор':group.id==='SWAP'?'Ожидает инструкции':'Загруженные';
    return ui`<tr><td><button class="button tertiary" data-dataset-group="${escapeHTML(group.id)}">${escapeHTML(datasetLabel(group.id))}</button></td><td class="numeric">${row.total}</td><td class="numeric">${row.checked}</td><td class="numeric">${fmt(row.average,2)}</td><td>${t(purpose)}</td></tr>`;
  }).join('')}</tbody></table></div></section>`:'';
  $('#analytics-content').innerHTML=ui`<div class="insights-layout">${groupBreakdown}<section class="insight-section"><h2>Оценка диалогов</h2><p class="quiet">Оценки ИИ с учётом решений по апелляциям</p><div class="coverage"><strong>${summary.checked}</strong><span>из ${summary.total} диалогов</span></div><div class="coverage-bar" role="img" aria-label="Оценено ИИ ${summary.checked} из ${summary.total}"><span style="width:${percent}%"></span></div><div class="coverage-legend"><span>С оценкой ИИ: ${summary.checked}</span><span>Без актуальной оценки: ${summary.total-summary.checked}</span></div><p class="quiet">Грубые нарушения в оценённых диалогах: ${summary.violations}</p><button class="button ghost" data-action="show-gross">Показать диалоги с грубыми ошибками ↗</button></section><section class="insight-section"><h2>Распределение баллов</h2><p class="quiet">Только диалоги с рассчитанным баллом</p>${summary.buckets.map(b=>ui`<div class="distribution-row"><span>${b.label}</span><div class="distribution-track" role="img" aria-label="${b.label} баллов: ${b.count} диалогов"><span style="width:${b.count/maximum*100}%"></span></div><span class="distribution-number">${b.count}</span></div>`).join('')}</section><section class="insight-section full-width"><h2>По языкам</h2><p class="quiet">Средний балл по актуальным оценкам</p>${table(summary.languages)}</section><section class="insight-section full-width"><h2>По каналам</h2>${table(summary.channels)}</section></div>`;
}
function showUploadError(message) {
  const node=$('#upload-error');node.textContent=t(message);node.hidden=false;
  node.scrollIntoView({block:'nearest'});
}
function rememberJsonConversation() {
  const item=uploadConversations[uploadIndex];if(!item)return;
  const form=$('#upload-form');
  item.title=form.elements.title.value;item.language=form.elements.language.value;item.channel=form.elements.channel.value;
  if(item.text!==form.elements.text.value){item.text=form.elements.text.value;delete item.transcript;}
}
function showJsonConversation(index) {
  uploadIndex=index;
  const item=uploadConversations[index],form=$('#upload-form');if(!item)return;
  form.elements.title.value=item.title;form.elements.text.value=item.text;item.text=form.elements.text.value;
  form.elements.language.value=item.language || 'RU';form.elements.channel.value=item.channel;
}
function resetUploadImage() {
  if(uploadImageURL && typeof URL!=='undefined')URL.revokeObjectURL(uploadImageURL);
  uploadImageURL=null;uploadIsImage=false;
  $('#upload-image-preview').hidden=true;$('#upload-preview-image').removeAttribute('src');
  $('#upload-ocr-notice').hidden=true;$('#upload-ocr-confirmation').hidden=true;
  $('#upload-reviewed').checked=false;
}
function openUpload() {
  ++uploadSequence;uploadConversations=[];uploadIndex=0;$('#upload-json-choice').hidden=true;resetUploadImage();
  $('#upload-form').reset();$('#upload-error').hidden=true;$('#upload-file-status').hidden=true;
  $('#upload-submit').disabled=false;$('#upload-submit').textContent=t('Добавить диалог');
  $('#upload-dialog').showModal();$('.upload-body').scrollTop=0;
}
async function readUploadFile(file) {
  if(!file)return;
  const sequence=++uploadSequence, form=$('#upload-form');
  $('#upload-error').hidden=true;
  form.classList.remove('busy');$('#upload-submit').disabled=false;
  $('#upload-file-status').hidden=true;
  if(file.size>5*1024*1024) {showUploadError(t('Размер файла должен быть не больше 5 МБ.'));return;}
  resetUploadImage();uploadConversations=[];uploadIndex=0;$('#upload-json-choice').hidden=true;
  uploadIsImage=/\.(png|jpe?g|webp)$/i.test(file.name);
  if(uploadIsImage && typeof URL!=='undefined' && typeof URL.createObjectURL==='function') {
    uploadImageURL=URL.createObjectURL(file);$('#upload-preview-image').src=uploadImageURL;$('#upload-image-preview').hidden=false;
  }
  $('#upload-file-status').hidden=false;$('#upload-file-status').textContent=t(uploadIsImage?'Распознаём текст на фото…':'Читаем документ…');
  $('#upload-submit').disabled=true;form.classList.add('busy');
  try {
    const result=await api(ui`/api/conversations/extract?filename=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
    if(sequence!==uploadSequence)return;
    uploadConversations=result.conversations || [];uploadIndex=0;
    $('#upload-json-choice').hidden=uploadConversations.length<2;
    if(uploadConversations.length) {
      $('#upload-json-select').innerHTML=uploadConversations.map((item,i)=>ui`<option value="${i}">${escapeHTML(item.title)}</option>`).join('');
      showJsonConversation(0);
      $('#upload-file-status').textContent=uploadConversations.length>1 ? ui`В файле диалогов: ${uploadConversations.length}. Выберите нужный для добавления.` : t('Диалог загружен. Проверьте реплики перед добавлением.');
    } else {
      form.elements.text.value=result.text;
      form.elements.title.value=file.name.replace(/\.[^.]+$/,'').slice(0,120);
      uploadIsImage=result.source==='image';
      $('#upload-ocr-notice').hidden=!uploadIsImage;$('#upload-ocr-confirmation').hidden=!uploadIsImage;
      $('#upload-file-status').textContent=t(uploadIsImage?'Текст распознан. Проверьте его и укажите роли участников.':'Текст загружен. Проверьте реплики перед добавлением.');
    }
  } catch(error) {
    if(sequence!==uploadSequence)return;
    resetUploadImage();showUploadError(error.message);$('#upload-file-status').hidden=true;
  } finally {if(sequence===uploadSequence){form.classList.remove('busy');$('#upload-submit').disabled=false;}}
}
async function importUpload(form) {
  $('#upload-error').hidden=true;
  if(uploadIsImage && !$('#upload-reviewed').checked) {showUploadError(t('Подтвердите, что проверили текст и роли участников.'));$('#upload-reviewed').focus?.();return;}
  $('#upload-submit').disabled=true;$('#upload-submit').textContent=t('Добавляем…');form.classList.add('busy');
  try {
    rememberJsonConversation();
    const item=uploadConversations[uploadIndex];
    const result=await post('/api/conversations/import',{title:form.elements.title.value.trim(),
      ...(item?.transcript?{transcript:item.transcript}:{text:form.elements.text.value}),
      language:form.elements.language.value,channel:form.elements.channel.value});
    clearTimeout(searchTimer);++filterSequence;state.searchIds=null;
    for(const id of ['search','language','channel','status']) $(ui`#${id}`).value='';
    $('#gross-only').checked=false;
    state.datasetGroup=null;try{sessionStorage.removeItem('cqa-dataset-group');}catch{}
    state.selected=result.id;$('#upload-dialog').close();
    await setWorkspaceView('conversations');await loadData();
    toast(t('Диалог добавлен.'));
  } catch(error) {
    if($('#upload-dialog').open){showUploadError(error.message);}
    else toast(t('Диалог сохранён, но список не обновился. Нажмите «Обновить».'),true);
  }
  finally {form.classList.remove('busy');$('#upload-submit').disabled=false;$('#upload-submit').textContent=t('Добавить диалог');}
}
/* Practice has its own immutable target: changing the selected conversation cannot
   redirect an in-flight check. Drafts and request IDs remain in this page session. */
const practiceDrafts=new Map(),practiceRequests=new Map();
let practiceSequence=0;
function coachingText(item,field) { const value=item?.[field] || '';return item?.source==='rule'?t(value):value; }
function criterionCoaching(criterion) {
  if(state.detail?.status!=='Evaluated' || criterion.is_na)return null;
  const deficient=criterion.type==='flag'?criterion.value===1:criterion.type==='scale'?criterion.value<criterion.max_scale:criterion.value===0;
  return deficient?(state.detail.coaching || []).find(item=>item.criterion_id===criterion.criterion_id):null;
}
function renderCoaching(criterion) {
  const coaching=criterionCoaching(criterion);if(!coaching)return '';
  const practiceButton=state.role==='operator'?ui`<button type="button" class="button subtle coaching-button" data-practice="${escapeHTML(criterion.criterion_id)}">Отработать навык</button>`:'';
  const sourceNote=coaching.source==='rule'?ui`<p class="quiet">На основе правил</p>`:'';
  return ui`<section class="coaching-card"><div class="coaching-heading"><span class="coaching-icon" aria-hidden="true">↗</span><h4>Рекомендация</h4></div>${sourceNote}${shortExplanation(coachingText(coaching,'recommendation'),160)}${practiceButton}</section>`;
}
function practiceDraftKey(session) {return [session.conversationId,session.criterionId,session.data?.exercise_key || session.evaluationId].join(':');}
function savePracticeDraft(session=state.practice) {
  if(session?.data)practiceDrafts.set(practiceDraftKey(session),$('#practice-answer').value);
}
function clearPractice() {savePracticeDraft();++practiceSequence;state.practice=null;}
function practiceStillCurrent(session) {return state.practice===session && session.sequence===practiceSequence && session.role===state.role;}
function practicePath(session) {return `/api/practice/${encodeURIComponent(session.conversationId)}/${encodeURIComponent(session.criterionId)}`;}
function practiceLanguage() {return window.CQA_I18N?.language() || 'ru';}
function cachedPracticeAttempt(session) {
  const answer=$('#practice-answer').value.trim();
  return (session?.data?.attempts || []).find(attempt=>attempt.answer?.trim()===answer && attempt.feedback_language===practiceLanguage());
}
function updatePracticeControls() {
  const session=state.practice;if(!session)return;
  const budget=state.budget,cached=Boolean(cachedPracticeAttempt(session));
  const answer=$('#practice-answer').value.trim();
  $('#practice-submit').disabled=!session.data || session.loading || session.pending || session.locked || state.busy || !answer || (!cached && !hasAiBudget(budget));
  $('#practice-submit').textContent=t(session.pending?'Проверяем ответ…':'Проверить ответ');
  $('#practice-answer').disabled=Boolean(session.pending || session.locked);
  $('#practice-form').setAttribute('aria-busy',String(Boolean(session.loading || session.pending)));
  $('#practice-cost').textContent=cached?t('Этот ответ уже проверен. Повторная проверка не расходует запрос.'):t('Одна проверка ответа — 1 запрос к ИИ.');
  $('#practice-availability').textContent=session.pending?t('Проверяем ответ. Можно закрыть окно: результат сохранится в истории.'):
    session.loading?t('Открытие упражнения не расходует запросы.'):
    session.locked?t('Закройте упражнение и обновите диалог перед новой попыткой.'):
    state.busy?t('Дождитесь завершения проверки.'):
    externalBlocked()&&!cached?t('Внешняя AI-обработка запрещена в настройках.'):
    !budget.configured&&!cached?t('Проверка ответа недоступна. Обратитесь к администратору.'):
    !hasAiBudget(budget)&&!cached?t('Лимит проверок исчерпан.'):
    budget.unlimited?t('Лимит проверок отключён'):
    ui`Осталось проверок: ${fmt(budget.remaining,0)} из ${fmt(budget.limit,0)}.`;
}
function practiceFeedbackText(value) {
  return Array.isArray(value)?`<ul>${value.map(item=>`<li>${escapeHTML(item)}</li>`).join('')}</ul>`:`<p>${escapeHTML(value || '—')}</p>`;
}
function practiceFeedbackMarkup(attempt,{history=false,cached=false}={}) {
  const completed=attempt.status==='COMPLETED';
  return ui`<div class="practice-feedback-heading"><span class="badge ${completed?'green':'amber'}">${completed?t('Упражнение выполнено'):t('Нужно доработать')}</span><time>${escapeHTML(dateTime(attempt.created_at))}</time></div>${cached?ui`<p class="practice-cached">Сохранённая проверка · новый запрос не использован</p>`:''}${!history?ui`<details class="practice-reviewed-answer"><summary>Проверенный ответ</summary><blockquote>${escapeHTML(attempt.answer)}</blockquote></details>`:''}<div class="practice-feedback-sections"><section><h4>Что получилось</h4>${practiceFeedbackText(attempt.worked)}</section><section><h4>Что улучшить</h4>${practiceFeedbackText(attempt.improve)}</section><section><h4>Почему</h4>${practiceFeedbackText(attempt.why)}</section></div>${!history&&!completed?ui`<button type="button" class="button subtle" data-practice-retry>Доработать ответ</button>`:''}`;
}
function renderPracticeFeedback() {
  const session=state.practice;if(!session?.data)return;
  const attempts=[...(session.data.attempts || [])].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
  const latest=session.feedback || attempts[0];
  $('#practice-feedback').hidden=!latest;
  $('#practice-feedback').innerHTML=latest?practiceFeedbackMarkup(latest,{cached:session.cached}):'';
  const previous=attempts.filter(attempt=>attempt.id!==latest?.id);
  $('#practice-history').hidden=!previous.length;
  $('#practice-history').innerHTML=previous.length?ui`<details><summary>Предыдущие попытки <span>${fmt(previous.length,0)}</span></summary><div class="practice-attempts">${previous.map(attempt=>ui`<article><h4>Ваш ответ</h4><blockquote>${escapeHTML(attempt.answer)}</blockquote>${practiceFeedbackMarkup(attempt,{history:true})}</article>`).join('')}</div></details>`:'';
}
function renderPractice() {
  const session=state.practice;if(!session)return;
  const data=session.data;
  $('#practice-title').textContent=data?t(data.criterion.name):t('Отработать навык');
  $('#practice-identity').textContent=ui`Диалог ${session.title || session.conversationId} · ${session.criterionId}`;
  $('#practice-loading').hidden=!session.loading;
  $('#practice-content').hidden=!data;
  $('#practice-error').hidden=!session.error;
  $('#practice-error').textContent=session.error || '';
  if(data) {
    $('#practice-issue').textContent=data.issue || '';
    $('#practice-task').textContent=coachingText(data,'task');
    $('#practice-recommendation').textContent=coachingText(data,'recommendation');
    $('#practice-rule').textContent=data.criterion.description || '';
    $('#practice-source').textContent=t(data.source==='rule'?'На основе правил':'По результатам оценки');
    const speakers={client:t('Клиент'),operator:t('Оператор'),bot:t('Бот'),system:t('Система')};
    const context=data.context || [],previous=context.slice(0,-5),recent=context.slice(-5);
    const messages=items=>items.map(message=>ui`<article class="practice-message ${message.index===data.target_message_index?'practice-target':''}"><div><strong>${speakers[message.speaker] || escapeHTML(message.speaker)}</strong><time>${escapeHTML(displayTime(message.timestamp))}</time></div><p>${escapeHTML(message.text)}</p></article>`).join('');
    $('#practice-context').innerHTML=(previous.length?ui`<details class="practice-earlier"><summary>Предыдущие сообщения <span>${fmt(previous.length,0)}</span></summary>${messages(previous)}</details>`:'')+messages(recent);
    renderPracticeFeedback();
  }
  updatePracticeControls();
}
async function openPractice(criterionId) {
  const detail=state.detail;
  if(detail?.status!=='Evaluated' || !(detail.coaching || []).some(item=>item.criterion_id===criterionId))return;
  savePracticeDraft();
  const session={sequence:++practiceSequence,conversationId:detail.conversation_id,criterionId,evaluationId:detail.evaluation.id,
    title:detail.title,role:state.role,loading:true,pending:false,locked:false,data:null,error:null};
  state.practice=session;$('#practice-answer').value='';
  $('#practice-dialog').showModal();renderPractice();$('.practice-body').scrollTop=0;
  try {
    const result=await api(practicePath(session));
    if(!practiceStillCurrent(session))return;
    if(result.evaluation_id!==session.evaluationId) {
      session.locked=true;session.error=t('Оценка изменилась. Закройте упражнение и обновите диалог.');return;
    }
    session.data=result;
    const draftKey=practiceDraftKey(session),latest=[...(result.attempts || [])].sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))[0];
    $('#practice-answer').value=practiceDrafts.has(draftKey)?practiceDrafts.get(draftKey):(latest?.answer || '');
    if(result.budget)updateBudget(result.budget);
  } catch(error) {
    if(practiceStillCurrent(session))session.error=error.message;
  } finally {if(practiceStillCurrent(session)){session.loading=false;renderPractice();const context=$('#practice-context');context.scrollTop=context.scrollHeight;}}
}
function practiceRequestId() {
  if(window.crypto?.randomUUID)return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.floor(Math.random()*16);return(c==='x'?n:(n&3)|8).toString(16);});
}
async function submitPractice() {
  const session=state.practice;if(!session?.data || session.loading || session.pending || session.locked || state.busy)return;
  const answer=$('#practice-answer').value.trim();if(!answer)return;
  const cached=cachedPracticeAttempt(session);
  if(cached){session.feedback=cached;session.cached=true;renderPracticeFeedback();return;}
  if(!hasAiBudget()){updatePracticeControls();return;}
  const language=practiceLanguage(),requestKey=JSON.stringify([practiceDraftKey(session),answer,language]);
  if(!practiceRequests.has(requestKey))practiceRequests.set(requestKey,practiceRequestId());
  const payload={exercise_key:session.data.exercise_key,evaluation_id:session.evaluationId,answer,language,request_id:practiceRequests.get(requestKey)};
  savePracticeDraft(session);session.pending=true;session.error=null;state.busy=true;renderPractice();if(state.detail)renderDetail();
  try {
    const preview=await reviewAI({purpose:'practice',conversation_id:session.conversationId,criterion_id:session.criterionId,answer,language});
    if(!preview || !practiceStillCurrent(session))return;
    const result=await post(practicePath(session),{...payload,preview_id:preview.preview_id});
    if(result.budget)updateBudget(result.budget);
    if(!practiceStillCurrent(session))return;
    const attempts=session.data.attempts || [];
    session.data.attempts=[...attempts.filter(attempt=>attempt.id!==result.attempt.id),result.attempt];
    session.feedback=result.attempt;session.cached=Boolean(result.cached);
    renderPracticeFeedback();$('#practice-feedback').scrollIntoView({block:'nearest',behavior:'smooth'});
  } catch(error) {
    // A network interruption may hide a successful response, so retain that ID.
    // A definite failed response can be retried as a new, explicitly paid check.
    if(error.status)practiceRequests.delete(requestKey);
    try {const health=await api('/api/health');if(health.budget)updateBudget(health.budget);}catch {/* Preserve the original error and draft if the server is unreachable. */}
    if(!practiceStillCurrent(session))return;
    session.error=error.message;
    if(error.status===409 && /измен|неактуаль|устар|не найден|не требует|Для практики|нет актуальной ошибки/i.test(error.detail || ''))session.locked=true;
  } finally {
    state.busy=false;session.pending=false;
    if(state.detail)renderDetail();else updateBudget(state.budget);
    if(practiceStillCurrent(session)){renderPractice();if(session.error)$('#practice-error').scrollIntoView({block:'nearest'});}
    else if(state.practice)updatePracticeControls();
  }
}

function setDetailView(view,{focus=false}={}) {
  if(!['assessment','transcript'].includes(view))return;
  state.detailView=view;
  for(const name of ['assessment','transcript']) {
    const tab=$(`#${name}-tab`);tab.setAttribute('aria-selected',String(view===name));tab.setAttribute('tabindex',view===name?'0':'-1');
    $(`#${name}-pane`).hidden=view!==name;
  }
  if(focus)$(`#${view}-tab`).focus?.();
}
function externalBlocked() {return Boolean(state.privacy?.block_external_ai || state.budget.external_blocked);}
function applyPrivacy(policy) {
  if(policy)state.privacy=policy;
  if(state.privacy) {
    $('#privacy-mask').checked=state.privacy.mask_personal_data;$('#privacy-block').checked=state.privacy.block_external_ai;
    state.budget.external_blocked=state.privacy.block_external_ai;
  }
  updateBudget(state.budget);updateAssistantControls();
}
async function openSettings() {
  const form=$('#settings-form');form.elements.token.value=state.token;form.elements.group.value=$('#group-badge').textContent;
  $('#settings-advanced').open=!$('#settings-token-field').hidden&&!state.token;
  $('#settings-error').hidden=true;applyPrivacy(state.privacy);$('#settings-dialog').showModal();
  try {applyPrivacy(await api('/api/ai/privacy'));}catch(error){$('#settings-error').textContent=error.message;$('#settings-error').hidden=false;}
}
async function saveSettings(form) {
  $('#settings-error').hidden=true;state.token=form.elements.token.value.trim();
  try {
    if(state.token)sessionStorage.setItem('cqa-token',state.token);else sessionStorage.removeItem('cqa-token');
  } catch { /* Session-only credentials still work without storage. */ }
  try {
    if(state.role==='supervisor')applyPrivacy(await post('/api/ai/privacy',{mask_personal_data:$('#privacy-mask').checked,block_external_ai:$('#privacy-block').checked}));
    $('#settings-dialog').close();toast(t('Настройки сохранены.'));if(state.detail)renderDetail();
  } catch(error){$('#settings-error').textContent=error.message;$('#settings-error').hidden=false;}
}
let aiReviewSequence=0;
function endAIReview(value=null) {
  const session=state.aiReview;if(!session)return;
  state.aiReview=null;++aiReviewSequence;session.resolve(value);
}
function aiReviewCurrent(session) {return Boolean(session&&state.aiReview===session&&session.sequence===aiReviewSequence&&session.role===state.role);}
function reviewAI(spec) {
  if(externalBlocked())return Promise.reject(new Error(t('Внешняя AI-обработка запрещена в настройках.')));
  if(state.aiReview)return Promise.reject(new Error(t('Завершите открытый предпросмотр.')));
  return new Promise(resolve=>{
    const session={sequence:++aiReviewSequence,role:state.role,spec:JSON.parse(JSON.stringify(spec)),resolve,prepared:null,preparing:false,dirty:false,error:null,revision:0};
    state.aiReview=session;$('#ai-redactions').value='';$('#ai-review-dialog').showModal();void prepareAIReview();
  });
}
function previewContent(value) {
  if(typeof value!=='string')return JSON.stringify(value,null,2);
  try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object')return JSON.stringify(parsed,null,2);}catch{}
  return value;
}
function renderAIReview() {
  const session=state.aiReview;if(!session)return;
  $('#ai-review-confirm').disabled=session.preparing || session.dirty || !session.prepared || externalBlocked();
  $('#ai-review-refresh').disabled=session.preparing;
  $('#ai-review-error').hidden=!session.error;$('#ai-review-error').textContent=session.error || '';
  $('#ai-review-status').textContent=t(session.preparing?'Подготавливаем запрос на ноутбуке…':session.dirty?'Фрагменты изменены. Обновите предпросмотр перед отправкой.':session.prepared?.cached?'Внешний запрос не нужен: доступен сохранённый результат.':'Предпросмотр готов. Данные ещё не отправлены AI.');
  $('#ai-review-content').innerHTML=session.prepared?(session.prepared.requests || []).map((entry,index)=>{
    const request=entry.request || {},messages=request.messages || [];
    return ui`<details class="ai-request" open><summary>${escapeHTML(entry.provider || 'AI')} · ${escapeHTML(entry.target || '')}${(session.prepared.requests || []).length>1?` (${index+1})`:''}</summary><div class="ai-request-body"><p class="quiet">${t(entry.mask_personal_data?'Маскирование включено':'Маскирование выключено')}</p>${messages.map(message=>{const content=escapeHTML(previewContent(message.content));return message.role==='system'?ui`<details class="ai-message ai-system"><summary>Инструкции для AI</summary><pre>${content}</pre></details>`:ui`<section class="ai-message"><h4>${t(message.role==='user'?'Содержимое запроса':'Контекст ответа')}</h4><pre>${content}</pre></section>`;}).join('')}<details class="ai-envelope"><summary>Полный запрос, включая инструкции и формат ответа</summary><pre>${escapeHTML(JSON.stringify(request,null,2))}</pre></details></div></details>`;
  }).join(''):'';
  const count=session.prepared?.requests?.length || 0;
  $('#ai-review-cost').textContent=session.prepared?.cached?t('Новый запрос не расходуется.'):ui`Запросов к внешнему AI: ${count}`;
}
async function prepareAIReview() {
  const session=state.aiReview;if(!aiReviewCurrent(session)||session.preparing)return;
  session.preparing=true;session.prepared=null;session.error=null;session.dirty=false;
  const revision=++session.revision,redactions=$('#ai-redactions').value.split('\n').map(value=>value.trim()).filter(Boolean);
  const input=$('#ai-redactions').value;renderAIReview();
  if(redactions.length>40 || redactions.some(value=>value.length>200)){session.preparing=false;session.error=t('Укажите до 40 фрагментов для скрытия, каждый от 1 до 200 символов.');renderAIReview();return;}
  try {
    const result=await post('/api/ai/prepare',{...session.spec,redactions});
    if(!aiReviewCurrent(session)||revision!==session.revision)return;
    session.prepared=result;session.dirty=$('#ai-redactions').value!==input;
  } catch(error){if(aiReviewCurrent(session))session.error=error.message;}
  finally{if(aiReviewCurrent(session)){session.preparing=false;renderAIReview();}}
}
function confirmAIReview() {
  const session=state.aiReview;if(!aiReviewCurrent(session)||session.preparing||session.dirty||!session.prepared||externalBlocked())return;
  if(session.prepared.expires_at&&Date.parse(session.prepared.expires_at)<=Date.now()) {
    session.prepared=null;session.error=t('Предпросмотр устарел. Обновите его перед отправкой.');renderAIReview();return;
  }
  const result=session.prepared;endAIReview(result);$('#ai-review-dialog').close();
}
function normalAssistantFilters() {
  reconcileGrossFilter();
  const status=$('#status').value;
  return {...(state.assistantFilters || {}),language:$('#language').value || null,channel:$('#channel').value || null,
    status:status&&status!=='appeals'?status:null,pending_appeals:status==='appeals',gross_only:$('#gross-only').checked};
}
function reconcileGrossFilter(changed=null) {
  if(!$('#gross-only').checked || ['', 'Evaluated', 'appeals'].includes($('#status').value))return;
  if(changed==='status')$('#gross-only').checked=false;
  else $('#status').value='';
}
function syncNormalFilters(filters) {
  $('#language').value=filters.language || '';$('#channel').value=filters.channel || '';
  $('#status').value=filters.pending_appeals?'appeals':filters.status || '';$('#gross-only').checked=Boolean(filters.gross_only);
}
function filterLabel(key,value) {
  const names={language:t('Язык'),channel:t('Канал'),status:t('Оценка'),score_below:t('Балл ниже'),score_above:t('Балл выше'),criterion_id:t('Критерий'),criterion_state:t('Результат критерия'),issue:t('Проблема'),sort:t('Сортировка'),pending_appeals:t('Апелляции'),gross_only:t('Грубые ошибки'),search:t('Поиск')};
  const values={unmet:t('Не выполнен'),met:t('Выполнен'),na:t('Не применяется'),operator_introduction:t('Нет представления оператора'),score_asc:t('Балл по возрастанию'),score_desc:t('Балл по убыванию'),'agent chat':t('Чат'),'voice call':t('Звонок')};
  if(value===true)return names[key];
  if(key==='criterion_id')value=t(state.checklist?.criteria.find(criterion=>criterion.id===value)?.name || value);
  return `${names[key] || key}: ${labels[value] || values[value] || value}`;
}
function renderActiveFilters() {
  const filters={...normalAssistantFilters(),search:$('#search').value.trim()};
  const entries=Object.entries(filters).filter(([key,value])=>value!=null&&value!==false&&value!==''&&!(key==='sort'&&value==='conversation_id'));
  $('#active-filters').hidden=!entries.length;
  $('#active-filters').innerHTML=entries.map(([key,value])=>ui`<button type="button" class="filter-chip" data-clear-filter="${escapeHTML(key)}">${escapeHTML(filterLabel(key,value))}<span aria-hidden="true">×</span><span class="sr-only">Сбросить фильтр</span></button>`).join('')+(entries.length?ui`<button type="button" class="button tertiary" data-action="clear-filters">Сбросить все</button>`:'');
}
async function refreshAssistantFilter(changed=null) {
  reconcileGrossFilter(changed);
  if(!state.assistantFilters || state.role!=='supervisor')return filterConversations();
  const sequence=++state.assistantFilterSequence,filters=normalAssistantFilters();
  const result=await post('/api/assistant/filter',{filters,dataset_group:state.datasetGroup});
  if(sequence!==state.assistantFilterSequence||state.role!=='supervisor')return;
  state.assistantFilters=result.filters;syncNormalFilters(result.filters);state.assistantIds=new Set(result.items.map(item=>item.id || item.conversation_id));
  await filterConversations();
}
async function clearFilter(key) {
  if(key==='search')$('#search').value='';
  else if(key==='language'||key==='channel'||key==='status')$(`#${key}`).value='';
  else if(key==='gross_only')$('#gross-only').checked=false;
  else if(key==='pending_appeals')$('#status').value='';
  if(state.assistantFilters){state.assistantFilters[key]=key==='sort'?'conversation_id':null;if(key==='criterion_id')state.assistantFilters.criterion_state=null;if(key==='criterion_state')state.assistantFilters.criterion_id=null;}
  await refreshAssistantFilter();
}
async function clearAllFilters() {
  state.assistantFilters=null;state.assistantIds=null;++state.assistantFilterSequence;
  for(const id of ['search','language','channel','status'])$(`#${id}`).value='';$('#gross-only').checked=false;
  await filterConversations();
}
function hasAssistantBudget(budget=state.assistantBudget) {
  return !budget || budget.unlimited===true || (Number.isFinite(budget.remaining)&&budget.remaining>0);
}
function updateAssistantControls() {
  const busy=Boolean(state.assistantBusy),blocked=externalBlocked(),budget=state.assistantBudget;
  $('#assistant-submit').disabled=busy||blocked||!$('#assistant-query').value.trim()||!hasAiBudget()||!hasAssistantBudget(budget);
  $('#assistant-query').disabled=busy;$('#assistant-loading').hidden=!busy;
  $('#assistant-budget').textContent=blocked?t('Внешняя AI-обработка запрещена'):budget?.unlimited?t('Запросы без ограничений'):budget?ui`Осталось запросов: ${fmt(budget.remaining,0)} из ${fmt(budget.limit,0)}`:'';
  $$('[data-assistant-recommendations]').forEach(button=>button.disabled=busy||blocked||!hasAiBudget()||!hasAssistantBudget(budget));
}
function closeAssistant() {
  const wasOpen=!$('#assistant-panel').hidden;++state.assistantSequence;$('#assistant-panel').hidden=true;
  $('[data-action="assistant"]').setAttribute('aria-expanded','false');if(wasOpen&&state.role==='supervisor')$('[data-action="assistant"]').focus?.();
}
async function openAssistant() {
  if(state.role!=='supervisor')return;
  const sequence=++state.assistantSequence,historyLength=state.assistantHistory.length;$('#assistant-panel').hidden=false;$('[data-action="assistant"]').setAttribute('aria-expanded','true');
  renderAssistant();$('#assistant-query').focus?.();
  try {
    const result=await api('/api/assistant/history');if(sequence!==state.assistantSequence||state.role!=='supervisor'||historyLength!==state.assistantHistory.length)return;
    state.assistantHistory=result.messages || [];state.assistantBudget=result.assistant_budget;renderAssistant();if(!state.assistantBusy)revealLatestAssistant();
  }catch(error){if(sequence===state.assistantSequence){state.assistantError=error.message;renderAssistant();}}
}
function assistantEvidence(source) {
  if(!source?.conversation_id)return '';
  return ui`<button type="button" data-assistant-source="${escapeHTML(source.conversation_id)}" ${Number.isInteger(source.message_index)?`data-message-index="${source.message_index}"`:''}>${escapeHTML(source.conversation_id)}${source.timestamp?` · ${escapeHTML(displayTime(source.timestamp))}`:''}${source.quote?`<br><span>«${escapeHTML(source.quote)}»</span>`:''}</button>`;
}
function assistantCoverage(result) {
  const subset=result.filtered_coverage,all=result.coverage;
  const statuses=new Set([...Object.keys(subset?.statuses || {}),...Object.keys(all?.statuses || {})]);
  const sameScope=subset&&all&&subset.evaluated===all.evaluated&&subset.total===all.total&&
    [...statuses].every(status=>(subset.statuses?.[status] || 0)===(all.statuses?.[status] || 0));
  return `${subset&&!sameScope?ui`<p class="quiet">В текущей выборке оценено: ${fmt(subset.evaluated,0)} из ${fmt(subset.total,0)}.</p>`:''}${all?ui`<p class="quiet">Оценено: ${fmt(all.evaluated,0)} из ${fmt(all.total,0)} диалогов.</p>`:''}${result.dataset?ui`<p class="assistant-dataset quiet">${escapeHTML(t(result.dataset.notice || (result.dataset.synthetic?'Синтетический DEV-набор: результаты не являются показателями компании.':'Результаты относятся только к загруженной выборке.')))}</p>`:''}`;
}
function renderAssistantResult(result,index) {
  if(result.kind==='clarification')return `<p>${escapeHTML(result.clarification)}</p>`;
  if(result.kind==='recommendations_available')return ui`<p>Могу предложить до трёх действий по актуальным оценкам.</p><button type="button" class="button subtle" data-assistant-recommendations="${index}">Подготовить рекомендации</button><p class="quiet">Это отдельный запрос к AI по текущим настройкам защиты.</p>`;
  if(result.kind==='summary')return renderAssistantSummary(result,index);
  if(result.kind==='recommendations')return assistantCoverage(result)+(result.recommendations || []).slice(0,3).map(item=>ui`<article class="assistant-recommendation"><h3>${escapeHTML(item.action)}</h3><p>${escapeHTML(item.observation)}</p><p class="quiet">Выборка: ${fmt(item.sample_size,0)} · наблюдений: ${fmt(item.count,0)}${item.excluded_na?ui` · Не применяется: ${fmt(item.excluded_na,0)}`:''}</p><p>${escapeHTML(item.goal)}</p>${item.hypothesis?ui`<p><strong>Гипотеза:</strong> ${escapeHTML(item.hypothesis)}</p>`:''}<div class="assistant-evidence">${(item.sources || []).map(source=>assistantEvidence(source)+(source.messages || []).map(assistantEvidence).join('')).join('')}</div></article>`).join('')+(!(result.recommendations || []).length?t('<p>Недостаточно актуальных оценок для рекомендаций.</p>'):'');
  const items=result.items || [];
  return ui`<h3>Найдено диалогов: ${fmt(result.result_count ?? result.total ?? items.length,0)}</h3>${assistantCoverage(result)}<button type="button" class="button subtle" data-assistant-apply="${index}">Показать в списке</button>${(result.limitations || []).map(text=>`<p class="quiet">${escapeHTML(t(text))}</p>`).join('')}<div class="assistant-evidence">${items.slice(0,12).map(item=>ui`<div>${assistantEvidence(item)}<p class="quiet">${labels[item.status]}${item.score!=null?ui` · Итог: ${fmt(item.score)}`:''}${item.initial_ai_score!=null&&item.initial_ai_score!==item.score?ui` · Исходная оценка AI: ${fmt(item.initial_ai_score)}`:''}</p>${assistantIssues(item,result.filters || {})}</div>`).join('')}</div>${items.length>12?t('<p class="quiet">Все найденные диалоги доступны в списке.</p>'):''}`;
}
function renderAssistantSummary(result,index) {
  const scope=Object.entries(result.filters || {}).filter(([key,value])=>value!=null&&value!==false&&value!==''&&key!=='sort').map(([key,value])=>filterLabel(key,value));
  const coverage=result.filtered_coverage || result.coverage;
  return ui`<h3>Какие ошибки повторяются чаще</h3><p class="quiet">${escapeHTML(scope.length?scope.join(' · '):t('Все диалоги'))}${coverage?ui` · Оценено: ${fmt(coverage.evaluated,0)} из ${fmt(coverage.total,0)}`:''}${result.dataset?.synthetic?ui`<br>DEV · синтетические данные`:''}</p>`+
    (result.issues_summary || []).map(item=>ui`<article class="assistant-frequency ${item.type==='flag'?'assistant-frequency-critical':''}"><h4>${escapeHTML(t(item.name))}</h4><p class="assistant-frequency-count"><strong>${fmt(item.count,0)}</strong> из ${fmt(item.sample_size,0)} применимых оценок · ${item.sample_size?fmt(item.count/item.sample_size*100,1):'—'}%</p>${item.excluded_na?ui`<p class="quiet">Не применяется: ${fmt(item.excluded_na,0)}</p>`:''}<details><summary>Диалоги и доказательства (${item.count})</summary><div class="assistant-evidence">${(item.sources || []).map(source=>ui`<div>${assistantEvidence(source.evidence || source)}<p>${escapeHTML(source.reason)}</p></div>`).join('')}</div></details></article>`).join('')+
    (!(result.issues_summary || []).length?ui`<p>${t(result.filtered_coverage?.evaluated?'В актуальных оценках этой выборки замечаний не найдено.':'В этой выборке нет актуальных оценок. Сводка ошибок пока недоступна.')}</p>`:'')+
    ui`<details class="assistant-summary-method"><summary>Как рассчитана сводка</summary>${assistantCoverage(result)}<p class="quiet">По финальным оценкам с учётом апелляций. N/A и отсутствующие оценки не считаются ошибками. Частичное выполнение учитывается как замечание.</p></details><button type="button" class="button subtle" data-assistant-apply="${index}">Показать в списке</button>`;
}
function assistantIssues(item,filters) {
  const issues=[...(item.issues || [])];
  const relevant=issue=>filters.gross_only?issue.type==='flag':filters.criterion_id?issue.criterion_id===filters.criterion_id:
    filters.issue==='operator_introduction'?/представ|introduc|таныстыр/i.test(issue.reason || ''):true;
  issues.sort((a,b)=>Number(relevant(b))-Number(relevant(a)));
  const markup=issue=>ui`<div class="assistant-issue">${shortExplanation(issue.reason,190)}${issue.original_ai_reason?ui`<details><summary>Предыдущее обоснование</summary><p>${escapeHTML(issue.original_ai_reason)}</p></details>`:''}${assistantEvidence(issue.evidence)}</div>`;
  return issues.length?markup(issues[0])+(issues.length>1?ui`<details class="assistant-more-issues"><summary>Остальные замечания (${issues.length-1})</summary>${issues.slice(1).map(markup).join('')}</details>`:''):'';
}
function revealLatestAssistant({focus=false}={}) {
  if($('#assistant-panel').hidden)return;
  const entry=$('#assistant-history .assistant-entry:last-child');if(!entry)return;
  entry.scrollIntoView({block:'start',behavior:'auto'});if(focus)entry.focus?.({preventScroll:true});
}
function renderAssistant() {
  const history=(state.assistantHistory || []).map((entry,index)=>({...entry,originalIndex:index})).filter(entry=>(entry.response.dataset_group || null)===state.datasetGroup);
  $('#assistant-history').innerHTML=history.map((entry,index)=>index<history.length-1?
    ui`<details class="assistant-entry assistant-previous"><summary>${escapeHTML(entry.query)}</summary><div class="assistant-answer">${renderAssistantResult(entry.response,entry.originalIndex)}</div></details>`:
    ui`<article class="assistant-entry" tabindex="-1"><p class="assistant-question">${escapeHTML(entry.query)}</p><div class="assistant-answer">${renderAssistantResult(entry.response,entry.originalIndex)}</div></article>`).join('');
  $('#assistant-empty').hidden=Boolean(history.length);$('#assistant-error').hidden=!state.assistantError;$('#assistant-error').textContent=state.assistantError || '';updateAssistantControls();
}

async function applyAssistantResult(result) {
  if(state.role!=='supervisor')return;
  if(Object.prototype.hasOwnProperty.call(result,'dataset_group')&&(result.dataset_group || null)!==state.datasetGroup)await selectDatasetGroup(result.dataset_group);
  state.assistantFilters={...result.filters};syncNormalFilters(result.filters);$('#search').value='';
  state.assistantIds=new Set((result.items || []).map(item=>item.id || item.conversation_id));
  await setWorkspaceView('conversations');await filterConversations({keepSelection:false});
}
async function submitAssistant(purpose='assistant_search',filters=null) {
  if(state.role!=='supervisor'||state.assistantBusy||externalBlocked()||!hasAiBudget()||!hasAssistantBudget())return;
  const query=$('#assistant-query').value.trim();if(purpose==='assistant_search'&&!query)return;
  const role=state.role,epoch=state.assistantRoleEpoch,language=practiceLanguage();let received=false;state.assistantBusy=true;state.assistantError=null;updateAssistantControls();
  try {
    // Sending a message is the user's action. Prepare with the server's current
    // privacy policy, then consume the protected ticket without a second dialog.
    const prepared=await post('/api/ai/prepare',{purpose,query:purpose==='assistant_search'?query:'',language,filters:filters || normalAssistantFilters(),dataset_group:state.datasetGroup});
    if(role!==state.role||epoch!==state.assistantRoleEpoch||externalBlocked()||!hasAiBudget()||!hasAssistantBudget())return;
    if(typeof prepared?.preview_id!=='string'||!prepared.preview_id)throw new Error(t('Не удалось безопасно подготовить запрос. Отправка заблокирована; оригинал не отправлен.'));
    const result=await post('/api/assistant',{preview_id:prepared.preview_id});
    if(result.budget)updateBudget(result.budget);if(result.assistant_budget)state.assistantBudget=result.assistant_budget;
    if(state.role!==role||epoch!==state.assistantRoleEpoch)return;
    received=true;state.assistantHistory.push({id:practiceRequestId(),query:purpose==='assistant_search'?query:t('На что обратить внимание?'),response:result});
    if($('#assistant-query').value.trim()===query)$('#assistant-query').value='';
    if(result.kind==='search'||result.kind==='summary')await applyAssistantResult(result);
  }catch(error){if(state.role===role&&epoch===state.assistantRoleEpoch)state.assistantError=error.message;try{const health=await api('/api/health');if(health.budget)updateBudget(health.budget);if(health.assistant_budget)state.assistantBudget=health.assistant_budget;}catch{}}
  finally{state.assistantBusy=false;updateAssistantControls();if(state.role===role&&epoch===state.assistantRoleEpoch){renderAssistant();if(received)revealLatestAssistant({focus:true});else if(!$('#assistant-panel').hidden)$('#assistant-query').focus?.();}}
}
async function openAssistantSource(cid,index) {
  if(state.role!=='supervisor')return;closeAssistant();
  const item=state.allItems.find(item=>item.id===cid);
  if(item&&state.datasetGroup&&item.dataset_group!==state.datasetGroup)await selectDatasetGroup(item.dataset_group);
  await setWorkspaceView('conversations');await selectConversation(cid);
  if(state.detail?.conversation_id!==cid)return;
  if(Number.isInteger(index))await seekProof(index);else{setDetailView('assessment');$('.dialogue-workspace').scrollIntoView({block:'start',behavior:'smooth'});}
}

const actions = {
  'assistant':openAssistant,'close-assistant':closeAssistant,'clear-filters':clearAllFilters,
  'jump-transcript':()=>{setDetailView('transcript');$('.conversation').scrollIntoView({block:'start',behavior:'smooth'});$('#transcript').focus?.({preventScroll:true});},
  'jump-assessment':()=>{setDetailView('assessment');$('.inspector').scrollIntoView({block:'start',behavior:'smooth'});$('#evaluation-status').focus?.({preventScroll:true});},
  'pending-appeals':()=>{$('#appeals-filter').value='PENDING';return setWorkspaceView('appeals');},
  'checklist':openChecklist,'audit':openAudit,'upload':openUpload,'show-gross':showGrossConversations,
  'reload':() => loadData(),
  'show-list':() => $('.queue').scrollIntoView({behavior:'smooth'}),
  'toggle-list':()=>toggleConversationList(),
  'export':() => { if (state.detail) download(ui`${state.selected}-cqa.json`,state.detail); },
  'settings':openSettings,
  'batch':() => {
    if(state.busy) return toast(t('Дождитесь завершения проверки.'),true);
    const pending = state.filtered.filter(r => r.status !== 'Evaluated'&&r.evaluation_enabled!==false).length;
    const count = state.budget.unlimited ? pending : Math.min(pending,state.budget.remaining);
    if (count <= 0 || !hasAiBudget()) return toast(t('Нет доступных проверок или диалогов без оценки.'),true);
    $('#batch-form').elements.count.max=count; $('#batch-form').elements.count.value=1;
    $('#batch-description').textContent=ui`Можно проверить до ${count} диалогов.`;
    $('#batch-dialog').showModal();
  }
};
document.addEventListener('click', event => {
  const dataset=event.target.closest('[data-dataset-group]');if(dataset)return void guarded(()=>selectDatasetGroup(dataset.dataset.datasetGroup));
  const detailTab=event.target.closest('[data-detail-view]');if(detailTab)return setDetailView(detailTab.dataset.detailView);
  const filterChip=event.target.closest('[data-clear-filter]');if(filterChip)return void guarded(()=>clearFilter(filterChip.dataset.clearFilter));
  const example=event.target.closest('[data-assistant-example]');if(example){$('#assistant-query').value=t(example.dataset.assistantExample);updateAssistantControls();$('#assistant-query').focus();return;}
  const source=event.target.closest('[data-assistant-source]');if(source)return void guarded(()=>openAssistantSource(source.dataset.assistantSource,source.hasAttribute('data-message-index')?Number(source.dataset.messageIndex):null));
  const recommendations=event.target.closest('[data-assistant-recommendations]');if(recommendations)return void submitAssistant('assistant_recommendations',state.assistantHistory[Number(recommendations.dataset.assistantRecommendations)].response.filters);
  const apply=event.target.closest('[data-assistant-apply]');if(apply)return void guarded(async()=>{const result=state.assistantHistory[Number(apply.dataset.assistantApply)].response;await applyAssistantResult(result);closeAssistant();});
  const locale=event.target.closest('[data-locale]');
  if(locale)return window.CQA_I18N.set(locale.dataset.locale);
  const speaker=event.target.closest('[data-insert-speaker]');
  if(speaker) {
    const field=$('#upload-text'), position=field.selectionStart || 0;
    const start=field.value.lastIndexOf('\n',position-1)+1;
    const prefix=speaker.dataset.insertSpeaker==='client'?'Client: ':'Operator: ';
    field.value=field.value.slice(0,start)+prefix+field.value.slice(start);
    field.focus();field.setSelectionRange(position+prefix.length,position+prefix.length);
    $('#upload-reviewed').checked=false;return;
  }
  const close = event.target.closest('[data-close]');
  if (close) return close.closest('dialog').close();
  const view=event.target.closest('[data-workspace-view]');
  if(view) return void guarded(()=>setWorkspaceView(view.dataset.workspaceView));
  const appealLink=event.target.closest('[data-open-appeal]');
  if(appealLink) return void guarded(()=>openAppealConversation(appealLink.dataset.openAppeal));
  const practice=event.target.closest('[data-practice]');
  if(practice)return void openPractice(practice.dataset.practice);
  if(event.target.closest('[data-practice-retry]')){$('#practice-answer').focus();$('#practice-answer').scrollIntoView({block:'center',behavior:'smooth'});return;}
  const action = event.target.closest('[data-action]');
  if (action) return void guarded(() => actions[action.dataset.action]());
  const item = event.target.closest('.conversation-item');
  if (item) return void guarded(async()=>{await selectConversation(item.dataset.id);toggleConversationList(false);});
  const proof = event.target.closest('[data-proof]');
  if (proof) return void guarded(() => seekProof(Number(proof.dataset.proof)));
  const appeal = event.target.closest('[data-appeal]');
  if (appeal) return openAppeal(appeal.dataset.appeal);
  const resolve = event.target.closest('[data-resolve]');
  if (resolve) return openResolve(resolve.dataset.resolve);
  if (event.target.closest('#evaluate-button')) return void guarded(evaluateSelected);
});
$('#role').addEventListener('change', () => { state.role=$('#role').value; applyRole(); });
$('#appeals-filter').addEventListener('change',renderAppeals);
window.addEventListener('popstate',()=>guarded(()=>setWorkspaceView(initialView(),{updateHistory:false})));
document.addEventListener('keydown',event=>{if(event.key==='Escape'){toggleConversationList(false);if(!$$('dialog[open]').length)closeAssistant();}});
for (const id of ['language','channel','status','gross-only']) $(ui`#${id}`).addEventListener('change',()=>guarded(()=>refreshAssistantFilter(id)));
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);++filterSequence;
  searchTimer=setTimeout(()=>guarded(()=>filterConversations()),200);
});
$('#show-context').addEventListener('change', () => { if (state.detail) renderTranscript(); });
$('#audio').addEventListener('timeupdate', () => { $('#audio-time').textContent=mmss($('#audio').currentTime); });
$('#audio').addEventListener('error', () => { cancelAudioSeek();if (state.detail?.audio_url && $('#audio').getAttribute('src')) toast(t('Не удалось загрузить запись.'),true); });
$('#appeal-form').addEventListener('submit',event=>{event.preventDefault();void submitAppeal();});
$('#appeal-select').addEventListener('change',event=>selectAppealCriterion(event.target.value));
$('#appeal-dialog').addEventListener('close',()=>{if(!$('#appeal-dialog').open)closeAppealSession();});
matchMedia('(max-width:650px)').addEventListener?.('change',orderOperatorWorkspace);
$('#resolve-form').elements.action.addEventListener('change', event => { $('#resolve-value').disabled=event.target.value === 'REJECTED'; });
$('#resolve-form').addEventListener('submit', event => {
  event.preventDefault(); const form=event.currentTarget;
  guarded(async () => {
    const a=state.resolveAppeal, value=form.elements.value.value;
    const result=await post('/api/appeals/resolve',{conversation_id:a.conversation_id,criterion_id:a.criterion_id,appeal_id:a.id,action:form.elements.action.value,new_score:value === 'na' ? null : Number(value),is_na:value === 'na',resolution_comment:form.elements.resolution_comment.value.trim()});
    $('#resolve-dialog').close(); await loadData(); $('.inspector-body').scrollTop=0; toast(ui`Решение сохранено. Итог: ${fmt(result.evaluation.final_score)} / 100.`);
  },form);
});
$('#checklist-editor').addEventListener('change', event => {
  if (['type','allow_na'].includes(event.target.dataset.field)) {
    collectEditor();
    const row=event.target.closest('.editor-criterion'), c=state.edit[Number(row.dataset.index)];
    if (event.target.dataset.field === 'type' && c.type === 'scale' && c.levels.length < 2) { c.max_scale=10; c.levels=[0,5,10]; }
    renderEditor();
  }
});
$('#checklist-editor').addEventListener('input', event => {
  if (event.target.dataset.field === 'weight') {
    const total=$$('#checklist-editor [data-field="weight"]').reduce((sum,node) => sum + Number(node.value || 0),0);
    $('#weight-total').textContent=ui`Сумма весов: ${fmt(total)}`;
  }
});
$('#checklist-editor').addEventListener('click', event => {
  const remove=event.target.closest('.remove-criterion');
  if (remove) { collectEditor(); state.edit.splice(Number(remove.closest('.editor-criterion').dataset.index),1); renderEditor(); }
});
$('#add-criterion').addEventListener('click', () => {
  collectEditor(); let id=state.edit.length+1; while (state.edit.some(c => c.id === String(id).padStart(2,'0'))) id++;
  state.edit.push({id:String(id).padStart(2,'0'),name:t('Новый критерий'),description:t('Опишите правило оценки'),type:'binary',weight:0,max_scale:1,levels:[],allow_na:false,na_condition:''}); renderEditor();
});
$('#checklist-form').addEventListener('submit', event => {
  event.preventDefault(); const form=event.currentTarget;
  guarded(async () => {
    collectEditor(); const result=await post('/api/checklist',{version:state.editVersion,criteria:state.edit});
    $('#checklist-dialog').close(); await loadData(); $('.inspector-body').scrollTop=0;
    toast(result.requires_ai ? ui`Правила сохранены. Нужно обновить оценок: ${result.stale}.` : ui`Изменения сохранены. Обновлено оценок: ${result.rescored}.`);
  },form);
});
$('#checklist-form').addEventListener('invalid', event => {
  const details=event.target.closest('details');
  if (details) details.open=true;
},true);
$('#settings-form').addEventListener('submit',event=>{event.preventDefault();void saveSettings(event.currentTarget);});
$('#refresh-dataset').addEventListener('click', () => guarded(async () => {
  const form=$('#settings-form'); state.token=form.elements.token.value.trim();
  const group=form.elements.group.value;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(group)) throw new Error(t('Проверьте название группы'));
  const result=await post(ui`/api/dataset/refresh?group_id=${encodeURIComponent(group)}`,{});
  $('#settings-dialog').close(); state.datasetGroup=result.group;await loadData(false);try{sessionStorage.setItem('cqa-dataset-group',result.group);}catch{} toast(ui`Загружено ${result.records} диалогов группы ${result.group}.`);
}));
$('#batch-form').addEventListener('submit',event=>{event.preventDefault();void guarded(()=>submitBatch(event.currentTarget));});
$('#practice-form').addEventListener('submit',event=>{event.preventDefault();void submitPractice();});
$('#practice-answer').addEventListener('input',()=>{savePracticeDraft();updatePracticeControls();});
$('#practice-dialog').addEventListener('close',clearPractice);
$('#upload-json-select').addEventListener('change',event=>{rememberJsonConversation();showJsonConversation(Number(event.target.value));});
$('#upload-file').addEventListener('change',event=>void readUploadFile(event.target.files[0]));
$('#upload-form').addEventListener('submit',event=>{event.preventDefault();if(!$('#upload-submit').disabled)void importUpload(event.currentTarget);});
$('#upload-dialog').addEventListener('close',()=>{++uploadSequence;$('#upload-form').classList.remove('busy');resetUploadImage();});
$('#upload-text').addEventListener('input',()=>{$('#upload-reviewed').checked=false;});
for(const name of ['dragenter','dragover'])$('#upload-dropzone').addEventListener(name,event=>{event.preventDefault();$('#upload-dropzone').classList.add('drag-over');});
for(const name of ['dragleave','drop'])$('#upload-dropzone').addEventListener(name,event=>{event.preventDefault();$('#upload-dropzone').classList.remove('drag-over');});
$('#upload-dropzone').addEventListener('drop',event=>{if(!$('#upload-form').classList.contains('busy'))void readUploadFile(event.dataTransfer.files[0]);});
window.addEventListener('cqa-language-change',()=>{
  if(state.practice)renderPractice();if(state.aiReview)renderAIReview();renderAssistant();
  if(state.appealSession)renderAppealSelection();
  updateBudget(state.budget);renderList();renderDetail();
  if(state.listSummary)applyDatasetScope();
  void guarded(()=>setWorkspaceView(state.view,{updateHistory:false}));
});
$('#assistant-form').addEventListener('submit',event=>{event.preventDefault();void submitAssistant();});
$('#assistant-query').addEventListener('input',updateAssistantControls);
$('#ai-review-form').addEventListener('submit',event=>{event.preventDefault();confirmAIReview();});
$('#ai-review-refresh').addEventListener('click',()=>void prepareAIReview());
$('#ai-redactions').addEventListener('input',()=>{if(state.aiReview){state.aiReview.dirty=true;renderAIReview();}});
$('#ai-review-dialog').addEventListener('close',()=>{if(!$('#ai-review-dialog').open)endAIReview();});
$('.detail-tabs').addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();setDetailView(event.key==='Home'?'assessment':event.key==='End'?'transcript':state.detailView==='assessment'?'transcript':'assessment',{focus:true});}});
window.CQA_I18N?.initialize();
$('#export-audit').addEventListener('click', () => download('cqa-audit.json',state.audit));
guarded(async () => {
  await loadData();
  if(state.view==='conversations') await setWorkspaceView('conversations',{updateHistory:false});
  if (!state.items.length) toast(t('Нет диалогов. Нажмите «Загрузить диалог».'),true);
});
