/* Buildless, framework-free client: suitable for a Dynamics 365 HTML web resource.
   Set window.CQA_API_BASE before loading this file when hosted separately. */
'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n, digits = 2) => n == null ? '—' : Number(n).toLocaleString('ru-RU', {maximumFractionDigits: digits});
const labels = {Pending:'Нет оценки ИИ', Evaluated:'Есть оценка ИИ', Stale:'Оценка устарела', Evaluating:'ИИ оценивает', PENDING:'Ожидает решения', APPROVED:'Удовлетворена', REJECTED:'Отклонена', SUPERSEDED:'Предыдущая версия'};
const languageNames={RU:'Русский',KZ:'Қазақша',EN:'English'};
function initialView() { const value=(window.location?.hash || '').slice(1);return ['appeals','analytics'].includes(value)?value:'conversations'; }
function storedToken() { try { return sessionStorage.getItem('cqa-token') || ''; } catch { return ''; } }
const state = {items:[], filtered:[], selected:null, detail:null, detailLoading:false, detailError:false, checklist:null, role:'supervisor', view:initialView(), appealItems:[], budget:{remaining:0}, busy:false, token:storedToken(), edit:[], audit:[], sequence:0};
let toastTimer, searchTimer, loadSequence=0, filterSequence=0, viewSequence=0, audioSeekSequence=0, pendingAudioSeek;

async function api(path, options = {}) {
  let response;
  try { response = await fetch((window.CQA_API_BASE || '') + path, {...options, headers:{'Content-Type':'application/json', 'X-Role':state.role, 'X-Supervisor-Token':state.token, ...options.headers}}); }
  catch { throw new Error('Нет соединения с сервером. Попробуйте ещё раз.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const validation=Array.isArray(data.detail) ? [...new Set(data.detail.map(x=>/[А-Яа-яЁё]/.test(x.msg || '') ? x.msg.replace(/^Value error,\s*/,'') : 'Проверьте заполненные поля.'))].join(' ') : '';
    const message = response.status === 403 ? 'Нет доступа. Проверьте роль и пароль в настройках.' : response.status === 429 ? 'Лимит проверок исчерпан.' : response.status === 503 ? (typeof data.detail === 'string' && data.detail.startsWith('Не удалось сохранить') ? data.detail : 'Действие временно недоступно. Попробуйте позже.') : response.status >= 500 ? 'Не удалось выполнить действие. Попробуйте позже.' : typeof data.detail === 'string' ? data.detail : validation || 'Не удалось выполнить действие.';
    throw new Error(message);
  }
  return data;
}
const post = (path, body) => api(path, {method:'POST', body:JSON.stringify(body)});
function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
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
  document.body.classList.toggle('operator-mode', state.role === 'operator');
  $$('.supervisor-only').forEach(node => node.hidden = state.role !== 'supervisor');
  if(state.role === 'operator' && state.view === 'analytics') void guarded(()=>setWorkspaceView('conversations'));
  if (state.detail) renderDetail();
}
function updateBudget(budget) {
  state.budget = budget;
  $('#budget').textContent = `Осталось проверок: ${budget.remaining}`;
  $('#settings-budget').textContent = `Осталось проверок: ${budget.remaining} из ${budget.limit}.`;
  $$('[data-action="batch"]').forEach(button => button.disabled=state.busy || !budget.configured || budget.remaining < 1);
}
async function loadData(keepSelection = true) {
  const sequence=++loadSequence;
  let list,checklist,health;
  try { [list, checklist, health] = await Promise.all([api('/api/conversations'), api('/api/checklist'), api('/api/health')]); }
  catch(error) {
    if(sequence !== loadSequence) return;
    if(!state.items.length) {
      $('#conversation-list').innerHTML='<div class="empty">Не удалось загрузить диалоги. Нажмите «Обновить».</div>';
      $('#data-status').textContent='Нет соединения';
    }
    throw error;
  }
  if(sequence !== loadSequence) return;
  state.items = list.items;
  state.checklist = checklist;
  updateBudget(list.budget);
  $('#auth-mode').textContent = health.auth_mode === 'local-demo' ? 'Локальное демо · роли без входа' : 'Доступ QA защищён токеном';
  $('#total-metric').textContent = fmt(list.total,0);
  $('#tab-count').textContent = list.total;
  $('#evaluated-metric').textContent = fmt(list.evaluated,0);
  $('#progress-metric').textContent = `${list.total ? Math.round(list.evaluated / list.total * 100) : 0}% от всех диалогов`;
  const scores = list.items.filter(r => r.status === 'Evaluated' && r.score != null).map(r => r.score);
  $('#score-metric').textContent = scores.length ? fmt(scores.reduce((a,b) => a+b,0)/scores.length,1) : '—';
  const chats = list.items.filter(r => r.channel === 'agent chat').length;
  $('#channel-metric').textContent = `${chats} чатов · ${list.total - chats} звонков`;
  $('#appeals-metric').textContent = list.items.reduce((sum,r) => sum+r.pending_appeals,0);
  const pending=list.items.reduce((sum,r)=>sum+r.pending_appeals,0);
  $('#nav-appeals-count').textContent=String(pending);$('#nav-appeals-count').hidden=pending===0;
  $('#group-badge').textContent = list.group;
  $('#checklist-version').textContent = 'Правила оценки';
  $('#data-status').textContent = `${list.total} диалогов`;
  await filterConversations({keepSelection,refreshDetail:true});
  applyRole();
  if(state.view !== 'conversations') await setWorkspaceView(state.view,{updateHistory:false});
}
async function filterConversations({keepSelection=true,refreshDetail=false}={}) {
  const sequence=++filterSequence, query=$('#search').value.trim();
  if(query) {
    const matches=await api(`/api/conversations?search=${encodeURIComponent(query)}`);
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
  const language = $('#language').value, channel = $('#channel').value, status = $('#status').value;
  const search = $('#search').value.trim().toLocaleLowerCase();
  // Server-side search includes full transcript; otherwise filter the loaded index locally.
  state.filtered = state.items.filter(r => (!language || r.language === language) && (!channel || r.channel === channel) && (!status || (status === 'appeals' ? r.pending_appeals > 0 : r.status === status)) && (!search || state.searchIds?.has(r.id)));
  $('#filter-count').textContent = `${state.filtered.length} из ${state.items.length}`;
  $('#conversation-list').innerHTML = state.filtered.length ? state.filtered.map(r => `<button class="conversation-item ${r.id === state.selected ? 'selected' : ''}" data-id="${escapeHTML(r.id)}" aria-pressed="${r.id === state.selected}"><div class="item-top"><span class="item-channel" aria-label="${r.channel === 'voice call' ? 'Звонок' : 'Чат'}"><svg viewBox="0 0 24 24" aria-hidden="true">${r.channel === 'voice call' ? '<path d="M5 3h4l2 5-3 2a16 16 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2Z"/>' : '<path d="M4 4h16v13H9l-5 4V4Z"/><path d="M8 8h8M8 12h5"/>'}</svg></span><span class="item-id">${escapeHTML(r.id)}</span><span class="item-score">${fmt(r.score,1)}</span></div><p class="item-preview">${escapeHTML(r.preview)}</p><div class="item-bottom"><span class="language-chip">${r.language}</span><span class="status-dot ${r.status.toLowerCase()}"></span><span>${labels[r.status]}</span>${r.pending_appeals ? `<span class="appeal-mini">↗ ${r.pending_appeals}</span>` : ''}</div></button>`).join('') : '<div class="empty">Диалоги не найдены</div>';
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
    const detail = await api(`/api/conversations/${encodeURIComponent(id)}`);
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
  if (timestamp?.includes('T')) {
    const time = new Date(timestamp);
    return Number.isNaN(time.getTime()) ? timestamp : time.toLocaleTimeString('ru-RU', {timeZone:'UTC',hour12:false});
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
  return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
}
function renderDetail() {
  updateBudget(state.budget);
  const d = state.detail;
  $('[data-action="export"]').disabled=!d;
  if (!d) {
    $('#deductions').hidden=true;$('#deductions').innerHTML='';
    $('#conversation-title').textContent=state.detailLoading ? 'Загрузка…' : 'Выберите диалог';
    $('#conversation-meta').textContent='ПЕРЕПИСКА';$('#message-count').textContent='—';
    $('#evaluation-status').textContent='Нет оценки ИИ';$('#evaluation-status').className='badge';
    const text=state.detailLoading ? 'Загрузка диалога…' : state.detailError ? 'Не удалось открыть диалог. Выберите его ещё раз.' : state.items.length ? 'По выбранным условиям диалогов нет.' : 'Нет диалогов. Загрузите их в настройках.';
    $('#transcript').innerHTML=`<div class="${state.detailLoading ? 'loading' : 'empty'}">${text}</div>`;
    $('#score-panel').innerHTML='';$('#criteria').innerHTML='';$('#audio-panel').hidden=true;
    return;
  }
  $('#conversation-title').textContent = d.conversation_id;
  $('#conversation-meta').textContent = `${d.channel === 'voice call' ? 'ЗАПИСЬ ЗВОНКА' : 'ПЕРЕПИСКА'} / ${d.language}${d.transcript[0].timestamp.includes('T') ? ' / ВРЕМЯ UTC' : ''}`;
  $('#transcript').setAttribute('lang',{RU:'ru',KZ:'kk',EN:'en'}[d.language] || 'ru');
  $('#message-count').textContent = `${d.transcript.length} реплик`;
  const audio = $('#audio');
  $('#audio-panel').hidden = !d.audio_url;
  const audioSource = d.audio_url ? (window.CQA_API_BASE || '') + d.audio_url : '';
  if (audioSource && audio.getAttribute('src') !== audioSource) { cancelAudioSeek();audio.pause();audio.src = audioSource;audio.load(); }
  else if (!audioSource && audio.getAttribute('src')) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  renderTranscript();
  const e = d.evaluation, current = d.status === 'Evaluated';
  renderDeductions(e,current);
  const status = $('#evaluation-status');
  status.textContent = labels[d.status];
  status.className = `badge ${current ? 'green' : d.status === 'Stale' ? 'amber' : ''}`;
  $('#criteria-count').textContent = String(state.checklist.criteria.length).padStart(2,'0');
  const sourceNote=e ? (e.criteria.some(r=>r.overridden_at || r.override_comment) ? 'Оценка ИИ с правками руководителя' : 'Оценка ИИ') : '';
  const percent = e?.final_score ?? 0;
  const eligible = !state.busy && d.status !== 'Evaluating' && !d.appeals.some(a=>a.status === 'PENDING') && state.budget.configured && state.budget.remaining > 0;
  const scoreNote=d.appeals.some(a=>a.status === 'PENDING') ? 'Сначала рассмотрите апелляции.' : e && e.final_score == null ? 'Нет применимых критериев с баллами.' : !state.budget.configured ? 'Оценка недоступна. Обратитесь к администратору.' : state.budget.remaining === 0 ? 'Лимит проверок исчерпан.' : e ? 'Проверьте обоснования и цитаты.' : '';
  $('#score-panel').innerHTML = `${d.status === 'Stale' ? '<div class="warning">Эту оценку нужно обновить.</div>' : ''}<div class="score-main"><div class="score-ring" style="--percent:${Math.min(100,Math.max(0,percent))}"><div class="score-value"><strong>${fmt(e?.final_score)}</strong><small>из 100 баллов</small></div></div><div class="score-info">${e ? current ? 'Итоговая оценка' : 'Предыдущая оценка' : 'Готов к проверке'}${e ? `<p class="score-source">${sourceNote}</p>` : ''}<p>${e ? `${e.criteria.length} критериев` : `${d.language} · ${d.channel === 'voice call' ? 'голосовой звонок' : 'чат с оператором'}`}</p><p>${e ? `Не учитывается: ${e.criteria.filter(r => r.is_na).length}` : `${state.checklist.criteria.length} критериев`}</p></div></div>${e?.has_gross_violation ? '<div class="violation-warning">⚑ Грубое нарушение</div>' : ''}${state.role === 'supervisor' ? `<button class="button primary" id="evaluate-button" ${!eligible ? 'disabled' : ''}>${state.busy ? 'Оценка выполняется…' : current ? 'Оценить повторно' : 'Оценить диалог'} <span aria-hidden="true">↗</span></button>` : ''}<p class="score-note">${scoreNote}</p>`;
  if (!e) {
    $('#criteria').innerHTML = state.checklist.criteria.map(c => `<div class="criterion"><div class="criterion-top"><span class="criterion-number">${escapeHTML(c.id)}</span><span class="criterion-name">${escapeHTML(c.name)}</span><span class="criterion-answer na">—</span></div><div class="criterion-math"><span>${c.type === 'flag' ? 'Без баллов' : `Вес ${fmt(c.weight)}`}</span><span>${c.allow_na ? 'Можно не учитывать' : 'Всегда применим'}</span></div></div>`).join('');
    return;
  }
  $('#criteria').innerHTML = e.criteria.map(r => {
    const appeals = d.appeals.filter(a => a.criterion_id === r.criterion_id);
    const pending = appeals.find(a => a.status === 'PENDING');
    const answer = r.is_na ? 'Не применяется' : r.type === 'scale' ? `${fmt(r.value)} / ${fmt(r.max_scale)}` : r.value === 1 ? 'Да' : 'Нет';
    const good = !r.is_na && (r.type === 'flag' ? r.value === 0 : r.type === 'binary' ? r.value === 1 : r.value === r.max_scale);
    return `<article class="criterion"><div class="criterion-top"><span class="criterion-number">${escapeHTML(r.criterion_id)}</span><span class="criterion-name">${escapeHTML(r.name)}</span><span class="criterion-answer ${r.is_na ? 'na' : good ? 'pass' : 'fail'}">${answer}</span></div><div class="criterion-math"><span>${r.type === 'flag' ? 'Не влияет на итог' : `Вклад в итог: ${fmt(r.normalized_weight)}%`}</span><span>${r.is_na ? 'Не учитывается' : r.type !== 'flag' ? `Баллы: ${fmt(r.earned_score)}` : 'Отметка о нарушении'}</span></div>${r.type !== 'flag' ? `<div class="criterion-bar"><span style="width:${r.is_na ? 0 : Math.min(100,r.earned_score/(r.normalized_weight || 1)*100)}%"></span></div>` : ''}<p class="criterion-reason">${r.override_comment ? "Решение руководителя: " : ""}${escapeHTML(r.override_comment || r.reason)}</p><button class="proof" data-proof="${r.proof_message_index}" title="Перейти к реплике${d.audio_url ? ' и записи' : ''}"><span class="proof-time">${escapeHTML(displayTime(r.proof_timestamp))} ↗</span><span class="proof-quote">«${escapeHTML(r.proof_quote)}»</span></button>${r.override_comment ? `<details class="appeal-history"><summary>Предыдущее обоснование</summary><p>${escapeHTML(r.reason)}</p></details>` : ''}${pending ? `<div class="appeal-pending"><strong>Апелляция ожидает решения</strong><p>${escapeHTML(pending.comment)}</p>${state.role === 'supervisor' ? `<button class="button ghost" data-resolve="${escapeHTML(pending.id)}">Рассмотреть апелляцию ↗</button>` : ''}</div>` : ''}${current && state.role === 'operator' && !pending ? `<div class="criterion-actions"><button class="button ghost" data-appeal="${escapeHTML(r.criterion_id)}">Оспорить оценку ↗</button></div>` : ''}${appeals.filter(a => a.status !== 'PENDING').map(a => `<details class="appeal-history"><summary>${labels[a.status]} · ${dateTime(a.resolved_at)}</summary><p>${escapeHTML(a.comment)}</p><p>Решение: ${escapeHTML(a.resolution_comment)}</p></details>`).join('')}</article>`;
  }).join('');
}
function renderTranscript() {
  const show = $('#show-context').checked;
  const scrollTop=$('#transcript').scrollTop;
  const speakers = {client:'Клиент', operator:'Оператор', bot:'Бот', system:'Система'};
  $('#transcript').innerHTML = state.detail.transcript.map((m,i) => {
    const hidden = !show && ['bot','system'].includes(m.speaker) ? 'hidden' : '';
    if (m.speaker === 'system') return `<div id="message-${i}" class="message system" ${hidden}><span>${escapeHTML(m.text)}</span><time>${escapeHTML(displayTime(m.timestamp))}</time></div>`;
    return `<article id="message-${i}" class="message ${m.speaker}" ${hidden}><div class="message-meta"><span class="speaker-avatar">${m.speaker === 'bot' ? 'AI' : m.speaker === 'operator' ? 'ОП' : 'КЛ'}</span><strong>${speakers[m.speaker]}</strong><time>${escapeHTML(displayTime(m.timestamp))}</time></div><div class="message-text">${escapeHTML(m.text)}</div></article>`;
  }).join('');
  $('#transcript').scrollTop=scrollTop;
}
async function seekProof(index) {
  const detail=state.detail;if(!detail) return;
  const m = detail.transcript[index];
  if (!m) return;
  if (['bot','system'].includes(m.speaker) && !$('#show-context').checked) { $('#show-context').checked = true; renderTranscript(); }
  const node = $(`#message-${index}`);
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
      try { await audio.play(); } catch { toast('Нажмите кнопку воспроизведения в записи.',true); }
    };
    if (audio.readyState >= 1) await seek();
    else { pendingAudioSeek=seek;audio.addEventListener('loadedmetadata',seek,{once:true});audio.load(); }
  }
}
function dateTime(value) {
  return value ? new Date(value).toLocaleString('ru-RU', {timeZone:'Asia/Bishkek',dateStyle:'short',timeStyle:'short'}) : '—';
}
async function evaluateSelected() {
  if (!state.detail || state.busy) return;
  const id = state.selected;
  state.busy = true; renderDetail();
  toast('Проверяем диалог…');
  try {
    const result = await post(`/api/evaluate/${encodeURIComponent(id)}${state.detail.status === 'Evaluated' ? '?force=true' : ''}`,{});
    updateBudget(result.budget);
    toast(`Оценка: ${fmt(result.evaluation.final_score)} из 100.`);
  } finally { state.busy = false; await loadData(); }
}
function openAppeal(id) {
  state.appealTarget={conversation_id:state.detail.conversation_id,criterion_id:id,evaluation_id:state.detail.evaluation.id};
  $('#appeal-form').reset();
  $('#appeal-criterion').textContent = `${id} · ${state.detail.evaluation.criteria.find(r => r.criterion_id === id).name}`;
  $('#appeal-dialog').showModal();
}
function openResolve(id) {
  const a = state.detail.appeals.find(a => a.id === id);
  if (!a) return;
  state.resolveAppeal = a;
  const c = state.checklist.criteria.find(c => c.id === a.criterion_id);
  const r = state.detail.evaluation.results.find(r => r.criterion_id === a.criterion_id);
  $('#resolve-form').reset();
  $('#resolve-criterion').textContent = `${c.id} · ${c.name}`;
  $('#operator-comment').textContent = a.comment;
  const options = c.type === 'scale' ? c.levels : [0,1];
  $('#resolve-value').innerHTML = options.map(value => `<option value="${value}">${c.type === 'scale' ? fmt(value) : value ? 'Да' : 'Нет'}</option>`).join('') + (c.allow_na ? '<option value="na">Не применяется</option>' : '');
  $('#resolve-value').value = r.is_na ? 'na' : String(r.value);
  $('#resolve-value').disabled = false;
  $('#resolve-dialog').showModal();
}
function collectEditor() {
  state.edit = $$('.editor-criterion').map(node => {
    const v = name => $(`[data-field="${name}"]`,node);
    const type = v('type').value, allow_na = type !== 'flag' && v('allow_na').checked;
    return {id:v('id').value.trim(),name:v('name').value.trim(),description:v('description').value.trim(),
      type, weight:type === 'flag' ? 0 : Number(v('weight').value),max_scale:type === 'scale' ? Number(v('max_scale').value) : 1,
      levels:type === 'scale' ? v('levels').value.split(',').filter(s=>s.trim()).map(s => Number(s.trim())) : [],allow_na,na_condition:v('na_condition').value.trim()};
  });
}
function renderEditor() {
  $('#checklist-editor').innerHTML = state.edit.map((c,i) => `<section class="editor-criterion" data-index="${i}"><div class="editor-grid${c.type === "scale" ? " with-scale" : ""}"><input type="hidden" data-field="id" value="${escapeHTML(c.id)}"><label>Название<input data-field="name" value="${escapeHTML(c.name)}" required maxlength="160"></label><label>Тип<select data-field="type">${[['binary','Да / Нет'],['scale','Баллы'],['flag','Без баллов']].map(([v,l]) => `<option value="${v}" ${c.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label>Вес<input data-field="weight" type="number" min="0" max="10000" step="any" value="${c.weight}" ${c.type === 'flag' ? 'disabled' : ''} required></label><label ${c.type !== "scale" ? "hidden" : ""}>Макс. балл<input data-field="max_scale" type="number" min="0.01" max="10000" step="any" value="${c.max_scale}" ${c.type !== 'scale' ? 'disabled' : ''} required></label><button type="button" class="icon-button remove-criterion" aria-label="Удалить критерий ${escapeHTML(c.id)}">×</button></div><label ${c.type !== 'scale' ? 'hidden' : ''}>Допустимые баллы (через запятую)<input class="editor-levels" aria-describedby="levels-help-${i}" data-field="levels" value="${escapeHTML(c.levels.join(', '))}" placeholder="0, 5, 10, 15, 20"></label><p id="levels-help-${i}" class="field-help" ${c.type !== 'scale' ? 'hidden' : ''}>Можно поставить только баллы из этого списка.</p><div class="editor-na"><input data-field="allow_na" id="na-${i}" type="checkbox" ${c.allow_na ? 'checked' : ''} ${c.type === 'flag' ? 'disabled' : ''}><label for="na-${i}">Можно не учитывать</label></div><details class="editor-rules"><summary>Правило и исключения</summary><div class="editor-detail"><label>Правило<textarea data-field="description" rows="3" required maxlength="2500">${escapeHTML(c.description)}</textarea></label><label>Когда не учитывать<textarea data-field="na_condition" rows="3" maxlength="1000" ${!c.allow_na || c.type === 'flag' ? 'disabled' : 'required'}>${escapeHTML(c.na_condition)}</textarea></label></div></details></section>`).join('');
  $('#weight-total').textContent = `Сумма весов: ${fmt(state.edit.reduce((s,c) => s+c.weight,0))}`;
}
function openChecklist() {
  if (state.busy) return toast('Дождитесь завершения оценки.',true);
  state.edit = structuredClone(state.checklist.criteria);
  state.editVersion = state.checklist.version;
  $('#editor-version').textContent = `v${state.editVersion}`;
  renderEditor(); $('#checklist-dialog').showModal();
}
function download(name,data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}));
  const a = document.createElement('a'); a.href=url; a.download=name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
async function openAudit() {
  const data = await api('/api/audit'); state.audit = data.events;
  const actions = {dataset_imported:'Диалоги загружены',checklist_updated:'Правила обновлены',evaluation_started:'Начата оценка',evaluation_completed:'Оценка завершена',evaluation_failed:'Ошибка оценки',appeal_submitted:'Подана апелляция',appeal_resolved:'Принято решение по апелляции',test_result_archived:'Тестовая оценка перенесена в историю'};
  $('#audit-content').innerHTML = [...data.events].reverse().map(e => `<article class="audit-event"><time>${dateTime(e.timestamp)}<br>UTC+6</time><div><strong>${actions[e.action] || escapeHTML(e.action)}</strong><p>${escapeHTML(e.conversation_id || e.appeal?.conversation_id || '')}${e.appeal ? ` · ${escapeHTML(e.appeal.criterion_id)} · ${labels[e.appeal.status]}` : ''}</p>${e.appeal ? `<p>${escapeHTML(e.appeal.resolution_comment || e.appeal.comment)}</p>` : ''}${e.before && e.after ? `<p>Балл: ${fmt(e.before.final_score)} → ${fmt(e.after.final_score)}</p>` : e.version ? `<p>Правила обновлены</p>` : ""}</div></article>`).join('') || '<div class="empty">Журнал пока пуст</div>';
  $('#audit-dialog').showModal();
}
function evaluationDeductions(evaluation) {
  return (evaluation?.criteria || []).filter(r=>r.type !== 'flag' && !r.is_na && r.normalized_weight-r.earned_score>0.00001)
    .map(r=>({...r,loss:r.normalized_weight-r.earned_score}));
}
function renderDeductions(evaluation,current) {
  const items=evaluationDeductions(evaluation),node=$('#deductions');node.hidden=items.length===0;
  node.innerHTML=items.length ? `<h3>${current?'Почему снижена оценка':'В предыдущей оценке'}</h3>`+items.map(r=>{
    const reason=r.override_comment || r.reason || '';
    const preview=reason.length>170?reason.slice(0,167)+'…':reason;
    return `<article class="deduction-row"><div class="deduction-top"><span>${escapeHTML(r.name)}</span><span class="deduction-loss" title="Снижение общего балла">−${fmt(r.loss)}</span></div><p>${escapeHTML(preview)}</p>${reason.length>170?`<details><summary>Полный комментарий</summary><p>${escapeHTML(reason)}</p></details>`:''}<button class="deduction-link" data-proof="${r.proof_message_index}">К фрагменту · ${escapeHTML(displayTime(r.proof_timestamp))} ↗</button></article>`;
  }).join('') : '';
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
  for(const name of ['conversations','appeals','analytics']) $(`#${name}-view`).hidden=name!==view;
  const title={conversations:'Диалоги',appeals:'Апелляции',analytics:'Аналитика'}[view];
  $('#page-title').textContent=title;$('#workspace-crumb').textContent=title;
  $$('[data-workspace-view]').forEach(button=>{
    const active=button.dataset.workspaceView===view;button.classList.toggle('active',active);
    if(active) button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  });
  if(updateHistory && window.history && window.location?.hash!==`#${view}`) window.history.pushState(null,'',`#${view}`);
  if(view === 'analytics') renderAnalytics();
  if(view === 'appeals') {
    $('#appeals-content').innerHTML='<div class="loading">Загрузка апелляций…</div>';
    try {
      const result=await api('/api/appeals');if(sequence!==viewSequence)return;
      state.appealItems=result.items;renderAppeals();
    } catch(error) {
      if(sequence!==viewSequence)return;
      $('#appeals-content').innerHTML='<div class="empty">Не удалось загрузить апелляции. Откройте раздел ещё раз.</div>';
      throw error;
    }
  }
}
function renderAppeals() {
  const selected=$('#appeals-filter').value;
  const items=state.appealItems.filter(a=>!selected || (selected==='resolved'?a.status!=='PENDING':a.status===selected));
  const pending=state.appealItems.filter(a=>a.status==='PENDING').length;
  $('#appeals-total').textContent=`Всего: ${state.appealItems.length} · Ожидают решения: ${pending}`;
  $('#appeals-content').innerHTML=items.length?`<div class="table-scroll"><table class="data-table"><thead><tr><th scope="col">Диалог</th><th scope="col">Критерий</th><th scope="col">Комментарий</th><th scope="col">Статус</th><th scope="col">Создана</th><th scope="col"><span class="sr-only">Действие</span></th></tr></thead><tbody>${items.map(a=>`<tr><td><strong>${escapeHTML(a.conversation_id)}</strong><small>${escapeHTML(languageNames[a.language] || 'Диалог недоступен')}${a.channel?' · '+(a.channel==='voice call'?'Звонок':'Чат'):''}</small></td><td>${escapeHTML(a.criterion_name)}</td><td><p class="table-comment">${escapeHTML(a.comment)}</p>${a.resolution_comment?`<details class="appeal-history"><summary>Решение</summary><p>${escapeHTML(a.resolution_comment)}</p></details>`:''}</td><td><span class="badge ${a.status==='PENDING'?'amber':a.status==='APPROVED'?'green':''}">${labels[a.status] || escapeHTML(a.status)}</span></td><td>${escapeHTML(dateTime(a.created_at))}</td><td><button class="button subtle" data-open-appeal="${escapeHTML(a.id)}" ${a.conversation_available?'':'disabled'}>${a.status==='PENDING'&&state.role==='supervisor'?'Рассмотреть':'Открыть'}</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Апелляций по выбранному условию нет.</div>';
}
async function openAppealConversation(id) {
  const appeal=state.appealItems.find(a=>a.id===id);if(!appeal?.conversation_available)return;
  clearTimeout(searchTimer);++filterSequence;state.searchIds=null;
  for(const name of ['search','language','channel','status']) $(`#${name}`).value='';
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
    channels:['agent chat','voice call'].map(channel=>({label:channel==='voice call'?'Звонки':'Чаты',total:items.filter(r=>r.channel===channel).length,
      checked:checked.filter(r=>r.channel===channel).length,average:average(checked.filter(r=>r.channel===channel))}))};
}
function renderAnalytics() {
  if(!state.checklist) {$('#analytics-content').innerHTML='<div class="loading">Загрузка данных…</div>';return;}
  const summary=analyticsSummary(state.items),percent=summary.total?summary.checked/summary.total*100:0;
  const maximum=Math.max(1,...summary.buckets.map(b=>b.count));
  const table=rows=>`<div class="table-scroll"><table class="data-table compact"><thead><tr><th scope="col">Группа</th><th scope="col" class="numeric">Диалогов</th><th scope="col" class="numeric">С оценкой ИИ</th><th scope="col" class="numeric">Средний балл</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHTML(r.label)}</td><td class="numeric">${fmt(r.total,0)}</td><td class="numeric">${fmt(r.checked,0)}</td><td class="numeric">${fmt(r.average,2)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#analytics-content').innerHTML=`<div class="insights-layout"><section class="insight-section"><h2>Оценка диалогов</h2><p class="quiet">Оценки ИИ с учётом решений по апелляциям</p><div class="coverage"><strong>${summary.checked}</strong><span>из ${summary.total} диалогов</span></div><div class="coverage-bar" role="img" aria-label="Оценено ИИ ${summary.checked} из ${summary.total}"><span style="width:${percent}%"></span></div><div class="coverage-legend"><span>С оценкой ИИ: ${summary.checked}</span><span>Без актуальной оценки: ${summary.total-summary.checked}</span></div><p class="quiet">Грубые нарушения в оценённых диалогах: ${summary.violations}</p></section><section class="insight-section"><h2>Распределение баллов</h2><p class="quiet">Только диалоги с рассчитанным баллом</p>${summary.buckets.map(b=>`<div class="distribution-row"><span>${b.label}</span><div class="distribution-track" role="img" aria-label="${b.label} баллов: ${b.count} диалогов"><span style="width:${b.count/maximum*100}%"></span></div><span class="distribution-number">${b.count}</span></div>`).join('')}</section><section class="insight-section full-width"><h2>По языкам</h2><p class="quiet">Средний балл по актуальным оценкам</p>${table(summary.languages)}</section><section class="insight-section full-width"><h2>По каналам</h2>${table(summary.channels)}</section></div>`;
}
const actions = {
  'checklist':openChecklist,'audit':openAudit,
  'reload':() => loadData(),
  'show-list':() => $('.queue').scrollIntoView({behavior:'smooth'}),
  'toggle-list':()=>toggleConversationList(),
  'export':() => { if (state.detail) download(`${state.selected}-cqa.json`,state.detail); },
  'settings':() => { $('#settings-form').elements.token.value=state.token; $('#settings-form').elements.group.value=$('#group-badge').textContent; $('#settings-dialog').showModal(); },
  'batch':() => {
    if(state.busy) return toast('Дождитесь завершения проверки.',true);
    const count = Math.min(state.filtered.filter(r => r.status !== 'Evaluated').length,state.budget.remaining);
    if (count <= 0 || !state.budget.configured) return toast('Нет доступных проверок или диалогов без оценки.',true);
    $('#batch-form').elements.count.max=count; $('#batch-form').elements.count.value=1;
    $('#batch-description').textContent=`Можно проверить до ${count} диалогов.`;
    $('#batch-dialog').showModal();
  }
};
document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]');
  if (close) return close.closest('dialog').close();
  const view=event.target.closest('[data-workspace-view]');
  if(view) return void guarded(()=>setWorkspaceView(view.dataset.workspaceView));
  const appealLink=event.target.closest('[data-open-appeal]');
  if(appealLink) return void guarded(()=>openAppealConversation(appealLink.dataset.openAppeal));
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
document.addEventListener('keydown',event=>{if(event.key==='Escape')toggleConversationList(false);});
for (const id of ['language','channel','status']) $(`#${id}`).addEventListener('change',()=>guarded(()=>filterConversations()));
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);++filterSequence;
  searchTimer=setTimeout(()=>guarded(()=>filterConversations()),200);
});
$('#show-context').addEventListener('change', () => { if (state.detail) renderTranscript(); });
$('#audio').addEventListener('timeupdate', () => { $('#audio-time').textContent=mmss($('#audio').currentTime); });
$('#audio').addEventListener('error', () => { cancelAudioSeek();if (state.detail?.audio_url && $('#audio').getAttribute('src')) toast('Не удалось загрузить запись.',true); });
$('#appeal-form').addEventListener('submit', event => {
  event.preventDefault(); const form=event.currentTarget;
  guarded(async () => {
    await post('/api/appeals/submit',{...state.appealTarget,comment:form.elements.comment.value.trim()});
    $('#appeal-dialog').close(); await loadData(); toast('Апелляция отправлена.');
  },form);
});
$('#resolve-form').elements.action.addEventListener('change', event => { $('#resolve-value').disabled=event.target.value === 'REJECTED'; });
$('#resolve-form').addEventListener('submit', event => {
  event.preventDefault(); const form=event.currentTarget;
  guarded(async () => {
    const a=state.resolveAppeal, value=form.elements.value.value;
    const result=await post('/api/appeals/resolve',{conversation_id:a.conversation_id,criterion_id:a.criterion_id,appeal_id:a.id,action:form.elements.action.value,new_score:value === 'na' ? null : Number(value),is_na:value === 'na',resolution_comment:form.elements.resolution_comment.value.trim()});
    $('#resolve-dialog').close(); await loadData(); toast(`Решение сохранено. Итог: ${fmt(result.evaluation.final_score)} / 100.`);
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
    $('#weight-total').textContent=`Сумма весов: ${fmt(total)}`;
  }
});
$('#checklist-editor').addEventListener('click', event => {
  const remove=event.target.closest('.remove-criterion');
  if (remove) { collectEditor(); state.edit.splice(Number(remove.closest('.editor-criterion').dataset.index),1); renderEditor(); }
});
$('#add-criterion').addEventListener('click', () => {
  collectEditor(); let id=state.edit.length+1; while (state.edit.some(c => c.id === String(id).padStart(2,'0'))) id++;
  state.edit.push({id:String(id).padStart(2,'0'),name:'Новый критерий',description:'Опишите правило оценки',type:'binary',weight:0,max_scale:1,levels:[],allow_na:false,na_condition:''}); renderEditor();
});
$('#checklist-form').addEventListener('submit', event => {
  event.preventDefault(); const form=event.currentTarget;
  guarded(async () => {
    collectEditor(); const result=await post('/api/checklist',{version:state.editVersion,criteria:state.edit});
    $('#checklist-dialog').close(); await loadData();
    toast(result.requires_ai ? `Правила сохранены. Нужно обновить оценок: ${result.stale}.` : `Изменения сохранены. Обновлено оценок: ${result.rescored}.`);
  },form);
});
$('#checklist-form').addEventListener('invalid', event => {
  const details=event.target.closest('details');
  if (details) details.open=true;
},true);
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault(); state.token=event.currentTarget.elements.token.value.trim();
  try { if (state.token) sessionStorage.setItem('cqa-token',state.token); else sessionStorage.removeItem('cqa-token'); } catch { /* Access remains valid for this open page. */ }
  $('#settings-dialog').close(); toast('Настройки сохранены.');
});
$('#refresh-dataset').addEventListener('click', () => guarded(async () => {
  const form=$('#settings-form'); state.token=form.elements.token.value.trim();
  const group=form.elements.group.value;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(group)) throw new Error('Проверьте название группы');
  const result=await post(`/api/dataset/refresh?group_id=${encodeURIComponent(group)}`,{});
  $('#settings-dialog').close(); await loadData(false); toast(`Загружено ${result.records} диалогов группы ${result.group}.`);
}));
$('#batch-form').addEventListener('submit', event => {
  event.preventDefault(); const form=event.currentTarget;
  guarded(async () => {
    if(state.busy) throw new Error('Дождитесь завершения проверки.');
    const ids=state.filtered.filter(r => r.status !== 'Evaluated').slice(0,Number(form.elements.count.value)).map(r => r.id);
    $('#batch-dialog').close(); state.busy=true; renderDetail(); toast(`Проверяем диалоги: ${ids.length}.`);
    try {
      const result=await post('/api/evaluate-batch',{conversation_ids:ids});
      toast(result.error ? `Проверено: ${result.completed.length}. Остальные диалоги не удалось проверить.` : `Проверено ${result.completed.length} диалогов.`,Boolean(result.error));
    } finally { state.busy=false; await loadData(); }
  },form);
});
$('#export-audit').addEventListener('click', () => download('cqa-audit.json',state.audit));
guarded(async () => {
  await loadData();
  if(state.view==='conversations') await setWorkspaceView('conversations',{updateHistory:false});
  if (!state.items.length) toast('Нет диалогов. Загрузите их в настройках.',true);
});
