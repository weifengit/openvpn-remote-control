/**
 * 多隧道地址枚举测试
 *
 * 场景来自真实需求：电脑上【同时】开着 EasyTier 和 OpenVPN，
 * 扫码界面必须把两个地址都列出来，手机装了哪个就用哪个连 ——
 * 而不是只给一个（原来只播发优先级最高的那一个，导致手机若只装了
 * OpenVPN 就连不上）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listOverlayAddresses } from '../lib/auth/overlay.js';
import { invalidateResolveCache, listIpv4Interfaces, OVERLAY_PRESETS } from '../lib/nets.js';

/* 合成快照：en0 + EasyTier(utun5) + OpenVPN(utun6)，与真实机器一致 */
const RAW = {
	en0: [{ family: 'IPv4', address: '192.168.3.29', netmask: '255.255.255.0', internal: false }],
	utun5: [{ family: 'IPv4', address: '10.126.126.11', netmask: '255.255.255.0', internal: false }],
	utun6: [{ family: 'IPv4', address: '10.8.0.2', netmask: '255.255.255.0', internal: false }],
};

const PEERS = new Map([
	['utun5', '10.8.8.8'],
	['utun6', '10.8.0.1'],
]);

function opts(extra = {}) {
	return { interfaces: listIpv4Interfaces(RAW), peers: PEERS, ...extra };
}

test('listOverlayAddresses：两条隧道同时在线时，两个地址都要列出来', () => {
	invalidateResolveCache();
	const rows = listOverlayAddresses(opts());

	const addresses = rows.map((r) => r.address);
	assert.ok(addresses.includes('10.126.126.11'), `未列出 EasyTier 地址，实际：${addresses}`);
	assert.ok(addresses.includes('10.8.0.2'), `未列出 OpenVPN 地址，实际：${addresses}`);

	// 只要隧道，不要物理局域网
	assert.ok(!addresses.includes('192.168.3.29'), '物理局域网不应出现在虚拟网地址列表里');

	// 每个地址都带可读标签
	const easy = rows.find((r) => r.address === '10.126.126.11');
	const open = rows.find((r) => r.address === '10.8.0.2');
	assert.equal(easy.label, 'EasyTier');
	assert.equal(open.label, 'OpenVPN');

	// 恰好一个被标为推荐（= 当前播发地址）
	assert.equal(rows.filter((r) => r.recommended).length, 1);
	assert.equal(rows.find((r) => r.recommended).address, '10.126.126.11');
});

test('listOverlayAddresses：prefer=openvpn 时只列 OpenVPN（用户主动锁定）', () => {
	invalidateResolveCache();
	const rows = listOverlayAddresses(opts({ prefer: 'openvpn' }));
	assert.deepEqual(rows.map((r) => r.address), ['10.8.0.2']);
});

test('listOverlayAddresses：没有隧道时返回空数组（不编造地址）', () => {
	invalidateResolveCache();
	const rows = listOverlayAddresses({
		interfaces: listIpv4Interfaces({
			en0: [{ family: 'IPv4', address: '192.168.3.29', netmask: '255.255.255.0', internal: false }],
		}),
		peers: new Map(),
	});
	assert.deepEqual(rows, [], '物理网卡不能作为虚拟网地址列出');
});

test('每个列出的地址都真的能被 isOverlayIp 放行（列了就能连）', async () => {
	const { isOverlayIp, resolveOverlayCidrs } = await import('../lib/nets.js');
	invalidateResolveCache();
	const o = opts();
	const cidrs = resolveOverlayCidrs(o);
	const rows = listOverlayAddresses(o);
	assert.ok(rows.length >= 2, '应有至少两条隧道');
	for (const row of rows) {
		assert.ok(isOverlayIp(row.address, cidrs), `列出的 ${row.address} 却不在放行网段内：${cidrs}`);
	}
});

test('预设目录里已不含 Tailscale，只保留通用虚拟网', () => {
	const ids = OVERLAY_PRESETS.map((p) => p.id);
	assert.ok(!ids.includes('tailscale'));
	assert.ok(ids.includes('easytier'));
	assert.ok(ids.includes('openvpn'));
});
