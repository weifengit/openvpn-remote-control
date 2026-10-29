/**
 * dsh-remote-anynet — 浏览器侧兼容层（注入 index.html 的 <head> 最前列）
 *
 * 为什么需要这一层：
 * 1. DSH 客户端 bundle 直接用 ES2024 平台 API（`AbortSignal.any` 需 Chromium 116、
 *    `Promise.withResolvers` 需 Chromium 119），而手机上的系统 WebView / 应用内核对
 *    版本并不可控（实测同一台手机共存 Chromium 115 与 150 两套内核）。
 *    缺失时 connection 的 generation 在第一步就抛 TypeError，重连退避永远走不到
 *    connected —— 手机上表现为一直「重新连接中」。
 * 2. HTTP + 非回环地址属于非安全上下文，`crypto.randomUUID` / `navigator.clipboard`
 *    为 undefined，官方 bundle 直接调用会崩。
 *
 * 约定：每个 shim 都先探测原生实现，已存在时零副作用；异常只发生在自身作用域内，
 * 绝不影响页面其余脚本。
 */

/** 旧内核缺失的 ES2024 平台 API（可安全 shim 的部分）。 */
export const ES2024_POLYFILL_SNIPPET = `
(function() {
  if (typeof Promise !== 'undefined' && typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function() {
      var resolve, reject;
      var promise = new Promise(function(res, rej) {
        resolve = res;
        reject = rej;
      });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
    AbortSignal.any = function(signals) {
      var controller = new AbortController();
      var list = [];
      try {
        list = Array.prototype.slice.call(signals || []);
      } catch (err) {}
      var detach = [];
      var detachAll = function() {
        for (var i = 0; i < detach.length; i++) {
          try { detach[i](); } catch (err) {}
        }
        detach = [];
      };
      for (var i = 0; i < list.length; i++) {
        var signal = list[i];
        if (!signal) continue;
        if (signal.aborted) {
          controller.abort(signal.reason);
          detachAll();
          return controller.signal;
        }
      }
      for (var j = 0; j < list.length; j++) {
        (function(source) {
          if (!source || typeof source.addEventListener !== 'function') return;
          var onAbort = function() {
            detachAll();
            controller.abort(source.reason);
          };
          source.addEventListener('abort', onAbort, { once: true });
          detach.push(function() {
            source.removeEventListener('abort', onAbort);
          });
        })(list[j]);
      }
      controller.signal.addEventListener('abort', detachAll, { once: true });
      return controller.signal;
    };
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = function(ms) {
      var controller = new AbortController();
      var reason;
      try {
        reason = new DOMException('signal timed out', 'TimeoutError');
      } catch (err) {
        reason = new Error('signal timed out');
      }
      setTimeout(function() {
        controller.abort(reason);
      }, ms);
      return controller.signal;
    };
  }
  if (typeof AbortSignal !== 'undefined'
    && typeof AbortSignal.prototype.throwIfAborted !== 'function') {
    AbortSignal.prototype.throwIfAborted = function() {
      if (this.aborted) throw this.reason;
    };
  }
})();
`;

/**
 * 非安全上下文（HTTP + 外部 IP）下的 UUID v4 能力
 */
export const CRYPTO_POLYFILL_SNIPPET = `
(function() {
  if (typeof window !== "undefined") {
    if (!window.crypto) window.crypto = {};
    if (typeof window.crypto.randomUUID !== "function") {
      window.crypto.randomUUID = function() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          var r = Math.random() * 16 | 0;
          var v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      };
    }
  }
})();
`;

/**
 * 非安全上下文（HTTP + 外部 IP，如 Overlay / 局域网）下的 Clipboard API 降级实现，
 * 避免官方 bundle 直接调用 navigator.clipboard.writeText 时抛
 * "Cannot read properties of undefined (reading 'writeText')" 崩溃。
 * 原生可用时不做任何替换。
 */
export const CLIPBOARD_POLYFILL_SNIPPET = `
(function() {
  if (typeof navigator === "undefined") return;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") return;
    var writeText = function(text) {
      try {
        var ta = document.createElement('textarea');
        ta.value = String(text == null ? '' : text);
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    var readText = function() {
      return Promise.reject(new Error('clipboard readText is not supported in insecure context'));
    };
    try {
      if (!navigator.clipboard) navigator.clipboard = {};
      if (typeof navigator.clipboard.writeText !== "function") navigator.clipboard.writeText = writeText;
      if (typeof navigator.clipboard.readText !== "function") navigator.clipboard.readText = readText;
    } catch (err) {
      try {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: writeText, readText: readText },
          configurable: true,
        });
      } catch (err2) {}
    }
  } catch (err) {}
})();
`;

/**
 * 兼容层清单：id 兼作注入后的 DOM 标记，供排查「到底哪个 shim 落到了页面上」。
 * 顺序即执行顺序（ES2024 最前，其余 shim 可能依赖 Promise）。
 */
export const BROWSER_POLYFILLS = [
    { id: 'dsh-es2024-polyfill', source: ES2024_POLYFILL_SNIPPET },
    { id: 'dsh-crypto-polyfill', source: CRYPTO_POLYFILL_SNIPPET },
    { id: 'dsh-clipboard-polyfill', source: CLIPBOARD_POLYFILL_SNIPPET },
];

/** 汇总后的 <script> 标签串：插到 <head> 开头即先于所有模块脚本执行。 */
export const BROWSER_POLYFILL_TAGS = BROWSER_POLYFILLS
    .map((item) => `<script id="${item.id}">${item.source}</script>`)
    .join('');

/**
 * 把一段标记插到 <head> 之后（找不到 <head> 时原样返回）。
 *
 * 用函数式替换：替换串里出现 `$&` / `$1` 之类也不会被 String.replace 解释，
 * 脚本源码可以放心写。
 */
export function prependToHead(html, markup) {
    if (typeof html !== 'string' || !markup || !html.includes('<head>')) {
        return html;
    }
    return html.replace('<head>', () => `<head>${markup}`);
}
