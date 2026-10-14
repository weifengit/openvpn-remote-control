/**
 * dsh-remote-anynet — HTTP 接缝
 *
 * 【为什么是"监听器排第一位 + 改写响应体"】
 * DSH 的 WebServer 只暴露三类可插拔点：register(route)（重复 (kind,path) 直接抛错）、
 * registerFallback(handler)（只兜没被认领的路径）、tapIndex(html)（改 index.html）。
 * 没有通用 HTTP 中间件。而我们要改的 /api/remote-mobile/status 已经被上游
 * dsh-remote-mobile 用 register 认领，重名会抛错，所以只能走响应层。
 *
 * 上游自己也是这么干的：它在 apply() 里 server.removeAllListeners('request')
 * 后塞进自己的门禁监听器，再在放行回调里依次调用它"捕获"下来的原始监听器。
 * 这个实现细节正好给了我们一个确定性的插入点 —— 关键在于：
 *
 *   上游是在【它自己打补丁的那一刻】快照 server.listeners('request')。
 *   因此只要我们排在那份快照（或直接在 server 上）的第一位，
 *   就一定会先于 DSH 的路由分发器执行，从而在路由写出响应体之前装上包装。
 *
 * 两种时序都不会出错：
 *   A) 我们先排首位，上游后打补丁 → 我们进入它的 originalListeners 且排第一；
 *   B) 上游先打补丁，我们后重排 → 我们排在 server 的第一位，它排第二，
 *      而它的 originalListeners 里仍然有我们（会被调用第二次 → 用 req 标记去重）。
 *
 * 所以重复重排是安全且收敛的：最终状态永远是"我们第一"。
 * 唯一的副作用是 B) 情形下监听器可能被调用两次，故每个请求用 Symbol 做一次性标记。
 */

import { UPSTREAM_STATUS_PATH, transformUpstreamStatus } from './status.js';

/** 标记：该请求已经过本插件的监听器（防止重排导致的重复执行）。 */
export const ANYNET_HANDLED = Symbol.for('dsh-remote-anynet.req-handled');

/** 标记：本插件的请求监听器函数（便于识别/去重）。 */
export const ANYNET_LISTENER = Symbol.for('dsh-remote-anynet.listener');

/** 把 write/end 的入参统一转成 Buffer；无法识别时返回 null。 */
function toBuffer(chunk, encoding) {
	if (chunk === null || chunk === undefined) return null;
	if (Buffer.isBuffer(chunk)) return chunk;
	if (typeof chunk === 'string') {
		return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
	}
	if (chunk instanceof Uint8Array) return Buffer.from(chunk);
	return Buffer.from(String(chunk), 'utf8');
}

/**
 * 给一次响应装上"缓冲整个 body → 改写 → 一次性写出"的包装。
 *
 * 只应在明确知道目标路径时调用。任何异常都被吞掉并原样回退，
 * 保证最坏情况下表现为"没有本插件"，而不是"接口 500"。
 */
export function interceptResponseBody(res, transform, onError) {
	const chunks = [];
	const origWrite = res.write;
	const origEnd = res.end;
	const origWriteHead = res.writeHead;
	const origFlushHeaders = res.flushHeaders;
	let done = false;
	/** 是否已经 flushHeaders()（头已上线路，长度不可再变）。 */
	let flushed = false;
	/** writeHead 时捕获的 Content-Encoding，非 identity 时不做改写。 */
	let contentEncoding = '';

	/** 大小写无关地剔除 Content-Length；未出现则返回 null。 */
	function stripContentLength(headers) {
		if (!headers || typeof headers !== 'object') return null;
		const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-length');
		if (key === undefined) return null;
		const copy = { ...headers };
		delete copy[key];
		return copy;
	}

	/** 从 writeHead 入参里取 content-encoding（可能是 setHeader 也可能是参数）。 */
	function readContentEncoding(args) {
		try {
			const v = res.getHeader?.('content-encoding');
			if (typeof v === 'string' && v) return v;
		} catch {
			/* ignore */
		}
		// Content-Encoding 更常见于 writeHead(status, headers) 的参数对象
		for (const arg of args || []) {
			if (!arg || typeof arg !== 'object') continue;
			const key = Object.keys(arg).find((k) => k.toLowerCase() === 'content-encoding');
			if (key && typeof arg[key] === 'string' && arg[key]) return arg[key];
		}
		return '';
	}

	/*
	 * 关键修正：Node 的 writeHead() 会把头烘进内部 _header 并清空 kOutHeaders，
	 * 之后 getHeader() 恒返回 undefined、setHeader() 直接抛 ERR_HTTP_HEADERS_SENT。
	 * 也就是说"先 writeHead 再按实际字节改 Content-Length"在 Node 里根本做不到，
	 * 强行发出去的 body 会被按旧长度截断。
	 * 所以改为在 writeHead 被调用的那一刻就把 Content-Length 摘掉，
	 * 让响应退回 chunked —— 长度无论如何都对。只在确实存在该头时才动手，
	 * 因此绝大多数响应（本来就没设长度）完全不受影响。
	 */
	res.writeHead = function patchedWriteHead(statusCode, ...args) {
		if (done) return origWriteHead.apply(this, arguments);
		contentEncoding = readContentEncoding(args) || contentEncoding;
		try {
			this.removeHeader?.('Content-Length');
		} catch {
			/* ignore */
		}
		// writeHead(status, headers) / writeHead(status, statusMessage, headers)
		for (let i = 0; i < args.length; i += 1) {
			const stripped = stripContentLength(args[i]);
			if (stripped) args[i] = stripped;
		}
		return origWriteHead.apply(this, [statusCode, ...args]);
	};

	if (typeof origFlushHeaders === 'function') {
		res.flushHeaders = function patchedFlushHeaders(...args) {
			flushed = true;
			return origFlushHeaders.apply(this, args);
		};
	}

	res.write = function patchedWrite(chunk, encoding, callback) {
		if (done) return origWrite.apply(this, arguments);
		const buf = toBuffer(chunk, encoding);
		if (buf) chunks.push(buf);
		// 缓冲阶段视为"写成功"，无需背压处理
		if (typeof encoding === 'function') encoding();
		else if (typeof callback === 'function') callback();
		return true;
	};

	res.end = function patchedEnd(chunk, encoding, callback) {
		if (done) return origEnd.apply(this, arguments);
		done = true;
		// 先恢复原方法，避免后续任何路径再次进入包装
		res.write = origWrite;
		res.end = origEnd;
		res.writeHead = origWriteHead;
		if (typeof origFlushHeaders === 'function') res.flushHeaders = origFlushHeaders;

		let payload;
		try {
			const buf = toBuffer(chunk, encoding);
			if (buf) chunks.push(buf);
			payload = Buffer.concat(chunks);
		} catch (error) {
			onError?.(error);
			payload = Buffer.alloc(0);
		}

		let out = payload;
		try {
			const compressed = contentEncoding && contentEncoding !== 'identity';
			if (compressed) {
				// 响应已被压缩，按文本改写会损坏字节流：宁可不改
				onError?.(new Error(`响应为 ${contentEncoding} 编码，已跳过改写`));
			} else if (flushed) {
				// 头已上线路，body 长度无法再变；改写只会造成截断/错位
				onError?.(new Error('headers 已 flush，已跳过改写以避免响应损坏'));
			} else {
				const text = payload.toString('utf8');
				const result = transform(text);
				if (result && typeof result.body === 'string' && result.body !== text) {
					out = Buffer.from(result.body, 'utf8');
				}
			}
		} catch (error) {
			onError?.(error);
			out = payload;
		}

		const cb = typeof encoding === 'function' ? encoding : typeof callback === 'function' ? callback : undefined;
		return cb ? origEnd.call(this, out, cb) : origEnd.call(this, out);
	};
}

/**
 * 创建本插件的请求监听器。
 *
 * 它只做一件事：命中上游 status 路径时挂上响应体改写。其它请求一律直接返回，
 * 不做任何干预（认证、路由、静态资源全部交回给上游与 DSH）。
 *
 * @param {object} deps { configStore, logger, onUpstreamSeen }
 */
export function createAnyNetRequestListener({ configStore, logger, onUpstreamSeen }) {
	const listener = function anynetRequestListener(req, res) {
		try {
			if (!req || req[ANYNET_HANDLED]) return;
			Object.defineProperty(req, ANYNET_HANDLED, {
				value: true,
				configurable: true,
				enumerable: false,
				writable: false,
			});

			const opts = configStore.get();
			if (!opts.enabled) return;

			// 只关心 GET/HEAD 的 status；HEAD 无 body，跳过
			if (req.method !== 'GET') return;
			const pathname = String(req.url || '').split('?')[0];
			if (pathname !== UPSTREAM_STATUS_PATH) return;

			onUpstreamSeen?.();
			interceptResponseBody(
				res,
				(text) => transformUpstreamStatus(text, configStore.get()),
				(error) => logger?.debug?.(`[dsh-remote-anynet] status 改写失败（已原样返回）：${error?.message || error}`),
			);
		} catch (error) {
			// 监听器绝不能抛：抛出去会打断整个请求链路
			try {
				logger?.debug?.(`[dsh-remote-anynet] 请求监听器异常（已忽略）：${error?.message || error}`);
			} catch {
				/* ignore */
			}
		}
	};
	Object.defineProperty(listener, ANYNET_LISTENER, { value: true, enumerable: false });
	return listener;
}

/**
 * 把 handler 排到 server 的 'request' 监听器首位，其余监听器保持原有相对顺序。
 *
 * @returns {{ok: boolean, alreadyFirst: boolean, listeners: number, reason?: string}}
 */
export function installFirstRequestListener(server, handler) {
	if (!server || typeof server.on !== 'function' || typeof server.listeners !== 'function') {
		return { ok: false, alreadyFirst: false, listeners: 0, reason: 'no-server' };
	}
	let current;
	try {
		current = server.listeners('request');
	} catch (error) {
		return { ok: false, alreadyFirst: false, listeners: 0, reason: `listeners-failed: ${error?.message || error}` };
	}
	if (current.length && current[0] === handler) {
		return { ok: true, alreadyFirst: true, listeners: current.length };
	}
	const others = current.filter((l) => l !== handler);
	try {
		server.removeAllListeners('request');
		server.on('request', handler);
		for (const other of others) server.on('request', other);
	} catch (error) {
		// 极端情况下重排失败：把已摘掉的监听器尽量装回去，避免整个服务失去处理能力
		try {
			server.removeAllListeners('request');
			for (const other of others) server.on('request', other);
		} catch {
			/* ignore */
		}
		return { ok: false, alreadyFirst: false, listeners: 0, reason: `reorder-failed: ${error?.message || error}` };
	}
	return { ok: true, alreadyFirst: false, listeners: others.length + 1 };
}
