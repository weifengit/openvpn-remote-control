#!/usr/bin/env node
/**
 * 从 dsh-remote-mobile 迁移到 dsh-remote-anynet
 *
 * 本插件已经把上游实现内联了进来，两个插件会注册同一批路由
 * （/api/remote-mobile/*），因此必须二选一。这个脚本负责把 profile 里
 * 的 dsh-remote-mobile 干净地移除，并确保 dsh-remote-anynet 已就位。
 *
 * 用法：
 *   node scripts/migrate-from-remote-mobile.mjs            # 预演，只打印将要做的改动
 *   node scripts/migrate-from-remote-mobile.mjs --apply    # 真正写入（会先备份）
 *
 * 注意：profile 的 package.json 一旦改动会触发 DSH 的热重载，而插件源码并不
 * 热重载，中间态会出现"路由没了、新插件还没生效"的空窗。请紧随其后重启
 * `dsh web`，两者一起完成。
 *
 * 幂等：重复执行不会有副作用；已迁移过会直接报告无需改动。
 */

import { copyFileSync, existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..');
const PLUGIN_NAME = 'dsh-remote-anynet';
const LEGACY_NAME = 'dsh-remote-mobile';

const apply = process.argv.includes('--apply');
const profileDir = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web');
const pkgPath = join(profileDir, 'package.json');

function die(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
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
	actions.push(`从 bundles 移除 "${LEGACY_NAME}"（第 ${legacyIdx} 项）`);
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
	console.log('✓ 已经是目标状态，无需改动。');
	process.exit(0);
}

console.log(apply ? '将要执行：' : '预演（未写入）——将要执行：');
for (const a of actions) console.log(`  • ${a}`);
console.log('');

if (!apply) {
	console.log('加 --apply 才会真正写入。');
	process.exit(0);
}

// 备份后原子写入
const backup = `${pkgPath}.bak-anynet-migrate-${Date.now()}`;
copyFileSync(pkgPath, backup);
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`已备份原配置 → ${backup}`);
console.log(`已写入 ${pkgPath}`);

try {
	if (linkState !== '已正确指向本插件') {
		if (existsSync(linkPath)) unlinkSync(linkPath);
		symlinkSync(PLUGIN_DIR, linkPath, 'dir');
	}
	console.log(`已建立软链 ${linkPath}`);
} catch (error) {
	console.error(`! 软链创建失败（可手动处理）：${error.message}`);
}

console.log('');
console.log('下一步（必须）：重启 DSH Web 让改动整体生效：');
console.log('  1) 结束当前 dsh web 进程');
console.log('  2) 重新执行 dsh web');
console.log('');
console.log('数据目录已自动从 ~/.dsh/remote-mobile 继承到 ~/.dsh/remote-anynet，');
console.log('已配对的手机会保留登录状态，无需重新扫码。');
