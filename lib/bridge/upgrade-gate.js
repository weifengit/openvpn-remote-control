/**
 * dsh-remote-anynet — WebSocket upgrade 层的门禁与上下文虚拟化
 *
 * 【为什么需要单独一层】
 * 主门禁挂在 http.Server 的 'request' 事件上，只处理普通 HTTP 请求。
 * 浏览器的实时通道（/api/remote.mux）走的是 'upgrade' 事件，两条路互不相干：
 * 页面能正常加载，但握手请求到达 dsh-client-connection 的 isTrusted() 时，
 * Host 仍是手机访问的外部地址（如 192.168.1.5），不在底座认可的
 * 「回环 / 绑定地址 / trustedHosts」之列，于是直接被判 403，前端表现就是
 * 永远停在「重新连接中」。
 *
 * 本模块把 request 层已经验证过的规则镜像到 upgrade 层：
 *   1. 先鉴权 —— 未授权的握手直接 401 并断开，不给下游任何机会；
 *   2. 再虚拟化 —— 已授权流量把 Host / Origin / sec-fetch-site 归一成回环特征，
 *      与 request 层完全一致，下游的 Host 栅栏因此放行；
 *   3. 回环 socket 不做改写 —— 保留浏览器原始同源信号，继续挡 drive-by 攻击。
 */

import { getClientIp, isLanIp, isOverlayIp, resolveOverlayCidrs } from '../auth/overlay.js';
import { isLoopbackRequest } from '../auth/gate.js';

/** 未授权握手的拒绝响应：WebSocket 客户端读到非 101 即会放弃并重试。 */
const UNAUTHORIZED_RESPONSE =
	'HTTP/1.1 401 Unauthorized\r\n' +
	'Content-Type: text/plain; charset=utf-8\r\n' +
	'Content-Length: 22\r\n' +
	'Connection: close\r\n' +
	'\r\n' +
	'Unauthorized (pair it)';

/**
 * 判定一次握手是否已获门禁授权。
 *
 * 与 request 层的 isRequestAuthorizedByGate 判据保持一致（回环 / 虚拟网免密 /
 * 局域网免密 / 有效会话 Token），但这里直接读 socket 上的未虚拟化来源地址，
 * 避免上下文虚拟化改写后的 127.0.0.1 把外部流量误判成本机。
 */
function isAuthorized(req, store) {
	if (isLoopbackRequest(req)) return true;
	const clientIp = getClientIp(req);
	const options = store.getOptions();
	if (options.allowOverlay && isOverlayIp(clientIp, resolveOverlayCidrs(options))) return true;
	if (options.allowLan && isLanIp(clientIp)) return true;
	const token = store.extractTokenFromRequest(req);
	return Boolean(token && store.validateToken(token, clientIp));
}

/** 把外部流量的握手请求归一成回环特征，与 request 层虚拟化规则一致。 */
function virtualizeHandshake(req) {
	const hostHeader = req.headers.host || '';
	const port = hostHeader.includes(':') ? hostHeader.split(':')[1] : '3080';
	req.headers.host = `127.0.0.1:${port}`;
	if (req.headers.origin) req.headers.origin = `http://127.0.0.1:${port}`;
	if (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'cross-site') {
		req.headers['sec-fetch-site'] = 'same-origin';
	}
	if (req.socket && req.socket.remoteAddress !== '127.0.0.1') {
		try {
			Object.defineProperty(req.socket, 'remoteAddress', {
				get: () => '127.0.0.1',
				configurable: true,
			});
		} catch {
			/* socket 可能已冻结 */
		}
	}
}

/**
 * 给 http.Server 的 upgrade 链路挂上门禁与虚拟化。
 *
 * 时机与 patchHttpServerWithVirtualizer 相同：必须在业务插件注册 upgrade
 * 监听器之后调用，这样复制下来的监听器列表才是完整的。
 *
 * @param {import('node:http').Server} server 底座的 http.Server
 * @param {{getOptions: Function, extractTokenFromRequest: Function, validateToken: Function}} store 会话管理器
 */
export function patchUpgradeWithGate(server, store) {
	if (!server || server.__dsh_upgrade_gate_patched__) return;
	server.__dsh_upgrade_gate_patched__ = true;

	const originalUpgradeListeners = server.listeners('upgrade').slice(0);
	server.removeAllListeners('upgrade');

	server.on('upgrade', (req, socket, head) => {
		// 记录未虚拟化的真实来源（与 request 层同一约定），供审计与门禁判定读取
		if (socket && !socket.__dsh_real_remote_address__) {
			socket.__dsh_real_remote_address__ = socket.remoteAddress;
		}

		let authorized = false;
		try {
			authorized = isAuthorized(req, store);
		} catch {
			authorized = false;
		}

		if (!authorized) {
			try {
				socket.write(UNAUTHORIZED_RESPONSE);
			} catch {
				/* 对端已断开 */
			}
			socket.destroy();
			return;
		}

		// 回环 socket 保留原始同源信号，只改外部来源（与 request 层一致）
		if (!isLoopbackRequest(req)) virtualizeHandshake(req);

		try {
			for (const listener of originalUpgradeListeners) listener.call(server, req, socket, head);
		} catch (error) {
			try {
				socket.destroy();
			} catch {
				/* 已断开 */
			}
			server.__dsh_upgrade_gate_error__ = error;
		}
	});
}
