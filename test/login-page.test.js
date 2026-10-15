/**
 * 登录页健康检查
 *
 * 这组测试守的是一个非常隐蔽、但会让整个远程登录彻底失效的坑：
 *
 *   login-page.js 把整段客户端 JS 放在【模板字符串】里返回。
 *   模板字符串会先做一次转义解析，所以源码里写 `/\/auth\/?$/`（一个反斜杠）
 *   输出出来会变成 `//auth/?$/` —— 而 `//` 在 JS 里是【注释】，
 *   于是正则字面量被截断，整个 <script> 块语法错误、完全不执行。
 *
 *   后果：手机在 /auth 页面点“提交”后没有任何 JS 接管，
 *   浏览器退回表单默认行为重新加载页面 ——
 *   用户看到的现象就是“配对码正确，但提交后又回到这个界面”。
 *
 * 所以这里必须验证【输出到页面的最终代码】是可解析、且正则正确。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { getLoginPageHtml } from '../lib/routes/login-page.js';

/** 取出页面里唯一的 <script> 块内容。 */
function inlineScript(html) {
	const m = html.match(/<script>([\s\S]*?)<\/script>/);
	assert.ok(m, '登录页应含一个 <script> 块');
	return m[1];
}

test('登录页内联 JS 必须是可解析的（模板转义没吃掉反斜杠）', () => {
	const js = inlineScript(getLoginPageHtml(''));
	assert.doesNotThrow(
		() => new vm.Script(js, { filename: 'login-inline.js' }),
		'页面内 JS 语法错误会让整个登录表单失效（点提交后原地刷新）',
	);
});

test('页面输出的 /auth 路径正则必须带转义（\\/auth 而不是 //auth）', () => {
	const js = inlineScript(getLoginPageHtml(''));

	// 正确：replace(/\/auth\/?$/, ...)
	assert.ok(
		js.includes('replace(/\\/auth\\/?$/, '),
		'正则里的反斜杠被模板字符串吃掉了，// 会被当成注释',
	);
	// 错误形态不应出现
	assert.ok(
		!js.includes('replace(//auth'),
		'replace(//auth...) 是注释开头，会让整段脚本语法错误',
	);
});

test('页面 JS 必须包含提交处理与验证请求（确认没被截断）', () => {
	const js = inlineScript(getLoginPageHtml(''));
	for (const token of [
		'doVerify',
		'addEventListener(\'submit\'',
		'api/remote-mobile/verify',
		'encryptCredential',
		'credential',
	]) {
		assert.ok(js.includes(token), `页面 JS 缺少关键片段：${token}`);
	}
});

test('登录页注入的公钥必须可用（否则加密路径必然失败）', () => {
	const js = inlineScript(getLoginPageHtml(''));
	const m = /const SERVER_RSA_KEY = (.*?);/.exec(js);
	assert.ok(m, '应内联 SERVER_RSA_KEY');
	const value = JSON.parse(m[1]);
	assert.ok(value.includes('BEGIN PUBLIC KEY'), '内联公钥应为 PEM');
});

test('页面不得把明文回退逻辑弄丢（RSA 环境异常时的兜底）', () => {
	const js = inlineScript(getLoginPageHtml(''));
	assert.ok(
		js.includes('credential') && js.includes('encryptedCredential'),
		'应同时支持明文与加密两条提交路径',
	);
});

test('所有被测语言的登录页都要通过同样的健康检查', () => {
	for (const html of [getLoginPageHtml('', 'zh'), getLoginPageHtml('', 'en')]) {
		const js = inlineScript(html);
		assert.doesNotThrow(() => new vm.Script(js));
		assert.ok(js.includes('replace(/\\/auth\\/?$/, '));
	}
});
