/**
 * 登录页回跳地址（redirect）构造与安全收窄测试
 *
 * 场景来自真实反馈：手机/异地设备从 `/api/intel/site/console/` 进来，
 * 未配对时被门禁 302 到 `/auth`。原来这次跳转**不带原始路径**，登录页
 * 只能默认跳回站点根 `/`，于是配对成功后落到 DSH 首页而不是控制台，
 * 用户看到的画面就是「授权成功 → 刷新 → 回到首页」，误以为没登录进去。
 *
 * 这里锁两件事：
 *   1. 原始路径要被带进 `?redirect=`，登录后能回到原页面；
 *   2. 该参数同时是开放重定向的攻击面，必须只接受站内路径。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveLoginPath, sanitizeRedirectTarget } from '../lib/auth/prefix.js';

test('子路径被拦时，redirect 携带原始路径（控制台场景）', () => {
	const location = resolveLoginPath({}, '/api/intel/site/console/', '/auth');
	assert.equal(location, '/auth?redirect=%2Fapi%2Fintel%2Fsite%2Fconsole%2F');
});

test('根路径被拦时，redirect 是 /，登录后仍回站点根', () => {
	assert.equal(resolveLoginPath({}, '/', '/auth'), '/auth?redirect=%2F');
});

test('带查询串的原始地址要完整保留（编码后不丢参数）', () => {
	const location = resolveLoginPath({}, '/api/intel/site/console/?date=2026-11-03', '/auth');
	assert.equal(location, '/auth?redirect=%2Fapi%2Fintel%2Fsite%2Fconsole%2F%3Fdate%3D2026-11-03');
});

test('网关前缀要拼在登录页路径上，而不是拼在 redirect 值里', () => {
	assert.equal(
		resolveLoginPath({ 'x-forwarded-prefix': '/gw' }, '/list', '/auth'),
		'/gw/auth?redirect=%2Flist',
	);
});

test('开放重定向一律拒绝：协议相对、绝对地址、协议、反斜杠、控制字符', () => {
	const cases = ['//evil.com', '//evil.com/x', 'https://evil.com', 'http:evil.com', '/\\evil.com', '/a\nb', '/a\rb', '/a\x00b'];
	for (const raw of cases) {
		assert.equal(sanitizeRedirectTarget(raw), '', `${JSON.stringify(raw)} 不应被接受`);
	}
	// 被拒时登录地址退化成不带参数的形式，登录页按默认规则回站点根
	assert.equal(resolveLoginPath({}, '//evil.com', '/auth'), '/auth');
});

test('登录页自身不参与回跳（否则登录成功又被踢回登录页形成环）', () => {
	assert.equal(sanitizeRedirectTarget('/auth'), '');
	assert.equal(sanitizeRedirectTarget('/auth/'), '');
	assert.equal(sanitizeRedirectTarget('/auth?token=abc'), '');
	assert.equal(resolveLoginPath({}, '/auth', '/auth'), '/auth');
});

test('非字符串与空值一律退化，不抛错', () => {
	assert.equal(sanitizeRedirectTarget(''), '');
	assert.equal(sanitizeRedirectTarget(undefined), '');
	assert.equal(sanitizeRedirectTarget(null), '');
	assert.equal(sanitizeRedirectTarget(42), '');
});

test('fragment 被丢弃（片段不会随重定向回传，留着只会污染地址）', () => {
	assert.equal(sanitizeRedirectTarget('/list#anchor'), '/list');
});
