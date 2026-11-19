/**
 * dsh-remote-anynet — 额外监听面（局域网 / 虚拟网）
 *
 * 【为什么需要这个模块】
 * 新版 @deepseek-ai/dsh-host-webserver 拒绝绑定通配地址 0.0.0.0（会直接把
 * RCE 暴露到整个网络），所以 profile 只能把 host 设成 127.0.0.1。代价是：
 * 手机无论走同一个 Wi-Fi 还是 EasyTier/OpenVPN，都连不进这个端口 —— 表现
 * 就是"扫码没反应 / 一直重新连接中"。
 *
 * 本模块在【不改变宿主配置】的前提下补一层监听：宿主仍只绑定回环，这里为
 * 本机每个非回环 IPv4（局域网网卡、utun/tun 隧道网卡）各开一个监听，收到
 * 连接后直接把 socket 交给宿主的 http.Server。
 *
 * 【为什么不是 TCP 反向代理】
 * 反代会让宿主看到的来源地址变成 127.0.0.1，门禁会把它当成"本机请求"无条件
 * 放行 —— 等于把鉴权整条拆掉。直接把 socket 交给 http.Server，remoteAddress
 * 保持真实来源，门禁与审计照常生效。
 */

import net from 'node:net';
import { networkInterfaces } from 'node:os';

import { isLoopbackIp, normalizeIp } from './nets.js';

/** 隧道网卡随时可能起来或断开（EasyTier 重连、OpenVPN 掉线），定期重扫。 */
const DEFAULT_RESCAN_INTERVAL_MS = 10_000;

/** 宿主 webServer 完成 listen 之前，附注监听没有意义，先等它就绪。 */
const SERVER_WAIT_INTERVAL_MS = 250;

/** 等待宿主监听的硬性上限，避免无限轮询。 */
const SERVER_WAIT_TIMEOUT_MS = 30_000;

function isIpv4Family(family) {
	return family === 'IPv4' || family === 4;
}

/** 通配地址（0.0.0.0 / :: / ::0.0.0.0）——此时宿主已监听所有接口。 */
function isWildcardAddress(address) {
	if (typeof address !== 'string') return false;
	const text = address.trim().toLowerCase();
	return text === '0.0.0.0' || text === '::' || text === '::0.0.0.0';
}

/**
 * 列出应当额外监听的地址。
 *
 * 只取非内部、非回环的 IPv4：局域网网卡与 utun/tun 隧道网卡都在此列。
 * `exclude` 用来排除宿主已经绑定的地址，避免同一地址二次监听报 EADDRINUSE。
 *
 * @param {string[]} exclude 不参与监听的地址（宿主已绑定的地址）
 * @param {object} [interfaces] 网卡快照，供测试注入
 * @returns {Array<{address: string, name: string}>}
 */
export function listListenableAddresses(exclude = [], interfaces = networkInterfaces()) {
	const skip = new Set((exclude || []).map((ip) => normalizeIp(ip)).filter(Boolean));
	const out = [];
	const seen = new Set();

	for (const name of Object.keys(interfaces || {})) {
		for (const info of interfaces?.[name] || []) {
			if (!info || !isIpv4Family(info.family)) continue;
			if (info.internal) continue;
			const address = normalizeIp(info.address);
			if (!address || isLoopbackIp(address)) continue;
			if (skip.has(address) || seen.has(address)) continue;
			seen.add(address);
			out.push({ address, name });
		}
	}

	return out;
}

/**
 * 创建额外监听管理器。
 *
 * 生命周期：`start()` → 等宿主 webServer listen → 首次扫描并绑定 → 定时重扫。
 * `stop()` 关闭本模块开的监听；已经交出去的 socket 归宿主 http.Server 管，
 * 宿主关闭时会一并断开。
 *
 * @param {object} options
 * @param {() => import('node:http').Server | undefined} options.getServer 取宿主 http.Server
 * @param {() => boolean} [options.isEnabled] 运行期开关（关掉即撤掉全部额外监听）
 * @param {{info?: Function, warn?: Function, debug?: Function}} [options.logger]
 * @param {number} [options.rescanIntervalMs]
 * @param {object} [options.interfaces] 网卡快照来源，供测试注入
 * @returns {{start: Function, stop: Function, getState: Function, rescan: Function}}
 */
export function createLanListeners(options = {}) {
	const {
		getServer,
		isEnabled = () => true,
		logger,
		rescanIntervalMs = DEFAULT_RESCAN_INTERVAL_MS,
		interfaces,
	} = options;

	/** address → { server, name, since } */
	const bound = new Map();
	/** address → 最近一次失败的错误码，避免同一错误刷屏 */
	const failures = new Map();
	let rescanTimer = null;
	let waitTimer = null;
	let waitStartedAt = 0;
	let disposed = false;
	let currentPort = 0;

	const log = (level, message) => {
		try {
			logger?.[level]?.(message);
		} catch {
			/* 日志失败不得影响监听 */
		}
	};

	const snapshotInterfaces = () => {
		if (typeof interfaces === 'function') return interfaces();
		if (interfaces) return interfaces;
		try {
			return networkInterfaces();
		} catch {
			return {};
		}
	};

	/** 关闭一个额外监听；已交出的 socket 不在这里处理。 */
	const closeListener = (address) => {
		const entry = bound.get(address);
		if (!entry) return;
		bound.delete(address);
		try {
			entry.server.close();
		} catch {
			/* 已关闭 */
		}
		log('info', `[dsh-remote-anynet] 已撤下监听 http://${address}:${currentPort}（${entry.name} 不再存在）`);
	};

	const closeAll = () => {
		for (const address of Array.from(bound.keys())) closeListener(address);
	};

	const bindAddress = (main, port, { address, name }) => {
		const extra = net.createServer({ pauseOnConnect: false, exclusive: true }, (socket) => {
			if (disposed) {
				socket.destroy();
				return;
			}
			// 直接把 socket 交给宿主 http.Server：remoteAddress 保持真实来源，
			// 门禁、审计与上下文虚拟化全都按外部流量处理。
			try {
				main.emit('connection', socket);
			} catch (error) {
				try {
					socket.destroy();
				} catch {
					/* 已断开 */
				}
				log('debug', `[dsh-remote-anynet] 交接 socket（${address}）失败: ${error?.message || error}`);
			}
		});

		extra.on('error', (error) => {
			const code = error?.code || 'ERROR';
			if (!bound.has(address) && failures.get(address) !== code) {
				failures.set(address, code);
				log('debug', `[dsh-remote-anynet] 追加监听 ${address}:${port} 失败（${code}），网卡变化后会重试`);
			}
			if (!bound.has(address)) {
				try {
					extra.close();
				} catch {
					/* 未进入监听 */
				}
			}
		});

		extra.listen({ port, host: address, exclusive: true }, () => {
			if (disposed) {
				try {
					extra.close();
				} catch {
					/* 已关闭 */
				}
				return;
			}
			failures.delete(address);
			bound.set(address, { server: extra, name, since: Date.now() });
			log('info', `[dsh-remote-anynet] 已追加监听 http://${address}:${port}（${name}），手机可从这里接入`);
		});
	};

	/** 扫描一次：该开的开、该关的关。 */
	const rescan = () => {
		if (disposed) return;
		const main = getServer?.();
		if (!main || !main.listening) return;
		if (!isEnabled()) {
			closeAll();
			return;
		}

		let info;
		try {
			info = main.address();
		} catch {
			return;
		}
		if (!info || typeof info !== 'object') return;
		// 宿主若已绑通配地址（非常规，但测试/自定义部署会出现），全接口本就可达，
		// 再补监听只会白白占端口并让事件循环多出一堆句柄。
		if (isWildcardAddress(info.address)) {
			closeAll();
			currentPort = info.port;
			return;
		}
		if (info.port !== currentPort) {
			// 宿主换了端口（或首次就绪），旧端口上的监听必须全部重建
			closeAll();
			currentPort = info.port;
		}

		const desired = listListenableAddresses([info.address], snapshotInterfaces());
		const wanted = new Set(desired.map((item) => item.address));

		for (const address of Array.from(bound.keys())) {
			if (!wanted.has(address)) closeListener(address);
		}
		for (const item of desired) {
			if (bound.has(item.address)) continue;
			if (failures.get(item.address) === 'EADDRINUSE') continue;
			bindAddress(main, info.port, item);
		}
	};

	const startRescan = () => {
		if (rescanTimer || disposed) return;
		rescanTimer = setInterval(rescan, rescanIntervalMs);
		if (typeof rescanTimer.unref === 'function') rescanTimer.unref();
		rescan();
	};

	/** 宿主 webServer 是异步 listen 的，等它就绪再开始扫描。 */
	const waitForServer = () => {
		if (disposed) return;
		const main = getServer?.();
		if (main?.listening) {
			startRescan();
			return;
		}
		if (Date.now() - waitStartedAt > SERVER_WAIT_TIMEOUT_MS) {
			log('debug', '[dsh-remote-anynet] 等待宿主 webServer 监听超时，放弃追加监听（本机回环入口不受影响）');
			return;
		}
		waitTimer = setTimeout(waitForServer, SERVER_WAIT_INTERVAL_MS);
		if (typeof waitTimer.unref === 'function') waitTimer.unref();
	};

	return {
		start() {
			if (disposed || waitStartedAt) return;
			waitStartedAt = Date.now();
			waitForServer();
		},
		stop() {
			disposed = true;
			if (waitTimer) clearTimeout(waitTimer);
			if (rescanTimer) clearInterval(rescanTimer);
			waitTimer = null;
			rescanTimer = null;
			closeAll();
		},
		rescan,
		getState() {
			return {
				enabled: Boolean(isEnabled()),
				port: currentPort,
				listeners: Array.from(bound.entries()).map(([address, entry]) => ({
					address,
					name: entry.name,
					since: entry.since,
				})),
				failures: Array.from(failures.entries()).map(([address, code]) => ({ address, code })),
			};
		},
	};
}
