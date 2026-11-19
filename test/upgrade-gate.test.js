/**
 * dsh-remote-anynet upgrade 层门禁测试
 *
 * 复刻线上拓扑：一个 http.Server，上面已挂业务方的 upgrade 监听器（模拟
 * dsh-client-connection 的 Host 栅栏），再由本插件包一层门禁。
 *
 * 要钉住的两件事：
 *   1. 已授权的外部握手必须被虚拟化成回环特征后放行（否则前端一直「重新连接中」）；
 *   2. 未授权的外部握手必须 401 断开，不能因为虚拟化被当成内部流量。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';

import { patchUpgradeWithGate } from '../lib/bridge/upgrade-gate.js';

/** 构造一个只带必要方法的假 store。 */
function fakeStore({ allowLan = false, allowOverlay = false, tokens = [], overlayCidrs = [] } = {}) {
	return {
		getOptions: () => ({ allowLan, allowOverlay, overlayCidrs }),
		extractTokenFromRequest: (req) => {
			const cookie = req.headers.cookie || '';
			const m = /dsh_mobile_token=([^;]+)/.exec(cookie);
			return m ? m[1] : undefined;
		},
		validateToken: (token) => tokens.includes(token),
	};
}

/** 找一个本机非回环 IPv4，用来模拟手机来源。 */
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

/**
 * 起一个复刻线上市局的 server：
 * 业务监听器模拟底座的 Host 栅栏 —— 只有 host 是 127.0.0.1 才接受升级。
 */
async function bootServer(bindHost) {
	const seen = { hosts: [], accepted: 0, rejected: 0 };

	const server = http.createServer((req, res) => res.end('ok'));
	server.on('upgrade', (req, socket) => {
		seen.hosts.push(req.headers.host);
		// 复刻 dsh-client-connection 的 isTrusted：Host 不在回环/绑定地址之列就 403
		const trusted = String(req.headers.host || '').startsWith('127.0.0.1');
		if (!trusted) {
			seen.rejected += 1;
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
			return;
		}
		seen.accepted += 1;
		socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
	});

	await new Promise((resolve) => server.listen(0, bindHost, resolve));
	return { server, seen, port: server.address().port };
}

/** 发一次原始 WebSocket 握手，拿到状态行。 */
function handshake(host, port, headers = {}) {
	return new Promise((resolve) => {
		const socket = net.connect(port, host, () => {
			const lines = [
				'GET /api/remote.mux HTTP/1.1',
				`Host: ${host}:${port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
			];
			for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
			socket.write(`${lines.join('\r\n')}\r\n\r\n`);
		});
		let buffer = '';
		const timer = setTimeout(() => {
			socket.destroy();
			resolve('TIMEOUT');
		}, 5000);
		socket.on('data', (chunk) => {
			buffer += chunk.toString('latin1');
			if (buffer.includes('\r\n')) {
				clearTimeout(timer);
				socket.destroy();
				resolve(buffer.split('\r\n')[0]);
			}
		});
		socket.on('error', () => {
			clearTimeout(timer);
			resolve('ERROR');
		});
		socket.on('close', () => {
			clearTimeout(timer);
			if (!buffer) resolve('CLOSED');
		});
	});
}

test('已授权的局域网来源：握手被虚拟化成回环特征后放行', async (t) => {
	const realAddress = pickRealAddress();
	if (!realAddress) return t.skip('本机没有非回环 IPv4');

	const { server, seen, port } = await bootServer('0.0.0.0');
	// 局域网免密：192.168/10.x 来源直接放行，等价于用户开了 allowLan
	patchUpgradeWithGate(server, fakeStore({ allowLan: true }));
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const line = await handshake(realAddress, port, { Origin: `http://${realAddress}:${port}` });
	assert.match(line, /101/, `应放行握手，实际 ${line}`);
	assert.equal(seen.accepted, 1);
	assert.equal(seen.hosts[0], `127.0.0.1:${port}`, '业务方看到的 Host 必须已被虚拟化');
});

test('未授权的来源：握手 401 断开，绝不进入业务监听器', async (t) => {
	const realAddress = pickRealAddress();
	if (!realAddress) return t.skip('本机没有非回环 IPv4');

	const { server, seen, port } = await bootServer('0.0.0.0');
	// 什么都不开：既没有免密，也没有有效 Token
	patchUpgradeWithGate(server, fakeStore());
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const line = await handshake(realAddress, port, { Origin: `http://${realAddress}:${port}` });
	assert.match(line, /401/, `未授权应 401，实际 ${line}`);
	assert.equal(seen.accepted, 0, '未授权请求不能到达业务监听器');
	assert.equal(seen.hosts.length, 0, '业务方根本不该看到这个请求');
});

test('携带有效会话 Token 的外部来源：放行', async (t) => {
	const realAddress = pickRealAddress();
	if (!realAddress) return t.skip('本机没有非回环 IPv4');

	const { server, seen, port } = await bootServer('0.0.0.0');
	patchUpgradeWithGate(server, fakeStore({ tokens: ['good-token'] }));
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const line = await handshake(realAddress, port, {
		Origin: `http://${realAddress}:${port}`,
		Cookie: 'dsh_mobile_token=good-token',
	});
	assert.match(line, /101/, `配对过的设备应放行，实际 ${line}`);
	assert.equal(seen.accepted, 1);
});

test('无效 Token 的外部来源仍然被拦', async (t) => {
	const realAddress = pickRealAddress();
	if (!realAddress) return t.skip('本机没有非回环 IPv4');

	const { server, seen, port } = await bootServer('0.0.0.0');
	patchUpgradeWithGate(server, fakeStore({ tokens: ['good-token'] }));
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const line = await handshake(realAddress, port, {
		Origin: `http://${realAddress}:${port}`,
		Cookie: 'dsh_mobile_token=forged',
	});
	assert.match(line, /401/);
	assert.equal(seen.accepted, 0);
});

test('回环来源：不改写 Host，保留浏览器原始同源信号', async (t) => {
	const { server, seen, port } = await bootServer('127.0.0.1');
	patchUpgradeWithGate(server, fakeStore());
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const line = await handshake('127.0.0.1', port);
	assert.match(line, /101/);
	assert.equal(seen.hosts[0], `127.0.0.1:${port}`);
});

test('重复调用幂等，不会把监听器包两层', async (t) => {
	const realAddress = pickRealAddress();
	if (!realAddress) return t.skip('本机没有非回环 IPv4');

	const { server, seen, port } = await bootServer('0.0.0.0');
	patchUpgradeWithGate(server, fakeStore({ allowLan: true }));
	patchUpgradeWithGate(server, fakeStore({ allowLan: true }));
	t.after(() => new Promise((resolve) => server.close(resolve)));

	const line = await handshake(realAddress, port);
	assert.match(line, /101/);
	assert.equal(seen.accepted, 1, '只应被业务监听器处理一次');
});
