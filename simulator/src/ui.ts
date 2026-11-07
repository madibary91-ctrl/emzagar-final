/** داشبورد وب شبیه‌ساز (فارسی، راست‌به‌چپ، ریسپانسیو) — بدون هیچ وابستگی بیرونی */
export function dashboardHtml(): string {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>شبیه‌ساز سرویس‌های بیرونی</title>
<style>
:root{--ink:#102c31;--mint:#41e4ad;--bg:#f4f6f7;--card:#fff;--line:#e3e8ea;--bad:#b91c1c;--ok:#15803d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Tahoma,system-ui,sans-serif;font-size:14px;line-height:1.7}
header{background:var(--ink);color:#fff;padding:14px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
header h1{font-size:17px;margin:0}header small{opacity:.75}
main{max-width:1250px;margin:0 auto;padding:16px;display:grid;gap:16px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;min-width:0}
.card h2{font-size:15px;margin:0 0 8px;display:flex;justify-content:space-between;gap:8px;align-items:center}
.badge{font-size:11px;border-radius:999px;padding:1px 10px;background:#e8f7f1;color:var(--ok);white-space:nowrap}.badge.err{background:#fee2e2;color:var(--bad)}
label{display:block;font-size:12px;margin:8px 0 3px;opacity:.8}
select,input,button{font:inherit;border-radius:10px;border:1px solid var(--line);padding:7px 10px;min-height:38px;max-width:100%}
select,input{width:100%;background:#fff}
button{cursor:pointer;background:var(--ink);color:#fff;border:0}button.alt{background:#e8edee;color:var(--ink)}button.warn{background:#fee2e2;color:var(--bad)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.row>*{flex:1 1 auto}
.desc{font-size:12px;opacity:.75;min-height:36px;margin-top:6px}
.tbl{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:640px;font-size:12px}th,td{padding:6px 8px;text-align:right;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f1f5f6;position:sticky;top:0}
td.ltr,.ltr{direction:ltr;text-align:left;font-family:ui-monospace,monospace}
.s2{color:var(--ok);font-weight:700}.s4,.s5,.s0{color:var(--bad);font-weight:700}
h3{margin:0 0 8px;font-size:15px}.muted{opacity:.6}
.presets{display:flex;flex-wrap:wrap;gap:8px}.presets button{flex:0 1 auto}
@media(max-width:520px){main{padding:10px}header h1{font-size:15px}}
</style></head><body>
<header><div><h1>🧪 شبیه‌ساز سرویس‌های بیرونی</h1><small>زرین‌پال · کاوه‌نگار · ملی‌پیامک · GapGPT</small></div><div class="row"><button class="alt" id="resetAll">پاک‌سازی کامل وضعیت</button><span class="badge" id="live">زنده</span></div></header>
<main>
<section class="card"><h3>پیش‌تنظیم‌های سریع</h3><div class="presets" id="presets"></div></section>
<section class="grid" id="services"></section>
<section class="card"><h3>تنظیمات</h3><div class="row"><div><label>صفحه‌ی پرداخت</label><select id="startPay"><option value="manual">دستی (کاربر کلیک می‌کند)</option><option value="auto">خودکار (پرداخت موفق فوری)</option></select></div><div><label>Seed آشوب</label><input id="seed" type="number"></div><div><label>اعتبار کاوه‌نگار (پیامک)</label><input id="credit" type="number"></div></div></section>
<section class="card"><h3>صندوق پیامک <span class="muted" id="smsCount"></span></h3><div class="tbl"><table><thead><tr><th>زمان</th><th>ارائه‌دهنده</th><th>گیرنده</th><th>کد</th><th>متن</th><th>تحویل</th></tr></thead><tbody id="sms"></tbody></table></div></section>
<section class="card"><h3>تراکنش‌های پرداخت <span class="muted" id="payCount"></span></h3><div class="tbl"><table><thead><tr><th>Authority</th><th>مبلغ (تومان)</th><th>وضعیت</th><th>verify</th><th>عملیات</th></tr></thead><tbody id="pay"></tbody></table></div></section>
<section class="card"><h3>درخواست‌های اخیر <span class="muted" id="reqCount"></span></h3><div class="tbl"><table><thead><tr><th>#</th><th>سرویس</th><th>فاز</th><th>مسیر</th><th>سناریو</th><th>وضعیت</th><th>ms</th><th>توضیح</th></tr></thead><tbody id="req"></tbody></table></div></section>
</main>
<script>
const token=new URLSearchParams(location.search).get('token');
const H=token?{'x-sim-token':token,'content-type':'application/json'}:{'content-type':'application/json'};
const api=(p,o={})=>fetch('/__sim/'+p,{headers:H,...o}).then(r=>r.json());
const post=(p,b,m='POST')=>api(p,{method:m,body:JSON.stringify(b||{})});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let cat=null,ui={};
async function init(){
  cat=await api('scenarios');
  document.getElementById('presets').innerHTML=cat.presets.map(p=>'<button class="alt" title="'+esc(p.description)+'" data-p="'+p.id+'">'+esc(p.title)+'</button>').join('');
  document.getElementById('presets').onclick=async e=>{const id=e.target.dataset?.p;if(id){await post('preset/'+id);refresh(true)}};
  document.getElementById('resetAll').onclick=async()=>{await post('reset');refresh(true)};
  document.getElementById('startPay').onchange=e=>post('settings',{startPay:e.target.value},'PUT');
  document.getElementById('seed').onchange=e=>post('settings',{seed:e.target.value},'PUT');
  document.getElementById('credit').onchange=e=>post('kavenegar/credit',{value:e.target.value},'PUT');
  const box=document.getElementById('services');
  box.innerHTML=Object.entries(cat.services).map(([id,s])=>'<div class="card" data-svc="'+id+'"><h2>'+esc(s.label)+'<span class="badge" data-badge></span></h2>'+
   '<label>سناریوی پیش‌فرض</label><select data-sel>'+s.scenarios.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.title)+'</option>').join('')+'</select>'+
   '<label>پارامتر / فاز (اختیاری؛ مثل verify@service_down یا slow:3000)</label><input data-raw class="ltr" placeholder="مثلا slow:3000">'+
   '<div class="desc" data-desc></div><label>تاخیر ثابت (ms)</label><input data-lat type="number" min="0" value="0">'+
   '<div class="row" style="margin-top:10px"><button data-apply>اعمال</button><button class="alt" data-q>افزودن به صف (یک‌بار)</button><button class="warn" data-clear>پاک‌کردن صف</button></div>'+
   '<div class="desc" data-queue></div></div>').join('');
  box.querySelectorAll('[data-svc]').forEach(el=>{
    const id=el.dataset.svc,sel=el.querySelector('[data-sel]'),raw=el.querySelector('[data-raw]');
    const upd=()=>{const x=cat.services[id].scenarios.find(s=>s.id===sel.value);el.querySelector('[data-desc]').textContent=x?x.description:''};
    sel.onchange=()=>{raw.value='';upd()};upd();
    const val=()=>raw.value.trim()||sel.value;
    el.querySelector('[data-apply]').onclick=async()=>{const r=await post('scenario/'+id,{scenario:val(),latencyMs:el.querySelector('[data-lat]').value});if(r.error)alert(r.error);refresh(true)};
    el.querySelector('[data-q]').onclick=async()=>{const r=await post('queue/'+id,{scenario:val(),times:1});if(r.error)alert(r.error);refresh(true)};
    el.querySelector('[data-clear]').onclick=async()=>{await post('queue/'+id,{},'DELETE');refresh(true)};
  });
  refresh(true);setInterval(()=>refresh(false),2000);
}
async function refresh(full){
  try{
    const [st,rq,sm,py]=await Promise.all([api('state'),api('requests?limit=60'),api('sms?limit=30'),api('zarinpal/payments')]);
    document.getElementById('live').textContent='زنده';document.getElementById('live').className='badge';
    for(const [id,s] of Object.entries(st.services)){
      const el=document.querySelector('[data-svc="'+id+'"]');if(!el)continue;
      const b=el.querySelector('[data-badge]');b.textContent=s.scenario+(s.latencyMs?' · '+s.latencyMs+'ms':'');b.className='badge'+(s.scenario==='success'?'':' err');
      el.querySelector('[data-queue]').textContent=s.queue.length?'صف: '+s.queue.map(q=>q.scenario+(q.remaining>1?'×'+q.remaining:'')).join(' ← '):'صف خالی · '+s.calls+' درخواست';
      if(full){el.querySelector('[data-lat]').value=s.latencyMs}
    }
    if(full){document.getElementById('startPay').value=st.settings.startPay;document.getElementById('seed').value=st.seed;document.getElementById('credit').value=st.credit.kavenegar}
    document.getElementById('reqCount').textContent='('+st.counts.requests+')';
    document.getElementById('req').innerHTML=rq.requests.slice().reverse().map(r=>'<tr><td>'+r.id+'</td><td>'+esc(r.service)+'</td><td>'+esc(r.phase)+'</td><td class="ltr">'+esc(r.method+' '+r.path)+'</td><td>'+esc(r.scenario)+' <span class="muted">'+esc(r.source)+'</span></td><td class="s'+String(r.status)[0]+'">'+(r.status||'قطع')+'</td><td>'+r.durationMs+'</td><td>'+esc(r.note||'')+'</td></tr>').join('')||'<tr><td colspan="8" class="muted">هنوز درخواستی نیامده است</td></tr>';
    document.getElementById('smsCount').textContent='('+sm.total+')';
    document.getElementById('sms').innerHTML=sm.sms.slice().reverse().map(s=>'<tr><td>'+esc(new Date(s.at).toLocaleTimeString('fa-IR'))+'</td><td>'+esc(s.provider)+'</td><td class="ltr">'+esc(s.to)+'</td><td class="ltr"><b>'+esc(s.code||'')+'</b></td><td>'+esc(s.text)+'</td><td>'+(s.delivery==='delivered'?'✅':'❌')+'</td></tr>').join('')||'<tr><td colspan="6" class="muted">پیامکی ارسال نشده است</td></tr>';
    document.getElementById('payCount').textContent='('+py.total+')';
    document.getElementById('pay').innerHTML=py.payments.slice().reverse().map(p=>'<tr><td class="ltr">'+esc(p.authority)+'</td><td>'+new Intl.NumberFormat('fa-IR').format(Math.round(p.amount/10))+'</td><td>'+esc(p.status)+(p.verifiedAt?' ✔':'')+'</td><td>'+p.verifyCalls+'</td><td>'+(p.status==='pending'?'<a href="/zarinpal/pg/StartPay/'+encodeURIComponent(p.authority)+'" target="_blank">باز کردن صفحه‌ی پرداخت</a>':'')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">تراکنشی ثبت نشده است</td></tr>';
  }catch(e){document.getElementById('live').textContent='قطع ارتباط';document.getElementById('live').className='badge err'}
}
init();
</script></body></html>`;
}
