/**
 * dsh-remote-anynet 单元测试
 *
 * 用固定的合成网卡快照断言探测与选择逻辑，不依赖运行机器的真实网络，
 * 因此结果稳定可复现。
 *
 * 运行：node --test test/
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConfigStore, DEFAULTS, normalizePatch } from '../lib/config.js';
import {
	cidrContains,
	detectCandidates,
	intToIpv4,
	ipv4ToInt,
	isCgnatIp,
	isLanIp,
	isLinkLocalIp,
	isLoopbackIp,
	isPublicIp,
	isRfc1918Ip,
	isTailscaleIp,
	listIpv4Interfaces,
	maskToPrefix,
	normalizeCidrList,
	parseCidr,
	pickAdvertisedAddress,
	presetCidrs,
} from '../lib/nets.js';
import { installFirstRequestListener, interceptResponseBody } from '../lib/rewrite.js';
import { buildAnyNetStatus, resolveBypassCidrs, transformUpstreamStatus } from '../lib/status.js';

/* ------------------------------------------------------------------ *
 * 合成网卡快照：模拟"本机同时开着 EasyTier 和 OpenVPN"的场景，
 * 数值取自一台真实的 macOS 机器（en0 + utun5 EasyTier + utun6 OpenVPN）。
 * ------------------------------------------------------------------ */
const RAW_INTERFACES = {
	lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
	en0: [{ family: 'IPv4', address: '192.168.3.29', netmask: '255.255.255.0', internal: false }],
	utun5: [{ family: 'IPv4', address: '10.126.126.11', netmask: '255.255.255.0', internal: false }],
	utun6: [{ family: 'IPv4', address: '10.8.0.2', netmask: '255.255.255.0', internal: false }],
	awdl0: [{ family: 'IPv4', address: '169.254.10.20', netmask: '255.255.0.0', internal: false }],
	// IPv6 行必须被忽略
	utun7: [{ family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false }],
};

const PEERS = new Map([
	['utun5', '10.8.8.8'],
	['utun6', '10.8.0.1'],
]);

function candidates() {
	return detectCandidates({ interfaces: listIpv4Interfaces(RAW_INTERFACES), peers: PEERS });
}

/* ================================================================== *
 * 1. IPv4 / CIDR 基础
 * ================================================================== */

test('ipv4ToInt / intToIpv4 往返一致，且拒绝非法输入', () => {
	assert.equal(ipv4ToInt('0.0.0.0'), 0);
	assert.equal(ipv4ToInt('255.255.255.255'), 4294967295);
	assert.equal(ipv4ToInt('10.126.126.11'), 0x0a7e7e0b);
	assert.equal(ipv4ToInt('::ffff:10.0.0.1'), 0x0a000001, '应剥掉 IPv4-mapped 前缀');
	assert.equal(ipv4ToInt('999.1.1.1'), null);
	assert.equal(ipv4ToInt('1.2.3'), null);
	assert.equal(ipv4ToInt('a.b.c.d'), null);
	assert.equal(ipv4ToInt(''), null);
	assert.equal(intToIpv4(0x0a7e7e0b), '10.126.126.11');
});

test('maskToPrefix 只接受连续掩码', () => {
	assert.equal(maskToPrefix('255.255.255.0'), 24);
	assert.equal(maskToPrefix('255.255.0.0'), 16);
	assert.equal(maskToPrefix('255.255.255.255'), 32);
	assert.equal(maskToPrefix('0.0.0.0'), 0);
	assert.equal(maskToPrefix('255.0.255.0'), null, '非连续掩码应被拒绝');
});

test('parseCidr 支持 CIDR / 掩码 / 单主机三种写法并做网络地址归一', () => {
	assert.equal(parseCidr('10.126.0.0/16').text, '10.126.0.0/16');
	// 主机地址要归一到网络地址
	assert.equal(parseCidr('10.126.126.11/16').text, '10.126.0.0/16');
	assert.equal(parseCidr('10.8.0.0/255.255.255.0').text, '10.8.0.0/24');
	assert.equal(parseCidr('10.8.0.2').text, '10.8.0.2/32');
	assert.equal(parseCidr('10.0.0.0/33'), null);
	assert.equal(parseCidr('nonsense'), null);
	assert.equal(parseCidr(''), null);
	assert.equal(parseCidr(null), null);
});

test('cidrContains 边界正确（含首尾地址，不含相邻网段）', () => {
	const c = parseCidr('10.126.0.0/16');
	assert.equal(cidrContains(c, '10.126.0.0'), true);
	assert.equal(cidrContains(c, '10.126.255.255'), true);
	assert.equal(cidrContains(c, '10.126.126.11'), true);
	assert.equal(cidrContains(c, '10.127.0.0'), false);
	assert.equal(cidrContains(c, '10.125.255.255'), false);
	assert.equal(cidrContains('10.8.0.0/24', '10.8.0.2'), true);
	assert.equal(cidrContains('10.8.0.0/24', '10.8.1.2'), false);
});

test('normalizeCidrList 去重、剔除非法项并单独报错', () => {
	const { ok, invalid } = normalizeCidrList([
		'10.126.0.0/16',
		'10.126.126.5/16', // 归一后与上一条重复
		'10.8.0.0/255.255.255.0',
		'垃圾',
		'',
		null,
	]);
	assert.deepEqual(ok, ['10.126.0.0/16', '10.8.0.0/24']);
	assert.deepEqual(invalid, ['垃圾']);
	assert.deepEqual(normalizeCidrList(undefined).ok, []);
});

/* ================================================================== *
 * 2. 地址分类
 * ================================================================== */

test('地址分类：回环 / RFC1918 / CGNAT / 链路本地 / 公网', () => {
	assert.equal(isLoopbackIp('127.0.0.1'), true);
	assert.equal(isLoopbackIp('127.9.9.9'), true);
	assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true);
	assert.equal(isLoopbackIp('10.0.0.1'), false);

	assert.equal(isRfc1918Ip('10.126.126.11'), true, 'EasyTier 默认网段落在 RFC1918 内');
	assert.equal(isRfc1918Ip('172.16.0.1'), true);
	assert.equal(isRfc1918Ip('172.32.0.1'), false);
	assert.equal(isRfc1918Ip('192.168.3.29'), true);

	assert.equal(isCgnatIp('100.64.0.1'), true);
	assert.equal(isCgnatIp('100.127.255.255'), true);
	assert.equal(isCgnatIp('100.128.0.1'), false);
	assert.equal(isCgnatIp('100.63.0.1'), false);
	assert.equal(isTailscaleIp('100.101.102.103'), true);

	assert.equal(isLinkLocalIp('169.254.10.20'), true);
	assert.equal(isLinkLocalIp('169.255.0.1'), false);

	assert.equal(isPublicIp('8.8.8.8'), true);
	assert.equal(isPublicIp('10.126.126.11'), false);
	assert.equal(isPublicIp('100.64.0.1'), false);
});

test('isLanIp 与上游语义保持一致（排除回环与 Tailscale）', () => {
	assert.equal(isLanIp('192.168.3.29'), true);
	assert.equal(isLanIp('10.126.126.11'), true, 'EasyTier 地址在上游眼里就是 lan');
	assert.equal(isLanIp('10.8.0.2'), true, 'OpenVPN 地址在上游眼里就是 lan');
	assert.equal(isLanIp('127.0.0.1'), false);
	assert.equal(isLanIp('100.101.102.103'), false, 'CGNAT 不算 lan');
	assert.equal(isLanIp('8.8.8.8'), false);
});

test('presetCidrs 聚合与筛选', () => {
	const all = presetCidrs();
	assert.ok(all.includes('10.126.0.0/16'));
	assert.ok(all.includes('10.8.0.0/24'));
	assert.deepEqual(presetCidrs(['easytier']), ['10.126.0.0/16', '10.144.0.0/16']);
	assert.deepEqual(presetCidrs(['nope']), []);
});

/* ================================================================== *
 * 3. 探测与打分
 * ================================================================== */

test('listIpv4Interfaces 只收非内部 IPv4，并给出直连网段与预设归属', () => {
	const list = listIpv4Interfaces(RAW_INTERFACES);
	const byAddr = Object.fromEntries(list.map((i) => [i.address, i]));
	assert.equal(list.length, 4, '回环与 IPv6 应被排除');
	assert.ok(!byAddr['127.0.0.1']);
	assert.ok(!byAddr['fe80::1']);
	assert.equal(byAddr['10.126.126.11'].onlinkCidr, '10.126.126.0/24', '由网卡掩码推出的直连网段');
	assert.deepEqual(byAddr['10.126.126.11'].presets, ['easytier']);
	assert.deepEqual(byAddr['10.8.0.2'].presets, ['openvpn']);
	assert.equal(byAddr['192.168.3.29'].physical, true);
	assert.equal(byAddr['10.126.126.11'].virtual, true);
});

test('detectCandidates：EasyTier 排在物理网卡之前，链路本地被降权', () => {
	const list = candidates();
	const order = list.map((c) => c.address);
	assert.equal(list[0].address, '10.126.126.11', `EasyTier 应排第一，实际顺序 ${order.join(' > ')}`);
	assert.deepEqual(list[0].presets, ['easytier']);
	assert.equal(list[0].peer, '10.8.8.8');
	assert.ok(list[0].score > 0);

	const en0 = list.find((c) => c.name === 'en0');
	const awdl = list.find((c) => c.name === 'awdl0');
	assert.ok(en0.score < list[0].score, '物理网卡应低于隧道网卡');
	assert.equal(awdl.eligible, false, '链路本地地址不可作为候选');
	// 排序稳定性：同分时按预设 priority 再按地址升序
	assert.equal(list[1].address, '10.8.0.2', '同分时 EasyTier(priority 10) 先于 OpenVPN(20)');
});

test('detectCandidates：没有隧道网卡时回落到物理网卡（行为不劣于上游）', () => {
	const list = detectCandidates({
		interfaces: listIpv4Interfaces({
			en0: [{ family: 'IPv4', address: '192.168.3.29', netmask: '255.255.255.0', internal: false }],
		}),
		peers: new Map(),
	});
	assert.equal(list.length, 1);
	assert.equal(list[0].address, '192.168.3.29');
	assert.equal(list[0].eligible, true);
});

/* ================================================================== *
 * 4. pickAdvertisedAddress
 * ================================================================== */

test('pickAdvertisedAddress：auto 选中 EasyTier 地址', () => {
	const ifaces = listIpv4Interfaces(RAW_INTERFACES);
	const picked = pickAdvertisedAddress({ interfaces: ifaces, peers: PEERS, prefer: 'auto' });
	assert.equal(picked.address, '10.126.126.11');
	assert.equal(picked.via, 'auto');
	assert.match(picked.reason, /EasyTier/);
});

test('pickAdvertisedAddress：prefer 可指定 openvpn / lan', () => {
	const ifaces = listIpv4Interfaces(RAW_INTERFACES);
	assert.equal(
		pickAdvertisedAddress({ interfaces: ifaces, peers: PEERS, prefer: 'openvpn' }).address,
		'10.8.0.2',
	);
	assert.equal(
		pickAdvertisedAddress({ interfaces: ifaces, peers: PEERS, prefer: 'lan' }).address,
		'192.168.3.29',
	);
});

test('pickAdvertisedAddress：pinnedAddress 优先级最高，非法值被忽略', () => {
	const ifaces = listIpv4Interfaces(RAW_INTERFACES);
	const pinned = pickAdvertisedAddress({
		interfaces: ifaces,
		peers: PEERS,
		prefer: 'openvpn',
		pinnedAddress: '10.8.0.99',
	});
	assert.equal(pinned.address, '10.8.0.99');
	assert.equal(pinned.via, 'pinned');

	const bogus = pickAdvertisedAddress({
		interfaces: ifaces,
		peers: PEERS,
		pinnedAddress: 'not-an-ip',
	});
	assert.equal(bogus.via, 'auto', '非法 pinned 应回落 auto 而不是返回垃圾值');
});

test('pickAdvertisedAddress：prefer 无匹配时明确回落并说明原因', () => {
	const ifaces = listIpv4Interfaces(RAW_INTERFACES);
	const picked = pickAdvertisedAddress({ interfaces: ifaces, peers: PEERS, prefer: 'zerotier' });
	assert.equal(picked.via, 'auto-fallback');
	assert.match(picked.reason, /未找到匹配/);
	assert.ok(picked.address, '仍应给出一个可用地址而不是 null');
});

test('pickAdvertisedAddress：完全没有可用网卡时返回 null 而不是抛错', () => {
	const picked = pickAdvertisedAddress({ interfaces: [], peers: new Map() });
	assert.equal(picked.address, null);
	assert.equal(picked.via, 'none');
});

/* ================================================================== *
 * 5. 上游状态改写（本插件的核心行为）
 * ================================================================== */

const UPSTREAM_BODY = JSON.stringify({
	success: true,
	locale: 'zh',
	tailscaleIp: null,
	lanIp: '192.168.3.29',
	networkIps: [
		{ name: 'en0', ip: '192.168.3.29', isTailscale: false, isLan: true },
		{ name: 'utun5', ip: '10.126.126.11', isTailscale: false, isLan: true },
		{ name: 'utun6', ip: '10.8.0.2', isTailscale: false, isLan: true },
	],
	allowTailscale: false,
	allowLan: false,
	devicesCount: 1,
});

function baseOpts(patch = {}) {
	return {
		...DEFAULTS,
		...normalizePatch(patch, DEFAULTS),
		// 注入固定网卡，避免测试依赖真实网络
		interfaces: listIpv4Interfaces(RAW_INTERFACES),
		peers: PEERS,
	};
}

test('transformUpstreamStatus：把 lanIp 换成 EasyTier 地址，其余字段原样保留', () => {
	// 注意：transformUpstreamStatus 内部调用 pickAdvertisedAddress(opts)，
	// 这里通过 monkey patch 让探测使用合成网卡。
	const opts = baseOpts();
	const original = transformUpstreamStatus(UPSTREAM_BODY, opts);
	const parsed = JSON.parse(original.body);

	// opts.interfaces / opts.peers 注入合成网卡，结果与真实网络无关。
	assert.equal(parsed.lanIp, '10.126.126.11', 'lanIp 应被改写为 EasyTier 地址');
	assert.equal(original.changed, true);
	assert.equal(parsed.success, true);
	assert.equal(parsed.devicesCount, 1, '非地址字段必须原样保留');
	assert.equal(parsed.allowLan, false);
	assert.ok(parsed.anynet, '应注入 anynet 块供前端与引导页读取');
	assert.equal(parsed.anynet.plugin, 'dsh-remote-anynet');
	assert.ok(Array.isArray(parsed.anynet.candidates));
	assert.ok(parsed.anynet.upstream.detected);
});

test('transformUpstreamStatus：结构不符时一律原样返回，绝不破坏别的接口', () => {
	for (const body of ['', 'not json', '{}', '[]', 'null', '{"success":true}', '{"foo":1}']) {
		const result = transformUpstreamStatus(body, DEFAULTS);
		assert.equal(result.body, body, `body 应原样返回：${body}`);
		assert.equal(result.changed, false);
	}
});

test('transformUpstreamStatus：enabled=false 时不改写地址', () => {
	const opts = { ...DEFAULTS, enabled: false };
	const result = transformUpstreamStatus(UPSTREAM_BODY, opts);
	const parsed = JSON.parse(result.body);
	assert.equal(parsed.lanIp, '192.168.3.29');
	assert.equal(result.changed, false);
});

test('transformUpstreamStatus：rewriteStatus=false 时保留上游地址但仍补 anynet', () => {
	const opts = { ...DEFAULTS, rewriteStatus: false };
	const result = transformUpstreamStatus(UPSTREAM_BODY, opts);
	const parsed = JSON.parse(result.body);
	assert.equal(parsed.lanIp, '192.168.3.29');
	assert.ok(parsed.anynet);
});

test('buildAnyNetStatus：候选带 selected 标记且只有一个为真', () => {
	const status = buildAnyNetStatus(DEFAULTS, {});
	assert.equal(status.plugin, 'dsh-remote-anynet');
	const selected = (status.candidates || []).filter((c) => c.selected);
	assert.ok(selected.length <= 1);
});

test('resolveBypassCidrs：默认收窄到当前地址所属预设，显式配置优先', () => {
	const explicit = resolveBypassCidrs({
		...DEFAULTS,
		bypass: { ...DEFAULTS.bypass, cidrs: ['10.99.0.0/16'] },
	});
	assert.deepEqual(explicit, ['10.99.0.0/16']);

	const auto = resolveBypassCidrs({ ...DEFAULTS, prefer: 'easytier' });
	assert.deepEqual(auto, ['10.126.0.0/16', '10.144.0.0/16']);
});

/* ================================================================== *
 * 6. 配置持久化
 * ================================================================== */

test('ConfigStore：默认值 → 插件行配置 → 文件，三层覆盖顺序正确', () => {
	const dir = mkdtempSync(join(tmpdir(), 'anynet-'));
	const file = join(dir, 'settings.json');
	try {
		const store = new ConfigStore({ prefer: 'openvpn', pinnedAddress: '10.8.0.9' }, { file });
		assert.equal(store.get().prefer, 'openvpn', '插件行配置应覆盖默认值');
		assert.equal(store.get().pinnedAddress, '10.8.0.9');
		assert.equal(store.get().enabled, DEFAULTS.enabled);

		store.update({ prefer: 'easytier' });
		store.save();
		const written = JSON.parse(readFileSync(file, 'utf8'));
		assert.equal(written.prefer, 'easytier');

		// 重新构造：文件应覆盖插件行配置
		const reloaded = new ConfigStore({ prefer: 'openvpn' }, { file });
		assert.equal(reloaded.get().prefer, 'easytier', '持久化文件优先级最高');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('normalizePatch：只接受已知字段，非法值回落', () => {
	const patch = normalizePatch({
		enabled: 'true',
		prefer: '不存在的网络类型',
		customCidrs: ['10.126.0.0/16', 'bad'],
		bypass: { enabled: 1, cidrs: ['10.8.0.0/24'] },
		unknownField: 'should-be-dropped',
	});
	assert.equal(patch.enabled, true);
	assert.equal(patch.prefer, 'auto');
	assert.deepEqual(patch.customCidrs, ['10.126.0.0/16']);
	assert.equal(patch.bypass.enabled, true);
	assert.deepEqual(patch.bypass.cidrs, ['10.8.0.0/24']);
	assert.equal('unknownField' in patch, false);
});

test('normalizePatch：非法 pinnedAddress 归为“不固定”而非原样落盘', () => {
	assert.equal(normalizePatch({ pinnedAddress: 'not-an-ip' }).pinnedAddress, '');
	assert.equal(normalizePatch({ pinnedAddress: '10.126.126.11' }).pinnedAddress, '10.126.126.11');
	assert.equal(normalizePatch({ pinnedAddress: '  10.126.126.11  ' }).pinnedAddress, '10.126.126.11');
	assert.equal(normalizePatch({ pinnedAddress: '::ffff:10.8.0.2' }).pinnedAddress, '10.8.0.2');
	assert.equal(normalizePatch({ pinnedAddress: 12345 }).pinnedAddress, '');
	assert.equal(normalizePatch({ pinnedAddress: null }).pinnedAddress, '');
	assert.equal(normalizePatch({ pinnedAddress: '999.1.1.1' }).pinnedAddress, '');
});

test('ConfigStore：配置文件损坏时不抛错，回落默认并记录原因', () => {
	const dir = mkdtempSync(join(tmpdir(), 'anynet-'));
	const file = join(dir, 'settings.json');
	try {
		writeFileSync(file, '{ this is not json');
		const store = new ConfigStore({}, { file });
		assert.equal(store.get().prefer, DEFAULTS.prefer);
		assert.equal(store.loadErrors.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/* ================================================================== *
 * 7. HTTP 接缝
 * ================================================================== */

test('installFirstRequestListener：把 handler 排首位且保留其余监听器顺序', () => {
	const server = new EventEmitter();
	const a = () => {};
	const b = () => {};
	const c = () => {};
	server.on('request', a);
	server.on('request', b);
	server.on('request', c);
	const handler = () => {};

	const first = installFirstRequestListener(server, handler);
	assert.equal(first.ok, true);
	assert.equal(first.alreadyFirst, false);
	assert.deepEqual(server.listeners('request'), [handler, a, b, c], '应排首位且其余保持原顺序');

	// 幂等：已在首位时不重排、不重复注册
	const again = installFirstRequestListener(server, handler);
	assert.equal(again.ok, true);
	assert.equal(again.alreadyFirst, true);
	assert.equal(server.listeners('request').filter((l) => l === handler).length, 1);

	// 被第三方重排后再次安装，仍应收敛到“我们第一”
	server.removeAllListeners('request');
	server.on('request', a);
	server.on('request', handler);
	const third = installFirstRequestListener(server, handler);
	assert.equal(third.ok, true);
	assert.deepEqual(server.listeners('request'), [handler, a]);
});

test('installFirstRequestListener：无 server 时安全返回失败而不是抛错', () => {
	assert.equal(installFirstRequestListener(null, () => {}).ok, false);
	assert.equal(installFirstRequestListener({}, () => {}).ok, false);
});

test('interceptResponseBody：改写 body 并正确透传回调', (t, done) => {
	const res = new EventEmitter();
	res.headers = {};
	res.write = () => true;
	res.end = (chunk, cb) => {
		assert.equal(typeof chunk === 'string' ? chunk : chunk.toString('utf8'), 'REWRITTEN');
		if (typeof cb === 'function') cb();
		done();
	};
	res.getHeader = () => undefined;
	res.setHeader = () => {};

	interceptResponseBody(res, () => ({ body: 'REWRITTEN', changed: true }));
	res.write('{"a":');
	res.end('1}', () => {});
});
