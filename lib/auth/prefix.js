/**
 * 反向代理路径前缀解析与安全重定向工具
 */
/**
 * 校验并提取反向代理传递的前缀路径 (如 X-Forwarded-Prefix)
 *
 * 安全约束：
 * 1. 必须以单个 / 开头，且不能以 // 开头（防御协议相对 URL 与开放重定向）
 * 2. 不能包含协议标识 (http:, https:, etc.)
 * 3. 不能包含反斜杠或控制字符（防御浏览器 URL 规范化逃逸与 CRLF 注入）
 * 4. 去除末尾冗余的斜杠
 */
export function resolveForwardedPrefix(raw) {
    if (typeof raw !== 'string')
        return '';
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '/')
        return '';
    // 必须以单个 / 开头，拒绝 // (如 //evil.com)、带有协议字符、以及含反斜杠与控制字符
    if (!trimmed.startsWith('/') ||
        trimmed.startsWith('//') ||
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ||
        /[\\\x00-\x1F\x7F]/.test(trimmed)) {
        return '';
    }
    return trimmed.replace(/\/+$/, '');
}
/**
 * 构造带网关前缀的重定向目标路径
 * @param headers 请求头
 * @param targetPath 目标相对路径，如 '/auth' 或 '/'
 */
export function resolveRedirectPath(headers, targetPath) {
    const rawPrefix = headers?.['x-forwarded-prefix'];
    const prefix = resolveForwardedPrefix(typeof rawPrefix === 'string' ? rawPrefix : Array.isArray(rawPrefix) ? rawPrefix[0] : '');
    const normPath = targetPath.startsWith('/') ? targetPath : `/${targetPath}`;
    if (!prefix) {
        return normPath;
    }
    return `${prefix}${normPath}`;
}

/**
 * 构造登录页地址，并把原始访问路径作为 `redirect` 携带过去。
 *
 * 为什么需要：门禁把未授权的主文档请求 302 到 `/auth` 时，若不带上原始路径，
 * 登录页只能默认跳回站点根（`/`）。用户从`/api/intel/site/console/`进来，
 * 配对成功后会被丢到 DSH 首页，看着就像“没有登录进去”。登录页那侧已实现了
 * `?redirect=` 支持与开放重定向防护，这里只负责把值送过去。
 *
 * 安全约束（与登录页的校验保持一致）：只带站内路径，且不带协议、`//`、反斜杠、
 * 控制字符与回退路径（回调到 `/auth` 自身会形成环路）。
 *
 * @param headers 请求头（用于解析网关前缀）
 * @param originalUrl 被拦下的原始请求 URL（含 search）
 * @param authPath 登录页路径，默认 '/auth'
 */
export function resolveLoginPath(headers, originalUrl, authPath = '/auth') {
    const loginPath = resolveRedirectPath(headers, authPath)
    const redirect = sanitizeRedirectTarget(originalUrl)
    return redirect ? `${loginPath}?redirect=${encodeURIComponent(redirect)}` : loginPath
}

/**
 * 把原始请求 URL 收窄成可安全回跳的站内路径（失败一律返回空串）。
 */
export function sanitizeRedirectTarget(rawUrl) {
    if (typeof rawUrl !== 'string')
        return ''
    const pathnameAndSearch = rawUrl.split('#')[0]
    if (!pathnameAndSearch.startsWith('/') ||
        pathnameAndSearch.startsWith('//') ||
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathnameAndSearch) ||
        /[\\\x00-\x1F\x7F]/.test(pathnameAndSearch)) {
        return ''
    }
    // 登录页自身不参与回跳，否则登录成功后又被踢回登录页
    const pathname = pathnameAndSearch.split('?')[0]
    if (pathname === '/auth' || pathname === '/auth/')
        return ''
    return pathnameAndSearch
}
