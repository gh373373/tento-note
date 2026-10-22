(() => {
"use strict";
/* ---------- 出荷ルール ---------- */
const ROUTES = {
  nae:   [["直売所"],["ネット販売"],["旬菜蔵"],["市場"]],
  yasai: [["直売所"],["ネット販売"],["飲食・スイーツ店"],["旬菜蔵","ヤマダストア","めぐみの郷"]],
};
const KIND_LABEL = {nae:"苗", yasai:"野菜"};
const UNITS = {nae:["ポット","トレイ","本"], yasai:["袋","kg","箱","個"]};
const LOG_MAX = 60;

/* ---------- 小道具 ---------- */
const $ = (s, el=document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2,"0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s+"T00:00:00"); d.setDate(d.getDate()+n); return ymd(d); };
const daysBetween = (a, b) => Math.round((new Date(b+"T00:00:00") - new Date(a+"T00:00:00"))/86400000);
const mdj = s => { if(!s) return "—"; const d=new Date(s+"T00:00:00"); return `${d.getMonth()+1}/${d.getDate()}(${"日月火水木金土"[d.getDay()]})`; };
const timej = iso => { const d=new Date(iso); return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const store = { get(k,f){ try{ const v=localStorage.getItem(k); return v==null?f:JSON.parse(v);}catch{return f;} }, set(k,v){ try{localStorage.setItem(k,JSON.stringify(v));}catch{} } };
const yen = n => "¥" + Math.round(n||0).toLocaleString("ja-JP");
const amt = (e, l) => (e.qty||0) * (e.price ?? l.price ?? 0);
const photoSrc = (o) => (o && o.photoData) || "";

/* ---------- 状態 ---------- */
let lots = {};          // id -> data
let fb = null, fdb = null, auth = null;
let mode = "loading";   // loading | login | shared | local
let tab = "today", filter = "all";
let me = store.get("gh.name", "");
let sheetState = null;
let unsubLots = null;
const fullPhotos = {};  // photo id -> dataURL（詳細画面の大きい写真）

/* ---------- 保存先：Firebase / 設定前はこの端末 ---------- */
const CFG = window.GH_CONFIG || {};
const configured = !!(CFG.firebase && CFG.firebase.apiKey && !/ここに/.test(CFG.firebase.apiKey));
const FB_VER = "10.12.2";
const LOCAL_KEY = "gh.local.lots";
function localSample(){
  const t = today(), ago = n => new Date(Date.now()-n*86400000).toISOString();
  const mk = (name, kind, unit, price, stock, shelf, limitIn, sold) => ({
    name: name+"（サンプル）", kind, unit, stock, shelf, price, shelfLimit: addDays(t, limitIn), stage:0, memo:"",
    createdAt: ago(8), updatedAt: ago(0.2), updatedBy:"サンプル",
    log: sold.map((q,i)=>({t:ago(i+1), type:"sell", qty:q, by:"サンプル"}))
  });
  return {
    s1: mk("紅はるか","yasai","袋",400,40,18,4,[3,4,2,3]),
    s2: mk("玉ねぎ苗","nae","トレイ",600,12,10,2,[1,0,1]),
    s3: mk("にんにく","yasai","袋",500,6,12,12,[2,3,2,2]),
    s4: mk("ビオラ苗","nae","ポット",150,30,24,10,[6,5,7,4]),
  };
}
async function boot(){
  render();
  if(!configured){
    mode = "local"; sales = store.get(SALES_KEY, []);
    lots = store.get(LOCAL_KEY, null) || localSample();
    showBanner("設定前のお試しモードです。記録はこの端末だけに保存されます。");
    render(); return;
  }
  try{
    const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
    const [appM, authM, fsM] = await Promise.all([import(base+"firebase-app.js"), import(base+"firebase-auth.js"), import(base+"firebase-firestore.js")]);
    fb = {...appM, ...authM, ...fsM};
    const app = fb.initializeApp(CFG.firebase);
    try{ fdb = fb.initializeFirestore(app, {localCache: fb.persistentLocalCache({tabManager: fb.persistentMultipleTabManager()})}); }
    catch{ fdb = fb.getFirestore(app); }
    auth = fb.getAuth(app);
    await fb.setPersistence(auth, fb.browserLocalPersistence).catch(()=>{});
    fb.onAuthStateChanged(auth, user => {
      if(unsubLots){ unsubLots(); unsubLots = null; }
      if(!user){ mode = "login"; lots = {}; closeSheet(); render(); return; }
      mode = "shared"; salesFrom = null; ensureSales(); render();
      unsubLots = fb.onSnapshot(fb.collection(fdb, "lots"), snap => {
        const next = {}; snap.forEach(d => { next[d.id] = d.data(); });
        lots = next; render(); if(sheetState) renderSheet();
        $("#modeBanner").hidden = !snap.metadata.fromCache || navigator.onLine;
      }, err => { showBanner("データを読み込めません。暗証番号でもう一度ログインしてください。"); });
    });
  }catch(e){
    mode = "local"; lots = store.get(LOCAL_KEY, null) || {}; sales = store.get(SALES_KEY, []);
    showBanner("通信できないため、この端末だけで動いています。電波のよい所で開き直してください。"); render();
  }
}
function showBanner(t){ const b=$("#modeBanner"); b.textContent=t; b.hidden=false; }
window.addEventListener("offline", () => { if(mode==="shared") showBanner("電波がありません。記録はこの端末にためておき、つながったら自動で送ります。"); });
window.addEventListener("online", () => { if(mode==="shared") $("#modeBanner").hidden = true; });

async function login(pin){
  await fb.signInWithEmailAndPassword(auth, CFG.shopEmail, pin);
}
async function logout(){ if(auth) await fb.signOut(auth); }

async function saveLot(id, data){
  const clean = JSON.parse(JSON.stringify(data));
  if(clean.log && clean.log.length > LOG_MAX) clean.log = clean.log.slice(-LOG_MAX);
  lots[id] = clean;
  if(mode === "shared"){
    // オフラインでもすぐ戻る（つながったら自動送信）
    fb.setDoc(fb.doc(fdb, "lots", id), clean).catch(e => toast(e && e.code==="permission-denied" ? "保存する権限がありません。ログインし直してください" : "保存できませんでした。もう一度試してください"));
  }else{
    store.set(LOCAL_KEY, lots);
  }
  render();
}
/* 既存の商品は「差分」だけ送る。2台で同時に操作しても数が消えない（在庫・店頭は足し引き、記録は追加） */
const EDIT_FIELDS = ["name","kind","unit","price","shelfLimit","memo","photo","photoData","stage"];
async function patchLot(id, before, after, entries, opts={}){
  const clean = JSON.parse(JSON.stringify(after));
  lots[id] = clean;
  if(mode !== "shared"){
    if(clean.log && clean.log.length > LOG_MAX) clean.log = clean.log.slice(-LOG_MAX);
    store.set(LOCAL_KEY, lots); render(); return;
  }
  const p = {updatedAt: clean.updatedAt, updatedBy: clean.updatedBy};
  const dStock = (clean.stock||0) - (before.stock||0);
  if(opts.absStock) p.stock = clean.stock || 0;
  else if(dStock) p.stock = fb.increment(dStock);
  if(opts.absShelf) p.shelf = clean.shelf;
  else { const dShelf = (clean.shelf||0) - (before.shelf||0); if(dShelf) p.shelf = fb.increment(dShelf); }
  EDIT_FIELDS.forEach(k => { if(JSON.stringify(clean[k] ?? null) !== JSON.stringify(before[k] ?? null)) p[k] = clean[k] ?? null; });
  const sp = clean.shipPrices || {}, bp = before.shipPrices || {};
  const args = [];
  Object.keys(sp).forEach(d => { if(sp[d] !== bp[d]) args.push(new fb.FieldPath("shipPrices", d), sp[d]); });
  if(entries.length) p.log = fb.arrayUnion(...JSON.parse(JSON.stringify(entries)));
  const ref = fb.doc(fdb, "lots", id);
  // 出荷先ごとの卸値はキーに「・」などが入るので FieldPath で指定する（その場合は全部を「名前, 値」の並びで渡す）
  const call = args.length ? fb.updateDoc(ref, ...Object.entries(p).flat(), ...args) : fb.updateDoc(ref, p);
  call.catch(e => toast(e && e.code==="permission-denied" ? "保存する権限がありません。ログインし直してください" : e && e.code==="not-found" ? "この商品は別の端末で削除されています" : "保存できませんでした。もう一度試してください"));
  if((clean.log||[]).length > LOG_MAX + 20) trimLog(id);
  render();
}
async function trimLog(id){
  try{
    await fb.runTransaction(fdb, async tx => {
      const ref = fb.doc(fdb, "lots", id); const d = await tx.get(ref); if(!d.exists()) return;
      const log = d.data().log || []; if(log.length > LOG_MAX) tx.update(ref, {log: log.slice(-LOG_MAX)});
    });
  }catch{}
}
async function removeLot(id){
  delete lots[id];
  if(mode==="shared"){ fb.deleteDoc(fb.doc(fdb, "lots", id)).catch(()=>toast("削除できませんでした")); }
  else store.set(LOCAL_KEY, lots);
  render();
}
function newId(){ return mode==="shared" ? fb.doc(fb.collection(fdb, "lots")).id : "l"+Date.now().toString(36); }


/* ---------- 売上の記録（消えない明細。商品を消しても残る） ---------- */
let sales = [], salesLoading = false, unsubSales = null;
const SALES_KEY = "gh.local.sales";
function saleRecord(id, l, e){
  const price = e.price ?? l.price ?? null;
  return {t:e.t, date:ymd(new Date(e.t)), lotId:id, name:l.name, kind:l.kind, unit:l.unit,
    type:e.type, channel: e.type==="ship" ? e.dest : "直売所", qty:e.qty, price, amount: price==null ? null : e.qty*price, by:e.by||""};
}
function recordSale(rec){
  if(mode === "shared"){
    fb.setDoc(fb.doc(fb.collection(fdb, "sales")), rec).catch(e => toast(e && e.code==="permission-denied" ? "売上を保存できません。Firestore のルールを更新してください" : "売上を保存できませんでした"));
  }else{
    sales.push(rec); store.set(SALES_KEY, sales); if(lotSales.id===rec.lotId) lotSales.rows.push(rec);
  }
}
function subscribeSales(from){
  if(mode !== "shared") return;
  if(unsubSales) unsubSales();
  salesLoading = true;
  unsubSales = fb.onSnapshot(fb.query(fb.collection(fdb, "sales"), fb.where("date", ">=", from)), snap => {
    const next = []; snap.forEach(d => next.push(d.data())); sales = next; salesLoading = false;
    render(); if(sheetState && sheetState.kind==="detail") renderSheet();
  }, e => { salesLoading = false; salesFrom = null;
    if(e && e.code==="permission-denied") showBanner("売上の明細を読み書きできません。Firestore のルールに sales の1行を足してください。");
    render(); });
}
let salesFrom = null;
function ensureSales(){
  if(mode !== "shared") return;
  const from = periodRange().from;
  if(salesFrom && salesFrom <= from) return;
  salesFrom = from; subscribeSales(from);
}

/* 商品ごとの累計（売上の明細から数えるので、記録が多くなっても正確） */
let lotSales = {id:null, rows:[], unsub:null};
function watchLotSales(id){
  if(lotSales.id === id) return;
  if(lotSales.unsub) lotSales.unsub();
  lotSales = {id, rows:[], unsub:null};
  if(mode !== "shared"){ lotSales.rows = sales.filter(x => x.lotId === id); return; }
  lotSales.unsub = fb.onSnapshot(fb.query(fb.collection(fdb, "sales"), fb.where("lotId", "==", id)), snap => {
    const rows = []; snap.forEach(d => rows.push(d.data())); lotSales.rows = rows;
    if(sheetState && sheetState.kind==="detail" && sheetState.id===id) renderSheet();
  }, () => {});
}

/* 写真：縮小して保存。一覧用の小さい写真は商品データに、大きい写真は photos に */
async function shrink(file, max){
  const url = URL.createObjectURL(file);
  try{
    const img = await new Promise((res, rej) => { const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=url; });
    const s = Math.min(1, max/Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas"); c.width=Math.round(img.naturalWidth*s); c.height=Math.round(img.naturalHeight*s);
    c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
async function storePhoto(file){
  const thumb = (await shrink(file, 360)).toDataURL("image/jpeg", .72);
  const mini = (await shrink(file, 120)).toDataURL("image/jpeg", .7);
  let photo = null;
  if(mode === "shared"){
    const big = (await shrink(file, 1000)).toDataURL("image/jpeg", .72);
    const ref = fb.doc(fb.collection(fdb, "photos"));
    fb.setDoc(ref, {data: big, t: new Date().toISOString(), by: me||""}).catch(()=>{});
    photo = ref.id; fullPhotos[photo] = big;
  }
  return {photo, photoData: thumb, mini, preview: thumb};
}
async function loadFullPhoto(id){
  if(!id || fullPhotos[id] || mode !== "shared") return;
  fullPhotos[id] = "";
  try{ const d = await fb.getDoc(fb.doc(fdb, "photos", id)); if(d.exists()){ fullPhotos[id] = d.data().data; if(sheetState && sheetState.kind==="detail") renderSheet(); } }catch{}
}

/* ---------- 判定ロジック ---------- */
function analyze(l){
  const total = (l.stock||0) + (l.shelf||0);
  const route = ROUTES[l.kind] || ROUTES.yasai;
  const t = today();
  const daysLeft = l.shelfLimit ? daysBetween(t, l.shelfLimit) : null;
  // 直近7日の売れ行き（1日あたり）
  const since = Date.now() - 7*86400000;
  const created = l.createdAt ? new Date(l.createdAt).getTime() : since;
  const span = Math.max(1, Math.min(7, (Date.now() - Math.max(since, created))/86400000));
  const sold = (l.log||[]).filter(e => e.type==="sell" && new Date(e.t).getTime() >= since).reduce((a,e)=>a+e.qty,0);
  const pace = sold > 0 ? sold/span : null;
  let surplus = null;
  if(daysLeft != null && daysLeft >= 0) surplus = pace==null ? null : Math.max(0, Math.ceil(total - pace*(daysLeft+1)));
  const stage = Math.min(l.stage||0, route.length-1);
  const nextStep = Math.min(stage+1, route.length-1);
  let level="ok", head="順調", text="", suggestQty=0;
  if(total === 0){ level="idle"; head="売り切れ"; text="在庫ゼロです。収穫・入荷したら「入荷」で数を足してください。"; }
  else if(daysLeft != null && daysLeft < 0){ level="bad"; head="店頭期限切れ"; text=`期限を${-daysLeft}日過ぎています。残り${total}${l.unit}を「${route[nextStep].join("・")}」へ出荷するか、廃棄を記録してください。`; suggestQty=total; }
  else if(daysLeft != null && daysLeft <= 1){ level="bad"; head= daysLeft===0?"今日が店頭期限":"明日が店頭期限"; text=`このままだと${surplus ?? total}${l.unit}残りそうです。「${route[nextStep].join("・")}」へ回す準備を。`; suggestQty=surplus ?? total; }
  else if(surplus != null && surplus > 0){ level = daysLeft<=4 ? "bad" : "warn"; head=`約${surplus}${l.unit}余りそう`; text=`売れ行きは1日${pace.toFixed(1)}${l.unit}。期限${mdj(l.shelfLimit)}までに売り切れない見込みです。次の出荷先は「${route[nextStep].join("・")}」。`; suggestQty=surplus; }
  else if(pace == null && daysLeft != null && daysLeft <= 4){ level="warn"; head="売れ行き不明"; text="直近の販売記録がありません。店頭チェックで数を数えると、余りそうか判定できます。"; }
  else { text = daysLeft==null ? "店頭期限が未設定です。" : (pace ? `1日${pace.toFixed(1)}${l.unit}ペース。期限${mdj(l.shelfLimit)}までに売り切れる見込みです。` : `期限${mdj(l.shelfLimit)}まであと${daysLeft}日。`); }
  return {total, daysLeft, pace, surplus, level, head, text, route, stage, nextStep, suggestQty};
}
const RANK = {bad:0, warn:1, ok:2, idle:3};
function sortedLots(){
  return Object.entries(lots).map(([id,l]) => ({id, l, a:analyze(l)}))
    .sort((x,y) => RANK[x.a.level]-RANK[y.a.level] || (x.a.daysLeft??999)-(y.a.daysLeft??999) || x.l.name.localeCompare(y.l.name,"ja"));
}

/* ---------- 画面 ---------- */
function thumbHTML(l, cls="thumb"){
  const src = photoSrc(l);
  return `<div class="${cls}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : esc((l.name||"?").slice(0,1))}</div>`;
}
function cardHTML({id,l,a}){
  return `<button type="button" class="card ${a.level==="bad"?"bad":a.level==="warn"?"warn":""}" data-open="${esc(id)}">
    ${thumbHTML(l)}
    <div class="card-body">
      <div class="card-title"><span class="kind ${l.kind}">${KIND_LABEL[l.kind]}</span><strong>${esc(l.name)}</strong></div>
      <div class="counts num"><span>店頭 <b>${l.shelf||0}</b></span><span>在庫 <b>${l.stock||0}</b></span><span>期限 <b>${mdj(l.shelfLimit)}</b></span>${l.price!=null?`<span>${yen(l.price)}</span>`:""}</div>
      <span class="pill ${a.level}">${esc(a.head)}${a.level!=="ok"&&a.level!=="idle"&&a.suggestQty?` → ${esc(a.route[a.nextStep][0])}${a.route[a.nextStep].length>1?"など":""}`:""}</span>
    </div></button>`;
}
function render(){
  document.querySelectorAll("[data-tab]").forEach(b => { if(b.dataset.tab===tab) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current"); });
  $("#whoBtn").textContent = "担当：" + (me || "未設定");
  const v = $("#view");
  document.querySelector("nav.tabs").hidden = mode === "login";
  $("#whoBtn").hidden = mode === "login";
  if(mode === "loading"){ v.innerHTML = `<div class="empty">読み込み中…</div>`; return; }
  if(mode === "login"){ v.innerHTML = viewLogin(); return; }
  if(tab === "today") v.innerHTML = viewToday();
  else if(tab === "stock") v.innerHTML = viewStock();
  else if(tab === "ship"){ ensureSales(); v.innerHTML = viewSales(); }
  else if(tab === "new"){ v.innerHTML = viewToday(); }
}
function viewLogin(){
  return `<form class="wrap" id="loginForm" autocomplete="off" style="padding-top:24px">
    <div><h2>お店の暗証番号</h2><p class="sub">責任者から聞いた暗証番号を入れてください。一度入れると、この端末では次から入れなくて大丈夫です。</p></div>
    <div class="field"><label for="pinIn">暗証番号</label><input id="pinIn" type="password" inputmode="numeric" autocomplete="current-password" required minlength="6"></div>
    <p class="sub" id="loginErr" style="color:var(--bad)" hidden></p>
    <button class="submit" type="submit">はじめる</button></form>`;
}
function viewToday(){
  const all = sortedLots();
  const bad = all.filter(x=>x.a.level==="bad"), warn = all.filter(x=>x.a.level==="warn");
  const t0 = new Date(); t0.setHours(0,0,0,0);
  const td = today();
  const salesToday = sales.filter(x => x.type==="sell" && x.date===td).reduce((a,x)=>a+(x.amount||0),0);
  const todo = [...bad, ...warn];
  return `
    <div><h2>${mdj(today())} の店頭</h2><p class="sub">期限が近いもの・余りそうなものから順に並べています。</p></div>
    <div class="tiles num">
      <div class="tile bad"><b>${bad.length}</b><span>今日動かす</span></div>
      <div class="tile warn"><b>${warn.length}</b><span>注意して見る</span></div>
      <div class="tile"><b style="font-size:20px">${yen(salesToday)}</b><span>今日の直売売上</span></div>
    </div>
    <div class="list">${todo.length ? todo.map(cardHTML).join("") : `<div class="empty">今日動かす必要があるものはありません。<br>店頭チェックで数と写真を更新しておきましょう。</div>`}</div>
    ${all.length ? `<div><h2>順調なもの</h2></div><div class="list">${all.filter(x=>x.a.level==="ok"||x.a.level==="idle").map(cardHTML).join("") || `<div class="empty">なし</div>`}</div>` :
      `<div class="empty">まだ商品が登録されていません。下の「登録」から最初の苗・野菜を追加してください。</div>`}`;
}
function viewStock(){
  const all = sortedLots().filter(x => filter==="all" || x.l.kind===filter);
  const sum = k => all.reduce((s,x)=>s+(x.l[k]||0),0);
  return `
    <div><h2>在庫一覧</h2><p class="sub">商品をタップすると、売れた・補充・出荷・店頭チェックができます。</p></div>
    <div class="seg" role="group" aria-label="種類で絞り込み">
      ${[["all","すべて"],["nae","苗"],["yasai","野菜"]].map(([k,t])=>`<button type="button" data-filter="${k}" aria-pressed="${filter===k}">${t}</button>`).join("")}
    </div>
    <div class="tiles num"><div class="tile"><b>${all.length}</b><span>品目</span></div><div class="tile"><b>${sum("shelf")}</b><span>店頭</span></div><div class="tile"><b>${sum("stock")}</b><span>畑・ハウス在庫</span></div></div>
    <div class="list">${all.length ? all.map(cardHTML).join("") : `<div class="empty">該当する商品はありません。</div>`}</div>`;
}
let salesPeriod = "month", pickMonth = "";
function periodRange(){
  const t = today();
  if(salesPeriod==="today") return {from:t, to:t, label:"今日"};
  if(salesPeriod==="week") return {from:addDays(t,-6), to:t, label:"この7日間"};
  if(salesPeriod==="month") return {from:t.slice(0,7)+"-01", to:t, label:"今月"};
  if(salesPeriod==="last"){ const d=new Date(t.slice(0,7)+"-01T00:00:00"); d.setDate(0); const m=ymd(d).slice(0,7); return {from:m+"-01", to:ymd(d), label:"先月"}; }
  const m = pickMonth || t.slice(0,7); const e = new Date(m+"-01T00:00:00"); e.setMonth(e.getMonth()+1); e.setDate(0);
  return {from:m+"-01", to:ymd(e), label:`${Number(m.slice(5))}月`};
}
function salesInRange(){ const r = periodRange(); return {r, rows: sales.filter(x => x.date >= r.from && x.date <= r.to)}; }
function viewSales(){
  const {r, rows} = salesInRange();
  const sum = (arr) => arr.reduce((a,x)=>a+(x.amount||0),0);
  const byCh = {}, byItem = {};
  rows.forEach(x => {
    const c = byCh[x.channel] = byCh[x.channel] || {yen:0, n:0, units:{}};
    c.yen += x.amount||0; c.n++; c.units[x.unit] = (c.units[x.unit]||0) + x.qty;
    const k = x.name+"｜"+x.unit, it = byItem[k] = byItem[k] || {name:x.name, unit:x.unit, kind:x.kind, qty:0, yen:0, direct:0};
    it.qty += x.qty; it.yen += x.amount||0; if(x.type==="sell") it.direct += x.qty;
  });
  const direct = rows.filter(x=>x.type==="sell"), ship = rows.filter(x=>x.type==="ship");
  const unitsTxt = u => Object.entries(u).map(([k,v])=>`${v}${k}`).join("・");
  const routeCard = (k) => `<div class="rule-card"><h3><span class="kind ${k}">${KIND_LABEL[k]}</span>の出荷順</h3>
    <div class="route">${ROUTES[k].map((names,i)=>`<div class="route-step"><span class="n">${i+1}</span><span>${names.join("・")}</span><span class="q">${i===0?"まずはここで":i===ROUTES[k].length-1?"最後の受け皿":"余りそうなら"}</span></div>`).join("")}</div></div>`;
  const items = Object.values(byItem).sort((a,b)=>b.yen-a.yen || b.qty-a.qty);
  return `
    <div><h2>売上と販売数量</h2><p class="sub">「売れた」「店頭チェック」「出荷する」で記録した分を集計しています。</p></div>
    <div class="seg" role="group" aria-label="期間">
      ${[["today","今日"],["week","7日間"],["month","今月"],["last","先月"],["pick","月を選ぶ"]].map(([k,t])=>`<button type="button" data-period="${k}" aria-pressed="${salesPeriod===k}">${t}</button>`).join("")}
    </div>
    ${salesPeriod==="pick"?`<div class="field"><label for="monthIn">集計する月</label><input id="monthIn" type="month" value="${esc(pickMonth||today().slice(0,7))}"></div>`:""}
    <p class="sub num">${esc(r.label)}：${mdj(r.from)}〜${mdj(r.to)}${salesLoading?"（読み込み中…）":""}</p>
    <div class="tiles num">
      <div class="tile"><b style="font-size:20px">${yen(sum(rows))}</b><span>売上の合計</span></div>
      <div class="tile"><b style="font-size:20px">${yen(sum(direct))}</b><span>直売所</span></div>
      <div class="tile"><b style="font-size:20px">${yen(sum(ship))}</b><span>出荷先</span></div>
    </div>
    <div class="box"><h4>販売先ごと</h4>${Object.keys(byCh).length ? `<div class="ship-sum">${Object.entries(byCh).sort((a,b)=>b[1].yen-a[1].yen).map(([c,v])=>`<div><strong>${esc(c)}</strong><span class="num" style="text-align:right">${yen(v.yen)}<br><small class="sub">${esc(unitsTxt(v.units))}</small></span></div>`).join("")}</div>` : `<p class="sub">この期間の販売記録はありません。</p>`}</div>
    <div class="box"><h4>品目ごと</h4>${items.length ? `<div class="ship-sum">${items.map(it=>`<div><strong><span class="kind ${it.kind}">${KIND_LABEL[it.kind]||""}</span> ${esc(it.name)}</strong><span class="num" style="text-align:right">${it.qty}${esc(it.unit)}　${yen(it.yen)}<br><small class="sub">うち直売 ${it.direct}${esc(it.unit)}</small></span></div>`).join("")}</div>` : `<p class="sub">この期間の販売記録はありません。</p>`}</div>
    ${rows.length ? `<button type="button" class="act wide" id="csvBtn">この期間の明細をCSVで保存<small>Excel で開けます（${rows.length}件）</small></button>` : ""}
    <div><h2>出荷先のルール</h2><p class="sub">店頭だけで売り切れないと判断したら、上から順に次の行き先へ回します。</p></div>
    <div class="rules">${routeCard("nae")}${routeCard("yasai")}</div>`;
}
function downloadCSV(){
  const {r, rows} = salesInRange();
  const q = v => { const t = String(v ?? ""); return /[",\n]/.test(t) ? `"${t.replace(/"/g,'""')}"` : t; };
  const head = ["日付","時刻","品名","種類","販売先","数量","単位","単価","金額","担当"];
  const lines = rows.slice().sort((a,b)=>a.t<b.t?-1:1).map(x => [x.date, new Date(x.t).toTimeString().slice(0,5), x.name, KIND_LABEL[x.kind]||"", x.channel, x.qty, x.unit, x.price ?? "", x.amount ?? "", x.by].map(q).join(","));
  const blob = new Blob(["﻿" + [head.join(","), ...lines].join("\r\n")], {type:"text/csv"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `sales_${r.from}_${r.to}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- シート（詳細・操作・登録） ---------- */
function openSheet(s){ sheetState = s; renderSheet(); $("#sheet").hidden = false; $("#sheet").scrollTop = 0; document.body.style.overflow="hidden"; }
function closeSheet(){ if(lotSales.unsub){ lotSales.unsub(); } lotSales = {id:null, rows:[], unsub:null}; sheetState = null; $("#sheet").hidden = true; $("#sheet").innerHTML=""; document.body.style.overflow=""; if(tab==="new"){ tab="today"; render(); } }
function renderSheet(){
  const s = sheetState; if(!s) return;
  const el = $("#sheet");
  if(s.kind === "detail"){ const l = lots[s.id]; if(!l){ closeSheet(); return; } el.innerHTML = sheetDetail(s.id, l); }
  else if(s.kind === "action"){ if(!lots[s.id]){ closeSheet(); return; } if(!s.drawn){ el.innerHTML = sheetAction(s); s.drawn = true; } }
  else if(s.kind === "edit"){ if(!s.drawn){ el.innerHTML = sheetEdit(s); s.drawn = true; } }
}
function head(title, backTo){ return `<div class="sheet-head"><button type="button" class="back" data-back="${backTo||""}">‹ 戻る</button><h3>${esc(title)}</h3></div>`; }

function sheetDetail(id, l){
  const a = analyze(l);
  if(l.photo) loadFullPhoto(l.photo);
  const src = (l.photo && fullPhotos[l.photo]) || photoSrc(l);
  const shipped = {};
  watchLotSales(id);
  const mine = lotSales.id===id ? lotSales.rows : [];
  mine.forEach(x => { if(x.type==="ship") shipped[x.channel] = (shipped[x.channel]||0)+x.qty; });
  const soldAll = mine.filter(x=>x.type==="sell").reduce((s,x)=>s+x.qty,0);
  const soldYen = mine.filter(x=>x.type==="sell").reduce((s,x)=>s+(x.amount||0),0);
  const shipYen = mine.filter(x=>x.type==="ship").reduce((s,x)=>s+(x.amount||0),0);
  const LOGNAME = {sell:"売れた", restock:"店頭へ補充", ship:"出荷", discard:"廃棄", count:"店頭チェック", harvest:"入荷・収穫", create:"登録", edit:"内容を変更"};
  const logs = (l.log||[]).slice().reverse().slice(0,20);
  return `${head(l.name)}
  <div class="sheet-body"><div class="wrap">
    <div class="hero">${src?`<img src="${esc(src)}" alt="${esc(l.name)}の店頭写真" onerror="this.remove()">`:esc(l.name.slice(0,1))}</div>
    <div class="card-title"><span class="kind ${l.kind}">${KIND_LABEL[l.kind]}</span><strong style="font-size:18px">${esc(l.name)}</strong>${l.price?`<span class="sub num">販売価格 ${yen(l.price)}／${esc(l.unit)}</span>`:""}</div>
    <div class="stat-row num">
      <div class="stat"><span>店頭</span><b>${l.shelf||0}</b> ${esc(l.unit)}</div>
      <div class="stat"><span>畑・ハウス在庫</span><b>${l.stock||0}</b> ${esc(l.unit)}</div>
      <div class="stat"><span>店頭期限</span><b style="font-size:17px">${mdj(l.shelfLimit)}</b></div>
    </div>
    <div class="advice ${a.level}"><strong>${esc(a.head)}</strong><p>${esc(a.text)}</p></div>
    <div class="actions">
      <button type="button" class="act primary wide" data-act="count">店頭チェック<small>写真を撮って、店頭の数を入れ直す</small></button>
      <button type="button" class="act" data-act="sell">売れた<small>店頭から減らす</small></button>
      <button type="button" class="act" data-act="restock">店頭へ補充<small>在庫 → 店頭</small></button>
      <button type="button" class="act" data-act="ship">出荷する<small>${esc(a.route[a.nextStep].join("・"))} など</small></button>
      <button type="button" class="act" data-act="harvest">入荷・収穫<small>在庫を増やす</small></button>
      <button type="button" class="act" data-act="discard">廃棄<small>傷み・枯れ</small></button>
      <button type="button" class="act" data-act="edit">内容を変更<small>期限・価格・数の直し</small></button>
    </div>
    <div class="box"><h4>出荷ルートと実績</h4><div class="route">
      ${a.route.map((names,i)=>{ const q = i===0 ? soldAll : names.reduce((s,n)=>s+(shipped[n]||0),0);
        const cls = i===a.stage ? "now" : i<a.stage ? "done" : "";
        return `<div class="route-step ${cls}"><span class="n">${i+1}</span><span>${names.join("・")}${i===a.stage?" <small class='sub'>（今ここ）</small>":""}</span><span class="q num">${q?`${q}${esc(l.unit)}`:"—"}</span></div>`; }).join("")}
    </div>
    <div class="counts num" style="justify-content:space-between"><span>直売の売上 <b>${yen(soldYen)}</b></span><span>出荷の金額 <b>${yen(shipYen)}</b></span></div></div>
    ${l.memo?`<div class="box"><h4>メモ</h4><div>${esc(l.memo)}</div></div>`:""}
    <div class="box"><h4>記録</h4><div class="log">${logs.length ? logs.map(e=>{
      const im = e.mini || "";
      const pr = (e.type==="sell"||e.type==="ship") && (e.price ?? l.price) != null ? `（${yen(amt(e,l))}）` : "";
      const what = e.type==="ship" ? `出荷 → ${esc(e.dest)} ${e.qty}${esc(l.unit)}${pr}` : e.type==="count" ? `店頭チェック：${e.qty}${esc(l.unit)}` : e.type==="create"||e.type==="edit" ? LOGNAME[e.type] : `${LOGNAME[e.type]||e.type} ${e.qty}${esc(l.unit)}${pr}`;
      return `<div class="log-row"><time>${timej(e.t)}</time><span class="what">${what}<br><small class="sub">${esc(e.by||"")}${e.note?"・"+esc(e.note):""}</small></span>${im?`<img src="${esc(im)}" alt="" onerror="this.remove()">`:"<span></span>"}</div>`; }).join("") : `<p class="sub">まだ記録がありません。</p>`}</div></div>
  </div></div>`;
}

const ACT_META = {
  sell:{title:"売れた数", btn:"売れた数を記録", hint:"店頭から減らします。"},
  restock:{title:"店頭へ補充", btn:"補充を記録", hint:"畑・ハウス在庫から店頭へ移します。"},
  ship:{title:"出荷する", btn:"出荷を記録", hint:"在庫から先に減らし、足りない分は店頭から減らします。"},
  harvest:{title:"入荷・収穫", btn:"在庫に足す", hint:"畑・ハウス在庫に足します。"},
  discard:{title:"廃棄", btn:"廃棄を記録", hint:"店頭から減らします。ロスとして記録されます。"},
  count:{title:"店頭チェック", btn:"店頭の数を保存", hint:"今、店頭に並んでいる数を数えて入れてください。減った分は「売れた」として計算します。"},
};
function sheetAction(s){
  const l = lots[s.id], a = analyze(l), m = ACT_META[s.act];
  let start = 1;
  if(s.act==="count") start = l.shelf||0;
  if(s.act==="ship") start = Math.max(1, a.suggestQty || 1);
  if(s.act==="restock") start = Math.max(1, Math.min(l.stock||0, 10));
  s.dest = s.dest || a.route[a.nextStep][0];
  const dests = a.route.slice(1).flat();
  return `${head(m.title+"｜"+l.name, "detail")}
  <div class="sheet-body"><form class="wrap" id="actForm" autocomplete="off">
    <p class="sub">${esc(m.hint)}　いま：店頭 <b class="num">${l.shelf||0}</b>・在庫 <b class="num">${l.stock||0}</b> ${esc(l.unit)}</p>
    ${s.act==="count" ? `<div class="field"><span class="lbl">店頭の写真</span><div class="photo-pick"><div class="prev" id="prev">写真なし</div>
      <label class="file-btn">写真を撮る・選ぶ<input type="file" id="photoIn" accept="image/*" capture="environment"></label></div></div>` : ""}
    ${s.act==="ship" ? `<div class="field"><span class="lbl">出荷先</span><div class="choice" id="destChoice">${dests.map(d=>{
        const step = a.route.findIndex(g=>g.includes(d));
        return `<button type="button" data-dest="${esc(d)}" aria-pressed="${d===s.dest}">${step+1}. ${esc(d)}${step===a.nextStep?'<span class="rec">次はここ</span>':""}</button>`; }).join("")}</div></div>` : ""}
    <div class="field"><label for="qty">${s.act==="count"?"店頭に並んでいる数":"数"}（${esc(l.unit)}）</label>
      <div class="stepper"><button type="button" data-step="-1" aria-label="1減らす">−</button><input id="qty" type="number" inputmode="numeric" min="0" step="1" value="${start}"><button type="button" data-step="1" aria-label="1増やす">＋</button></div>
      <div class="quick">${[5,10].map(n=>`<button type="button" data-step="${n}">+${n}</button>`).join("")}${s.act==="ship"||s.act==="discard"?`<button type="button" data-set="${a.total}">全部（${a.total}）</button>`:""}${s.act==="restock"?`<button type="button" data-set="${l.stock||0}">在庫全部（${l.stock||0}）</button>`:""}</div>
    </div>
    ${s.act==="sell"||s.act==="ship" ? `<div class="field"><label for="aPrice">${s.act==="sell"?"販売価格":"出荷単価"}（円／${esc(l.unit)}）</label>
      <input id="aPrice" type="number" inputmode="numeric" min="0" placeholder="任意" value="${s.act==="sell" ? (l.price??"") : ((l.shipPrices||{})[s.dest] ?? "")}">
      <span class="hint">${s.act==="sell"?"値引きした時はここを変えてください。":"出荷先ごとの卸値を覚えておき、次回から自動で入ります。"}</span></div>` : ""}
    <div class="field"><label for="note">ひとことメモ（任意）</label><input id="note" type="text" placeholder="${s.act==="discard"?"例：葉が黄色くなった":"例：午前中によく売れた"}"></div>
    <button class="submit" type="submit">${m.btn}</button>
  </form></div>`;
}
function sheetEdit(s){
  const l = s.id ? lots[s.id] : {kind: s.preset||"yasai", unit: (UNITS[s.preset||"yasai"])[0], stock:0, shelf:0, shelfLimit: addDays(today(), 7)};
  const kind = l.kind;
  return `${head(s.id ? "内容を変更" : "新しく登録", s.id ? "detail" : "")}
  <div class="sheet-body"><form class="wrap" id="editForm" autocomplete="off">
    <div class="field"><span class="lbl">種類</span><div class="choice" id="kindChoice">
      ${["nae","yasai"].map(k=>`<button type="button" data-kind="${k}" aria-pressed="${kind===k}">${KIND_LABEL[k]}</button>`).join("")}</div>
      <span class="hint" id="routeHint">出荷順：${ROUTES[kind].map(g=>g.join("・")).join(" → ")}</span></div>
    <div class="field"><label for="fName">品名</label><input id="fName" type="text" required placeholder="例：紅はるか、玉ねぎ苗" value="${esc(l.name||"")}"></div>
    <div class="field"><span class="lbl">写真</span><div class="photo-pick"><div class="prev" id="prev">${photoSrc(l)?`<img src="${esc(photoSrc(l))}" alt="">`:"写真なし"}</div>
      <label class="file-btn">写真を撮る・選ぶ<input type="file" id="photoIn" accept="image/*" capture="environment"></label></div></div>
    <div class="two">
      <div class="field"><label for="fShelf">店頭の数</label><input id="fShelf" type="number" inputmode="numeric" min="0" value="${l.shelf}"></div>
      <div class="field"><label for="fStock">畑・ハウス在庫</label><input id="fStock" type="number" inputmode="numeric" min="0" value="${l.stock}"></div></div>
    ${s.id ? `<span class="hint" style="margin-top:-8px">数がずれている時は、今の正しい数に直して保存してください。</span>` : ""}
    <div class="two">
      <div class="field"><label for="fUnit">単位</label><select id="fUnit">${[...new Set([...UNITS[kind], l.unit])].map(u=>`<option ${u===l.unit?"selected":""}>${esc(u)}</option>`).join("")}</select></div>
      <div class="field"><label for="fPrice">販売価格（円）</label><input id="fPrice" type="number" inputmode="numeric" min="0" value="${l.price??""}" placeholder="例：400"></div></div>
    <div class="field"><label for="fLimit">店頭販売期限</label><input id="fLimit" type="date" value="${esc(l.shelfLimit||"")}">
      <div class="quick">${[3,7,14,30].map(n=>`<button type="button" data-limit="${n}">今日から${n}日</button>`).join("")}</div>
      <span class="hint">この日までに店頭で売り切れない見込みなら、次の出荷先を提案します。</span></div>
    <div class="field"><label for="fMemo">メモ（任意）</label><textarea id="fMemo" placeholder="例：A棟ハウス、10/15収穫">${esc(l.memo||"")}</textarea></div>
    <button class="submit" type="submit">${s.id?"変更を保存":"登録する"}</button>
    ${s.id?`<button type="button" class="danger-link" id="delBtn">この商品を削除</button><div id="delConfirm" hidden class="advice bad"><strong>本当に削除しますか？</strong><p>記録もすべて消えます。</p><div class="two"><button type="button" class="act" id="delNo">やめる</button><button type="button" class="act" id="delYes" style="color:var(--bad)">削除する</button></div></div>`:""}
  </form></div>`;
}

/* ---------- 操作 ---------- */
function stamp(){ return {t:new Date().toISOString(), by: me || "未設定"}; }
async function submitAction(s){
  const before = lots[s.id];
  const l = JSON.parse(JSON.stringify(before));
  const entries = [];
  const q = Math.max(0, Math.floor(Number($("#qty").value)||0));
  const note = $("#note").value.trim();
  const e = {...stamp(), type:s.act, qty:q}; if(note) e.note = note;
  const ap = $("#aPrice"); if(ap && ap.value !== "") e.price = Math.max(0, Number(ap.value)||0);
  l.log = l.log || [];
  const unit = l.unit;
  if(s.act !== "count" && q === 0){ toast("数を1以上にしてください"); return false; }
  if(s.act==="sell"){ if(q > l.shelf){ toast(`店頭は${l.shelf}${unit}しかありません`); return false; } l.shelf -= q; }
  if(s.act==="discard"){ const fromShelf = Math.min(q, l.shelf); const rest = q - fromShelf; if(rest > l.stock){ toast("在庫より多い数です"); return false; } l.shelf -= fromShelf; l.stock -= rest; }
  if(s.act==="restock"){ if(q > l.stock){ toast(`在庫は${l.stock}${unit}しかありません`); return false; } l.stock -= q; l.shelf += q; }
  if(s.act==="harvest"){ l.stock += q; }
  if(s.act==="ship"){
    if(q > l.stock + l.shelf){ toast("在庫と店頭の合計より多い数です"); return false; }
    const fromStock = Math.min(q, l.stock); l.stock -= fromStock; l.shelf -= (q - fromStock);
    e.dest = s.dest; if(e.price != null){ l.shipPrices = {...(l.shipPrices||{}), [s.dest]: e.price}; } const step = ROUTES[l.kind].findIndex(g=>g.includes(s.dest)); if(step > (l.stage||0)) l.stage = step;
  }
  if(s.act==="count"){
    const diff = (l.shelf||0) - q;
    if(s.photo){ e.mini = s.photo.mini; if(s.photo.photo) e.photo = s.photo.photo; l.photo = s.photo.photo; l.photoData = s.photo.photoData; }
    if(diff > 0){ const se = {...stamp(), type:"sell", qty:diff, note:"店頭チェックで計算", ...(l.price!=null?{price:l.price}:{})}; l.log.push(se); entries.push(se); recordSale(saleRecord(s.id, l, se)); }
    l.shelf = q;
  }
  l.log.push(e); entries.push(e); l.updatedAt = e.t; l.updatedBy = e.by;
  if(s.act==="sell" || s.act==="ship") recordSale(saleRecord(s.id, l, e));
  await patchLot(s.id, before, l, entries, {absShelf: s.act==="count"});
  toast({sell:`${q}${unit} 売れたと記録しました`, restock:`${q}${unit} 店頭へ補充しました`, ship:`${s.dest} へ ${q}${unit} 出荷しました`, harvest:`${q}${unit} 在庫に足しました`, discard:`${q}${unit} の廃棄を記録しました`, count:`店頭 ${q}${unit} で保存しました`}[s.act]);
  return true;
}
async function submitEdit(s){
  const name = $("#fName").value.trim(); if(!name){ toast("品名を入れてください"); return false; }
  const base = s.id ? JSON.parse(JSON.stringify(lots[s.id])) : {stock:0, shelf:0, stage:0, log:[], createdAt:new Date().toISOString()};
  base.name = name; base.kind = s.kindSel; base.unit = $("#fUnit").value;
  const p = $("#fPrice").value; base.price = p===""?null:Math.max(0,Number(p));
  base.shelfLimit = $("#fLimit").value || null; base.memo = $("#fMemo").value.trim();
  const nShelf = Math.max(0, Math.floor(Number($("#fShelf").value)||0)), nStock = Math.max(0, Math.floor(Number($("#fStock").value)||0));
  const fixShelf = !s.id || nShelf !== (base.shelf||0), fixStock = !s.id || nStock !== (base.stock||0);
  base.shelf = nShelf; base.stock = nStock;
  if(s.photo){ base.photo = s.photo.photo; base.photoData = s.photo.photoData; }
  const e = {...stamp(), type: s.id?"edit":"create", qty:0};
  if(s.id && (fixShelf || fixStock)) e.note = `数を直した（店頭${nShelf}・在庫${nStock}）`;
  base.log = base.log || []; base.log.push(e); base.updatedAt = e.t; base.updatedBy = e.by;
  const id = s.id || newId();
  if(s.id) await patchLot(id, lots[s.id], base, [e], {absShelf: fixShelf, absStock: fixStock}); else await saveLot(id, base);
  toast(s.id ? "変更を保存しました" : `「${name}」を登録しました`);
  return id;
}

let toastTimer;
function toast(t){ const el=$("#toast"); el.textContent=t; el.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.hidden=true, 2400); }

/* ---------- イベント ---------- */
document.addEventListener("click", async ev => {
  const b = ev.target.closest("button"); if(!b) return;
  if(b.dataset.tab){
    if(b.dataset.tab === "new"){ if(!me){ askName(()=>openSheet({kind:"edit", kindSel:"yasai"})); return; } openSheet({kind:"edit", kindSel:"yasai"}); return; }
    tab = b.dataset.tab; render(); window.scrollTo(0,0); return;
  }
  if(b.dataset.period){ salesPeriod = b.dataset.period; render(); return; }
  if(b.id==="csvBtn"){ downloadCSV(); return; }
  if(b.dataset.filter){ filter = b.dataset.filter; render(); return; }
  if(b.dataset.open){ openSheet({kind:"detail", id:b.dataset.open}); return; }
  if(b.id === "whoBtn"){ askName(); return; }
  if(b.dataset.unpick){ const n=b.dataset.unpick; store.set("gh.names", store.get("gh.names",[]).filter(x=>x!==n)); if(me===n){ me=""; store.set("gh.name",""); } const then=sheetState&&sheetState.then; askName(then); toast(`「${n}」を消しました`); return; }
  if(b.dataset.pick && sheetState && sheetState.done){ sheetState.done(b.dataset.pick); return; }
  if(b.hasAttribute("data-back")){
    if(b.dataset.back==="detail" && sheetState && sheetState.id){ openSheet({kind:"detail", id:sheetState.id}); }
    else closeSheet();
    return;
  }
  const s = sheetState; if(!s) return;
  if(b.dataset.act){
    if(!me){ askName(()=>openSheet(b.dataset.act==="edit" ? {kind:"edit", id:s.id, kindSel:lots[s.id].kind} : {kind:"action", id:s.id, act:b.dataset.act})); return; }
    openSheet(b.dataset.act==="edit" ? {kind:"edit", id:s.id, kindSel:lots[s.id].kind} : {kind:"action", id:s.id, act:b.dataset.act}); return;
  }
  if(b.dataset.step){ const i=$("#qty"); i.value = Math.max(0,(Math.floor(Number(i.value)||0)) + Number(b.dataset.step)); return; }
  if(b.dataset.set){ $("#qty").value = b.dataset.set; return; }
  if(b.dataset.dest){ s.dest = b.dataset.dest; const ap=$("#aPrice"); if(ap){ const v=((lots[s.id]||{}).shipPrices||{})[s.dest]; ap.value = v ?? ""; } document.querySelectorAll("#destChoice button").forEach(x=>x.setAttribute("aria-pressed", x===b)); return; }
  if(b.dataset.kind){
    s.kindSel = b.dataset.kind;
    document.querySelectorAll("#kindChoice button").forEach(x=>x.setAttribute("aria-pressed", x===b));
    $("#routeHint").textContent = "出荷順：" + ROUTES[s.kindSel].map(g=>g.join("・")).join(" → ");
    const cur = $("#fUnit").value; $("#fUnit").innerHTML = UNITS[s.kindSel].map(u=>`<option ${u===cur?"selected":""}>${u}</option>`).join("");
    return;
  }
  if(b.dataset.limit){ $("#fLimit").value = addDays(today(), Number(b.dataset.limit)); return; }
  if(b.id==="logoutBtn"){ closeSheet(); await logout(); return; }
  if(b.id==="delBtn"){ $("#delConfirm").hidden=false; b.hidden=true; return; }
  if(b.id==="delNo"){ $("#delConfirm").hidden=true; $("#delBtn").hidden=false; return; }
  if(b.id==="delYes"){ const id=s.id; closeSheet(); await removeLot(id); toast("削除しました"); return; }
});
document.addEventListener("change", async ev => {
  if(ev.target.id === "monthIn"){ pickMonth = ev.target.value; render(); return; }
  if(ev.target.id === "importIn"){ const f=ev.target.files[0]; if(!f) return;
    try{ const data = JSON.parse(await f.text()); const items = Array.isArray(data) ? data : Object.entries(data).map(([id,v])=>({id, ...v}));
      let n=0; for(const it of items){ const {id, ...rest} = it; if(!id || !rest.name) continue; await saveLot(id, rest); n++; }
      toast(`${n}件を取り込みました`); }catch{ toast("ファイルを読めませんでした"); }
    return; }
  if(ev.target.id !== "photoIn") return;
  const f = ev.target.files && ev.target.files[0]; if(!f || !sheetState) return;
  const s = sheetState, prev = $("#prev");
  prev.textContent = "保存中…";
  const btn = $(".submit"); if(btn) btn.disabled = true;
  try{ s.photo = await storePhoto(f); prev.innerHTML = `<img src="${esc(s.photo.preview)}" alt="選んだ写真">`; }
  catch{ prev.textContent = "写真を読めませんでした"; s.photo = null; }
  finally{ if(btn) btn.disabled = false; }
});
document.addEventListener("submit", async ev => {
  ev.preventDefault();
  const s = sheetState; if(!s && ev.target.id !== "loginForm") return;
  const btn = ev.target.querySelector(".submit"); btn.disabled = true;
  try{
    if(ev.target.id === "loginForm"){ const err=$("#loginErr"); err.hidden=true;
      try{ await login($("#pinIn").value.trim()); }
      catch(e){ err.textContent = (e && /network/.test(e.code||"")) ? "通信できません。電波のよい所でもう一度。" : "暗証番号が違います。"; err.hidden=false; }
      return; }
    if(ev.target.id === "nameForm"){ const n=$("#nameIn").value.trim(); if(n) s.done(n); return; }
    if(ev.target.id === "actForm"){ if(await submitAction(s)) openSheet({kind:"detail", id:s.id}); }
    if(ev.target.id === "editForm"){ const id = await submitEdit(s); if(id) openSheet({kind:"detail", id}); }
  }catch{} finally{ btn.disabled = false; }
});

function askName(then){
  openSheet({kind:"name"});
  const names = store.get("gh.names", []);
  $("#sheet").innerHTML = `${head("担当者の名前")}
  <div class="sheet-body"><form class="wrap" id="nameForm">
    <p class="sub">記録に誰が操作したかを残すために使います。この端末に覚えておきます。</p>
    ${names.length?`<div class="field"><span class="lbl">この端末で使った名前</span><div class="choice">${names.map(n=>`<span class="name-chip"><button type="button" data-pick="${esc(n)}">${esc(n)}</button><button type="button" class="unpick" data-unpick="${esc(n)}" aria-label="${esc(n)}を消す">×</button></span>`).join("")}</div>
      <span class="hint">辞めた人の名前は「×」で消せます。これまでの記録に残った名前は消えません。</span></div>`:""}
    <div class="field"><label for="nameIn">名前</label><input id="nameIn" type="text" value="${esc(me)}" placeholder="例：山田" required></div>
    <button class="submit" type="submit">これで始める</button>
    ${mode==="shared"?`<div class="box"><h4>この端末の設定</h4>
      <label class="file-btn">データを取り込む（JSON）<input type="file" id="importIn" accept="application/json,.json"></label>
      <button type="button" class="danger-link" id="logoutBtn">この端末からログアウト</button></div>`:""}</form></div>`;
  const done = n => { me = n; store.set("gh.name", n); store.set("gh.names", [...new Set([n, ...names])].slice(0,8)); closeSheet(); render(); if(then) then(); };
  sheetState.done = done; sheetState.then = then;
}

boot();
})();
