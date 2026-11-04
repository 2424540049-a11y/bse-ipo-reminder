'use strict';

// Offline tests for the browser-only data layer; no DOM emulator or packages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'docs', 'platform.js'), 'utf8');
const clean = value => JSON.parse(JSON.stringify(value));
const BASE = 'https://example.github.io/bse-ipo-reminder/';

function record(changes = {}) {
  return {
    code:'920309', name:'测试股份', subscription_code:'920309',
    subscription_date:'2026-11-04', listing_date:null,
    issue_price:31.92, subscription_limit:499700,
    source_name:'公开测试日程', source_url:'https://www.bse.cn/example',
    subscription_status:'scheduled', ...changes,
  };
}
function published(records = [record()], changes = {}) {
  return {records, generated_at:'2026-11-04T10:00:00+08:00',
    last_attempt:'2026-11-04T10:00:00+08:00', refresh_error:null, ...changes};
}
function harness({storage = new Map(), baseURI = BASE, time = '2026-11-04T14:30:00Z', failWrite = false} = {}) {
  const responses = [], requests = [];
  let epoch = Date.parse(time);
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [epoch])); }
    static now() { return epoch; }
  }
  const navigator = {onLine:true};
  const context = vm.createContext({
    window:{}, document:{baseURI}, navigator, URL, Intl,
    Date:FixedDate, Error, TypeError, AbortController, setTimeout, clearTimeout,
    localStorage:{getItem:key => storage.get(key) ?? null,
      setItem:(key,value) => {if(failWrite) throw new Error('Quota exceeded');storage.set(key,value);}},
    fetch:async (url,options) => {
      requests.push({url:String(url),options});
      if(!responses.length) throw new Error('Unexpected test fetch');
      const response = responses.shift();
      if(response instanceof Error) throw response;
      return {ok:response.status === undefined || response.status === 200,
        status:response.status ?? 200,json:async () => clean(response.payload)};
    },
  });
  vm.runInContext(SOURCE, context, {filename:'platform.js'});
  return {api:context.window.BSEPlatform, storage, requests, navigator,
    queue:payload => responses.push({payload}),
    fail:error => responses.push(error),
    status:status => responses.push({status,payload:{}}),
    time:value => {epoch=Date.parse(value);}};
}

test('published data loads through the project-relative URL and strips private fields', async () => {
  const h=harness();h.queue(published([record({manual:true,account:'private',handled:true})]));
  const state=await h.api.request('/api/refresh',{});
  assert.equal(state.records.length,1);
  assert.equal(state.records[0].manual,false);
  assert.equal(state.records[0].account,undefined);
  assert.equal(state.last_refresh,'2026-11-04T10:00:00+08:00');
  assert.equal(state.refresh_error,null);
  assert.equal(state.refreshing,false);
  const requested=new URL(h.requests[0].url);
  assert.equal(requested.pathname,'/bse-ipo-reminder/data/schedule.json');
  assert.equal(h.requests[0].options.cache,'no-store');
  assert.equal(h.storage.size,1);
});

test('network, empty, duplicate, and invalid data failures retain last-good cache and timestamp', async () => {
  const h=harness();h.queue(published());await h.api.refresh();
  const baseline=clean(h.api.getState());
  const failures=[new TypeError('offline'),published([]),published([record(),record()]),published([record({listing_date:'2026-11-03'})]),published([record()],{generated_at:'invalid'})];
  for(const bad of failures) {
    if(bad instanceof Error) h.fail(bad);else h.queue(bad);
    const current=await h.api.refresh();
    assert.deepEqual(clean(current.records),baseline.records);
    assert.equal(current.last_refresh,baseline.last_refresh);
    assert.equal(current.last_sync,baseline.last_sync);
    assert.ok(current.refresh_error);
  }
  h.status(503);
  assert.match((await h.api.refresh()).refresh_error,/503/);
});

test('an older edge snapshot cannot replace newer published data', async () => {
  const h=harness();h.queue(published());await h.api.refresh();
  h.queue(published([record({name:'旧数据'})],{generated_at:'2026-11-03T10:00:00+08:00'}));
  const state=await h.api.refresh();
  assert.equal(state.records[0].name,'测试股份');
  assert.match(state.refresh_error,/较旧快照/);
});

test('upstream refresh error remains visible even when published JSON downloads successfully', async () => {
  const h=harness();h.queue(published(undefined,{refresh_error:'数据源连接失败，保留昨日快照'}));
  const state=await h.api.refresh();
  assert.equal(state.records.length,1);
  assert.match(state.refresh_error,/数据源连接失败/);
});

test('manual overrides persist locally, survive refresh, and can restore source data', async () => {
  const h=harness();h.queue(published());await h.api.refresh();
  h.api.mutate('/api/record',record({name:'人工核对名称',listing_date:'2026-11-12'}));
  h.queue(published([record({listing_date:'2026-11-13'})],{generated_at:'2026-11-04T11:00:00+08:00'}));
  const updated=await h.api.refresh();
  assert.equal(updated.records[0].name,'人工核对名称');
  assert.equal(updated.records[0].listing_date,'2026-11-12');
  assert.equal(updated.records[0].manual,true);
  const reloaded=harness({storage:h.storage});
  assert.equal(reloaded.api.getState().records[0].listing_date,'2026-11-12');
  const reverted=reloaded.api.mutate('/api/record/delete',{code:'920309'});
  assert.equal(reverted.records[0].listing_date,'2026-11-13');
  assert.equal(reverted.records[0].manual,false);
  assert.equal(harness().api.getState().records.length,0,'another device does not inherit private changes');
  assert.equal(harness({storage:h.storage,baseURI:'https://example.github.io/another-app/'}).api.getState().records.length,0,'another project path is isolated');
});

test('handled flags persist but do not silently handle changed dates or listing events', async () => {
  const h=harness();h.queue(published());await h.api.refresh();
  const id='920309:subscription:2026-11-04';
  h.api.mutate('/api/handled',{id,handled:true});
  assert.ok(harness({storage:h.storage}).api.getState().handled.includes(id));
  h.queue(published([record({subscription_date:'2026-11-05',listing_date:'2026-11-13'})],{generated_at:'2026-11-04T11:00:00+08:00'}));
  const state=await h.api.refresh();
  assert.ok(!state.handled.includes('920309:subscription:2026-11-05'));
  assert.ok(!state.handled.includes('920309:listing:2026-11-13'));
  assert.throws(()=>h.api.mutate('/api/handled',{id,handled:false}),/已变更/);
  assert.throws(()=>h.api.mutate('/api/handled',{id:'920309:listing:2026-11-13',handled:'yes'}),/已变更/);
});

test('demo records and flags cannot contaminate live data', async () => {
  const h=harness();h.queue(published());await h.api.refresh();
  h.api.mutate('/api/handled',{id:'920309:subscription:2026-11-04',handled:true});
  const demo=h.api.mutate('/api/mode',{mode:'demo'});
  assert.ok(demo.records.every(r=>r.source_name==='虚构演示数据'));
  assert.deepEqual(clean(demo.handled),[]);
  const r=demo.records[0],demoId=`${r.code}:subscription:${r.subscription_date}`;
  h.api.mutate('/api/handled',{id:demoId,handled:true});
  assert.throws(()=>h.api.mutate('/api/record',record({code:'920998'})),/退出演示模式/);
  const live=h.api.mutate('/api/mode',{mode:'live'});
  assert.deepEqual(clean(live.records.map(r=>r.name)),['测试股份']);
  assert.deepEqual(clean(live.handled),['920309:subscription:2026-11-04']);
});

test('missing and suspended dates remain unknown and cannot be marked as invented events', async () => {
  const h=harness();h.queue(published([record(),record({code:'920310',subscription_date:null,listing_date:null,subscription_status:'suspended'})]));
  const state=await h.api.refresh();
  assert.equal(state.records[0].listing_date,null);
  assert.equal(state.records[1].subscription_date,null);
  assert.equal(state.records[1].subscription_status,'suspended');
  assert.throws(()=>h.api.mutate('/api/handled',{id:'920309:listing:2026-11-12',handled:true}),/已变更/);
});

test('CSV with BOM, Chinese text, commas, escaped quotes and multiline values round-trips', () => {
  const h=harness();
  const original=h.api.validateRecord(record({name:'测试,股份"A"',source_name:'公告\n第二行'}));
  const csv=h.api.exportCsv([original]);
  assert.ok(csv.startsWith('\uFEFF股票代码,股票名称'));
  assert.deepEqual(clean(h.api.parseCsv(csv)),[clean(original)]);
});

test('CSV import is atomic when later row is invalid or duplicates an earlier stock', () => {
  const h=harness();h.api.mutate('/api/record',record());
  const snapshot=clean(h.api.getState().records),saved=[...h.storage.values()][0];
  const invalid=h.api.exportCsv([record({code:'920310'}),record({code:'920311',subscription_date:'2026-02-30'})]);
  assert.throws(()=>h.api.mutate('/api/import',{csv:invalid}),/第 3 行/);
  assert.deepEqual(clean(h.api.getState().records),snapshot);
  assert.equal([...h.storage.values()][0],saved);
  const duplicate=h.api.exportCsv([record(),record()]);
  assert.throws(()=>h.api.mutate('/api/import',{csv:duplicate}),/重复/);
  assert.equal([...h.storage.values()][0],saved);
});

test('CSV keeps pending dates null and escapes formula prefixes for spreadsheet export', () => {
  const h=harness();
  const r=h.api.validateRecord(record({subscription_date:null,subscription_status:'pending'}),false);
  assert.equal(h.api.parseCsv(h.api.exportCsv([r]))[0].subscription_date,null);
  for(const prefix of ['=','+','-','@','\t','\r']) {
    const csv=h.api.exportCsv([record({name:prefix+'TEST'})]);
    assert.ok(csv.includes("'"+prefix+'TEST'));
  }
  assert.throws(()=>h.api.parseCsv('股票代码,股票代码\n920309,920309\n'),/列名重复/);
  assert.throws(()=>h.api.parseCsv('股票代码,股票名称\n920309,"未闭合'),/未闭合/);
});

test('unsafe source URLs, invalid calendar dates, and nonpositive quantities are rejected', () => {
  const h=harness();
  for(const source_url of ['javascript:alert(1)','data:text/html,x','file:///etc/passwd']) {
    assert.throws(()=>h.api.validateRecord(record({source_url})),/http/);
  }
  for(const subscription_date of ['2026-02-30','2026-13-01','2026/11/04']) {
    assert.throws(()=>h.api.validateRecord(record({subscription_date})),/有效/);
  }
  for(const subscription_limit of [-100,0,1.5,Infinity,true]) {
    assert.throws(()=>h.api.validateRecord(record({subscription_limit})),/正整数/);
  }
});

test('calendar date uses Beijing even after midnight in Brisbane', () => {
  const h=harness({time:'2026-11-04T14:30:00Z'});
  assert.equal(h.api.getState().today,'2026-11-04');
  assert.equal(h.api.getState().timezone,'Asia/Shanghai');
  h.time('2026-11-04T16:00:00Z');
  assert.equal(h.api.getState().today,'2026-11-05');
});

test('unavailable localStorage cannot falsely confirm saving private changes', async () => {
  const h=harness({failWrite:true});h.queue(published());
  const state=await h.api.refresh();
  assert.equal(state.records.length,1,'public data can still be viewed in memory');
  assert.match(state.storage_warning,/无法保存/);
  assert.throws(()=>h.api.mutate('/api/record',record({name:'不应保存'})),/无法保存/);
  assert.equal(h.api.getState().records[0].name,'测试股份');
});

test('corrupt localStorage is preserved and prevents silently overwriting user data', async () => {
  const key='bse-ipo-calendar:/bse-ipo-reminder/:v1';
  const storage=new Map([[key,'not valid JSON']]),h=harness({storage});
  h.queue(published());await h.api.refresh();
  assert.equal(storage.get(key),'not valid JSON');
  assert.match(h.api.getState().storage_warning,/已保留原始记录/);
  assert.throws(()=>h.api.mutate('/api/record',record()),/已保留原始记录/);
});
