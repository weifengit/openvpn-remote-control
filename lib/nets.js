/**
 * dsh-remote-anynet — 通用私有/虚拟网探测
 *
 * 【为什么需要这个模块】
 * 上游 dsh-remote-mobile 把"对外可达地址"硬编码成两种假设：
 *   1) 局域网 = RFC1918，且优先取 en0/eth0/wlan0（物理网卡）；
 *   2) 异地 = 只有某一种特定虚拟网才算。它自己的实现如此，这里留作背景说明。
 * 因此当用户用 EasyTier / OpenVPN / ZeroTier / WireGuard 之类的方式组网时：
 *   - 别家虚拟网的 10.x 地址不被识别为“异地可达”；
 *   - getLocalLanIp() 依旧优先命中 en0（真实局域网 IP），
 *     于是二维码 / 复制链接 / 设置页里播发的都是那个"出了这个 Wi-Fi 就没人能访问"的地址。
 * 本模块把这些假设换成"按网卡名 + 网段 + 对端提示"的通用探测，
 * 并把"该播发哪个地址"变成可解释、可固定（pin）、可覆盖的选择。
 *
 * 本文件不依赖 DSH，可单独单测。
 */

import { networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';

/* ================================================================== *
 * 1. IPv4 基础工具
 * ================================================================== */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 去掉 IPv4-mapped IPv6 前缀与首尾空白（::ffff:10.0.0.1 → 10.0.0.1）。 */
export function normalizeIp(raw) {
	if (typeof raw !== 'string') return '';
	let ip = raw.trim();
	if (ip.startsWith('::ffff:')) ip = ip.slice(7);
	return ip;
}

/** 点分十进制 → 32 位无符号整数；非法返回 null。 */
export function ipv4ToInt(ip) {
	const m = IPV4_RE.exec(normalizeIp(ip));
	if (!m) return null;
	let out = 0;
	for (let i = 1; i <= 4; i += 1) {
		const octet = Number(m[i]);
		if (!Number.isInteger(octet) || octet > 255) return null;
		out = out * 256 + octet;
	}
	return out >>> 0;
}

/** 32 位无符号整数 → 点分十进制。 */
export function intToIpv4(n) {
	return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** 点分十进制掩码（255.255.255.0）→ 前缀长度（24）；非法返回 null。 */
export function maskToPrefix(mask) {
	const n = ipv4ToInt(mask);
	if (n === null) return null;
	// 必须是连续的 1 后跟连续的 0
	let prefix = 0;
	let seenZero = false;
	for (let bit = 31; bit >= 0; bit -= 1) {
		const one = ((n >>> bit) & 1) === 1;
		if (one) {
			if (seenZero) return null; // 1 出现在 0 之后 → 非连续掩码
			prefix += 1;
		} else {
			seenZero = true;
		}
	}
	return prefix;
}

/**
 * 解析网段表达式。接受三种写法：
 *   '10.126.0.0/16'          CIDR
 *   '10.126.0.0/255.255.0.0' 掩码
 *   '10.126.0.0'             单主机（隐式 /32）
 * 非法返回 null。
 */
export function parseCidr(text) {
	if (typeof text !== 'string') return null;
	const trimmed = text.trim();
	if (!trimmed) return null;

	const slash = trimmed.indexOf('/');
	const ipPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
	const maskPart = slash === -1 ? null : trimmed.slice(slash + 1).trim();

	const base = ipv4ToInt(ipPart);
	if (base === null) return null;

	let prefix;
	if (maskPart === null || maskPart === '') {
		prefix = 32;
	} else if (/^\d{1,2}$/.test(maskPart)) {
		prefix = Number(maskPart);
		if (prefix > 32) return null;
	} else {
		prefix = maskToPrefix(maskPart);
		if (prefix === null) return null;
	}

	const size = prefix === 0 ? 0x100000000 : 2 ** (32 - prefix);
	const start = prefix === 0 ? 0 : Math.floor(base / size) * size;
	const end = start + size - 1;

	return {
		text: `${intToIpv4(start)}/${prefix}`,
		base: start >>> 0,
		prefix,
		start: start >>> 0,
		end: end >>> 0,
	};
}

/** 该 IP 是否落在网段内。cidr 可为字符串或 parseCidr 的结果。 */
export function cidrContains(cidr, ip) {
	const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
	if (!parsed) return false;
	const n = ipv4ToInt(ip);
	if (n === null) return false;
	return n >= parsed.start && n <= parsed.end;
}

/** 该 IP 是否落在列表中任意一个网段内。 */
export function ipInAnyCidr(ip, cidrs) {
	if (!Array.isArray(cidrs)) return false;
	return cidrs.some((c) => cidrContains(c, ip));
}

/** 规范化网段列表：解析、去重、剔除非法项，返回 {ok, invalid}。 */
export function normalizeCidrList(list) {
	const ok = [];
	const invalid = [];
	const seen = new Set();
	for (const raw of Array.isArray(list) ? list : []) {
		const parsed = parseCidr(raw);
		if (!parsed) {
			if (typeof raw === 'string' && raw.trim()) invalid.push(raw.trim());
			continue;
		}
		if (seen.has(parsed.text)) continue;
		seen.add(parsed.text);
		ok.push(parsed.text);
	}
	return { ok, invalid };
}

/* ================================================================== *
 * 2. 地址分类
 * ================================================================== */

/** 回环地址（127.0.0.0/8、::1、localhost）。 */
export function isLoopbackIp(rawIp) {
	const ip = normalizeIp(rawIp);
	if (ip === '::1' || ip === 'localhost') return true;
	const n = ipv4ToInt(ip);
	if (n === null) return false;
	return (n >>> 24) === 127;
}

/** CGNAT 虚拟网段 100.64.0.0/10（NetBird 等使用）。 */
export function isCgnatIp(rawIp) {
	const n = ipv4ToInt(rawIp);
	if (n === null) return false;
	const second = (n >>> 16) & 255;
	return (n >>> 24) === 100 && second >= 64 && second <= 127;
}


/** 链路本地 169.254.0.0/16（含云元数据）。 */
export function isLinkLocalIp(rawIp) {
	const n = ipv4ToInt(rawIp);
	if (n === null) return false;
	return (n >>> 16) === 0xa9fe;
}

/**
 * RFC1918 私有地址：10/8、172.16/12、192.168/16。
 * 注意：EasyTier 默认 10.126.0.0/16、OpenVPN 默认 10.8.0.0/24 都落在这里面，
 * 所以"是不是私有地址"不能用来判断"是不是同一个局域网"。
 */
export function isRfc1918Ip(rawIp) {
	const n = ipv4ToInt(rawIp);
	if (n === null) return false;
	const a = (n >>> 24) & 255;
	const b = (n >>> 16) & 255;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

/** isLanIp 排除回环与 CGNAT，其余按 RFC1918 判定。 */
export function isLanIp(rawIp) {
	const ip = normalizeIp(rawIp);
	if (!ip || isLoopbackIp(ip) || isCgnatIp(ip)) return false;
	return isRfc1918Ip(ip);
}

/** 可路由的全球地址（既非私有、也非 CGNAT/链路本地/回环）。 */
export function isPublicIp(rawIp) {
	const n = ipv4ToInt(rawIp);
	if (n === null) return false;
	const ip = normalizeIp(rawIp);
	return !isLoopbackIp(ip) && !isRfc1918Ip(ip) && !isCgnatIp(ip) && !isLinkLocalIp(ip);
}

/* ================================================================== *
 * 3. 虚拟网预设（EasyTier / OpenVPN / ZeroTier / WireGuard / ...）
 * ================================================================== */

/**
 * 每项描述一类"异地组网"软件的默认特征。
 *
 * - `cidrs`：该软件默认使用的隧道网段。用于把一张 utunN 网卡归类到具体软件，
 *   因为 macOS 上 EasyTier 与 OpenVPN 都用 utun 前缀、单看网卡名无法区分，
 *   而两者的默认网段（10.126.0.0/16 vs 10.8.0.0/24）是不重叠的。
 * - `ifaceHints`：网卡名正则。用于在网段未命中默认值时兜底判断"这是张隧道网卡"。
 * - `peerHints`：对端（ifconfig 的 `-->`）IP 列表，作为弱加权提示。
 * - `priority`：auto 模式下的偏好次序，数字小者优先。
 */
export const OVERLAY_PRESETS = [
	{
		id: 'easytier',
		label: 'EasyTier',
		priority: 10,
		cidrs: ['10.126.0.0/16', '10.144.0.0/16'],
		ifaceHints: [/^utun/i, /^tun/i, /^tap/i, /easytier/i, /^et\d/i],
		peerHints: ['10.8.8.8', '10.126.0.1'],
		note: 'EasyTier 默认虚拟网段 10.126.0.0/16',
	},
	{
		id: 'openvpn',
		label: 'OpenVPN',
		priority: 20,
		cidrs: ['10.8.0.0/24', '10.9.0.0/24', '172.16.0.0/24'],
		ifaceHints: [/^utun/i, /^tun/i, /^tap/i, /openvpn/i, /wintun/i],
		peerHints: ['10.8.0.1', '10.9.0.1'],
		note: 'OpenVPN 服务端默认下发 10.8.0.0/24',
	},
	{
		id: 'wireguard',
		label: 'WireGuard',
		priority: 30,
		cidrs: ['10.10.0.0/24', '10.0.0.0/24'],
		ifaceHints: [/^wg\d/i, /^wg/i, /^utun/i],
		peerHints: [],
		note: 'WireGuard 默认使用 wg0 / utun 隧道网卡',
	},
	{
		id: 'zerotier',
		label: 'ZeroTier',
		priority: 40,
		cidrs: ['10.147.0.0/16', '10.144.0.0/16', '172.22.0.0/16', '172.23.0.0/16', '172.24.0.0/16', '172.25.0.0/16'],
		ifaceHints: [/^zt/i, /zerotier/i, /^utun/i],
		peerHints: [],
		note: 'ZeroTier 自动分配 10.147/10.144/172.22-25 网段',
	},
	{
		id: 'netbird',
		label: 'NetBird',
		priority: 50,
		cidrs: ['100.64.0.0/10'],
		ifaceHints: [/^wt\d/i, /netbird/i, /^utun/i],
		peerHints: [],
		note: 'NetBird 复用 CGNAT 100.64.0.0/10',
	},
];

/** 按 id 取预设。 */
export function getPreset(id) {
	return OVERLAY_PRESETS.find((p) => p.id === id) || null;
}

/** 所有预设聚合出的默认网段（用于免密放行的默认值）。 */
export function presetCidrs(ids) {
	const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
	const out = [];
	for (const preset of OVERLAY_PRESETS) {
		if (wanted && !wanted.has(preset.id)) continue;
		for (const c of preset.cidrs) if (!out.includes(c)) out.push(c);
	}
	return out;
}

/** 某 IP 命中的预设（可能多个，如 100.64/10 同时属于 NetBird 等）。 */
export function matchPresetsByIp(ip) {
	return OVERLAY_PRESETS.filter((p) => ipInAnyCidr(ip, p.cidrs));
}

/** 网卡名是否像隧道/虚拟网卡。 */
export function isVirtualIfaceName(name) {
	if (typeof name !== 'string') return false;
	return OVERLAY_PRESETS.some((p) => p.ifaceHints.some((re) => re.test(name)));
}

/**
 * 网卡名是否像"物理局域网"网卡（en0 / eth0 / wlan0 / Wi-Fi ...）。
 * 注意 en7-en9 / anpi* 之类在 macOS 上是雷雳/USB 网卡，也可能带 IP。
 */
export function isPhysicalIfaceName(name) {
	if (typeof name !== 'string') return false;
	return /^(en\d+|eth\d+|wlan\d+|wl[a-z]*\d*|wi-?fi|以太网|ethernet)/i.test(name);
}

/* ================================================================== *
 * 4. 网卡枚举与对端提示
 * ================================================================== */

/** family 字段在 Node 各版本间是 'IPv4' 或 4，统一判断。 */
function isIpv4Family(family) {
	return family === 'IPv4' || family === 4;
}

/**
 * 读取本机所有非内部 IPv4 网卡，附带分类信息。
 * 返回：{ name, address, netmask, prefix, onlinkCidr, virtual, physical, presets }
 */
export function listIpv4Interfaces(interfaces = networkInterfaces()) {
	const out = [];
	let names;
	try {
		names = Object.keys(interfaces || {});
	} catch {
		return out;
	}
	for (const name of names) {
		let addrs;
		try {
			addrs = interfaces[name] || [];
		} catch {
			continue;
		}
		for (const info of addrs) {
			if (!info || !isIpv4Family(info.family)) continue;
			if (info.internal) continue;
			const address = normalizeIp(info.address);
			if (!address) continue;
			const prefix = maskToPrefix(info.netmask);
			out.push({
				name,
				address,
				netmask: info.netmask || '',
				prefix,
				// 该网卡自身的直连网段（来自 netmask）；掩码不可解析时为 null
				onlinkCidr: prefix === null ? null : `${intToIpv4(ipv4ToInt(address) & (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0))}/${prefix}`,
				virtual: isVirtualIfaceName(name),
				physical: isPhysicalIfaceName(name),
				presets: matchPresetsByIp(address).map((p) => p.id),
			});
		}
	}
	return out;
}

/**
 * 尽力读取隧道网卡的"对端"地址（ifconfig 的 `--> x.x.x.x`）。
 * 纯提示用途：EasyTier 默认 peer 是 10.8.8.8，OpenVPN 是服务端隧道 IP。
 * 失败/非 macOS 一律返回空 Map，绝不影响主流程。
 */
export function readInterfacePeers() {
	const peers = new Map();
	try {
		if (process.platform !== 'darwin') return peers;
		const text = execFileSync('ifconfig', [], {
			encoding: 'utf8',
			timeout: 800,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		let current = null;
		for (const line of text.split('\n')) {
			const head = /^([a-z0-9_.-]+):\s/i.exec(line);
			if (head) {
				current = head[1];
				continue;
			}
			if (!current) continue;
			const peer = /inet\s+\d+\.\d+\.\d+\.\d+\s+-->\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
			if (peer) peers.set(current, peer[1]);
		}
	} catch {
		/* 提示信息，读不到就算了 */
	}
	return peers;
}

/* ================================================================== *
 * 5. 候选地址打分与选择
 * ================================================================== */

/**
 * 给每张网卡打分，产出可解释的候选列表（分数高者更可能是"异地可达地址"）。
 *
 * 打分依据（每项累加，reason 记录命中原因）：
 *   +120  命中某个虚拟网预设网段（EasyTier 10.126/16、OpenVPN 10.8/24 ...）
 *   + 60  网卡名像隧道网卡（utun/tun/tap/wg/zt...）
 *   + 30  对端提示命中该预设（弱证据）
 *   + 20  是 CGNAT 地址（100.64/10）
 *   + 10  网卡名像物理网卡（en0/eth0...，等价于"仅局域网可达"的兜底）
 *   − 40  链路本地 169.254/16
 *
 * 同分时按预设 priority 升序、再按地址数字升序，保证结果稳定可复现。
 */
export function detectCandidates(opts = {}) {
	const extraCidrs = Array.isArray(opts.customCidrs) ? normalizeCidrList(opts.customCidrs).ok : [];
	const peers = opts.peers instanceof Map ? opts.peers : readInterfacePeers();
	const ifaces = Array.isArray(opts.interfaces) ? opts.interfaces : listIpv4Interfaces();

	const candidates = ifaces.map((iface) => {
		let score = 0;
		const reasons = [];

		const hitPresets = iface.presets;
		if (hitPresets.length) {
			score += 120;
			const labels = hitPresets.map((id) => getPreset(id)?.label || id);
			reasons.push(`命中预设网段：${labels.join(' / ')}`);
		}
		if (iface.virtual) {
			score += 60;
			reasons.push('虚拟/隧道网卡');
		}
		const peer = peers.get(iface.name);
		if (peer) {
			const peerPreset = OVERLAY_PRESETS.find((p) => p.peerHints.includes(peer));
			if (peerPreset && (!peerPreset.id || hitPresets.includes(peerPreset.id) || hitPresets.length === 0)) {
				score += 30;
			}
			if (peerPreset) reasons.push(`对端 ${peer} 指向 ${peerPreset.label}`);
		}
		if (isCgnatIp(iface.address)) {
			score += 20;
			reasons.push('CGNAT 网段');
		}
		if (iface.physical) {
			score += 10;
			reasons.push('物理网卡（通常仅同局域网可达）');
		}
		if (extraCidrs.length && ipInAnyCidr(iface.address, extraCidrs)) {
			score += 100;
			reasons.push('命中自定义网段');
		}
		if (isLinkLocalIp(iface.address)) {
			score -= 40;
			reasons.push('链路本地地址，不可用');
		}

		const priority = hitPresets.length
			? Math.min(...hitPresets.map((id) => getPreset(id)?.priority ?? 99))
			: 99;

		return {
			...iface,
			peer: peer || null,
			score,
			priority,
			reasons,
			// 自动模式下是否可被选中（链路本地与纯公网不作为首选）
			eligible: !isLinkLocalIp(iface.address) && !isLoopbackIp(iface.address),
		};
	});

	candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		if (a.priority !== b.priority) return a.priority - b.priority;
		return (ipv4ToInt(a.address) ?? 0) - (ipv4ToInt(b.address) ?? 0);
	});

	return candidates;
}

/**
 * 按配置选出"应该对外播发"的地址。
 *
 * 优先级：
 *   1. pinnedAddress（用户显式固定，只要合法就用）
 *   2. prefer 指定类别（easytier / openvpn / ... / lan / custom / public）
 *   3. auto：按 detectCandidates 打分
 *
 * @returns {{address: string|null, via: string, reason: string, candidates: Array}}
 */
export function pickAdvertisedAddress(opts = {}) {
	const peers = opts.peers instanceof Map ? opts.peers : readInterfacePeers();
	const candidates = detectCandidates({ ...opts, peers });

	const pinned = normalizeIp(opts.pinnedAddress || '');
	if (pinned && ipv4ToInt(pinned) !== null) {
		return {
			address: pinned,
			via: 'pinned',
			reason: '用户固定的对外地址',
			candidates,
		};
	}

	const prefer = typeof opts.prefer === 'string' && opts.prefer ? opts.prefer : 'auto';

	if (prefer !== 'auto') {
		const matched = candidates.filter((c) => {
			if (!c.eligible) return false;
			if (prefer === 'lan') return c.physical && isRfc1918Ip(c.address);
			if (prefer === 'custom') return c.reasons.includes('命中自定义网段');
			if (prefer === 'public') return isPublicIp(c.address);
			return c.presets.includes(prefer);
		});
		if (matched.length) {
			const best = matched[0];
			const label = prefer === 'lan' ? '局域网' : getPreset(prefer)?.label || prefer;
			return {
				address: best.address,
				via: prefer,
				reason: `按「${label}」偏好选中 ${best.name} 上的地址`,
				candidates,
			};
		}
		// 偏好没命中任何网卡 → 明确回落到 auto，并说明原因，避免"静默播发错地址"
		const fallback = candidates.find((c) => c.eligible) || null;
		return {
			address: fallback ? fallback.address : null,
			via: fallback ? 'auto-fallback' : 'none',
			reason: `未找到匹配「${prefer}」的网卡，已回落到自动选择`,
			candidates,
		};
	}

	const best = candidates.find((c) => c.eligible) || null;
	return {
		address: best ? best.address : null,
		via: best ? 'auto' : 'none',
		reason: best ? `自动选择：${best.reasons.join('；') || best.name}` : '未找到可用的非回环 IPv4 地址',
		candidates,
	};
}

/**
 * 上游兼容：等价于旧的 getLocalLanIp()，但优先返回隧道网卡地址。
 * 仅用于在无法介入响应时给出一个合理的兜底值。
 */
export function getPreferredLocalIp(opts = {}) {
	return pickAdvertisedAddress(opts).address;
}

/* ================================================================== *
 * 6. 解析器与门禁判定（带缓存）
 *
 * 门禁每个请求都要判定来源是否属于“已放行的虚拟网”，因此这里所有
 * 会扫网卡 / 起子进程的函数都必须有缓存，否则会拖垮请求路径。
 * ================================================================== */

/** 缓存时长：网卡变动不频繁，10 秒足够。 */
const RESOLVE_TTL_MS = 10000;

/** ifconfig 对端解析缓存（readInterfacePeers 是子进程调用）。 */
let peersCache = { at: 0, value: null };
/** 首选地址解析缓存。 */
let pickCache = { at: 0, key: '', value: null };

/** 带缓存的 readInterfacePeers()。 */
export function readInterfacePeersCached(ttlMs = RESOLVE_TTL_MS) {
	const now = Date.now();
	if (peersCache.value && now - peersCache.at < ttlMs) return peersCache.value;
	const value = readInterfacePeers();
	peersCache = { at: now, value };
	return value;
}

/**
 * 带缓存的 pickAdvertisedAddress()。
 * 请求路径（门禁、状态接口、引导页）统一走它，避免每次请求都扫网卡。
 * 注意 key 只包含影响结果的配置项：只要这些不变，结果就不变。
 */
export function pickAdvertisedAddressCached(opts = {}, ttlMs = RESOLVE_TTL_MS) {
	const key = JSON.stringify([opts.prefer || 'auto', opts.pinnedAddress || '', opts.customCidrs || []]);
	const now = Date.now();
	if (pickCache.value && pickCache.key === key && now - pickCache.at < ttlMs) return pickCache.value;
	const value = pickAdvertisedAddress(opts);
	pickCache = { at: now, key, value };
	return value;
}

/** 配置变更 / 网卡热插拔后强制失效缓存。 */
export function invalidateResolveCache() {
	peersCache = { at: 0, value: null };
	pickCache = { at: 0, key: '', value: null };
}

/**
 * 计算“虚拟网免密”实际放行的网段。
 *
 * 默认尽量窄，刻意不学那个一次放开整片 RFC1918 的局域网免密开关：
 *   1. 显式配置 overlayCidrs → 用它（最精确）；
 *   2. 否则用当前播发地址命中的预设网段（播发 10.126.126.11 → 10.126.0.0/16）；
 *   3. 否则用该地址所在网卡自己的直连网段（能覆盖非默认网段的自定义隧道）；
 *   4. 都没有 → 空数组（不放行任何来源）。
 */
export function resolveOverlayCidrs(opts = {}) {
	const explicit = normalizeCidrList(opts.overlayCidrs).ok;
	if (explicit.length) return explicit;

	const picked = pickAdvertisedAddressCached(opts);
	if (!picked.address) return [];

	const byPreset = matchPresetsByIp(picked.address).map((p) => p.id);
	if (byPreset.length) return presetCidrs(byPreset);

	const hit = picked.candidates.find((c) => c.address === picked.address);
	if (hit && hit.onlinkCidr && cidrContains(hit.onlinkCidr, picked.address)) return [hit.onlinkCidr];

	return [];
}

/** 该 IP 是否落在放行网段内（回环永远不算）。 */
export function isOverlayIp(rawIp, cidrs) {
	const ip = normalizeIp(rawIp);
	if (!ip || isLoopbackIp(ip)) return false;
	return ipInAnyCidr(ip, cidrs);
}

/** 一步到位：来源 IP 是否属于“已配置放行的虚拟网”。 */
export function isOverlaySource(rawIp, opts = {}) {
	return isOverlayIp(rawIp, resolveOverlayCidrs(opts));
}
