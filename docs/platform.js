'use strict';

// Browser-only data layer. Personal changes stay on this device; no server API.
(function () {
  const STORAGE_KEY = `bse-ipo-calendar:${new URL('./', document.baseURI).pathname}:v1`;
  const fields = ['code','name','subscription_code','subscription_date','listing_date','issue_price','subscription_limit','source_url','source_name','subscription_status'];
  const labels = ['股票代码','股票名称','申购代码','申购日期','上市日期','发行价','网上申购上限（股）','来源链接','来源名称','申购状态'];
  let storageWarning = '';
  let readFailure = false;
  let fetching = null;
  let db = {records:[],overrides:{},handled:[],demo_handled:[],mode:'live',generated_at:null,last_attempt:null,last_sync:null,source_error:null,fetch_error:null};

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function beijingToday() {
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    return ['year','month','day'].map(k => parts.find(p => p.type === k).value).join('-');
  }
  function shiftedDate(today, delta) { return new Date(Date.parse(`${today}T00:00:00Z`) + delta * 86400000).toISOString().slice(0,10); }
  function date(value, label) {
    if (value == null || value === '') return null;
    const text = String(value).trim();
    const parsed = Date.parse(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0,10) !== text) throw new Error(`${label}请使用有效的 YYYY-MM-DD 日期`);
    return text;
  }
  function number(value, label, integer = false) {
    if (value == null || value === '') return null;
    const result = typeof value === 'boolean' ? NaN : Number(value);
    if (!Number.isFinite(result) || result <= 0 || (integer && !Number.isSafeInteger(result))) throw new Error(`${label}必须是${integer ? '正整数股数' : '大于 0 的数字'}`);
    return result;
  }
  function validateRecord(raw, requireSubscription = true, manual = true) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('记录格式不正确');
    const code = String(raw.code || '').trim();
    const name = String(raw.name || '').trim();
    const subscriptionCode = String(raw.subscription_code || '').trim() || null;
    if (!/^\d{6}$/.test(code)) throw new Error('股票代码须为 6 位数字，请仅录入北交所网上发行股票');
    if (!name || name.length > 80) throw new Error('请填写不超过 80 字的股票名称');
    if (subscriptionCode && !/^\d{6}$/.test(subscriptionCode)) throw new Error('申购代码须为 6 位数字');
    const subscriptionDate = date(raw.subscription_date,'申购日期');
    const listingDate = date(raw.listing_date,'上市日期');
    if (requireSubscription && !subscriptionDate) throw new Error('请填写网上申购日期；上市日期可留空待公告');
    if (subscriptionDate && listingDate && listingDate < subscriptionDate) throw new Error('上市日期不能早于申购日期');
    const sourceUrl = String(raw.source_url || '').trim();
    if (sourceUrl) {
      let parsed;
      try { parsed = new URL(sourceUrl); } catch { throw new Error('来源链接须为有效的 http 或 https 链接'); }
      if (!['https:','http:'].includes(parsed.protocol) || sourceUrl.length > 2000) throw new Error('来源链接须为有效的 http 或 https 链接');
    }
    return {code,name,subscription_code:subscriptionCode,subscription_date:subscriptionDate,listing_date:listingDate,
      issue_price:number(raw.issue_price,'发行价格'),subscription_limit:number(raw.subscription_limit,'网上申购上限',true),
      source_url:sourceUrl,source_name:String(raw.source_name || (manual ? '手工录入，请核对公告' : '东方财富·北交所新股')).slice(0,120),
      subscription_status:subscriptionDate ? 'scheduled' : raw.subscription_status === 'suspended' ? 'suspended' : 'pending',manual};
  }
  function validatePublished(payload) {
    if (!payload || !Array.isArray(payload.records) || !payload.records.length || payload.records.length > 10000) throw new Error('公开日程数据为空或格式异常，已保留上次数据');
    if (!payload.generated_at || !Number.isFinite(Date.parse(payload.generated_at))) throw new Error('公开日程缺少有效的更新时间');
    const seen = new Set();
    const records = payload.records.map(raw => {
      const record = validateRecord(raw,false,false);
      if (seen.has(record.code)) throw new Error('公开日程包含重复股票，请等待数据源更新');
      seen.add(record.code);
      return record;
    });
    return {records,generated_at:payload.generated_at,last_attempt:payload.last_attempt || payload.generated_at,source_error:payload.refresh_error ? String(payload.refresh_error) : null};
  }
  function persist(next, required = true) {
    if (readFailure) {
      if (required) throw new Error(storageWarning);
      return false;
    }
    try { localStorage.setItem(STORAGE_KEY,JSON.stringify(next)); storageWarning = ''; return true; }
    catch { storageWarning = '当前浏览器无法保存本机记录，请检查无痕模式或存储空间。公开日程仍可查看。'; if (required) throw new Error(storageWarning); return false; }
  }
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) {
      const saved = JSON.parse(text);
      if (!saved || !Array.isArray(saved.records) || !Array.isArray(saved.handled) || !Array.isArray(saved.demo_handled) || !saved.overrides || typeof saved.overrides !== 'object' || Array.isArray(saved.overrides)) throw new Error('本机数据格式异常');
      const records = saved.records.map(r => validateRecord(r,false,false));
      const overrides = {};
      for (const [key,raw] of Object.entries(saved.overrides)) { const r=validateRecord(raw,false,true); if (r.code !== key) throw new Error('本机记录代码不匹配'); overrides[key]=r; }
      db = {...db,...saved,records,overrides,mode:saved.mode === 'demo' ? 'demo' : 'live',fetch_error:null};
    }
  } catch { readFailure = true; storageWarning = '本机保存的数据暂时无法读取，已保留原始记录。当前仅查看公开日程；请备份浏览器数据后再处理存储问题。'; }

  function demoRecords(today) {
    function make(code,name,subDelta,listDelta=null) { return {code,name,subscription_code:code,subscription_date:shiftedDate(today,subDelta),listing_date:listDelta == null ? null : shiftedDate(today,listDelta),issue_price:12.5,subscription_limit:200000,source_url:'',source_name:'虚构演示数据',subscription_status:'scheduled',manual:false}; }
    return [make('920001','示例·今日申购',0),make('920002','示例·即将申购',2),make('920003','示例·今日上市',-9,0),make('920004','示例·即将上市',-7,3),make('920005','示例·上市待公告',-5)];
  }
  function getState() {
    const today = beijingToday();
    const demo = db.mode === 'demo';
    const merged = new Map((demo ? demoRecords(today) : db.records).map(r => [r.code,clone(r)]));
    if (!demo) for (const r of Object.values(db.overrides)) merged.set(r.code,clone(r));
    return {now:new Date().toISOString(),today,timezone:'Asia/Shanghai',mode:db.mode,records:[...merged.values()],handled:[...(demo ? db.demo_handled : db.handled)],
      last_refresh:db.generated_at,last_attempt:db.last_attempt,last_sync:db.last_sync,refresh_error:db.fetch_error || db.source_error || null,
      storage_warning:storageWarning,offline:!navigator.onLine,refreshing:Boolean(fetching)};
  }
  async function refresh() {
    if (fetching) return fetching;
    fetching = (async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(),20000);
        let response;
        try { response = await fetch(new URL(`./data/schedule.json?t=${Date.now()}`,document.baseURI),{cache:'no-store',signal:controller.signal}); }
        finally { clearTimeout(timeout); }
        if (!response.ok) throw new Error(`暂时无法同步公开日程（${response.status}）`);
        const published = validatePublished(await response.json());
        // Never roll a newer cache backward if an old edge cache responds.
        if (db.generated_at && Date.parse(published.generated_at) < Date.parse(db.generated_at)) throw new Error('服务器返回了较旧快照，已保留本机较新日程');
        db = {...db,...published,last_sync:new Date().toISOString(),fetch_error:null};
        persist(db,false);
      } catch (error) {
        db.fetch_error = error.name === 'AbortError' ? '同步超时，已保留上次日程' : (error instanceof TypeError ? '网络不可用，当前显示本机缓存' : error.message);
      } finally { fetching = null; }
      return getState();
    })();
    return fetching;
  }
  function parseCsv(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('CSV 文件为空');
    if (text.length > 2_000_000) throw new Error('CSV 文件过大，请使用小于 2 MB 的文件');
    const rows=[];let row=[],cell='',quoted=false,afterQuote=false;
    text=text.replace(/^\uFEFF/,'');
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(quoted) { if(c==='"' && text[i+1]==='"') { cell+='"';i++; } else if(c==='"') { quoted=false;afterQuote=true; } else cell+=c; }
      else if(c===',') { row.push(cell);cell='';afterQuote=false; }
      else if(c==='\n' || c==='\r') { if(c==='\r' && text[i+1]==='\n') i++;row.push(cell);rows.push(row);row=[];cell='';afterQuote=false; }
      else if(c==='"') { if(cell || afterQuote) throw new Error('CSV 引号格式不正确');quoted=true; }
      else if(afterQuote) { if(!/\s/.test(c)) throw new Error('CSV 引号后存在多余内容'); }
      else cell+=c;
    }
    if(quoted) throw new Error('CSV 引号未闭合');
    if(cell || row.length) {row.push(cell);rows.push(row);}
    if(rows.length<2) throw new Error('CSV 没有数据，请先下载模板');
    const aliases=Object.fromEntries(labels.map((label,i)=>[label,fields[i]]));
    aliases['网上申购上限(股)']='subscription_limit';aliases['网上申购上限']='subscription_limit';
    const headers=rows.shift().map(h=>aliases[h.trim()] || h.trim());
    if(new Set(headers).size!==headers.length) throw new Error('CSV 列名重复，请使用页面模板');
    const seen=new Set(),records=[];
    rows.forEach((values,i)=>{
      if(!values.some(v=>v.trim())) return;
      if(values.length>headers.length) throw new Error(`CSV 第 ${i+2} 行列数不正确`);
      const raw=Object.fromEntries(headers.map((key,j)=>[key,values[j] || '']));
      let record;
      try { record=validateRecord(raw,!['pending','suspended'].includes(raw.subscription_status),true); }
      catch(error) {throw new Error(`CSV 第 ${i+2} 行：${error.message}`);}
      if(seen.has(record.code)) throw new Error(`CSV 股票代码 ${record.code} 重复，请先合并`);
      seen.add(record.code);records.push(record);
    });
    if(!records.length || records.length>2000) throw new Error('单次需导入 1—2,000 条记录');
    return records;
  }
  function exportCsv(records = getState().records) {
    function cell(value) { let text=value==null ? '' : String(value);if(/^[=+@\-\t\r]/.test(text)) text="'"+text;return /[",\n\r]/.test(text) ? '"'+text.replaceAll('"','""')+'"' : text; }
    return '\uFEFF'+[labels,...records.map(r=>fields.map(k=>r[k]))].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
  }
  function downloadCsv(template=false) {
    const blob=new Blob([exportCsv(template ? [] : getState().records)],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=template ? '北交所日程导入模板.csv' : `北交所申购日程_${beijingToday()}.csv`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function mutate(path,body) {
    if(!body || typeof body!=='object' || Array.isArray(body)) throw new Error('请求格式不正确');
    const next=clone(db);
    if(path==='/api/mode') {if(!['live','demo'].includes(body.mode)) throw new Error('模式不正确');next.mode=body.mode;}
    else if(path==='/api/handled') {
      const ids=new Set(getState().records.flatMap(r=>[['subscription',r.subscription_date],['listing',r.listing_date]].filter(([,d])=>d).map(([type,d])=>`${r.code}:${type}:${d}`)));
      if(!ids.has(body.id) || typeof body.handled!=='boolean') throw new Error('事件已变更，请刷新后重试');
      const key=next.mode==='demo' ? 'demo_handled' : 'handled',handled=new Set(next[key]);
      if(body.handled) handled.add(body.id);else handled.delete(body.id);next[key]=[...handled];
    } else {
      if(next.mode==='demo') throw new Error('请先退出演示模式，再编辑真实日程');
      if(path==='/api/record') {const r=validateRecord(body);next.overrides[r.code]=r;}
      else if(path==='/api/record/delete') {if(!Object.hasOwn(next.overrides,body.code)) throw new Error('仅可移除手工记录或覆盖');delete next.overrides[body.code];}
      else if(path==='/api/import') {for(const r of parseCsv(body.csv)) next.overrides[r.code]=r;}
      else throw new Error('未知操作');
    }
    persist(next);db=next;return getState();
  }
  async function request(path,body) { if(path==='/api/state') return getState();if(path==='/api/refresh') return refresh();return mutate(path,body); }
  window.BSEPlatform={request,getState,refresh,mutate,parseCsv,exportCsv,downloadCsv,validateRecord};
})();
