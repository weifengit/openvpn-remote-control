/**
 * dsh-remote-anynet — 地址选择接口与引导页
 *
 * 这里注册的都是全新路径（/api/remote-anynet/* 与 /remote-anynet），
 * 与上游既有的 /api/remote-mobile/* 不冲突，可以直接走官方的
 * ctx.webServer.register()，不需要碰响应层。
 *
 * 【可达性】本模块的路径不在门禁的白名单里，因此：
 *   - 本机回环访问：门禁无条件放行（这正是挑选/固定地址的场景）；
 *   - 异地访问：需先通过 /auth 配对，之后携带 Cookie 即可。
 * 这是刻意的姿态 —— 不新增任何未认证的对外入口。
 */

import {
	invalidateResolveCache,
	matchPresetsByIp,
	normalizeCidrList,
	OVERLAY_PRESETS,
	pickAdvertisedAddress,
	presetCidrs,
	resolveOverlayCidrs,
} from '../nets.js';
import { getAllNetworkIps, getLocalLanIp } from '../auth/overlay.js';

/** 请求体上限：配置项都是小 JSON，超出直接拒绝，避免内存放大。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 插件版本（与 package.json 保持同步）。 */
export const VERSION = '1.0.0';

/** 合法的 prefer 取值。 */
export const PREFER_VALUES = ['auto', 'custom', 'lan', 'public', ...OVERLAY_PRESETS.map((p) => p.id)];

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
	return text ? JSON.parse(text) : {};
}

/** 从 store 的 options 里取出与地址选择相关的部分。 */
function addressOptions(store) {
	const opts = store.getOptions() || {};
	return {
		prefer: typeof opts.prefer === 'string' && PREFER_VALUES.includes(opts.prefer) ? opts.prefer : 'auto',
		pinnedAddress: typeof opts.pinnedAddress === 'string' ? opts.pinnedAddress : '',
		customCidrs: normalizeCidrList(opts.customCidrs).ok,
		overlayCidrs: normalizeCidrList(opts.overlayCidrs).ok,
	};
}

/** 组装完整的地址状态（引导页与 /api/remote-anynet/status 共用）。 */
export function buildAddressStatus(store) {
	const opts = addressOptions(store);
	const picked = pickAdvertisedAddress(opts);
	const live = store.getOptions() || {};

	return {
		success: true,
		plugin: 'dsh-remote-anynet',
		version: VERSION,
		enabled: true,
		prefer: opts.prefer,
		pinnedAddress: opts.pinnedAddress,
		customCidrs: opts.customCidrs,
		overlayCidrs: opts.overlayCidrs,
		allowOverlay: Boolean(live.allowOverlay),
		allowLan: Boolean(live.allowLan),
		address: picked.address,
		via: picked.via,
		reason: picked.reason,
		lanAddress: getLocalLanIp(),
		candidates: picked.candidates.map((c) => ({
			name: c.name,
			address: c.address,
			onlinkCidr: c.onlinkCidr,
			peer: c.peer,
			virtual: c.virtual,
			physical: c.physical,
			presets: c.presets,
			score: c.score,
			reasons: c.reasons,
			eligible: c.eligible,
			selected: c.address === picked.address,
		})),
		networkIps: getAllNetworkIps(),
		effectiveOverlayCidrs: resolveOverlayCidrs({ ...opts, overlayCidrs: opts.overlayCidrs }),
		presets: OVERLAY_PRESETS.map((p) => ({
			id: p.id,
			label: p.label,
			cidrs: p.cidrs,
			note: p.note,
		})),
	};
}

/** 引导页：自包含单文件页面，数据在浏览器端从本模块的接口拉取。 */
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
main{max-width:840px;margin:0 auto}
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
button{background:#2a3038;color:#e6e8eb;border:1px solid #39404b;border-radius:7px;
  padding:6px 11px;font-size:12.5px;cursor:pointer;white-space:nowrap}
button:hover{background:#333a44}
button.primary{background:#2563eb;border-color:#2563eb;color:#fff}
button.primary:hover{background:#1d4ed8}
select,input[type=text]{background:#0f1115;color:#e6e8eb;border:1px solid #39404b;
  border-radius:7px;padding:6px 9px;font-size:12.5px;font-family:inherit}
input[type=text]{flex:1;min-width:150px}
label.sw{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:12.5px}
.badge{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;
  background:#23303f;color:#8ec5ff;border:1px solid #2f4358;margin-right:4px}
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
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:#1d3328;
  border:1px solid #2a4a37;color:#86efac;padding:8px 16px;border-radius:8px;font-size:12.5px;
  opacity:0;transition:opacity .2s;pointer-events:none}
.toast.on{opacity:1}
</style>
</head>
<body>
<main>
  <h1>远程接入地址</h1>
  <div class="sub">决定 DSH 对外播发哪个地址（二维码 / 复制链接都取自它）。<strong>建议在本机浏览器打开</strong>。</div>
  <div id="root"><div class="card dim">加载中…</div></div>
</main>
<div class="toast" id="toast"></div>
<script>
const $ = (s, c) => (c || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let S = null;
let toastTimer = null;
function toast(msg){
  const el = $('#toast'); el.textContent = msg; el.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 1800);
}
async function jget(u){ const r = await fetch(u, {headers:{Accept:'application/json'}}); return r.json(); }
async function jpost(u, b){
  const r = await fetch(u, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
  return r.json();
}

function render(){
  const st = S;
  const port = location.port || '3080';
  const link = st.address ? ('http://' + st.address + ':' + port + '/auth') : '';

  const candRows = (st.candidates || []).map(c => {
    const badges = []
      .concat((c.presets || []).map(p => '<span class="badge g">' + esc(p) + '</span>'))
      .concat(c.virtual ? ['<span class="badge">隧道网卡</span>'] : [])
      .concat(c.physical ? ['<span class="badge o">物理网卡</span>'] : [])
      .concat(c.eligible ? [] : ['<span class="badge r">不可用</span>'])
      .join('');
    return '<tr class="' + (c.selected ? 'sel' : '') + '">'
      + '<td class="mono">' + esc(c.name) + '</td>'
      + '<td class="mono">' + esc(c.address) + '</td>'
      + '<td>' + badges + '<div class="dim">' + esc((c.reasons || []).join('；')) + '</div></td>'
      + '<td>' + (c.selected ? '<span class="badge g">当前播发</span>'
          : '<button data-pin="' + esc(c.address) + '">固定</button>') + '</td></tr>';
  }).join('');

  const preferOpts = [['auto','自动（按分值）'],['easytier','EasyTier'],['openvpn','OpenVPN'],
      ['wireguard','WireGuard'],['zerotier','ZeroTier'],['netbird','NetBird'],
      ['custom','仅自定义网段'],['lan','仅局域网'],['public','仅公网地址']]
    .map(([v,l]) => '<option value="' + v + '"' + (st.prefer === v ? ' selected' : '') + '>' + l + '</option>').join('');

  $('#root').innerHTML = \`
  <div class="card hero">
    <div class="dim">当前对外播发地址</div>
    <div class="addr">\${esc(st.address || '（未找到可用地址）')}</div>
    <div class="reason">\${esc(st.reason || '')} · 来源：\${esc(st.via)}\${st.pinnedAddress ? ' · 已固定' : ''}</div>
    <div class="row" style="margin-top:12px">
      <input type="text" id="link" readonly value="\${esc(link)}">
      <button class="primary" id="copy">复制地址</button>
      <button id="openUpstream">打开插件设置页</button>
    </div>
    <div class="dim" style="margin-top:8px">二维码在「设置 → 远程与移动端 → 访问」里，它渲染的就是上面这个地址。</div>
  </div>

  <h2>播发策略</h2>
  <div class="card">
    <div class="row">
      <span style="min-width:76px">优先级</span>
      <select id="prefer">\${preferOpts}</select>
      <span class="dim">自动＝按网卡名 / 网段 / 对端提示综合判定</span>
    </div>
    <div class="row">
      <span style="min-width:76px">固定地址</span>
      <input type="text" id="pinned" placeholder="留空＝自动（例：10.126.126.11）" value="\${esc(st.pinnedAddress)}">
    </div>
    <div class="row">
      <span style="min-width:76px">自定义网段</span>
      <input type="text" id="cidrs" placeholder="逗号分隔，例：10.126.0.0/16, 10.8.0.0/24" value="\${esc((st.customCidrs || []).join(', '))}">
    </div>
    <div class="row">
      <button class="primary" id="save">保存</button>
      <button id="reset">恢复默认</button>
    </div>
  </div>

  <h2>本机候选地址</h2>
  <div class="card" style="padding:4px 6px">
    <table><thead><tr><th>网卡</th><th>地址</th><th>判定</th><th>操作</th></tr></thead>
    <tbody>\${candRows || '<tr><td colspan="4" class="dim">无候选</td></tr>'}</tbody></table>
  </div>

  <h2>虚拟网免密直连</h2>
  <div class="card">
    <div class="row">
      <label class="sw">上游开关：<strong>\${st.allowOverlay ? '已开启' : '已关闭'}</strong></label>
      <span class="dim">在「设置 → 远程与移动端 → 访问」里切换</span>
    </div>
    <div class="row">
      <span style="min-width:76px">放行网段</span>
      <input type="text" id="overlayCidrs" placeholder="留空＝自动用当前地址所属的预设网段" value="\${esc((st.overlayCidrs || []).join(', '))}">
    </div>
    <div class="dim" style="margin-top:8px">
      实际放行：<code>\${esc((st.effectiveOverlayCidrs || []).join(', ') || '（空，不会放行任何来源）')}</code><br>
      留空时会自动收窄到当前地址所属的虚拟网段（例如播发 10.126.126.11 就只放行 10.126.0.0/16），
      不像"局域网免密"那样一次放开整片 RFC1918。
    </div>
  </div>

  <h2>全部网卡</h2>
  <div class="card" style="padding:4px 6px">
    <table><thead><tr><th>网卡</th><th>IP</th><th>直连网段</th><th>归属</th></tr></thead><tbody>
    \${(st.networkIps || []).map(n => '<tr><td class="mono">' + esc(n.name) + '</td><td class="mono">' + esc(n.ip)
      + '</td><td class="mono dim">' + esc(n.onlinkCidr || '—') + '</td><td class="dim">'
      + esc((n.presets || []).join(', ') || (n.physical ? '物理局域网' : '未知')) + '</td></tr>').join('')}
    </tbody></table>
  </div>
  \`;

  $('#copy').onclick = () => { const i = $('#link'); i.select(); navigator.clipboard?.writeText(i.value).catch(()=>{}); toast('已复制'); };
  $('#openUpstream').onclick = () => toast('在 DSH 里打开：设置 → 远程与移动端');
  document.querySelectorAll('[data-pin]').forEach(b => {
    b.onclick = async () => { await jpost('/api/remote-anynet/config', { pinnedAddress: b.dataset.pin }); await load(); toast('已固定 ' + b.dataset.pin); };
  });
  $('#save').onclick = async () => {
    await jpost('/api/remote-anynet/config', {
      prefer: $('#prefer').value,
      pinnedAddress: $('#pinned').value.trim(),
      customCidrs: $('#cidrs').value.split(',').map(s => s.trim()).filter(Boolean),
      overlayCidrs: $('#overlayCidrs').value.split(',').map(s => s.trim()).filter(Boolean),
    });
    await load(); toast('已保存');
  };
  $('#reset').onclick = async () => { await jpost('/api/remote-anynet/reset', {}); await load(); toast('已恢复默认'); };
}

async function load(){
  try { S = await jget('/api/remote-anynet/status'); render(); }
  catch (e) { $('#root').innerHTML = '<div class="err">加载失败：' + esc(e?.message || e) + '</div>'; }
}

load();
setInterval(load, 15000);
</script>
</body>
</html>`;
}

/**
 * 构造本模块的路由列表。
 * @param {object} deps { store }
 */
export function createAnyNetRoutes({ store }) {
	return [
		{
			kind: 'exact',
			method: 'GET',
			path: '/api/remote-anynet/status',
			handler: (_req, res) => {
				try {
					json(res, 200, buildAddressStatus(store));
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
					const body = await readJsonBody(req);
					const patch = {};

					if (typeof body.prefer === 'string') {
						patch.prefer = PREFER_VALUES.includes(body.prefer) ? body.prefer : 'auto';
					}
					if ('pinnedAddress' in body) {
						const raw = typeof body.pinnedAddress === 'string' ? body.pinnedAddress.trim() : '';
						// 只接受合法 IPv4；其余归为"不固定"，避免脏值落盘
						patch.pinnedAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : '';
					}
					if ('customCidrs' in body) patch.customCidrs = normalizeCidrList(body.customCidrs).ok;
					if ('overlayCidrs' in body) patch.overlayCidrs = normalizeCidrList(body.overlayCidrs).ok;
					if (typeof body.allowOverlay === 'boolean') patch.allowOverlay = body.allowOverlay;

					if (patch.pinnedAddress && !patch.pinnedAddress.split('.').every((p) => Number(p) <= 255)) {
						patch.pinnedAddress = '';
					}

					store.updateOptions(patch);
					// 配置变了，探测缓存必须立刻失效，否则界面要等 TTL 才更新
					invalidateResolveCache();

					json(res, 200, { success: true, changed: Object.keys(patch), ...buildAddressStatus(store) });
				} catch (error) {
					json(res, 400, { success: false, reason: error?.message || String(error) });
				}
			},
		},
		{
			kind: 'exact',
			method: 'POST',
			path: '/api/remote-anynet/reset',
			handler: (_req, res) => {
				try {
					store.updateOptions({ prefer: 'auto', pinnedAddress: '', customCidrs: [], overlayCidrs: [] });
					invalidateResolveCache();
					json(res, 200, buildAddressStatus(store));
				} catch (error) {
					json(res, 500, { success: false, reason: error?.message || String(error) });
				}
			},
		},
		{
			kind: 'exact',
			method: 'GET',
			path: '/remote-anynet',
			handler: (_req, res) => {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
				res.end(guidePageHtml());
			},
		},
	];
}
