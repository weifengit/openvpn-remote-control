/**
 * dsh-remote-anynet — 插件 HTTP 接口与引导页
 *
 * 注册的都是全新路径，与上游 dsh-remote-mobile 的 /api/remote-mobile/* 不冲突，
 * 因此可以走官方的 ctx.webServer.register()，不需要碰响应层。
 *
 * 【可达性说明（重要）】
 * 上游门禁的 isPublicPath() 只放行 /auth、/api/remote-mobile/public-key*、
 * /api/remote-mobile/verify*、静态资源等。本插件新增的路径不在白名单里，
 * 所以：
 *   - 从本机回环访问：门禁无条件放行 → 可用（这正是生成二维码/固定地址的场景）；
 *   - 从手机/异地访问：需要先通过 /auth 完成配对，之后携带 Cookie 即可访问。
 * 这是刻意的安全姿态：不新增任何未认证的对外入口。
 */

import { buildAnyNetStatus, resolveBypassCidrs } from './status.js';

/** 请求体上限：配置项都是小 JSON，超出直接拒绝，避免内存放大。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 统一 JSON 响应。 */
function json(res, status, data) {
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-cache, no-store, must-revalidate',
	});
	res.end(JSON.stringify(data));
}

/** 读取并解析 JSON 请求体（带大小上限）。 */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	const text = Buffer.concat(chunks).toString('utf8').trim();
	if (!text) return {};
	return JSON.parse(text);
}

/** 当前请求是否来自本机回环（仅用于页面提示文案）。 */
function isLoopback(req) {
	const addr = (req.socket && (req.socket.__dsh_real_remote_address__ || req.socket.remoteAddress)) || '';
	return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * 引导页：一个自包含的单文件页面。
 * 数据全部在浏览器端从 /api/remote-anynet/status 拉取，页面本身不含敏感信息。
 */
function guidePageHtml() {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>远程接入地址 · dsh-remote-anynet</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:20px;background:#0f1115;color:#e6e8eb;
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:820px;margin:0 auto}
h1{font-size:19px;margin:0 0 4px}
h2{font-size:14px;margin:26px 0 10px;color:#9aa4b2;font-weight:600;letter-spacing:.02em}
.sub{color:#8b95a3;font-size:12.5px;margin-bottom:18px}
.card{background:#171a20;border:1px solid #262b34;border-radius:10px;padding:14px 16px;margin-bottom:10px}
.hero{background:linear-gradient(180deg,#1b2130,#171a20);border-color:#2b3648}
.addr{font:600 24px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#7dd3fc;word-break:break-all}
.reason{color:#8b95a3;font-size:12.5px;margin-top:6px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.row+.row{margin-top:8px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.grow{flex:1;min-width:0}
button{background:#2a3038;color:#e6e8eb;border:1px solid #39404b;border-radius:7px;
  padding:6px 11px;font-size:12.5px;cursor:pointer;white-space:nowrap}
button:hover{background:#333a44}
button.primary{background:#2563eb;border-color:#2563eb;color:#fff}
button.primary:hover{background:#1d4ed8}
button:disabled{opacity:.5;cursor:not-allowed}
select,input[type=text]{background:#0f1115;color:#e6e8eb;border:1px solid #39404b;
  border-radius:7px;padding:6px 9px;font-size:12.5px;font-family:inherit}
input[type=text]{flex:1;min-width:140px}
label.sw{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:12.5px}
.badge{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;
  background:#23303f;color:#8ec5ff;border:1px solid #2f4358}
.badge.g{background:#1d3328;color:#86efac;border-color:#2a4a37}
.badge.o{background:#33291d;color:#fdba74;border-color:#4a3a26}
.badge.r{background:#3a2124;color:#fca5a5;border-color:#552e33}
.dim{color:#7c8695;font-size:12px}
code{background:#0f1115;border:1px solid #262b34;border-radius:5px;padding:1px 5px;
  font-family:ui-monospace,Menlo,monospace;font-size:12px}
.err{background:#3a2124;border:1px solid #552e33;color:#fca5a5;border-radius:8px;padding:10px 12px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #22262e;vertical-align:top}
th{color:#8b95a3;font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em}
tr.sel td{background:#15251c}
a{color:#7dd3fc}
</style>
</head>
<body>
<main>
  <h1>远程接入地址（dsh-remote-anynet）</h1>
  <div class="sub">让 EasyTier / OpenVPN 之类打通的异地网络也能正确被播发。本页在<strong>本机浏览器</strong>打开最方便。</div>
  <div id="root"><div class="card dim">加载中…</div></div>
</main>
<script>
const $ = (sel, ctx) => (ctx || document).querySelector(sel);

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function jget(url){ const r = await fetch(url, {headers:{'Accept':'application/json'}}); return r.json(); }
async function jpost(url, body){
  const r = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
  return r.json();
}

let S = null;
let upstream = null;

function renderError(msg){
  $('#root').innerHTML = '<div class="err">加载失败：' + esc(msg) + '</div>';
}

function render(){
  const st = S;
  const cands = st.candidates || [];
  const port = location.port || '3080';
  const token = upstream && upstream.code ? upstream.code : '';
  const link = st.address ? ('http://' + st.address + ':' + port + '/auth' + (token ? '?token=' + token : '')) : '';

  const candRows = cands.map(c => {
    const badges = []
      .concat((c.presets||[]).map(p => '<span class="badge g">' + esc(p) + '</span>'))
      .concat(c.virtual ? ['<span class="badge">隧道网卡</span>'] : [])
      .concat(c.physical ? ['<span class="badge o">物理网卡</span>'] : [])
      .concat(c.eligible ? [] : ['<span class="badge r">不可用</span>'])
      .join(' ');
    return '<tr class="' + (c.selected ? 'sel' : '') + '">'
      + '<td class="mono">' + esc(c.name) + '</td>'
      + '<td class="mono">' + esc(c.address) + '</td>'
      + '<td>' + badges + '<div class="dim">' + esc((c.reasons||[]).join('；')) + '</div></td>'
      + '<td>' + (c.selected
          ? '<span class="badge g">当前播发</span>'
          : '<button data-pin="' + esc(c.address) + '">固定</button>') + '</td>'
      + '</tr>';
  }).join('');

  const preferOpts = [['auto','自动（按分值）'],['easytier','EasyTier'],['openvpn','OpenVPN'],
      ['wireguard','WireGuard'],['zerotier','ZeroTier'],['netbird','NetBird'],['tailscale','Tailscale'],
      ['custom','仅自定义网段'],['lan','仅局域网'],['public','仅公网地址']]
    .map(([v,l]) => '<option value="' + v + '"' + (st.prefer === v ? ' selected' : '') + '>' + l + '</option>').join('');

  const upstreamNote = !upstream
    ? '<div class="err">未能读取 <code>/api/remote-mobile/status</code>：未检测到上游 dsh-remote-mobile 插件，或该请求被门禁拦截。地址改写只在上游存在时生效。</div>'
    : (upstream.anynet
        ? '<div class="dim">上游 status 已被本插件改写：<code>lanIp</code> = <code>' + esc(upstream.lanIp) + '</code>（上游自己算出来的是 <code>' + esc((upstream.anynet.candidates.find(c=>c.name&&c.physical)||{}).address || '—') + '</code> 之类的局域网地址）。上游设置页里的<strong>二维码</strong>会跟着指向这里。</div>'
        : '<div class="dim">上游 status 未见 <code>anynet</code> 字段，改写可能未生效。</div>');

  $('#root').innerHTML = \`
  <div class="card hero">
    <div class="dim">当前对外播发地址</div>
    <div class="addr" id="addr">\${esc(st.address || '（未找到可用地址）')}</div>
    <div class="reason">\${esc(st.reason || '')} · 来源：\${esc(st.via)}</div>
    <div class="row" style="margin-top:12px">
      <input type="text" id="link" readonly value="\${esc(link)}">
      <button class="primary" id="copy">复制配对链接</button>
    </div>
    <div class="dim" style="margin-top:8px">手机上打开该链接即完成配对（二维码由上游设置页渲染，现已指向同一地址）。</div>
  </div>

  <h2>播发策略</h2>
  <div class="card">
    <div class="row">
      <span style="min-width:74px">优先级</span>
      <select id="prefer">\${preferOpts}</select>
      <span class="dim">自动=按网卡名/网段/对端自动挑；也可直接指定 EasyTier 或 OpenVPN</span>
    </div>
    <div class="row">
      <span style="min-width:74px">固定地址</span>
      <input type="text" id="pinned" placeholder="留空=自动（例：10.126.126.11）" value="\${esc(st.pinnedAddress)}">
    </div>
    <div class="row">
      <span style="min-width:74px">自定义网段</span>
      <input type="text" id="cidrs" placeholder="逗号分隔，例：10.126.0.0/16, 10.8.0.0/24" value="\${esc((st.customCidrs||[]).join(', '))}">
    </div>
    <div class="row">
      <label class="sw"><input type="checkbox" id="enabled" \${st.enabled?'checked':''}> 启用插件</label>
      <label class="sw"><input type="checkbox" id="rewrite" \${st.rewriteStatus?'checked':''}> 改写上游状态里的地址</label>
      <button class="primary" id="save">保存</button>
      <button id="reset">恢复默认</button>
    </div>
  </div>

  <h2>本机候选地址</h2>
  <div class="card" style="padding:4px 6px">
    <table><thead><tr><th>网卡</th><th>地址</th><th>判定</th><th>操作</th></tr></thead>
    <tbody>\${candRows || '<tr><td colspan="4" class="dim">无候选</td></tr>'}</tbody></table>
  </div>

  <h2>上游插件状态</h2>
  <div class="card">\${upstreamNote}
    <div class="row" style="margin-top:10px">
      <label class="sw"><input type="checkbox" id="bypass" \${st.bypass.enabled?'checked':''}> 对下列网段免密直连（可选）</label>
    </div>
    <div class="row">
      <span style="min-width:74px">免密网段</span>
      <input type="text" id="bypassCidrs" placeholder="留空=自动用当前地址所属预设网段" value="\${esc((st.bypass.configuredCidrs||[]).join(', '))}">
    </div>
    <div class="dim" style="margin-top:8px">
      实际生效：<code>\${esc((st.bypass.effectiveCidrs||[]).join(', ') || '（空）')}</code><br>
      免密由上游门禁决定。上游只提供「Tailscale 免密」与「局域网免密（覆盖全部 RFC1918）」两个开关，
      本插件不重复实现门禁；若需要免密，请在上游设置页打开对应开关。<strong>配对后 Cookie 有效期 365 天</strong>，
      通常不需要开免密。
    </div>
  </div>
  \`;

  $('#copy').onclick = () => {
    const input = $('#link'); input.select();
    navigator.clipboard?.writeText(input.value).catch(()=>{});
  };
  document.querySelectorAll('[data-pin]').forEach(btn => {
    btn.onclick = async () => {
      const r = await jpost('/api/remote-anynet/config', { pinnedAddress: btn.dataset.pin });
      S = r.anynet || S; render();
    };
  });
  $('#save').onclick = async () => {
    const patch = {
      enabled: $('#enabled').checked,
      rewriteStatus: $('#rewrite').checked,
      prefer: $('#prefer').value,
      pinnedAddress: $('#pinned').value.trim(),
      customCidrs: $('#cidrs').value.split(',').map(s=>s.trim()).filter(Boolean),
      bypass: {
        enabled: $('#bypass').checked,
        cidrs: $('#bypassCidrs').value.split(',').map(s=>s.trim()).filter(Boolean),
      },
    };
    const r = await jpost('/api/remote-anynet/config', patch);
    if (r && r.anynet) { S = r.anynet; }
    await load(true);
  };
  $('#reset').onclick = async () => { await jpost('/api/remote-anynet/reset', {}); await load(true); };
}

let lastErrToast = '';
async function load(fromAction){
  try {
    S = await jget('/api/remote-anynet/status');
    try { upstream = await jget('/api/remote-mobile/status'); } catch(e){ upstream = null; }
    render();
    if (fromAction && $('#addr')) {
      $('#addr').style.transition = 'color .2s';
      $('#addr').style.color = '#86efac';
      setTimeout(()=>{ const a=$('#addr'); if(a) a.style.color=''; }, 550);
    }
  } catch (e) {
    renderError(e && e.message ? e.message : String(e));
  }
}

load(false);
setInterval(() => load(false), 15000);
</script>
</body>
</html>`;
}

/**
 * 构造路由列表。
 *
 * @param {object} deps { configStore, state }
 */
export function createRoutes({ configStore, state }) {
	return [
		{
			kind: 'exact',
			method: 'GET',
			path: '/api/remote-anynet/status',
			handler: async (_req, res) => {
				try {
					json(res, 200, {
						success: true,
						anynet: buildAnyNetStatus(configStore.get(), state()),
					});
				} catch (error) {
					json(res, 500, { success: false, reason: error?.message || String(error) });
				}
			},
		},
		{
			kind: 'exact',
			method: 'POST',
			path: '/api/remote-anynet/config',
			handler: async (req, res) => {
				try {
					const patch = await readJsonBody(req);
					const { options, changed } = configStore.update(patch);
					json(res, 200, {
						success: true,
						changed,
						options,
						anynet: buildAnyNetStatus(options, state()),
					});
				} catch (error) {
					json(res, 400, { success: false, reason: error?.message || String(error) });
				}
			},
		},
		{
			kind: 'exact',
			method: 'POST',
			path: '/api/remote-anynet/reset',
			handler: async (_req, res) => {
				try {
					const options = configStore.reset();
					json(res, 200, {
						success: true,
						options,
						anynet: buildAnyNetStatus(options, state()),
					});
				} catch (error) {
					json(res, 500, { success: false, reason: error?.message || String(error) });
				}
			},
		},
		{
			kind: 'exact',
			method: 'GET',
			path: '/remote-anynet',
			handler: async (req, res) => {
				const body = guidePageHtml();
				const hint = isLoopback(req)
					? ''
					: '<!-- 非回环访问：需先通过 /auth 配对 -->';
				res.writeHead(200, {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'no-cache',
				});
				res.end(hint + body);
			},
		},
	];
}

/** 供 index.js 复用的兜底导出（状态计算）。 */
export { resolveBypassCidrs };
