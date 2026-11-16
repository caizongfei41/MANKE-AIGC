(function(){
  if(window.__mkLora) return; window.__mkLora=1;
  (function(){
    if(document.getElementById('mkLoraCss')) return;
    var s=document.createElement('style'); s.id='mkLoraCss';
    s.textContent='.mk-lora-btn{height:26px;min-height:26px;padding:0 9px;border-radius:7px;border:1px solid var(--border);background:var(--bg-elev);color:var(--text-dim);font-size:11px;line-height:24px;cursor:pointer;flex:0 0 auto}.mk-lora-btn:hover{color:var(--text);border-color:var(--border-strong)}.mk-lora-pop{position:fixed;z-index:99999;width:300px;padding:10px;border-radius:12px;background:var(--bg-elev);border:1px solid var(--border);box-shadow:0 18px 50px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:8px}.mk-lora-head{font-size:12px;font-weight:600;color:var(--text)}.mk-lora-list{max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:4px}.mk-lora-item{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim)}.mk-lora-item span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mk-lora-item input[type=number]{width:48px;height:24px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);border-radius:6px;font-size:11px;padding:0 4px}.mk-lora-custom{display:flex;gap:4px}.mk-lora-custom input[type=text]{flex:1;height:26px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);border-radius:6px;font-size:11px;padding:0 6px}.mk-lora-custom input[type=number]{width:48px;height:26px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);border-radius:6px;font-size:11px}.mk-lora-custom button,.mk-lora-ref{height:26px;border:1px solid var(--border);background:rgba(255,255,255,.08);color:var(--text);border-radius:6px;font-size:11px;cursor:pointer}.mk-lora-tip{font-size:10px;color:var(--text-faint)}html.theme-light .mk-lora-pop{background:#fff;border-color:rgba(15,23,42,.12)}html.theme-light .mk-lora-pop input{background:#fff;color:#1b2434;border-color:rgba(15,23,42,.14)}';
    document.head.appendChild(s);
  })();
  function read(){
    try{
      var a=JSON.parse(localStorage.getItem('mk.loras')||'null');
      if(Array.isArray(a)) return a.filter(function(x){return x&&x.n}).map(function(x){return {n:String(x.n),s:Number(x.s)||0.7}});
    }catch(e){}
    var n=(localStorage.getItem('mk.lora.custom')||'').trim()||localStorage.getItem('mk.lora.name')||'';
    return n?[{n:n,s:Number(localStorage.getItem('mk.lora.strength')||0.7)}]:[];
  }
  function save(list){
    localStorage.setItem('mk.loras',JSON.stringify(list));
    var b=document.querySelector('.mk-lora-btn');
    if(b) b.textContent=list.length?('LoRA('+list.length+')'):'LoRA';
  }
  function inject(j,list){
    if(!j||!j.prompt||!list.length) return;
    var p=j.prompt, ids=Object.keys(p), first=null, base=null;
    for(var i=0;i<ids.length;i++){var c=String(p[ids[i]].class_type||''); if(/LoraLoaderModelOnly|MiniMaxH3TurboLoRA/.test(c)){first=ids[i];break}}
    if(!first){
      for(var k=0;k<ids.length;k++){var t=String(p[ids[k]].class_type||''); if(/UNETLoader|UnetLoader|CheckpointLoaderSimple/.test(t)){base=ids[k];break}}
      if(!base) return;
    }
    var prev=first||base, chain=[];
    if(first){
      p[first].inputs=p[first].inputs||{};
      p[first].inputs.lora_name=list[0].n;
      p[first].inputs.strength_model=list[0].s;
      p[first].inputs.strength=list[0].s;
    }
    var start=first?1:0;
    for(var n=start;n<list.length;n++){
      var id='mk_lora_'+n; while(p[id]) id+='x';
      p[id]={class_type:'LoraLoaderModelOnly',inputs:{model:[prev,0],lora_name:list[n].n,strength_model:list[n].s}};
      chain.push(id); prev=id;
    }
    if(prev!==first){
      var origin=first||base;
      for(var id2 in p){
        if(id2===origin||chain.indexOf(id2)>=0) continue;
        var ins=p[id2].inputs||{};
        for(var key in ins){
          var v=ins[key];
          if(Array.isArray(v)&&v.length===2&&v[0]===origin&&Number(v[1])===0) ins[key]=[prev,0];
        }
      }
    }
  }
  var of=window.fetch;
  window.fetch=function(input,init){
    try{
      var u=typeof input==='string'?input:(input&&input.url)||'';
      if(u.indexOf('/comfy/prompt')>=0&&init&&typeof init.body==='string'){
        var j=JSON.parse(init.body); inject(j,read());
        init=Object.assign({},init,{body:JSON.stringify(j)});
      }
    }catch(e){}
    return of.apply(this,arguments);
  };
  var cache=[],at=0,pop=null,curBtn=null;
  function load(force){
    if(!force&&cache&&Date.now()-at<60000) return Promise.resolve(cache);
    return fetch('/comfy/object_info/LoraLoaderModelOnly').then(function(r){return r.json()}).then(function(j){
      var a=j&&j.LoraLoaderModelOnly&&j.LoraLoaderModelOnly.input&&j.LoraLoaderModelOnly.input.required&&j.LoraLoaderModelOnly.input.required.lora_name;
      cache=Array.isArray(a&&a[0])?a[0].map(String):[]; at=Date.now(); return cache;
    }).catch(function(){cache=[];at=Date.now();return []});
  }
  function close(){ if(pop){pop.remove();pop=null;document.removeEventListener('mousedown',outside,true)} }
  function outside(e){ if(pop&&!pop.contains(e.target)&&e.target!==curBtn) close(); }
  function render(pop,list){
    var state=read();
    var box=pop.querySelector('.mk-lora-list'); box.innerHTML='';
    var names=cache.slice();
    state.forEach(function(x){ if(names.indexOf(x.n)<0) names.push(x.n); });
    names.forEach(function(name){
      var row=document.createElement('label'); row.className='mk-lora-item';
      var cb=document.createElement('input'); cb.type='checkbox';
      var hit=state.filter(function(x){return x.n===name})[0]; cb.checked=!!hit;
      var sp=document.createElement('span'); sp.textContent=name.replace(/\.safetensors$/i,''); sp.title=name;
      var num=document.createElement('input'); num.type='number'; num.min='0'; num.max='2'; num.step='0.05'; num.value=hit?hit.s:0.7;
      cb.onchange=function(){ var s=read(); if(cb.checked){s=s.filter(function(x){return x.n!==name});s.push({n:name,s:Number(num.value)||0.7})} else {s=s.filter(function(x){return x.n!==name})} save(s); render(pop); };
      num.onchange=function(){ var s=read(); for(var i=0;i<s.length;i++){if(s[i].n===name)s[i].s=Number(num.value)||0.7} save(s); };
      row.appendChild(cb); row.appendChild(sp); row.appendChild(num); box.appendChild(row);
    });
    var cnt=pop.querySelector('.mk-lora-count'); if(cnt) cnt.textContent='已选 '+state.length+' 个';
  }
  function open(btn){
    if(pop){ close(); return; }
    curBtn=btn;
    pop=document.createElement('div'); pop.className='mk-lora-pop';
    var h=document.createElement('div'); h.className='mk-lora-head'; h.innerHTML='LoRA 多选 <span class="mk-lora-count" style="font-weight:400;color:var(--text-faint)"></span>'; pop.appendChild(h);
    var box=document.createElement('div'); box.className='mk-lora-list'; pop.appendChild(box);
    var cus=document.createElement('div'); cus.className='mk-lora-custom';
    var ci=document.createElement('input'); ci.type='text'; ci.placeholder='自定义 LoRA 文件名'; cus.appendChild(ci);
    var cn=document.createElement('input'); cn.type='number'; cn.min='0'; cn.max='2'; cn.step='0.05'; cn.value='0.7'; cus.appendChild(cn);
    var cb=document.createElement('button'); cb.type='button'; cb.textContent='添加'; cus.appendChild(cb);
    pop.appendChild(cus);
    var row=document.createElement('div'); row.className='mk-lora-custom';
    var ref=document.createElement('button'); ref.type='button'; ref.className='mk-lora-ref'; ref.textContent='刷新列表'; row.appendChild(ref);
    pop.appendChild(row);
    var tip=document.createElement('div'); tip.className='mk-lora-tip'; tip.textContent='多选会按顺序串联 LoraLoader；后端启动后点刷新读取列表'; pop.appendChild(tip);
    document.body.appendChild(pop);
    var r=btn.getBoundingClientRect(), w=300;
    pop.style.left=Math.max(8,Math.min(innerWidth-w-8,r.left))+'px';
    var top=r.top-pop.offsetHeight-8; pop.style.top=(top>8?top:r.bottom+8)+'px';
    render(pop); load(false).then(function(){render(pop)});
    cb.onclick=function(){ var n=ci.value.trim(); if(!n)return; var s=read(); if(!s.some(function(x){return x.n===n}))s.push({n:n,s:Number(cn.value)||0.7}); save(s); ci.value=''; render(pop); };
    ref.onclick=function(){load(true).then(function(){render(pop)})};
    document.addEventListener('mousedown',outside,true);
  }
  function add(){
    var strip=document.querySelector('.pstrip');
    if(!strip||strip.querySelector('.mk-lora-btn')) return;
    var btn=document.createElement('button'); btn.type='button'; btn.className='mk-lora-btn'; btn.title='LoRA 多选（点击展开）';
    var st=read(); btn.textContent=st.length?('LoRA('+st.length+')'):'LoRA';
    btn.onclick=function(e){e.preventDefault();e.stopPropagation();open(btn)};
    var gen=strip.querySelector('.gen-wrap');
    if(gen) strip.insertBefore(btn,gen); else strip.appendChild(btn);
  }
  new MutationObserver(add).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',add); add();
})();
