/**
 * dsh-remote-anynet — 让 EasyTier / OpenVPN 打通后的异地网络也能被正确远程访问
 *
 * 【要解决的问题】
 * 上游 dsh-remote-mobile 把"对外可达地址"写死成两种假设：局域网(RFC1918，优先 en0)
 * 或 Tailscale(100.64/10)。用 EasyTier / OpenVPN / ZeroTier / WireGuard 组网时，
 * 它算出来的播发地址仍然是 en0 上的那个私有地址，于是二维码/复制链接指向
 * "只有同一个 Wi-Fi 才连得上"的地址——这就是"打通了网络却访问不了"的根因。
 *
 * 【本插件的做法】
 * 1. 通用探测：按网卡名 + 网段 + 对端提示识别隧道网卡，支持 EasyTier/OpenVPN/
 *    ZeroTier/WireGuard/NetBird/Tailscale 与自定义网段；
 * 2. 修正播发：在上游 /api/remote-mobile/status 的响应体里把 lanIp 换成真正可达的
 *    地址。上游客户端正是用它拼二维码与链接，所以改这一个字段即可让整套 UI 正确，
 *    上游代码零改动、node_modules 零改动；
 * 3. 可视化：提供 /remote-anynet 引导页，列出全部候选地址并支持一键固定。
 *
 * 【不做什么】
 * 不重复实现上游的认证门禁、不改动上游任何文件、不新增未认证的对外入口。
 */

import { ConfigStore } from './config.js';
import { createAnyNetRequestListener, installFirstRequestListener } from './rewrite.js';
import { createRoutes } from './routes.js';
import { buildAnyNetStatus } from './status.js';

/** Cordis 插件名称标识（需与 package.json 的 name 一致）。 */
export const name = 'dsh-remote-anynet';

/** 声明注入底座内置的 webServer 服务，apply 时 ctx.webServer 可用。 */
export const inject = ['webServer'];

/** 插件版本（与 package.json 的 version 保持同步）。 */
export const VERSION = '0.1.0';

/**
 * 监听器就位重试时间表（毫秒）。
 *
 * 为什么要重试：上游 dsh-remote-mobile 会在它自己的 apply() 或就绪横幅里
 * 调用 server.removeAllListeners('request') 重排一次监听器（内部有
 * __dsh_tailscale_gate_patched__ 幂等守卫，只执行一次）。它执行的那一刻会把
 * 当时存在的监听器"快照"进 originalListeners。我们在多个时间点重新排到首位，
 * 就能保证无论它何时执行，最终状态都是"本插件第一"。
 * 每次重排都只是判断首位 + 必要时重排，非常廉价。
 */
const INSTALL_RETRY_MS = [0, 120, 320, 700, 1200, 1800, 2600, 3600, 5000, 7000];

/**
 * 插件生命周期挂载入口。
 *
 * @param ctx Cordis 应用上下文
 * @param config 插件行 config（cordis.patch.yml / DSH 设置里该行）
 */
export function apply(ctx, config = {}) {
	const logger = ctx?.logger;
	const configStore = new ConfigStore(config, { logger });

	/** 运行期统计（用于状态接口与横幅）。 */
	const runtime = {
		upstreamDetected: false,
		rewriteCount: 0,
		installed: false,
		installAttempts: 0,
		lastReason: '',
	};
	const stateFn = () => ({
		upstreamDetected: runtime.upstreamDetected,
		rewriteCount: runtime.rewriteCount,
		version: VERSION,
	});

	/* ---------------------------------------------------------------- *
	 * 1. 请求监听器：排到首位，改写上游 status
	 * ---------------------------------------------------------------- */

	const listener = createAnyNetRequestListener({
		configStore,
		logger,
		onUpstreamSeen: () => {
			runtime.upstreamDetected = true;
			runtime.rewriteCount += 1;
		},
	});

	const getServer = () => {
		try {
			const webServer = (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined) || ctx?.webServer;
			return webServer?.server || null;
		} catch {
			return null;
		}
	};

	const ensureInstalled = (why) => {
		const server = getServer();
		if (!server) {
			runtime.lastReason = 'webServer.server 尚未就绪';
			return false;
		}
		runtime.installAttempts += 1;
		const result = installFirstRequestListener(server, listener);
		runtime.lastReason = result.reason || (result.alreadyFirst ? '已在首位' : '已重排至首位');
		if (result.ok && !result.alreadyFirst) {
			runtime.installed = true;
			logger?.info?.(`[dsh-remote-anynet] 请求监听器已排到首位（${why}），同级监听器 ${result.listeners} 个`);
		} else if (result.ok) {
			runtime.installed = true;
		} else {
			logger?.warn?.(`[dsh-remote-anynet] 监听器就位失败（${why}）：${result.reason}`);
		}
		return result.ok;
	};

	const timers = [];
	let disposed = false;
	const onDispose = () => {
		disposed = true;
		for (const t of timers) clearTimeout(t);
		timers.length = 0;
	};
	try {
		ctx?.on?.('dispose', onDispose);
	} catch {
		/* 没有 dispose 事件也不影响主流程 */
	}

	for (const delay of INSTALL_RETRY_MS) {
		const timer = setTimeout(() => {
			if (disposed) return;
			ensureInstalled(`retry+${delay}ms`);
		}, delay);
		if (typeof timer.unref === 'function') timer.unref();
		timers.push(timer);
	}

	// 立即尝试一次，覆盖 webServer 已就绪的常见情形
	ensureInstalled('apply');

	/* ---------------------------------------------------------------- *
	 * 2. 注册本插件自己的接口与引导页
	 * ---------------------------------------------------------------- */

	try {
		const webServer = (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined) || ctx?.webServer;
		if (webServer && typeof webServer.register === 'function') {
			for (const route of createRoutes({ configStore, state: stateFn })) {
				webServer.register(route);
			}
		} else {
			logger?.debug?.('[dsh-remote-anynet] webServer.register 不可用，跳过接口注册');
		}
	} catch (error) {
		// 路由注册失败不应拖垮插件：核心的地址改写不依赖它
		logger?.warn?.(`[dsh-remote-anynet] 注册路由失败（引导页将不可用）：${error?.message || error}`);
	}

	/* ---------------------------------------------------------------- *
	 * 3. 启动横幅：一次性提示"该用哪个地址"
	 * ---------------------------------------------------------------- */

	const printBanner = () => {
		if (disposed) return;
		try {
			// 横幅打印前再确保一次，此时上游的就绪横幅通常已经执行完毕
			ensureInstalled('banner');
			const webServer = (typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined) || ctx?.webServer;
			const port = webServer?.port ?? 3080;
			// 绑定诊断：只有监听 0.0.0.0 时异地设备才连得进来。
			// 这里刻意不改 webserver 配置（那是 profile 层的职责，重复覆盖会清掉该行其它键），
			// 只做检测并给出可执行的提示。
			let bindNote = '';
			try {
				const bound = webServer?.server?.address?.();
				if (bound && typeof bound === 'object') {
					const host = bound.address || '';
					const allInterfaces = host === '0.0.0.0' || host === '::' || host === '';
					if (!allInterfaces) {
						bindNote = `当前仅监听 ${host}，异地设备无法连接；请把 webserver.host 设为 0.0.0.0（或安装 dsh-lan-access）`;
					}
				}
			}
			catch {
				/* 拿不到绑定信息就不提示 */
			}
			const opts = configStore.get();
			const status = buildAnyNetStatus(opts, stateFn());
			const hit = status.candidates.filter((c) => c.eligible).slice(0, 5);
			const divider = '─'.repeat(72);

			console.log(`\n┌${divider}`);
			console.log('│ [dsh-remote-anynet] 异地虚拟网接入地址修正已就绪');
			if (status.address) {
				const tag = status.via === 'pinned' ? '已固定' : status.via;
				console.log(`│   • 对外播发地址: http://${status.address}:${port}   (${tag})`);
				console.log(`│     判定依据: ${status.reason}`);
				if (bindNote) console.log(`│   ⚠ ${bindNote}`);
			} else {
				console.log('│   • 未找到可用的对外地址，请检查网卡或固定一个地址');
			}
			if (hit.length) {
				console.log('│   • 本机候选地址:');
				for (const c of hit) {
					const mark = c.selected ? '*' : ' ';
					const presets = c.presets.length ? ` [${c.presets.join(',')}]` : '';
					console.log(`│     ${mark} ${c.address.padEnd(15)} ${c.name}${presets}`);
				}
			}
			console.log('│   • 上游 dsh-remote-mobile 的二维码/链接已指向上面的地址');
			console.log(`│   • 地址选择与说明: http://127.0.0.1:${port}/remote-anynet`);
			console.log('└' + divider + '\n');

			logger?.info?.(
				`[dsh-remote-anynet] 播发地址 ${status.address || '(none)'}（${status.via}），` +
					`候选 ${status.candidates.length} 个，改写 ${runtime.rewriteCount} 次`,
			);
		} catch (error) {
			logger?.debug?.(`[dsh-remote-anynet] 横幅输出失败：${error?.message || error}`);
		}
	};

	// 尽量排在上游的提示横幅之后：上游用 loader.await() + 120ms 或者 1500ms 兜底
	try {
		const loader = typeof ctx?.get === 'function' ? ctx.get('loader') : undefined;
		const settled = loader?.await?.();
		if (settled && typeof settled.then === 'function') {
			settled
				.then(() => {
					const t = setTimeout(printBanner, 400);
					if (typeof t.unref === 'function') t.unref();
					timers.push(t);
				})
				.catch(() => {
					const t = setTimeout(printBanner, 2100);
					if (typeof t.unref === 'function') t.unref();
					timers.push(t);
				});
		}
	} catch {
		/* 无 loader 环境走下面的兜底 */
	}
	const bannerTimer = setTimeout(printBanner, 2100);
	if (typeof bannerTimer.unref === 'function') bannerTimer.unref();
	timers.push(bannerTimer);
}

export { buildAnyNetStatus, ConfigStore, installFirstRequestListener, createAnyNetRequestListener };
export * from './nets.js';
export * from './status.js';
export * from './config.js';
export * from './rewrite.js';
export * from './routes.js';
