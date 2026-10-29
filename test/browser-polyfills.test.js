/**
 * dsh-remote-anynet — 浏览器兼容层测试
 *
 * 覆盖两件事：
 * 1. shim 语义正确：在「没有 AbortSignal.any / Promise.withResolvers / throwIfAborted」
 *    的旧内核环境里（用假对象模拟 Chromium < 116/119），脚本真的把能力补齐，
 *    且中止语义（reason 透传、已中止立即返回）与原生一致。
 * 2. 注入链路正确：mountIndexInjections 的两条路径（tapIndex 与 index-inject 表）
 *    都把兼容层放到了 <head>，且冲突防护脚本仍在最前。
 *
 * 为什么这条测试重要：客户端 connection 的 generation 在第一步就调用
 * AbortSignal.any，缺失时手机端会一直停在「重新连接中」，属于线上可见故障。
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';

import {
	BROWSER_POLYFILLS,
	BROWSER_POLYFILL_TAGS,
	ES2024_POLYFILL_SNIPPET,
	prependToHead,
} from '../lib/bridge/browser-polyfills.js';
import { mountIndexInjections } from '../lib/bridge/compat.js';

/** 只实现 polyfill 会用到的最小语义：aborted / reason / addEventListener。 */
function createLegacyAbortPrimitives() {
	class FakeAbortSignal {
		constructor() {
			this.aborted = false;
			this.reason = undefined;
			this.listeners = new Set();
		}

		addEventListener(type, listener) {
			if (type === 'abort') this.listeners.add(listener);
		}

		removeEventListener(type, listener) {
			if (type === 'abort') this.listeners.delete(listener);
		}

		/** 触发中止，并清空监听器（原生实现同样会清空）。 */
		abort(reason) {
			if (this.aborted) return;
			this.aborted = true;
			this.reason = reason;
			const pending = [...this.listeners];
			this.listeners.clear();
			for (const listener of pending) listener();
		}
	}

	class FakeAbortController {
		constructor() {
			this.signal = new FakeAbortSignal();
		}

		abort(reason) {
			this.signal.abort(reason);
		}
	}

	return { FakeAbortSignal, FakeAbortController };
}

/**
 * 在"旧内核"沙箱里执行 shim 脚本。
 * @returns {{ LegacyPromise, FakeAbortSignal, FakeAbortController }}
 */
function runShimInLegacySandbox() {
	const { FakeAbortSignal, FakeAbortController } = createLegacyAbortPrimitives();
	// 只有 executor 行为的 Promise 替身：没有 withResolvers 静态方法
	function LegacyPromise(executor) {
		return new Promise(executor);
	}

	const sandbox = {
		Promise: LegacyPromise,
		AbortSignal: FakeAbortSignal,
		AbortController: FakeAbortController,
		DOMException,
		setTimeout,
		clearTimeout,
	};
	vm.runInNewContext(ES2024_POLYFILL_SNIPPET, sandbox);
	return { LegacyPromise, FakeAbortSignal, FakeAbortController };
}

test('ES2024 shim：补齐 Promise.withResolvers 并保留 resolve/reject 语义', async () => {
	const { LegacyPromise } = runShimInLegacySandbox();
	assert.equal(typeof LegacyPromise.withResolvers, 'function');

	const resolved = LegacyPromise.withResolvers();
	resolved.resolve('ok');
	assert.equal(await resolved.promise, 'ok');

	const rejected = LegacyPromise.withResolvers();
	rejected.reject(new Error('boom'));
	await assert.rejects(rejected.promise, /boom/);
});

test('ES2024 shim：AbortSignal.any 汇总多个信号，任一中止即中止并透传 reason', () => {
	const { FakeAbortSignal, FakeAbortController } = runShimInLegacySandbox();
	assert.equal(typeof FakeAbortSignal.any, 'function');

	const first = new FakeAbortController();
	const second = new FakeAbortController();
	const merged = FakeAbortSignal.any([first.signal, second.signal]);
	assert.equal(merged.aborted, false);

	second.abort('network down');
	assert.equal(merged.aborted, true);
	assert.equal(merged.reason, 'network down');
});

test('ES2024 shim：AbortSignal.any 遇到已中止的信号立即返回中止态', () => {
	const { FakeAbortSignal, FakeAbortController } = runShimInLegacySandbox();
	const alive = new FakeAbortController();
	const dead = new FakeAbortController();
	dead.abort('already gone');

	const merged = FakeAbortSignal.any([alive.signal, dead.signal]);
	assert.equal(merged.aborted, true);
	assert.equal(merged.reason, 'already gone');
});

test('ES2024 shim：补齐 throwIfAborted 与 AbortSignal.timeout', async () => {
	const { FakeAbortSignal, FakeAbortController } = runShimInLegacySandbox();
	assert.equal(typeof FakeAbortSignal.prototype.throwIfAborted, 'function');
	assert.equal(typeof FakeAbortSignal.timeout, 'function');

	const alive = new FakeAbortController();
	assert.doesNotThrow(() => alive.signal.throwIfAborted());

	const dead = new FakeAbortController();
	dead.abort('stop');
	assert.throws(() => dead.signal.throwIfAborted(), (error) => error === 'stop');

	const timed = FakeAbortSignal.timeout(5);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(timed.aborted, true);
	assert.equal(timed.reason?.name, 'TimeoutError');
});

test('兼容层标签：顺序稳定且包含三个脚本', () => {
	const ids = BROWSER_POLYFILLS.map((item) => item.id);
	assert.deepEqual(ids, ['dsh-es2024-polyfill', 'dsh-crypto-polyfill', 'dsh-clipboard-polyfill']);
	assert.equal(BROWSER_POLYFILL_TAGS, BROWSER_POLYFILLS
		.map((item) => `<script id="${item.id}">${item.source}</script>`)
		.join(''));
	// 关键回归点：客户端 connection 依赖这两个 API，不能被删掉
	assert.ok(ES2024_POLYFILL_SNIPPET.includes('AbortSignal.any'));
	assert.ok(ES2024_POLYFILL_SNIPPET.includes('Promise.withResolvers'));
});

test('prependToHead：插在 <head> 之后，且替换串不被 $ 语法解释', () => {
	const html = '<html><head><script src="app.js"></script></head></html>';
	const injected = prependToHead(html, '<script id="x">var a = "$&$1";</script>');
	assert.ok(injected.startsWith('<html><head><script id="x">var a = "$&$1";</script><script src="app.js">'));

	// 没有 <head> 的片段原样返回，避免注入出错改坏文档
	assert.equal(prependToHead('<html></html>', '<script></script>'), '<html></html>');
	assert.equal(prependToHead(undefined, '<script></script>'), undefined);
});

test('mountIndexInjections：tapIndex 路径把兼容层写进 <head>，冲突防护脚本仍在最前', () => {
	const taps = [];
	const listeners = new Map();
	const ctx = {
		webServer: {
			tapIndex(fn) {
				taps.push(fn);
				return () => {};
			},
		},
		on(event, cb) {
			listeners.set(event, cb);
			return () => {};
		},
	};

	mountIndexInjections(ctx);
	assert.equal(taps.length, 1);

	const html = taps[0]('<html><head></head><body>hi</body></html>');
	const forceAt = html.indexOf('<script id="dsh-force-desktop-suppression">');
	const es2024At = html.indexOf('<script id="dsh-es2024-polyfill">');
	assert.ok(forceAt !== -1);
	assert.ok(es2024At !== -1);
	assert.ok(forceAt < es2024At, '冲突防护脚本必须排在兼容层之前');
	assert.ok(html.indexOf('<script id="dsh-crypto-polyfill">') > es2024At);
	assert.ok(html.indexOf('<script id="dsh-clipboard-polyfill">') > es2024At);
	assert.ok(html.includes('<body>hi</body>'));
});

test('mountIndexInjections：index-inject 表按顺序登记兼容层与冲突防护脚本', () => {
	const listeners = new Map();
	const ctx = {
		webServer: {
			tapIndex() {
				return () => {};
			},
		},
		on(event, cb) {
			listeners.set(event, cb);
			return () => {};
		},
	};

	mountIndexInjections(ctx);
	const table = [];
	listeners.get('webserver/index-inject')(table);

	assert.equal(table.length, 4);
	assert.ok(table.every((row) => row.kind === 'script' && row.placement === 'head'));
	assert.ok(table[0].text.includes('AbortSignal.any'));
	assert.ok(table[3].text.includes('dsh-remote-force-desktop'));
});
