/**
 * dsh-remote-anynet 无头端到端测试
 *
 * 目的：在【完全不动线上服务】的前提下，把合并后的插件当作真实插件跑一遍。
 *
 * 做法：伪造一个最小 cordis ctx（真 http.Server + register/tapIndex/on/get），
 * 先挂一个路由分发器，再调用插件的 apply() —— 这样门禁补丁会把分发器当作
 * 原始监听器快照下来，与线上 DSH 的时序完全一致。然后发真实 HTTP 请求验证：
 *
 *   - 回环访问：门禁无条件放行，status 返回正确的虚拟网地址
 *   - 异地访问：未配对时被拦（401 / 302），/auth 公开
 *   - 虚拟网免密：把来源网段放进放行列表后，异地来源直接放行
 *   - 地址选择：prefer / pinnedAddress 生效
 *
 * 隔离：显式传 devicesFile 指向临时目录，token.js 的 isTestEnv 判定会因此
 * 关闭对全局配置文件的读写，绝不会动到 ~/.dsh 下的真实设备与密钥。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../lib/index.js';
import { invalidateResolveCache } from '../lib/nets.js';

/** 找一个可用的非回环本机 IPv4，用来模拟"异地来源"。 */
function pickNonLoopbackAddress() {
	const ifaces = networkInterfaces();
	for (const name of Object.keys(ifaces)) {
		for (const info of ifaces[name] || []) {
			const family = info.family;
			if (family !== 'IPv4' && family !== 4) continue;
			if (info.internal) continue;
			if (/^127\./.test(info.address)) continue;
			return { name, address: info.address };
		}
	}
	return null;
}

/**
 * 起一个"假 DSH"：真 http.Server + 最小 ctx，然后加载插件。
 * @returns {Promise<{port, base, baseRemote, store, close, routes}>}
 */
async function bootPlugin(tmpDir, pluginConfig = {}) {
	const routes = [];
	const taps = [];
	const disposers = new Map();

	// 可变数组：路由在 apply() 期间才被注册，分发器每次请求时再读
	const dispatch = (req, res) => {
		const pathname = String(req.url || '').split('?')[0];
		for (const route of routes) {
			const matched = route.kind === 'prefix' ? pathname.startsWith(route.path) : pathname === route.path;
			if (!matched) continue;
			if (route.method && route.method !== req.method) continue;
			return route.handler(req, res);
		}
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('no-route');
	};

	const server = http.createServer();
	server.on('request', dispatch);

	const webServer = {
		server,
		port: 0,
		register(route) {
			routes.push(route);
			return () => {};
		},
		tapIndex(fn) {
			taps.push(fn);
			return () => {};
		},
	};

	const ctx = {
		logger: { info() {}, warn() {}, debug() {}, error() {} },
		webServer,
		get(name) {
			return name === 'webServer' ? webServer : undefined;
		},
		on(event, cb) {
			disposers.set(event, cb);
			return () => {};
		},
		inject() {},
	};

	// 静音启动横幅（否则测试输出会被刷屏）
	const origLog = console.log;
	console.log = () => {};
	try {
		apply(ctx, { devicesFile: join(tmpDir, 'devices.json'), ...pluginConfig });
	} finally {
		console.log = origLog;
	}

	await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
	const port = server.address().port;

	// 从门禁视角取出 SessionStore：插件没有直接返回它，这里通过路由闭包无法拿到，
	// 因此改用一个约定：插件把 store 挂在了 ctx 上（见 index.js 的 ctx.anynetStore）。
	const store = ctx.anynetStore;

	return {
		port,
		base: `http://127.0.0.1:${port}`,
		store,
		routes,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/** 极简 JSON 请求。 */
async function getJson(url, headers = {}) {
	const res = await fetch(url, { headers, redirect: 'manual' });
	const text = await res.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, headers: res.headers, body };
}

/* ================================================================== */

test('回环访问：门禁放行，status 播发的是虚拟网地址而不是物理网卡', async (t) => {
	const tmpDir = mkdtempSync(join(tmpdir(), 'anynet-hl-'));
	let app;
	try {
		app = await bootPlugin(tmpDir);
		if (!app.store) return t.skip('插件未暴露 store，跳过（见 index.js 的 ctx.anynetStore）');

		const { status, body } = await getJson(`${app.base}/api/remote-mobile/status`);
		assert.equal(status, 200);
		assert.equal(body.success, true);
		assert.ok(body.overlayIp, 'overlayIp 必须有值');
		assert.ok(body.networkIps.length >= 1);

		// 核心断言：播发的地址不能是"只在一个 Wi-Fi 内可达"的物理网卡地址，
		// 除非本机确实没有隧道网卡。
		const hasTunnel = body.networkIps.some((n) => n.virtual && n.ip === body.overlayIp);
		const onlyPhysical = body.networkIps.filter((n) => n.virtual).length === 0;
		assert.ok(hasTunnel || onlyPhysical, `播发了 ${body.overlayIp}，但存在隧道网卡却未被选中`);

		invalidateResolveCache();
	} finally {
		if (app) await app.close();
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('异地访问：未配对被拦，/auth 公开，配对后放行', async (t) => {
	const remote = pickNonLoopbackAddress();
	if (!remote) return t.skip('本机没有非回环 IPv4，无法模拟异地来源');

	const tmpDir = mkdtempSync(join(tmpdir(), 'anynet-hl-'));
	let app;
	try {
		app = await bootPlugin(tmpDir);
		if (!app.store) return t.skip('插件未暴露 store');
		const remoteBase = `http://${remote.address}:${app.port}`;

		// 1) 未配对的异地请求：API 被 401，主文档被 302 到 /auth
		const denied = await getJson(`${remoteBase}/api/remote-mobile/status`);
		assert.equal(denied.status, 401, `异地未授权应 401，实际 ${denied.status}`);

		const root = await fetch(`${remoteBase}/`, { redirect: 'manual' });
		assert.equal(root.status, 302);
		assert.equal(root.headers.get('location'), '/auth');

		// 2) /auth 公开可访问
		const authPage = await fetch(`${remoteBase}/auth`, { redirect: 'manual' });
		assert.equal(authPage.status, 200, '/auth 应公开');

		// 3) 走完配对：本机生成配对码 → 异地用码换取 Cookie → 再访问放行
		const { body: codeBody } = await getJson(`${app.base}/api/remote-mobile/generate-code`, {
			'Content-Type': 'application/json',
		});
		// generate-code 是 POST
		const codeRes = await fetch(`${app.base}/api/remote-mobile/generate-code`, { method: 'POST' });
		assert.equal(codeRes.status, 200);
		const { code } = await codeRes.json();
		assert.ok(code, '应拿到 6 位配对码');

		const verify = await fetch(`${remoteBase}/api/remote-mobile/verify`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ credential: code }),
		});
		assert.equal(verify.status, 200);
		const cookie = verify.headers.get('set-cookie');
		assert.ok(cookie && cookie.includes('dsh_mobile_token='), '应下发会话 Cookie');

		const token = /dsh_mobile_token=([^;]+)/.exec(cookie)[1];
		const ok = await getJson(`${remoteBase}/api/remote-mobile/status`, { Cookie: `dsh_mobile_token=${token}` });
		assert.equal(ok.status, 200, '配对后异地应放行');
		assert.ok(ok.body.overlayIp);

		void codeBody;
	} finally {
		if (app) await app.close();
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('虚拟网免密：把来源网段放进放行列表后，异地来源无需配对直接放行', async (t) => {
	const remote = pickNonLoopbackAddress();
	if (!remote) return t.skip('本机没有非回环 IPv4');

	const tmpDir = mkdtempSync(join(tmpdir(), 'anynet-hl-'));
	let app;
	try {
		app = await bootPlugin(tmpDir);
		if (!app.store) return t.skip('插件未暴露 store');
		const remoteBase = `http://${remote.address}:${app.port}`;

		// 基线：未开免密 → 401
		assert.equal((await getJson(`${remoteBase}/api/remote-mobile/status`)).status, 401);

		// 先开上游的 Overlay 免密开关，但还不放行任何网段 → 仍然 401
		app.store.updateOptions({ allowOverlay: true, overlayCidrs: [] });
		invalidateResolveCache();
		assert.equal(
			(await getJson(`${remoteBase}/api/remote-mobile/status`)).status,
			401,
			'未配置放行网段时不应放行任何来源',
		);

		// 精确放行来源所在网段 → 直接放行
		const prefix = remote.address.split('.').slice(0, 3).join('.');
		app.store.updateOptions({ allowOverlay: true, overlayCidrs: [`${prefix}.0/24`] });
		invalidateResolveCache();

		const allowed = await getJson(`${remoteBase}/api/remote-mobile/status`);
		assert.equal(allowed.status, 200, `${remote.address} 在放行网段内却仍被拦截`);
		assert.ok(allowed.body.overlayIp);
	} finally {
		if (app) await app.close();
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('地址选择：prefer 与 pinnedAddress 通过接口生效并持久化', async (t) => {
	const tmpDir = mkdtempSync(join(tmpdir(), 'anynet-hl-'));
	let app;
	try {
		app = await bootPlugin(tmpDir);
		if (!app.store) return t.skip('插件未暴露 store');

		// 引导页接口在回环下可用
		const initial = await getJson(`${app.base}/api/remote-anynet/status`);
		assert.equal(initial.status, 200);
		assert.equal(initial.body.plugin, 'dsh-remote-anynet');
		assert.ok(Array.isArray(initial.body.candidates));

		// 固定到一个候选地址
		const target = initial.body.candidates.find((c) => c.eligible);
		assert.ok(target, '应有可用候选');
		const pinned = await fetch(`${app.base}/api/remote-anynet/config`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pinnedAddress: target.address }),
		});
		assert.equal(pinned.status, 200);

		const after = await getJson(`${app.base}/api/remote-anynet/status`);
		assert.equal(after.body.address, target.address);
		assert.equal(after.body.via, 'pinned');

		// 上游 status 也必须跟着变
		const upstream = await getJson(`${app.base}/api/remote-mobile/status`);
		assert.equal(upstream.body.overlayIp, target.address);

		// 非法地址归为"不固定"
		await fetch(`${app.base}/api/remote-anynet/config`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ pinnedAddress: 'not-an-ip' }),
		});
		const bogus = await getJson(`${app.base}/api/remote-anynet/status`);
		assert.equal(bogus.body.pinnedAddress, '');
		assert.notEqual(bogus.body.via, 'pinned');

		// 非法网段被丢弃
		const cidrRes = await fetch(`${app.base}/api/remote-anynet/config`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ customCidrs: ['10.126.0.0/16', '垃圾'] }),
		});
		const cidrBody = await cidrRes.json();
		assert.deepEqual(cidrBody.customCidrs, ['10.126.0.0/16']);
	} finally {
		if (app) await app.close();
		rmSync(tmpDir, { recursive: true, force: true });
	}
});
