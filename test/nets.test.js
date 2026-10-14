/**
 * dsh-remote-anynet 单元测试（探测与判定逻辑）
 *
 * 用固定的合成网卡快照断言，不依赖运行机器的真实网络，结果稳定可复现。
 * 端到端的部分见 test/headless.test.js。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	cidrContains,
	detectCandidates,
	invalidateResolveCache,
	intToIpv4,
	ipInAnyCidr,
	ipv4ToInt,
	isCgnatIp,
	isLanIp,
	isLinkLocalIp,
	isLoopbackIp,
	isOverlayIp,
	isPublicIp,
	isRfc1918Ip,
	isVirtualIfaceName,
	listIpv4Interfaces,
	maskToPrefix,
	matchPresetsByIp,
	normalizeCidrList,
	parseCidr,
	pickAdvertisedAddress,
	presetCidrs,
	resolveOverlayCidrs,
} from '../lib/nets.js';

/* 合成快照：一台 macOS 同时开着 EasyTier(utun5) 与 OpenVPN(utun6) */
const RAW_INTERFACES = {
	lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
	en0: [{ family: 'IPv4', address: '192.168.3.29', netmask: '255.255.255.0', internal: false }],
	utun5: [{ family: 'IPv4', address: '10.126.126.11', netmask: '255.255.255.0', internal: false }],
	utun6: [{ family: 'IPv4', address: '10.8.0.2', netmask: '255.255.255.0', internal: false }],
	awdl0: [{ family: 'IPv4', address: '169.254.10.20', netmask: '255.255.0.0', internal: false }],
	utun7: [{ family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false }],
};

const PEERS = new Map([
	['utun5', '10.8.8.8'],
	['utun6', '10.8.0.1'],
]);

/** 用合成快照跑一遍选择。 */
function pick(overrides = {}) {
	return pickAdvertisedAddress({
		interfaces: listIpv4Interfaces(RAW_INTERFACES),
		peers: PEERS,
		...overrides,
	});
}

/* ================================================================== *
 * IPv4 / CIDR 基础
 * ================================================================== */

test('ipv4 整数与点分互转，并拒绝非法输入', () => {
	assert.equal(ipv4ToInt('0.0.0.0'), 0);
	assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
	assert.equal(ipv4ToInt('10.126.126.11'), 0x0a7e7e0b);
	assert.equal(ipv4ToInt('::ffff:10.0.0.1'), 0x0a000001, '应剥掉 IPv4-mapped 前缀');
	assert.equal(ipv4ToInt('999.1.1.1'), null);
	assert.equal(ipv4ToInt('1.2.3'), null);
	assert.equal(ipv4ToInt(''), null);
	assert.equal(intToIpv4(0x0a7e7e0b), '10.126.126.11');
});

test('maskToPrefix 只接受连续掩码', () => {
	assert.equal(maskToPrefix('255.255.255.0'), 24);
	assert.equal(maskToPrefix('255.255.0.0'), 16);
	assert.equal(maskToPrefix('0.0.0.0'), 0);
	assert.equal(maskToPrefix('255.0.255.0'), null, '非连续掩码应被拒绝');
});

test('parseCidr 支持 CIDR / 掩码 / 单主机并归一到网络地址', () => {
	assert.equal(parseCidr('10.126.0.0/16').text, '10.126.0.0/16');
	assert.equal(parseCidr('10.126.126.11/16').text, '10.126.0.0/16');
	assert.equal(parseCidr('10.8.0.0/255.255.255.0').text, '10.8.0.0/24');
	assert.equal(parseCidr('10.8.0.2').text, '10.8.0.2/32');
	assert.equal(parseCidr('10.0.0.0/33'), null);
	assert.equal(parseCidr('nonsense'), null);
	assert.equal(parseCidr(null), null);
});

test('cidrContains 边界正确', () => {
	const c = parseCidr('10.126.0.0/16');
	assert.equal(cidrContains(c, '10.126.0.0'), true);
	assert.equal(cidrContains(c, '10.126.255.255'), true);
	assert.equal(cidrContains(c, '10.127.0.0'), false);
	assert.equal(cidrContains('10.8.0.0/24', '10.8.0.2'), true);
	assert.equal(cidrContains('10.8.0.0/24', '10.8.1.2'), false);
});

test('normalizeCidrList 去重并剔除非法项', () => {
	const { ok, invalid } = normalizeCidrList(['10.126.0.0/16', '10.126.126.5/16', '10.8.0.0/255.255.255.0', '垃圾', '', null]);
	assert.deepEqual(ok, ['10.126.0.0/16', '10.8.0.0/24']);
	assert.deepEqual(invalid, ['垃圾']);
	assert.deepEqual(normalizeCidrList(undefined).ok, []);
});

test('ipInAnyCidr 空列表恒为 false', () => {
	assert.equal(ipInAnyCidr('10.0.0.1', []), false);
	assert.equal(ipInAnyCidr('10.0.0.1', null), false);
	assert.equal(ipInAnyCidr('10.0.0.1', ['10.0.0.0/8']), true);
});

/* ================================================================== *
 * 地址分类
 * ================================================================== */

test('地址分类：回环 / RFC1918 / CGNAT / 链路本地 / 公网', () => {
	assert.equal(isLoopbackIp('127.0.0.1'), true);
	assert.equal(isLoopbackIp('127.9.9.9'), true);
	assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true);
	assert.equal(isLoopbackIp('10.0.0.1'), false);

	assert.equal(isRfc1918Ip('10.126.126.11'), true, 'EasyTier 网段落在 RFC1918 内');
	assert.equal(isRfc1918Ip('172.16.0.1'), true);
	assert.equal(isRfc1918Ip('172.32.0.1'), false);
	assert.equal(isRfc1918Ip('192.168.3.29'), true);

	assert.equal(isCgnatIp('100.64.0.1'), true);
	assert.equal(isCgnatIp('100.127.255.255'), true);
	assert.equal(isCgnatIp('100.128.0.1'), false);

	assert.equal(isLinkLocalIp('169.254.10.20'), true);
	assert.equal(isLinkLocalIp('169.255.0.1'), false);

	assert.equal(isPublicIp('8.8.8.8'), true);
	assert.equal(isPublicIp('10.126.126.11'), false);
});

test('isLanIp 排除回环与 CGNAT', () => {
	assert.equal(isLanIp('192.168.3.29'), true);
	assert.equal(isLanIp('10.126.126.11'), true);
	assert.equal(isLanIp('127.0.0.1'), false);
	assert.equal(isLanIp('100.101.102.103'), false);
	assert.equal(isLanIp('8.8.8.8'), false);
});

test('isVirtualIfaceName 识别各家的隧道网卡名', () => {
	for (const n of ['utun5', 'tun0', 'tap1', 'wg0', 'ztabc', 'netbird0']) {
		assert.equal(isVirtualIfaceName(n), true, `${n} 应被识别为隧道网卡`);
	}
	for (const n of ['en0', 'eth0', 'wlan0', 'lo0']) {
		assert.equal(isVirtualIfaceName(n), false, `${n} 不应被识别为隧道网卡`);
	}
});

/* ================================================================== *
 * 预设
 * ================================================================== */

test('预设里已经没有 Tailscale 专属项', () => {
	const ids = presetCidrs(['easytier', 'openvpn', 'tailscale']);
	assert.deepEqual(presetCidrs(['tailscale']), [], 'tailscale 预设应已被移除');
	assert.deepEqual(ids, presetCidrs(['easytier', 'openvpn']));
	assert.ok(presetCidrs().includes('10.126.0.0/16'));
	assert.ok(presetCidrs().includes('10.8.0.0/24'));
});

test('matchPresetsByIp 归类正确', () => {
	assert.deepEqual(matchPresetsByIp('10.126.126.11').map((p) => p.id), ['easytier']);
	assert.deepEqual(matchPresetsByIp('10.8.0.2').map((p) => p.id), ['openvpn']);
	assert.deepEqual(matchPresetsByIp('192.168.3.29').map((p) => p.id), []);
	assert.deepEqual(matchPresetsByIp('100.101.1.1').map((p) => p.id), ['netbird'], 'CGNAT 归 NetBird，不再有 Tailscale');
});

/* ================================================================== *
 * 探测与打分
 * ================================================================== */

test('listIpv4Interfaces 只收非内部 IPv4，并给出直连网段与预设归属', () => {
	const list = listIpv4Interfaces(RAW_INTERFACES);
	const byAddr = Object.fromEntries(list.map((i) => [i.address, i]));
	assert.equal(list.length, 4, '回环与 IPv6 应被排除');
	assert.equal(byAddr['10.126.126.11'].onlinkCidr, '10.126.126.0/24');
	assert.deepEqual(byAddr['10.126.126.11'].presets, ['easytier']);
	assert.deepEqual(byAddr['10.8.0.2'].presets, ['openvpn']);
	assert.equal(byAddr['192.168.3.29'].physical, true);
	assert.equal(byAddr['10.126.126.11'].virtual, true);
});

test('EasyTier 排在物理网卡之前；同分时按预设优先级决出（EasyTier 先于 OpenVPN）', () => {
	const list = detectCandidates({ interfaces: listIpv4Interfaces(RAW_INTERFACES), peers: PEERS });
	const order = list.map((c) => c.address);
	assert.equal(list[0].address, '10.126.126.11', `实际顺序 ${order.join(' > ')}`);
	assert.equal(list[1].address, '10.8.0.2');
	assert.ok(list.find((c) => c.name === 'en0').score < list[0].score);
	assert.equal(list.find((c) => c.name === 'awdl0').eligible, false, '链路本地不可选');
});

test('没有隧道网卡时回落到物理网卡（行为不劣于上游）', () => {
	const list = detectCandidates({
		interfaces: listIpv4Interfaces({ en0: [{ family: 'IPv4', address: '192.168.3.29', netmask: '255.255.255.0', internal: false }] }),
		peers: new Map(),
	});
	assert.equal(list.length, 1);
	assert.equal(list[0].address, '192.168.3.29');
	assert.equal(list[0].eligible, true);
});

/* ================================================================== *
 * 地址选择
 * ================================================================== */

test('auto 选中 EasyTier；prefer 可指定 openvpn / lan', () => {
	assert.equal(pick({ prefer: 'auto' }).address, '10.126.126.11');
	assert.equal(pick({ prefer: 'openvpn' }).address, '10.8.0.2');
	assert.equal(pick({ prefer: 'lan' }).address, '192.168.3.29');
});

test('pinnedAddress 优先级最高，非法值被忽略', () => {
	const pinned = pick({ prefer: 'openvpn', pinnedAddress: '10.8.0.99' });
	assert.equal(pinned.address, '10.8.0.99');
	assert.equal(pinned.via, 'pinned');
	assert.equal(pick({ pinnedAddress: 'not-an-ip' }).via, 'auto', '非法 pinned 应回落 auto');
});

test('prefer 无匹配时明确回落并说明原因', () => {
	const p = pick({ prefer: 'zerotier' });
	assert.equal(p.via, 'auto-fallback');
	assert.match(p.reason, /未找到匹配/);
	assert.ok(p.address);
});

test('完全没有可用网卡时返回 null 而不是抛错', () => {
	const p = pickAdvertisedAddress({ interfaces: [], peers: new Map() });
	assert.equal(p.address, null);
	assert.equal(p.via, 'none');
});

/* ================================================================== *
 * 免密放行的网段收窄（相较上游 allowLan 的核心改进）
 * ================================================================== */

test('resolveOverlayCidrs：显式配置优先，否则收窄到当前地址所属预设', () => {
	// 用合成网卡，不依赖运行机器当下开着哪些隧道（否则隧道一关测试就飘）
	const opts = { interfaces: listIpv4Interfaces(RAW_INTERFACES), peers: PEERS };

	// 1) 显式配置最优先
	assert.deepEqual(resolveOverlayCidrs({ ...opts, overlayCidrs: ['10.99.0.0/16'] }), ['10.99.0.0/16']);

	// 2) 未显式配置时，收窄到播发地址所属的预设网段
	invalidateResolveCache();
	const auto = resolveOverlayCidrs({ ...opts, prefer: 'openvpn' });
	assert.deepEqual(auto, presetCidrs(['openvpn']));
	for (const c of auto) {
		assert.ok(!cidrContains(c, '192.168.3.29'), '不应顺带放行物理局域网地址');
	}
});

test('resolveOverlayCidrs：只有物理网卡时必须为空（不得变成局域网免密）', () => {
	// 回归测试：曾经在“隧道全关、播发的是物理网卡”时，这里会退回该网卡的
	// 直连网段（如 192.168.3.0/24），等于把“虚拟网免密”变成“局域网免密”。
	const physicalOnly = listIpv4Interfaces({
		en0: [{ family: 'IPv4', address: '192.168.3.29', netmask: '255.255.255.0', internal: false }],
	});
	invalidateResolveCache();
	assert.deepEqual(
		resolveOverlayCidrs({ interfaces: physicalOnly, peers: new Map() }),
		[],
		'物理局域网的直连网段绝不能当虚拟网放行',
	);

	// 显式配置仍然尊重用户意愿（用户自己写下的网段不做二次判断）
	invalidateResolveCache();
	assert.deepEqual(
		resolveOverlayCidrs({ interfaces: physicalOnly, peers: new Map(), overlayCidrs: ['192.168.3.0/24'] }),
		['192.168.3.0/24'],
	);
});

test('resolveOverlayCidrs：非预设的自定义隧道退回它自己的直连网段', () => {
	// 10.55.7.3 不属于任何预设，但网卡掩码给出 10.55.7.0/24
	const ifaces = listIpv4Interfaces({
		utun9: [{ family: 'IPv4', address: '10.55.7.3', netmask: '255.255.255.0', internal: false }],
	});
	invalidateResolveCache();
	const cidrs = resolveOverlayCidrs({ interfaces: ifaces, peers: new Map(), pinnedAddress: '10.55.7.3' });
	assert.deepEqual(cidrs, ['10.55.7.0/24']);
});

test('isOverlayIp：回环永远不算，空列表不放行任何来源', () => {
	assert.equal(isOverlayIp('10.8.0.2', ['10.8.0.0/24']), true);
	assert.equal(isOverlayIp('10.8.1.2', ['10.8.0.0/24']), false);
	assert.equal(isOverlayIp('127.0.0.1', ['0.0.0.0/0']), false, '回环不应被当作虚拟网来源');
	assert.equal(isOverlayIp('10.8.0.2', []), false, '空放行列表必须拒绝一切');
});

test('缓存：同一配置下重复解析返回同一对象，配置变化后可失效', () => {
	invalidateResolveCache();
	const opts = { interfaces: listIpv4Interfaces(RAW_INTERFACES), peers: PEERS, prefer: 'auto' };
	const a = resolveOverlayCidrs(opts);
	const b = resolveOverlayCidrs(opts);
	assert.deepEqual(a, b);
	invalidateResolveCache();
	assert.deepEqual(resolveOverlayCidrs(opts), a, '失效后重算结果应一致');
});

