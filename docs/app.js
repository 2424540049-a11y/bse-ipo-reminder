'use strict';

let state = null;
let currentRange = '30';
let busy = false;
let editedCode = null;
let toastTimer;
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateValue = (date) => date ? Date.parse(`${date}T00:00:00+08:00`) : NaN;
const dayDiff = (date) => Math.round((dateValue(date) - dateValue(state.today)) / 86400000);
const eventId = (record, type, date) => `${record.code}:${type}:${date}`;
const number = (value, digits = 0) => value == null || value === '' ? '—' : Number(value).toLocaleString('zh-CN', {maximumFractionDigits:digits});
const safeURL = (value) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const scheduled = (r) => !r.subscription_status || r.subscription_status === 'scheduled';
const pendingListing = (r) => Boolean(scheduled(r) && r.subscription_date && dayDiff(r.subscription_date) <= 0 && !r.listing_date);
function subscriptionSession() {
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const minute = Number(parts.find(p => p.type === 'hour').value) * 60 + Number(parts.find(p => p.type === 'minute').value);
  if (minute < 9 * 60 + 15) return '尚未开始';
  if (minute < 11 * 60 + 30) return '申购时段';
  if (minute < 13 * 60) return '午间休市';
  if (minute < 15 * 60) return '申购时段';
  return '申购已结束';
}

function readableTimestamp(value) {
  if (!value) return '尚未更新';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间未知';
  return date.toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
}

function clockTick() {
  const now = new Date();
  $('#clock').textContent = `北京时间 ${now.toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}`;
}

async function api(path, body) {
  return window.BSEPlatform.request(path,body);
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

function notice(message, isError = false) {
  const box = $('#notice');
  box.hidden = !message;
  box.textContent = message || '';
  box.classList.toggle('error', isError);
}

function render() {
  if (!state) return;
  state.records ||= [];
  state.handled ||= [];
  $('#demo-banner').hidden = state.mode !== 'demo';
  $('#demo-button').hidden = state.mode === 'demo';
  $('#add-button').disabled = state.mode === 'demo';
  $('#import-button').disabled = state.mode === 'demo';
  $('#refresh-button').disabled = busy || state.mode === 'demo';
  $('#refresh-label').textContent = busy ? '正在更新' : '刷新日程';
  $('#refresh-icon').classList.toggle('spinning', busy);
  const isStale = state.last_refresh && Date.now() - new Date(state.last_refresh).getTime() > 24 * 3600000;
  if (state.mode === 'demo') notice('演示模式可查看提醒和标记“已处理”，标记与真实日程分开保存。切回真实日程后可补充或导入记录。');
  else if (state.storage_warning) notice(state.storage_warning, true);
  else if (state.refresh_error) notice(`本次更新未成功：${state.refresh_error}。${state.records.length ? '页面保留已有记录，请核对来源和更新时间。' : '可重试刷新，或根据发行公告手动录入日程。'}`, true);
  else if (state.offline) notice('当前离线，显示此设备上次缓存的日程，请核对更新时间。');
  else if (isStale) notice('公开日程超过 24 小时未更新。刷新可重新同步已发布快照；具体安排请核对发行、上市公告。');
  else if (!state.last_refresh) notice(state.records.length ? '当前为本地记录，尚未成功更新公开数据，请自行核对公告。' : '尚未获取日程，可点击“刷新日程”，也可补充公告信息或体验演示数据。');
  else notice('');
  $('#count-today').textContent = state.records.filter(r => scheduled(r) && r.subscription_date === state.today).length;
  $('#count-upcoming').textContent = state.records.filter(r => scheduled(r) && r.subscription_date && dayDiff(r.subscription_date) > 0 && dayDiff(r.subscription_date) <= 7).length;
  $('#count-listing').textContent = state.records.filter(r => r.listing_date && dayDiff(r.listing_date) >= 0 && dayDiff(r.listing_date) <= 7).length;
  $('#count-pending').textContent = state.records.filter(pendingListing).length;
  renderReminders();
  renderTable();
}

function renderReminders() {
  const filter = $('#reminder-filter').value;
  const events = [];
  for (const record of state.records) {
    for (const [type, key] of [['subscription','subscription_date'],['listing','listing_date']]) {
      const date = record[key];
      if (type === 'subscription' && !scheduled(record)) continue;
      if (!date || dayDiff(date) < 0 || dayDiff(date) > 7) continue;
      if (filter === 'today' && !(type === 'subscription' && date === state.today)) continue;
      if (filter === 'upcoming' && !(type === 'subscription' && date > state.today)) continue;
      if (filter === 'listing' && type !== 'listing') continue;
      events.push({record, type, date, id:eventId(record,type,date)});
    }
  }
  events.sort((a,b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.record.code.localeCompare(b.record.code));
  $('#reminder-total').textContent = events.length;
  const doneCount = events.filter(e => state.handled.includes(e.id)).length;
  $('#reminder-caption').textContent = `今天及未来 7 天 · 北京时间${doneCount ? ` · ${doneCount} 项已处理` : ''}`;
  if (!events.length) {
    $('#reminder-list').innerHTML = `<div class="empty-state"><div class="empty-symbol">✓</div><h3>${state.records.length ? '当前范围内暂无提醒' : '还没有日程记录'}</h3><p>${state.records.length ? '上市日期未公布的项目，可在下方“待公告”中查看。' : '刷新公开数据，或根据公告补充一条日程。'}</p></div>`;
    return;
  }
  $('#reminder-list').innerHTML = events.map(({record:r,type,date,id}) => {
    const done = state.handled.includes(id);
    const today = date === state.today;
    const label = type === 'subscription' ? (today ? subscriptionSession() : '网上申购') : '上市关注';
    const detail = type === 'subscription' ? `申购代码 ${r.subscription_code || '待核对'} · 9:15–11:30 / 13:00–15:00 · 以公告为准` : '核对到账持仓 · 是否卖出由投资经理决定';
    return `<div class="event-row ${type} ${done ? 'handled' : ''}"><div class="event-date"><div class="month">${date.slice(5,7)} 月</div><div class="day">${date.slice(8,10)}</div></div><span class="event-accent"></span><div class="event-main"><div class="event-title"><strong>${esc(r.name)}</strong><span class="code">${esc(r.code)}</span><span class="event-badge ${today ? 'today' : ''}">${today ? '今日 · ' : ''}${label}</span></div><div class="event-detail">${esc(detail)}</div></div><button class="done-button" data-event="${esc(id)}" aria-pressed="${done}">${done ? '✓ 已处理' : '标记处理'}</button></div>`;
  }).join('');
}

function renderTable() {
  const query = $('#search').value.trim().toLowerCase();
  const pendingOnly = $('#pending-only').checked;
  const filtered = state.records.filter(r => {
    if (query && ![r.code,r.name,r.subscription_code].some(v => String(v || '').toLowerCase().includes(query))) return false;
    if (pendingOnly && !pendingListing(r)) return false;
    if (currentRange === 'all') return true;
    const within = [r.subscription_date, r.listing_date].filter(Boolean).some(d => dayDiff(d) >= 0 && dayDiff(d) <= Number(currentRange));
    return within || pendingListing(r);
  }).sort((a,b) => {
    const nextDate = r => [r.subscription_date,r.listing_date].filter(d => d && d >= state.today).sort()[0];
    const aNext = nextDate(a), bNext = nextDate(b);
    if (aNext && bNext) return aNext.localeCompare(bNext) || a.code.localeCompare(b.code);
    if (aNext || bNext) return aNext ? -1 : 1;
    return (b.subscription_date || '').localeCompare(a.subscription_date || '') || a.code.localeCompare(b.code);
  });
  $('#record-total').textContent = filtered.length;
  $('#table-empty').hidden = Boolean(filtered.length);
  $('#schedule-body').innerHTML = filtered.map(r => {
    const sourceURL = safeURL(r.source_url);
    const source = sourceURL ? `<a class="source-link" href="${esc(sourceURL)}" target="_blank" rel="noopener noreferrer">${esc(r.source_name || '查看来源')} ↗</a>` : `<span class="source-link">${esc(r.source_name || '未提供来源')}</span>`;
    const subscriptionDate = r.subscription_status === 'suspended' ? '<span class="pending-date">已暂缓</span>' : r.subscription_date ? esc(r.subscription_date) : '<span class="pending-date">待确认</span>';
    return `<tr><td><div class="stock-name">${esc(r.name)}${r.manual ? '<span class="manual-tag">手工</span>' : ''}</div><div class="stock-code">${esc(r.code)}<span> · 申购 ${esc(r.subscription_code || '待核对')}</span></div></td><td class="${r.subscription_date === state.today ? 'today-date' : ''}">${subscriptionDate}</td><td class="${r.listing_date === state.today ? 'today-date' : ''}">${r.listing_date ? esc(r.listing_date) : '<span class="pending-date">待公告</span>'}</td><td class="number">${r.issue_price != null ? '¥ ' : ''}${number(r.issue_price,4)}</td><td class="number">${number(r.subscription_limit)}${r.subscription_limit != null ? ' 股' : ''}</td><td>${source}</td><td><button class="edit-button" data-edit="${esc(r.code)}" aria-label="编辑${esc(r.name)}" ${state.mode === 'demo' ? 'disabled' : ''}>编辑</button></td></tr>`;
  }).join('');
  const stateText = state.mode === 'demo' ? '演示数据 · 不用于交易' : `公开数据更新：${readableTimestamp(state.last_refresh)}${state.refresh_error ? ' · 当前更新失败' : ''}`;
  $('#data-status').textContent = `${stateText} · 共 ${state.records.length} 条，显示 ${filtered.length} 条`;
}

async function refresh(quiet = false) {
  if (busy || state?.mode === 'demo') return;
  busy = true;
  render();
  let failure = '';
  try {
    state = await api('/api/refresh', {});
    if (!quiet && !state.refresh_error) toast('已同步最新发布的日程，请核对数据更新时间');
  } catch (error) { failure = error.message; }
  finally { busy = false; render(); if (failure) notice(failure, true); }
}

function openRecord(code = null) {
  editedCode = code;
  const form = $('#record-form');
  form.reset();
  const record = code ? state.records.find(r => r.code === code) : null;
  $('#dialog-title').textContent = record ? '编辑日程' : '补充日程';
  $('#form-error').hidden = true;
  $('#delete-record').hidden = !record?.manual;
  for (const key of ['code','name','subscription_code','subscription_date','listing_date','issue_price','subscription_limit','source_name','source_url']) form.elements[key].value = record?.[key] ?? '';
  form.elements.code.readOnly = Boolean(record);
  $('#record-dialog').showModal();
}

$('#refresh-button').addEventListener('click', () => refresh());
$('#add-button').addEventListener('click', () => openRecord());
$('#close-dialog').addEventListener('click', () => $('#record-dialog').close());
$('#cancel-dialog').addEventListener('click', () => $('#record-dialog').close());
$('#reminder-filter').addEventListener('change', () => state && renderReminders());
$('#search').addEventListener('input', () => state && renderTable());
$('#pending-only').addEventListener('change', () => state && renderTable());
document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => {
  currentRange = button.dataset.range;
  document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('active', b === button));
  if (state) renderTable();
}));
document.querySelectorAll('[data-summary]').forEach(button => button.addEventListener('click', () => {
  if (!state) return;
  if (button.dataset.summary === 'pending') {
    $('#pending-only').checked = true;
    $('#search').value = '';
    currentRange = 'all';
    document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('active', b.dataset.range === 'all'));
    renderTable();
    $('#schedule').scrollIntoView({behavior:'smooth'});
  } else {
    $('#reminder-filter').value = button.dataset.summary;
    renderReminders();
    $('#reminders').scrollIntoView({behavior:'smooth'});
  }
}));
$('#reminder-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-event]');
  if (!button || !state) return;
  button.disabled = true;
  try { state = await api('/api/handled', {id:button.dataset.event,handled:!state.handled.includes(button.dataset.event)}); render(); }
  catch (error) { toast(error.message); button.disabled = false; }
});
$('#schedule-body').addEventListener('click', (event) => { const button = event.target.closest('[data-edit]'); if (button) openRecord(button.dataset.edit); });
$('#record-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  for (const key of ['subscription_date','listing_date','issue_price','subscription_limit']) data[key] = data[key] === '' ? null : ['issue_price','subscription_limit'].includes(key) ? Number(data[key]) : data[key];
  data.manual = true;
  if (editedCode) data.subscription_status = state.records.find(r => r.code === editedCode)?.subscription_status;
  if (!data.source_name.trim()) data.source_name = '手工录入';
  if (data.source_url && !safeURL(data.source_url)) { $('#form-error').textContent = '来源链接请使用 http 或 https 地址。'; $('#form-error').hidden = false; return; }
  $('#save-record').disabled = true;
  try { state = await api('/api/record',data); $('#record-dialog').close(); render(); toast('日程已保存'); }
  catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
  finally { $('#save-record').disabled = false; }
});
$('#delete-record').addEventListener('click', async () => {
  if (!editedCode || !confirm('移除这条手工记录或覆盖？若公开来源中存在同一股票，将恢复来源中的日程。')) return;
  try { state = await api('/api/record/delete',{code:editedCode}); $('#record-dialog').close(); render(); toast('手工记录已删除'); }
  catch (error) { $('#form-error').textContent = error.message; $('#form-error').hidden = false; }
});
$('#import-button').addEventListener('click', () => $('#import-file').click());
$('#template-button').addEventListener('click', () => window.BSEPlatform.downloadCsv(true));
$('#export-button').addEventListener('click', () => window.BSEPlatform.downloadCsv(false));
$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { toast('请导入小于 2 MB 的 CSV 文件。'); event.target.value = ''; return; }
  try { state = await api('/api/import',{csv:await file.text()}); render(); toast('CSV 日程已导入，请核对日期及数据来源'); }
  catch (error) { toast(`导入失败：${error.message}`); }
  finally { event.target.value = ''; }
});
async function setMode(mode) {
  try { state = await api('/api/mode',{mode}); render(); if (mode === 'live') refresh(true); }
  catch (error) { toast(error.message); }
}
$('#demo-button').addEventListener('click', () => setMode('demo'));
$('#leave-demo').addEventListener('click', () => setMode('live'));

async function init() {
  clockTick();
  setInterval(clockTick,1000);
  try { state = await api('/api/state'); render(); if (state.mode !== 'demo') refresh(true); }
  catch (error) { notice(error.message, true); $('#reminder-list').innerHTML = '<div class="empty-state"><div class="empty-symbol">!</div><h3>暂时无法载入日程</h3><p>请联网后重新打开页面。</p></div>'; }
  setInterval(async () => {
    if (document.hidden || busy || $('#record-dialog').open) return;
    try { state = await api('/api/state'); render(); } catch (error) { notice(error.message,true); }
  },30000);
  setInterval(() => { if (!document.hidden && !$('#record-dialog').open) refresh(true); },30 * 60000);
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || $('#record-dialog').open) return;
    state = await api('/api/state'); render();
    if (!state.last_sync || Date.now() - new Date(state.last_sync).getTime() > 30 * 60000) refresh(true);
  });
  window.addEventListener('online', () => refresh(true));
  window.addEventListener('offline', async () => { state = await api('/api/state'); render(); });
}
init();

let installPrompt = null;
function isInstalled() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function updateInstallUI() {
  $('#install-button').innerHTML = isInstalled() ? '<span>✓</span> 已安装 / 使用说明' : '<span>↓</span> 安装到手机';
  $('#native-install').hidden = !installPrompt || isInstalled();
  $('#install-status').textContent = isInstalled() ? '已从主屏幕打开。手工日程与处理标记保存在当前应用的设备存储中。' : '安装后可像应用一样打开，手机无需运行 Python。';
}
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; updateInstallUI(); });
window.addEventListener('appinstalled', () => { installPrompt = null; updateInstallUI(); toast('已添加到设备，可从主屏幕打开'); });
$('#install-button').addEventListener('click', () => { updateInstallUI(); $('#install-dialog').showModal(); });
$('#close-install').addEventListener('click', () => $('#install-dialog').close());
$('#native-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; updateInstallUI();
});
$('#copy-link').addEventListener('click', async () => {
  const url = new URL('./',location.href).href;
  try { await navigator.clipboard.writeText(url); toast('链接已复制，可在手机浏览器中打开'); }
  catch { toast('请复制浏览器地址栏中的页面链接'); }
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* Page remains usable online if offline installation is unsupported. */ });
}
updateInstallUI();
