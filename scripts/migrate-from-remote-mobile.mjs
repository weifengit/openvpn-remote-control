#!/usr/bin/env node
/**
 * 从 dsh-remote-mobile 迁移到 dsh-remote-anynet
 *
 * 本插件已经把上游实现内联了进来，两个插件会注册同一批路由
 * （/api/remote-mobile/*），因此必须二选一。这个脚本负责把 profile 里的
 * dsh-remote-mobile 干净地移除，并确保 dsh-remote-anynet 已就位。
 *
 * 用法：
 *   node scripts/migrate-from-remote-mobile.mjs                  # 预演，只打印将要做的改动
 *   node scripts/migrate-from-remote-mobile.mjs --apply           # 只写入配置（需你手动重启）
 *   node scripts/migrate-from-remote-mobile.mjs --apply --restart # 写入配置并自动重启 dsh web
 *
 * 为什么推荐 --restart：
 *   profile 的 package.json 一旦改动会触发 DSH 热重载，而插件源码并不热重载。
 *   于是"只改配置、稍后手动重启"中间会有一段窗口期：旧插件已被卸载、新插件
 *   还没真正加载，远程接入相关路由会短暂缺失。--restart 会在写入配置后
 *   自动结束旧的 dsh web 进程并拉起一个新的，把窗口期压到几秒。
 *
 * 幂等：重复执行不会有副作用；已迁移过会直接报告无需改动。
 */

import { copyFileSync, existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..');
const PLUGIN_NAME = 'dsh-remote-anynet';
const LEGACY_NAME = 'dsh-remote-mobile';

const apply = process.argv.includes('--apply');
const restart = process.argv.includes('--restart');
const profileDir = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web');
const pkgPath = join(profileDir, 'package.json');

function die(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}

/** 单引号包裹，供 sh -c 安全使用。 */
function shq(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 找出正在运行的 `dsh web` 进程。
 * 返回 { pid, command, cwd } 或 null。刻意排除本脚本自身。
 */
function findRunningDshWeb() {
	let out;
	try {
		out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 4000 });
	} catch {
		return null;
	}
	const self = process.pid;
	for (const line of out.split('\n')) {
		const m = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const pid = Number(m[1]);
		const command = m[2];
		if (pid === self) continue;
		if (!/\bdsh\b/.test(command)) continue;
		if (!/\bweb\b/.test(command)) continue;
		if (command.includes('migrate-from-remote-mobile')) continue;
		if (command.includes('--dump-config')) continue;

		let cwd = null;
		try {
			// lsof -a -d cwd -Fn 输出形如 "p123\nn/Users/xxx"
			const lsof = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
				encoding: 'utf8',
				timeout: 4000,
				stdio: ['ignore', 'pipe', 'ignore'],
			});
			const cwdLine = lsof.split('\n').find((l) => l.startsWith('n'));
			if (cwdLine) cwd = cwdLine.slice(1).trim();
		} catch {
			cwd = null;
		}
		return { pid, command, cwd: cwd || process.cwd() };
	}
	return null;
}

if (!existsSync(pkgPath)) die(`找不到 profile：${pkgPath}`);

const raw = readFileSync(pkgPath, 'utf8');
let pkg;
try {
	pkg = JSON.parse(raw);
} catch (error) {
	die(`profile package.json 不是合法 JSON：${error.message}`);
}

const deps = pkg.dependencies || (pkg.dependencies = {});
const bundles = pkg.dsh?.profile?.bundles || null;
if (!Array.isArray(bundles)) die('profile package.json 缺少 dsh.profile.bundles');

const actions = [];

// 1) 依赖：确保本插件在，移除上游
const wantDep = `link:${PLUGIN_DIR}`;
if (deps[PLUGIN_NAME] !== wantDep) {
	actions.push(`dependencies["${PLUGIN_NAME}"] = "${wantDep}"`);
	deps[PLUGIN_NAME] = wantDep;
}
if (LEGACY_NAME in deps) {
	actions.push(`删除 dependencies["${LEGACY_NAME}"]（原值 ${deps[LEGACY_NAME]}）`);
	delete deps[LEGACY_NAME];
}

// 2) bundles：确保本插件在且唯一，移除上游
const legacyIdx = bundles.indexOf(LEGACY_NAME);
if (legacyIdx !== -1) {
	actions.push(`从 bundles 移除 "${LEGACY_NAME}"（原位置索引 ${legacyIdx}）`);
	bundles.splice(legacyIdx, 1);
}
const dupIdx = bundles.map((b, i) => (b === PLUGIN_NAME ? i : -1)).filter((i) => i !== -1);
if (dupIdx.length > 1) {
	actions.push(`bundles 里 "${PLUGIN_NAME}" 重复 ${dupIdx.length} 次，去重`);
	for (let i = dupIdx.length - 1; i > 0; i -= 1) bundles.splice(dupIdx[i], 1);
}
if (!bundles.includes(PLUGIN_NAME)) {
	actions.push(`把 "${PLUGIN_NAME}" 追加到 bundles 末尾`);
	bundles.push(PLUGIN_NAME);
}

// 3) node_modules 软链
const linkPath = join(profileDir, 'node_modules', PLUGIN_NAME);
let linkState = '不存在';
try {
	const target = readlinkSync(linkPath);
	linkState = target === PLUGIN_DIR ? '已正确指向本插件' : `指向 ${target}（需修正）`;
} catch {
	linkState = '不存在';
}
if (linkState !== '已正确指向本插件') {
	actions.push(`建立软链 node_modules/${PLUGIN_NAME} → ${PLUGIN_DIR}`);
}

console.log(`profile: ${profileDir}`);
console.log(`插件:    ${PLUGIN_DIR}`);
console.log(`软链:    ${linkState}`);
console.log('');

if (!actions.length) {
	console.log('✓ 配置已是目标状态，无需改动。');
} else {
	console.log(apply ? '将要执行：' : '预演（未写入）——将要执行：');
	for (const a of actions) console.log(`  • ${a}`);
	console.log('');
}

if (!apply) {
	if (actions.length) console.log('加 --apply 才会真正写入；加 --restart 可连带自动重启。');
	process.exit(0);
}

if (actions.length) {
	const backup = `${pkgPath}.bak-anynet-migrate-${Date.now()}`;
	copyFileSync(pkgPath, backup);
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
	console.log(`已备份原配置 → ${backup}`);
	console.log(`已写入 ${pkgPath}`);
}

try {
	if (linkState !== '已正确指向本插件') {
		if (existsSync(linkPath)) unlinkSync(linkPath);
		symlinkSync(PLUGIN_DIR, linkPath, 'dir');
		console.log(`已建立软链 ${linkPath}`);
	}
} catch (error) {
	console.error(`! 软链创建失败（可手动处理）：${error.message}`);
}

console.log('');
console.log('数据目录已自动从 ~/.dsh/remote-mobile 继承到 ~/.dsh/remote-anynet，');
console.log('已配对的手机会保留登录状态，无需重新扫码。');
console.log('');

if (!restart) {
	console.log('下一步：重启 DSH Web 让改动整体生效');
	console.log('  1) 结束当前 dsh web 进程');
	console.log('  2) 重新执行 dsh web');
	process.exit(0);
}

/* ---------------- 自动重启 ---------------- */

const target = findRunningDshWeb();
if (!target) {
	console.log('! 没有找到正在运行的 `dsh web` 进程，跳过自动重启。');
	console.log('  请手动执行 dsh web。');
	process.exit(0);
}

console.log(`检测到 dsh web：pid=${target.pid}`);
console.log(`  工作目录：${target.cwd}`);
console.log(`  启动命令：${target.command}`);
console.log('');
console.log('将在 3 秒后结束旧进程并拉起新的 dsh web。');
console.log(`新进程日志：/tmp/dsh-web-restart.log`);
console.log('');

// 分离的守护脚本：先给当前脚本/界面一点时间收尾，再优雅结束旧进程并拉起新的。
// 用 -TERM 让 DSH 有机会正常收尾；等到端口释放后再启动，避免 EADDRINUSE。
const script = [
	'sleep 3',
	`kill -TERM ${target.pid} 2>/dev/null`,
	// 最多等 15 秒，直到旧进程真的退出
	`for i in $(seq 1 30); do kill -0 ${target.pid} 2>/dev/null || break; sleep 0.5; done`,
	`kill -0 ${target.pid} 2>/dev/null && kill -KILL ${target.pid} 2>/dev/null`,
	'sleep 1',
	`cd ${shq(target.cwd)}`,
	// 自动重启时补上 --no-open：页面本来就已经开着，不必凭空再开一个标签页
	`nohup ${target.command}${/--no-open/.test(target.command) ? '' : ' --no-open'} >/tmp/dsh-web-restart.log 2>&1 &`,
].join('; ');

const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
child.unref();

console.log('已安排自动重启。当前这个页面会断开几秒，稍等后刷新即可。');
