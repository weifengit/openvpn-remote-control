/**
 * dsh-remote-anynet — 配置持久化
 *
 * 配置来源有三层，后面的覆盖前面的：
 *   1. DEFAULTS            代码内置默认值
 *   2. 插件行 config         cordis.patch.yml / DSH 设置里的该插件行配置
 *   3. settings.json        本插件自有持久化文件（Web 引导页写入）
 *
 * 为什么不复用 DSH 的 settings 服务：上游 dsh-remote-mobile 的注释已说明
 * DSH 0.1.7+ 起 dsh-settings 改为 profile cordis.patch.yml 的 Config 表单模型，
 * 没有 register 可写 API；插件自持文件是当前版本下唯一稳定的可写通道。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ipv4ToInt, normalizeCidrList, normalizeIp, OVERLAY_PRESETS } from './nets.js';

/** 插件自有数据目录（与上游 dsh-remote-mobile 平级，互不干扰）。 */
export const DATA_DIR = join(homedir(), '.dsh', 'remote-anynet');
/** 持久化文件绝对路径。 */
export const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

/** 合法的 prefer 取值。 */
export const PREFER_VALUES = ['auto', 'custom', 'lan', 'public', ...OVERLAY_PRESETS.map((p) => p.id)];

/** 内置默认配置。 */
export const DEFAULTS = Object.freeze({
	/** 总开关：关闭后不介入任何请求，插件退化为只读探测。 */
	enabled: true,
	/** 播发哪个地址：auto / easytier / openvpn / ... / lan / custom / public。 */
	prefer: 'auto',
	/** 显式固定的对外地址（最高优先级），空串表示不固定。 */
	pinnedAddress: '',
	/** 自定义网段：参与候选打分，也可用 prefer='custom' 只认这些网段。 */
	customCidrs: [],
	/** 是否改写上游 /api/remote-mobile/status 的对外地址（修正二维码与链接）。 */
	rewriteStatus: true,
	/** 是否把上游没有覆盖到的隧道地址补进 status（供引导页展示全部候选）。 */
	exposeCandidates: true,
	/** 免密直连（可选，默认关闭）：对这些网段的来源 IP 直接放行。 */
	bypass: {
		enabled: false,
		/** 留空则使用所选/命中的虚拟网预设默认网段。 */
		cidrs: [],
		/** 免密放行时额外要求的共享口令；空串表示不校验（仅靠网段）。 */
		requireSecret: '',
	},
});

/** 深拷贝（仅处理本配置里的纯 JSON 结构）。 */
function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 把任意值收敛成布尔。 */
function toBool(value, fallback) {
	if (typeof value === 'boolean') return value;
	if (value === 'true' || value === 1) return true;
	if (value === 'false' || value === 0) return false;
	return fallback;
}

/**
 * 归一化一份（可能来自插件行配置或 settings.json 的）配置补丁。
 * 只接受已知字段，非法值回落，网段统一规范化 —— 避免脏数据写进文件。
 */
export function normalizePatch(patch, base = DEFAULTS) {
	const out = {};
	if (!patch || typeof patch !== 'object') return out;

	if ('enabled' in patch) out.enabled = toBool(patch.enabled, base.enabled);
	if ('rewriteStatus' in patch) out.rewriteStatus = toBool(patch.rewriteStatus, base.rewriteStatus);
	if ('exposeCandidates' in patch) out.exposeCandidates = toBool(patch.exposeCandidates, base.exposeCandidates);

	if ('prefer' in patch) {
		const prefer = typeof patch.prefer === 'string' ? patch.prefer.trim() : '';
		out.prefer = PREFER_VALUES.includes(prefer) ? prefer : 'auto';
	}

	if ('pinnedAddress' in patch) {
		const raw = typeof patch.pinnedAddress === 'string' ? patch.pinnedAddress.trim() : '';
		// 只接受合法 IPv4；其余一律归为“不固定”。
		// 使用时会再校验一次，但这里就挡住可以避免脏值落盘、也让 UI 状态自洽。
		out.pinnedAddress = raw && ipv4ToInt(raw) !== null ? normalizeIp(raw) : '';
	}

	if ('customCidrs' in patch) {
		out.customCidrs = normalizeCidrList(patch.customCidrs).ok;
	}

	if ('bypass' in patch && patch.bypass && typeof patch.bypass === 'object') {
		const b = patch.bypass;
		const bypass = {};
		if ('enabled' in b) bypass.enabled = toBool(b.enabled, false);
		if ('cidrs' in b) bypass.cidrs = normalizeCidrList(b.cidrs).ok;
		if ('requireSecret' in b) {
			bypass.requireSecret = typeof b.requireSecret === 'string' ? b.requireSecret : '';
		}
		if (Object.keys(bypass).length) out.bypass = bypass;
	}

	return out;
}

/**
 * 配置仓库。线程内单例使用，写盘走「临时文件 + rename」保证原子性，
 * 并且对高频写入做 300ms 防抖。
 */
export class ConfigStore {
	/**
	 * @param {object} pluginConfig 插件行 config（cordis.patch.yml 中的 config:）
	 * @param {object} [options] { file, logger }
	 */
	constructor(pluginConfig = {}, options = {}) {
		this.file = options.file || SETTINGS_FILE;
		this.logger = options.logger || null;
		this.options = clone(DEFAULTS);
		this.loadErrors = [];
		this._timer = null;

		// 第 2 层：插件行配置
		this._apply(normalizePatch(pluginConfig, this.options));
		// 第 3 层：自有持久化文件
		this._loadFile();
	}

	_apply(patch) {
		for (const [key, value] of Object.entries(patch)) {
			if (key === 'bypass') {
				this.options.bypass = { ...this.options.bypass, ...value };
			} else {
				this.options[key] = value;
			}
		}
	}

	_loadFile() {
		try {
			if (!existsSync(this.file)) return;
			const text = readFileSync(this.file, 'utf8');
			if (!text.trim()) return;
			const data = JSON.parse(text);
			this._apply(normalizePatch(data, this.options));
		} catch (error) {
			// 损坏的配置文件不能让插件起不来：记录后按默认值继续
			this.loadErrors.push(String(error && error.message ? error.message : error));
			this.logger?.warn?.(`[dsh-remote-anynet] 读取 ${this.file} 失败，已回落默认配置：${this.loadErrors.at(-1)}`);
		}
	}

	/** 读取当前配置（返回副本，避免调用方误改内部状态）。 */
	get() {
		return clone(this.options);
	}

	/**
	 * 合并写入一份配置补丁。
	 * @returns {{options: object, changed: string[]}}
	 */
	update(patch) {
		const normalized = normalizePatch(patch, this.options);
		const changed = [];
		for (const [key, value] of Object.entries(normalized)) {
			const before = JSON.stringify(this.options[key]);
			const after = JSON.stringify(key === 'bypass' ? { ...this.options.bypass, ...value } : value);
			if (before === after) continue;
			changed.push(key);
			if (key === 'bypass') this.options.bypass = { ...this.options.bypass, ...value };
			else this.options[key] = value;
		}
		if (changed.length) this.saveDebounced();
		return { options: this.get(), changed };
	}

	/** 重置为内置默认值。 */
	reset() {
		this.options = clone(DEFAULTS);
		this.saveDebounced();
		return this.get();
	}

	/** 立即落盘（原子写）。 */
	save() {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.tmp-${process.pid}`;
			writeFileSync(tmp, `${JSON.stringify(this.options, null, 2)}\n`, 'utf8');
			renameSync(tmp, this.file);
			return true;
		} catch (error) {
			this.logger?.warn?.(`[dsh-remote-anynet] 写入 ${this.file} 失败：${error?.message || error}`);
			return false;
		}
	}

	/** 防抖落盘。 */
	saveDebounced() {
		if (this._timer) clearTimeout(this._timer);
		this._timer = setTimeout(() => {
			this._timer = null;
			this.save();
		}, 300);
		if (typeof this._timer.unref === 'function') this._timer.unref();
	}
}
