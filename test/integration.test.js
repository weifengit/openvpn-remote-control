/**
 * dsh-remote-anynet 端到端集成测试
 *
 * 单测证明了探测与配置文件本身；这里证明【接缝真的能工作】：
 * 起一个真实的 http.Server，按上游 dsh-remote-mobile 的真实行为
 * （removeAllListeners('request') → 快照原监听器 → 只挂自己的门禁，再在放行回调里
 *   依次调用快照）布置监听器，然后发真实 HTTP 请求，断言响应体里的地址被改写。
 *
 * 两种挂载时序都要覆盖，因为插件无法决定自己与上游谁先 apply：
 *   A) 先装本插件，后布置上游门禁  → 本插件落在上游快照的第一位
 *   B) 先布置上游门禁，后装本插件  → 本插件排在 server 首位，上游快照里也仍有它
 * 这正是 lib/rewrite.js 顶部论证的两个分支，必须有测试兜住。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { ConfigStore } from '../lib/config.js';
import { createAnyNetRequestListener, installFirstRequestListener } from '../lib/rewrite.js';

/** 待改写地址：用 pin 保证与运行机器的真实网卡无关，测试结果确定。 */
const PINNED = '10.126.126.11';

/** 上游 /api/remote-mobile/status 的真实响应形状（字段取自 1.9.0）。 */
const UPSTREAM_STATUS = {
	success: true,
	locale: 'zh',
	tailscaleIp: null,
	lanIp: '192.168.3.29',
	networkIps: [
		{ name: 'en0', ip: '192.168.3.29', isTailscale: false, isLan: true },
		{ name: 'utun5', ip: '10.126.126.11', isTailscale: false, isLan: true },
	],
	allowTailscale: false,
	allowLan: false,
	devicesCount: 1,
};

/** DSH 风格的下游路由：只认领 status，其余 404。 */
function routerListener(req, res) {
	if ((req.url || '').split('?')[0] === '/api/remote-mobile/status') {
		res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify(UPSTREAM_STATUS));
		return;
	}
	res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end('not-found');
}

/**
 * 复刻上游 dsh-remote-mobile 的 patchHttpServerWithVirtualizer 关键行为：
 * 快照当前 'request' 监听器 → 全部摘掉 → 只挂自己的门禁 → 放行时依次调用快照。
 * gate 用「直接放行」实现，本测试只关心响应体改写，不关心鉴权。
 */
function installUpstreamGate(server) {
	const snapshot = server.listeners('request').slice(0);
	server.removeAllListeners('request');
	server.on('request', (req, res) => {
		for (const listener of snapshot) listener.call(server, req, res);
	});
}

/** 起服务、跑一次请求、关闭服务。 */
async function withServer(setup, run) {
	const server = http.createServer(routerListener);
	setup(server);
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	try {
		return await run(port);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

/** 构造一份使用临时文件、地址已 pin 的配置。 */
function makeStore(dir) {
	return new ConfigStore({ enabled: true, rewriteStatus: true, pinnedAddress: PINNED }, {
		file: join(dir, 'settings.json'),
	});
}

function makeListener(store) {
	return createAnyNetRequestListener({ configStore: store, logger: null, onUpstreamSeen: () => {} });
}

test('端到端 A：本插件先装，上游后打补丁 → status 里的地址被改写', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'anynet-e2e-a-'));
	try {
		const store = makeStore(dir);
		const listener = makeListener(store);
		const body = await withServer(
			(server) => {
				installFirstRequestListener(server, listener);
				installUpstreamGate(server);
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/api/remote-mobile/status`);
				assert.equal(res.status, 200);
				return res.json();
			},
		);
		assert.equal(body.lanIp, PINNED, 'lanIp 应被改写为固定的异地地址');
		assert.equal(body.anynet.plugin, 'dsh-remote-anynet');
		assert.equal(body.devicesCount, 1, '其余字段必须原样保留');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('端到端 B：上游先打补丁，本插件后重排首位 → status 里的地址同样被改写', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'anynet-e2e-b-'));
	try {
		const store = makeStore(dir);
		const listener = makeListener(store);
		const body = await withServer(
			(server) => {
				installUpstreamGate(server);
				installFirstRequestListener(server, listener);
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/api/remote-mobile/status`);
				assert.equal(res.status, 200);
				return res.json();
			},
		);
		assert.equal(body.lanIp, PINNED);
		assert.equal(body.anynet.plugin, 'dsh-remote-anynet');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('端到端：非 status 路径完全不受影响（不被吞、不被改写）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'anynet-e2e-c-'));
	try {
		const store = makeStore(dir);
		const listener = makeListener(store);
		await withServer(
			(server) => {
				installUpstreamGate(server);
				installFirstRequestListener(server, listener);
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/other`);
				assert.equal(res.status, 404);
				assert.equal(await res.text(), 'not-found');
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('端到端：插件关闭时必须是彻头彻尾的 no-op', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'anynet-e2e-d-'));
	try {
		const store = new ConfigStore({ enabled: false, pinnedAddress: PINNED }, { file: join(dir, 'settings.json') });
		const listener = makeListener(store);
		const body = await withServer(
			(server) => {
				installUpstreamGate(server);
				installFirstRequestListener(server, listener);
			},
			async (port) => {
				const res = await fetch(`http://127.0.0.1:${port}/api/remote-mobile/status`);
				return res.json();
			},
		);
		assert.equal(body.lanIp, '192.168.3.29', '关闭后不应改动上游播发的地址');
		assert.equal(body.anynet, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('端到端：响应体含中文时字节长度变化不会破坏响应（Content-Length 同步）', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'anynet-e2e-e-'));
	try {
		const store = makeStore(dir);
		const listener = makeListener(store);
		const server = http.createServer((req, res) => {
			// 故意显式设置 Content-Length，模拟链路上有人设过长度的情况
			const payload = JSON.stringify({ ...UPSTREAM_STATUS, locale: 'zh', note: '中文注释' });
			res.writeHead(200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Content-Length': Buffer.byteLength(payload),
			});
			res.end(payload);
		});
		try {
			installUpstreamGate(server);
			installFirstRequestListener(server, listener);
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			const { port } = server.address();
			const res = await fetch(`http://127.0.0.1:${port}/api/remote-mobile/status`);
			const body = await res.json();
			assert.equal(body.lanIp, PINNED, '显式 Content-Length 场景下仍应正确改写');
			assert.equal(body.note, '中文注释');
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('端到端安全：响应已被 gzip 压缩时必须原样透传，绝不改成乱码', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'anynet-e2e-gzip-'));
	try {
		const store = makeStore(dir);
		const listener = makeListener(store);
		const server = http.createServer((req, res) => {
			const gz = zlib.gzipSync(Buffer.from(JSON.stringify(UPSTREAM_STATUS), 'utf8'));
			res.writeHead(200, {
				'Content-Type': 'application/json; charset=utf-8',
				'Content-Encoding': 'gzip',
			});
			res.end(gz);
		});
		try {
			installUpstreamGate(server);
			installFirstRequestListener(server, listener);
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			const { port } = server.address();
			// 用原始 http 取未解压字节，确认没有被按文本改写
			const raw = await new Promise((resolve, reject) => {
				http
					.get({ host: '127.0.0.1', port, path: '/api/remote-mobile/status' }, (res) => {
						const bufs = [];
						res.on('data', (c) => bufs.push(c));
						res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(bufs) }));
					})
					.on('error', reject);
			});
			assert.equal(raw.headers['content-encoding'], 'gzip');
			// 关键：仍能正确解压并解析，说明字节流未被破坏
			const parsed = JSON.parse(zlib.gunzipSync(raw.body).toString('utf8'));
			assert.equal(parsed.lanIp, '192.168.3.29', '压缩响应必须原样保留');
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
