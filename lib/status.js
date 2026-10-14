/**
 * dsh-remote-anynet — 状态视图模型
 *
 * 把「探测到的候选地址 + 当前配置」整理成两份输出：
 *   1. buildAnyNetStatus()      —— 本插件自己的完整状态（引导页 / 自己的 API 用）
 *   2. transformUpstreamStatus() —— 改写上游 dsh-remote-mobile 的 status 响应体
 *
 * 第 2 项是本插件真正解决"网址不对"的着力点：
 * 上游 /api/remote-mobile/status 返回的 `lanIp` 会被它的客户端界面当成
 * 「对外可达地址」直接拼进二维码与复制链接：
 *     const directLink = `http://${currentHost}:${port}/auth?token=${...}`
 * 而在 macOS 上 getLocalLanIp() 永远优先命中 en0，于是异地用 EasyTier/OpenVPN
 * 打通网络后，手机扫到的仍然是那个"出了这个 Wi-Fi 就访问不了"的局域网地址。
 * 我们只在响应体里把它替换成真正可达的隧道地址，上游代码一行都不用改。
 */

import {
	matchPresetsByIp,
	normalizeCidrList,
	OVERLAY_PRESETS,
	pickAdvertisedAddress,
	presetCidrs,
} from './nets.js';

/** 上游状态接口路径（改写目标）。 */
export const UPSTREAM_STATUS_PATH = '/api/remote-mobile/status';

/**
 * 计算免密放行实际生效的网段列表。
 *
 * 规则：
 *   1. 用户在 bypass.cidrs 里显式给了网段 → 就用这些（精确控制，推荐）；
 *   2. 否则用「当前播发地址命中的预设网段」——例如播发的是 10.126.126.11，
 *      就自动放行 EasyTier 的 10.126.0.0/16，而不是整片 RFC1918；
 *   3. 再否则用 prefer 指定的预设网段。
 *
 * 这条链路的重点：默认尽量"窄"，避免上游那个 allowLan 开关那样一次放开
 * 全部 10/172.16-31/192.168 网段。
 */
export function resolveBypassCidrs(opts) {
	const explicit = normalizeCidrList(opts?.bypass?.cidrs).ok;
	if (explicit.length) return explicit;

	const picked = pickAdvertisedAddress(opts || {});
	const hitPresets = picked.address ? matchPresetsByIp(picked.address).map((p) => p.id) : [];
	if (hitPresets.length) return presetCidrs(hitPresets);

	if (opts?.prefer && opts.prefer !== 'auto') return presetCidrs([opts.prefer]);
	return [];
}

/**
 * 构造本插件的完整状态对象。
 *
 * @param {object} opts 当前配置
 * @param {object} [extra] { upstreamDetected, rewriteCount }
 */
export function buildAnyNetStatus(opts, extra = {}) {
	const picked = pickAdvertisedAddress(opts || {});
	const bypassCidrs = resolveBypassCidrs(opts || {});

	return {
		plugin: 'dsh-remote-anynet',
		version: extra.version || null,
		enabled: Boolean(opts?.enabled),
		prefer: opts?.prefer || 'auto',
		pinnedAddress: opts?.pinnedAddress || '',
		customCidrs: normalizeCidrList(opts?.customCidrs).ok,
		rewriteStatus: Boolean(opts?.rewriteStatus),
		exposeCandidates: Boolean(opts?.exposeCandidates),
		// 当前实际播发的对外地址
		address: picked.address,
		via: picked.via,
		reason: picked.reason,
		// 全部候选（按分值降序），供引导页一键切换
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
		bypass: {
			enabled: Boolean(opts?.bypass?.enabled),
			configuredCidrs: normalizeCidrList(opts?.bypass?.cidrs).ok,
			effectiveCidrs: bypassCidrs,
			requireSecret: Boolean(opts?.bypass?.requireSecret),
		},
		presets: OVERLAY_PRESETS.map((p) => ({
			id: p.id,
			label: p.label,
			cidrs: p.cidrs,
			note: p.note,
		})),
		upstream: {
			detected: Boolean(extra.upstreamDetected),
			rewriteCount: extra.rewriteCount || 0,
			statusPath: UPSTREAM_STATUS_PATH,
		},
	};
}

/**
 * 改写上游 status 响应体。
 *
 * 只在能确认"这确实是一份上游 status"时才动手（有 success 布尔 + networkIps 数组），
 * 解析失败或结构不符一律原样返回 —— 绝不因为本插件把上游接口弄坏。
 *
 * @param {string} body 上游原始响应体
 * @param {object} opts 当前配置
 * @returns {{body: string, changed: boolean, reason?: string}}
 */
export function transformUpstreamStatus(body, opts) {
	if (typeof body !== 'string' || !body) return { body, changed: false, reason: 'empty' };

	let data;
	try {
		data = JSON.parse(body);
	} catch {
		return { body, changed: false, reason: 'not-json' };
	}

	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return { body, changed: false, reason: 'not-object' };
	}
	if (typeof data.success !== 'boolean' || !Array.isArray(data.networkIps)) {
		// 不是上游 status（可能是别的插件撞了同名路径）
		return { body, changed: false, reason: 'shape-mismatch' };
	}

	const picked = pickAdvertisedAddress(opts || {});
	const status = buildAnyNetStatus(opts || {}, { upstreamDetected: true });
	const next = { ...data, anynet: status };

	let changed = false;
	if (opts?.enabled && opts?.rewriteStatus && picked.address && picked.address !== data.lanIp) {
		next.lanIp = picked.address;
		changed = true;
	}

	if (opts?.enabled && opts?.exposeCandidates) {
		// 上游的 networkIps 只标了 isLan/isTailscale；补上虚拟网归属，
		// 让前端（以及本插件引导页）能看出哪张是 EasyTier、哪张是 OpenVPN。
		next.networkIps = (data.networkIps || []).map((entry) => {
			if (!entry || typeof entry !== 'object') return entry;
			return {
				...entry,
				presets: matchPresetsByIp(entry.ip).map((p) => p.id),
			};
		});
		changed = true;
	}

	if (!changed) {
		// 地址本来就对（例如用户已经 pin 成 en0 的地址）→ 仍带上 anynet 供前端读取
		return { body: JSON.stringify(next), changed: false, reason: 'address-already-correct' };
	}

	return { body: JSON.stringify(next), changed: true };
}
