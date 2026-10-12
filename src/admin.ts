export function adminPage() {
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  );
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iCloud 管理</title><style nonce="${nonce}">body{font:16px/1.6 system-ui;background:#f4f6fb;color:#18243b;margin:0}main{max-width:900px;margin:32px auto;padding:24px}section{background:white;padding:24px;margin:20px 0;border:1px solid #ddd;border-radius:16px}input,button{font:inherit;padding:8px;margin:6px}label{display:block}button,a{color:#135bc4}pre{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;text-align:left}</style><main><h1>iCloud MCP 管理</h1><p>六项服务独立开关。凭证只在此页面录入，切勿放入聊天。状态来自已保存会话，实际可用性需逐项检查。</p><section><h2>网页会话</h2><a href="/connect/apple">登录 Apple 账户并完成设备验证</a><button id="resume">检查提醒事项 PCS 授权</button><button id="disconnect">断开网页会话</button><p>备忘录、照片、云盘使用同一会话，各自需要 PCS 授权。主密码在浏览器中计算证明，不保存。</p><div id="pcs"></div></section><section><h2>日历 / 通讯录专用密码</h2><form id="dav"><label>Apple 账户 <input id="account" type="email" autocomplete="username" required></label><label>App 专用密码 <input id="password" type="password" autocomplete="off" pattern="[a-z]{4}(-[a-z]{4}){3}" required></label><button>加密保存</button></form><button id="remove">移除专用密码</button></section><section><h2>服务权限</h2><table><thead><tr><th>服务</th><th>启用</th><th>允许写入</th><th>联调</th></tr></thead><tbody id="services"></tbody></table><p>备忘录、照片和云盘只读；删除工具未公开。</p></section><section><h2>状态</h2><button id="refresh">刷新</button><pre id="status" role="status"></pre></section></main><script nonce="${nonce}">
const byId=id=>document.getElementById(id);let current;
async function api(path,value){const r=await fetch(path,value===undefined?{cache:'no-store'}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data;}
function error(e){byId('status').textContent=e.message;}
async function refresh(){current=await api('/api/admin/status');byId('status').textContent=JSON.stringify(current,null,2);const tbody=byId('services');tbody.replaceChildren();for(const item of current.services){const tr=document.createElement('tr');const label=document.createElement('td');label.textContent=item.service;tr.append(label);for(const key of ['enabled','writable']){const td=document.createElement('td'),input=document.createElement('input');input.type='checkbox';input.checked=item[key];input.disabled=key==='writable'&&['notes','photos','drive'].includes(item.service);input.onchange=async()=>{try{await api('/api/admin/service',{service:item.service,enabled:key==='enabled'?input.checked:item.enabled,writable:key==='writable'?input.checked:item.writable});await refresh();}catch(e){error(e);}};td.append(input);tr.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.textContent='检查';button.onclick=async()=>{try{const data=await api('/api/admin/check',{service:item.service});byId('status').textContent=JSON.stringify(data,null,2);}catch(e){error(e);}};td.append(button);tr.append(td);tbody.append(tr);}}
byId('dav').onsubmit=async e=>{e.preventDefault();let password=byId('password').value;byId('password').value='';try{await api('/api/admin/credentials',{account:byId('account').value,password,expectedVersion:current.dav.version});password='';await refresh();}catch(e){error(e);}finally{password='';}};
byId('remove').onclick=()=>api('/api/admin/remove-credentials',{}).then(refresh).catch(error);
byId('refresh').onclick=()=>refresh().catch(error);
byId('disconnect').onclick=()=>api('/api/auth/disconnect',{}).then(refresh).catch(error);
byId('resume').onclick=()=>api('/api/auth/resume',{expectedGeneration:current.web.generation,restartApproval:true}).then(refresh).catch(error);
for(const service of ['notes3','photos','iclouddrive']){const button=document.createElement('button');button.textContent='申请 / 检查 '+service+' PCS';button.onclick=()=>api('/api/admin/pcs',{service}).then(refresh).catch(error);byId('pcs').append(button);}
refresh().catch(error);
</script></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}
