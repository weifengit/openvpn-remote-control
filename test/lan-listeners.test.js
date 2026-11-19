/**
 * dsh-remote-anynet 额外监听面测试
 *
 * 两条硬约束，任何一条破了都等于把鉴权拆掉或把手机挡在门外：
 *   1. 宿主只绑回环时，手机能通过本机其他地址连进来；
 *   2. 经由附加监听进来的请求，来源地址必须仍是真实来源，不能被改写成回环
 *      （否则门禁会把它当本机请求无条件放行）。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';

import { createLanListeners, listListenableAddresses } from '../lib/lan-listeners.js';

/** 合成网卡快照：物理网卡 + 隧道网卡 + 回环 + 内部网卡。 */
const RAW_INTERFACES = {
	lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
	en0: [{ family: 'IPv4', address: '192.168.3.29', netmask: '255.255.255.0', internal: false }],
	utun5: [{ family: 'IPv4', address: '10.126.126.11', netmask: '255.255.255.0', internal: false }],
	utun6: [{ family: 'IPv4', address: '10.8.0.2', netmask: '255.255.255.0', internal: false }],
	en7: [{ family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false }],
	awdl0: [{ family: 'IPv4', address: '169.254.10.20', netmask: '255.255.0.0', internal: false }],
};

test('枚举可监听地址：跳过回环/内部/非 IPv4，保留物理与隧道网卡', () => {
	const list = listListenableAddresses([], RAW_INTERFACES);
	const addresses = list.map((item) => item.address);

	assert.ok(addresses.includes('192.168.3.29'), '应包含物理网卡地址');
	assert.ok(addresses.includes('10.126.126.11'), '应包含 EasyTier 隧道地址');
	assert.ok(addresses.includes('10.8.0.2'), '应包含 OpenVPN 隧道地址');
	assert.ok(!addresses.includes('127.0.0.1'), '回环不能被重复监听');
	assert.ok(!addresses.includes('fe80::1'), 'IPv6 不在本次范围');
	assert.equal(list.find((i) => i.address === '10.8.0.2')?.name, 'utun6');
});

test('枚举可监听地址：排除宿主已绑定的地址，避免 EADDRINUSE', () => {
	const list = listListenableAddresses(['192.168.3.29'], RAW_INTERFACES);
	assert.ok(!list.some((item) => item.address === '192.168.3.29'));

	// 带 IPv4-mapped 前缀的排除项也要归一化后命中
	const mapped = listListenableAddresses(['::ffff:10.8.0.2'], RAW_INTERFACES);
	assert.ok(!mapped.some((item) => item.address === '10.8.0.2'));
});

test('枚举可监听地址：同一地址出现在两张网卡上时只监听一次', () => {
	const duplicated = {
		en0: [{ family: 'IPv4', address: '192.168.3.29', netmask: '255.255.255.0', internal: false }],
		utun9: [{ family: 4, address: '192.168.3.29', netmask: '255.255.255.0', internal: false }],
	};
	const list = listListenableAddresses([], duplicated);
	assert.equal(list.length, 1);
});

/** 找一个本机真实可用的非回环 IPv4，否则跳过（CI 容器里可能只有一个回环）。 */
function pickRealAddress() {
	for (const infos of Object.values(networkInterfaces())) {
		for (const info of infos || []) {
			if (info.family !== 'IPv4' && info.family !== 4) continue;
			if (info.internal) continue;
			if (/^127\./.test(info.address)) continue;
			return info.address;
		}
	}
	return null;
}

test('端到端：宿主只绑回环时，附加监听让其他地址可达，并保留真实来源 IP', async (t) => {
	const realAddress = pickRealAddress();
	if (!realAddress) return t.skip('本机没有非回环 IPv4，无法验证附加监听');

	// 记录服务端看到的来源地址：这正是门禁用来判定"是不是本机"的字段
	let seenRemoteAddress = null;
	const main = http.createServer((req, res) => {
		seenRemoteAddress = req.socket.remoteAddress;
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('ok');
	});

	await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve));
	const port = main.address().port;

	const listeners = createLanListeners({
		getServer: () => main,
		interfaces: {
			lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
			en0: [{ family: 'IPv4', address: realAddress, internal: false }],
		},
		rescanIntervalMs: 50,
		logger: { info() {}, warn() {}, debug() {} },
	});

	try {
		listeners.start();

		// 等附加监听真正绑上
		for (let i = 0; i < 60 && listeners.getState().listeners.length === 0; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const state = listeners.getState();
		assert.equal(state.listeners.length, 1, `应为一个地址建立附加监听，实际 ${JSON.stringify(state)}`);
		assert.equal(state.listeners[0].address, realAddress);
		assert.equal(state.port, port);

		// 经附加监听访问：必须真的连得上
		const viaExtra = await fetch(`http://${realAddress}:${port}/`);
		assert.equal(viaExtra.status, 200);
		await viaExtra.text();

		// 关键断言：来源地址不能被改写成 127.0.0.1，否则门禁会误判为本机而放行
		assert.equal(seenRemoteAddress, realAddress, '附加监听必须保留真实来源地址');

		// 回环入口同时保持可用（宿主自己的监听不受影响）
		const loopback = await fetch(`http://127.0.0.1:${port}/`);
		assert.equal(loopback.status, 200);
		await loopback.text();
		assert.equal(seenRemoteAddress, '127.0.0.1');
	} finally {
		listeners.stop();
		await new Promise((resolve) => main.close(resolve));
	}
});

test('开关关闭时撤下全部附加监听', async (t) => {
	const realAddress = pickRealAddress();
	if (!realAddress) return t.skip('本机没有非回环 IPv4');

	let enabled = true;
	const main = http.createServer((req, res) => res.end('ok'));
	await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve));
	const port = main.address().port;

	const listeners = createLanListeners({
		getServer: () => main,
		isEnabled: () => enabled,
		interfaces: {
			en0: [{ family: 'IPv4', address: realAddress, internal: false }],
		},
		logger: { info() {}, warn() {}, debug() {} },
	});

	try {
		listeners.start();
		for (let i = 0; i < 60 && listeners.getState().listeners.length === 0; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(listeners.getState().listeners.length, 1);

		enabled = false;
		listeners.rescan();
		assert.equal(listeners.getState().listeners.length, 0, '关掉开关后不应再有附加监听');

		const blocked = await fetch(`http://${realAddress}:${port}/`).then(
			() => 'connected',
			() => 'refused',
		);
		assert.equal(blocked, 'refused', '撤下监听后该地址应连不上');
	} finally {
		listeners.stop();
		await new Promise((resolve) => main.close(resolve));
	}
});

test('stop() 之后不再接受连接，且不会因为重复调用报错', async (t) => {
	const realAddress = pickRealAddress();
	if (!realAddress) return t.skip('本机没有非回环 IPv4');

	const main = http.createServer((req, res) => res.end('ok'));
	await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve));
	const port = main.address().port;

	const listeners = createLanListeners({
		getServer: () => main,
		interfaces: { en0: [{ family: 'IPv4', address: realAddress, internal: false }] },
		logger: { info() {}, warn() {}, debug() {} },
	});

	try {
		listeners.start();
		for (let i = 0; i < 60 && listeners.getState().listeners.length === 0; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		listeners.stop();
		listeners.stop();

		assert.equal(listeners.getState().listeners.length, 0);
		const result = await fetch(`http://${realAddress}:${port}/`).then(
			() => 'connected',
			() => 'refused',
		);
		assert.equal(result, 'refused');
	} finally {
		await new Promise((resolve) => main.close(resolve));
	}
});
