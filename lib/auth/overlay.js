/**
 * dsh-remote-anynet — 探测与门禁判定的适配层
 *
 * 本文件取代上游的 auth/tailscale.js。上游那份代码把"异地可达地址"绑定在
 * 某一种特定的虚拟网实现上：写死 CGNAT 网段、并且会去起 `tailscale ip -4`
 * 子进程。这里全部改走 lib/nets.js 的通用探测。
 *
 * 对外接口（auth/ routes/ bridge/ 三个目录都依赖这几个名字）：
 *   - getClientIp(req)          来源 IP，取 Socket 上的未虚拟化快照
 *   - getLocalOverlayIp(opts)   当前应当对外播发的地址（自动判定 EasyTier/OpenVPN/...）
 *   - getLocalLanIp()           物理局域网地址（同一个 Wi-Fi 才可达的那个）
 *   - getAllNetworkIps()        全部网卡快照，带预设归属，供界面展示
 *   - isOverlayIp(ip, cidrs)    来源 IP 是否落在"已放行的虚拟网段"内
 *
 * 为什么不直接让各处 import nets.js：保持这一薄层可以让 auth/ routes/ bridge/
 * 里那些内联自上游的文件改动最小，将来重新同步上游也更容易比对。
 */

import {
	listIpv4Interfaces,
	matchPresetsByIp,
	normalizeIp,
	OVERLAY_PRESETS,
	pickAdvertisedAddressCached,
} from '../nets.js';

export {
	isCgnatIp,
	isLanIp,
	isLoopbackIp,
	isOverlayIp,
	isOverlaySource,
	matchPresetsByIp,
	resolveOverlayCidrs,
} from '../nets.js';

/** 预设 id → 人类可读名称（如 'easytier' → 'EasyTier'）。 */
function presetLabel(id) {
	return OVERLAY_PRESETS.find((p) => p.id === id)?.label || id;
}

/**
 * 提取请求的客户端真实 IP。
 *
 * 固定走底层 Socket 而不是 X-Forwarded-For，避免外部伪造来源绕过门禁。
 * `__dsh_real_remote_address__` 是门禁在 Socket 首道关卡记下的未虚拟化地址：
 * 上下文虚拟化会把 socket.remoteAddress 改写成 127.0.0.1（为兼容只允许回环的
 * 插件），所以必须优先读这个快照，否则外部流量会被误判成回环而全部免认证。
 */
export function getClientIp(req) {
	const realAddress = req?.socket?.__dsh_real_remote_address__ || req?.socket?.remoteAddress;
	return normalizeIp(realAddress || '') || '127.0.0.1';
}

/**
 * 当前应当对外播发的地址。
 * 这是整套界面的唯一数据源：二维码、复制链接、地址显示都取自它。
 */
export function getLocalOverlayIp(opts = {}) {
	return pickAdvertisedAddressCached(opts || {}).address;
}

/**
 * 物理局域网地址（en0/eth0 之类上的 RFC1918 地址）。
 * 只有在同一个 Wi-Fi 下的设备才能访问它，用于界面上提供"局域网扫码"入口。
 * 没有物理地址时返回 null（而不是退回 overlay 地址），避免两个入口指向同一个地址造成误解。
 */
export function getLocalLanIp() {
	const picked = pickAdvertisedAddressCached({ prefer: 'lan', pinnedAddress: '' });
	return picked.via === 'lan' ? picked.address : null;
}

/** 全部网卡快照（含预设归属），供状态接口与引导页展示。 */
export function getAllNetworkIps() {
	return listIpv4Interfaces().map((iface) => {
		const presets = matchPresetsByIp(iface.address).map((p) => p.id);
		return {
			name: iface.name,
			ip: iface.address,
			presets,
			virtual: iface.virtual,
			physical: iface.physical,
			onlinkCidr: iface.onlinkCidr,
			isOverlay: presets.length > 0,
			isLan: iface.physical,
		};
	});
}

/**
 * 列出所有【可用隧道地址】，越靠前越应该优先展示。
 *
 * 这是多隧道场景的关键：电脑同时开着 EasyTier 和 OpenVPN 时，
 * 扫码界面需要把两个地址都列出来（而不是只给一个），手机装了哪个就用哪个连。
 *
 * @param {object} opts 当前配置（prefer / pinnedAddress / customCidrs ...）
 * @returns {Array<{address,label,shortLabel,iface,presets,score,recommended}>}
 */
export function listOverlayAddresses(opts = {}) {
	const picked = pickAdvertisedAddressCached(opts || {});
	const prefer = typeof opts?.prefer === 'string' && opts.prefer !== 'auto' ? opts.prefer : null;

	return (picked.candidates || [])
		.filter((c) => {
			if (!c.virtual || !c.eligible) return false;
			// 用户用 prefer 锁定了某一类组网时，只列它
			if (prefer && prefer !== 'custom' && !(c.presets || []).includes(prefer)) return false;
			return true;
		})
		.map((c) => {
			const labels = (c.presets || []).map((id) => presetLabel(id));
			return {
				address: c.address,
				name: c.name,
				label: labels.length ? labels.join(' / ') : c.name || '隧道',
				shortLabel: labels[0] || c.name || '隧道',
				presets: c.presets || [],
				onlinkCidr: c.onlinkCidr,
				score: c.score,
				recommended: c.address === picked.address,
			};
		});
}
