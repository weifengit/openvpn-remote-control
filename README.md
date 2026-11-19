# dsh-remote-anynet

**一个插件搞定 DSH 远程与移动端访问**：扫码配对 + RSA 加密传输 + 防暴力破解，
并且**用 EasyTier / OpenVPN 之类打通异地网络后能拿到正确的对外地址**（真远程，
不要求同一个局域网）。

它是 [dsh-remote-mobile](https://github.com/IceApriler/dsh-remote-mobile)（MIT）的
**内联改造版**：保留其全部认证能力，去掉 Tailscale 专属逻辑，改为通用虚拟网探测。
只需维护这一个插件，不再需要同时装两个。

---

## 1. 为什么要改造

上游把"对外可达地址"写死成两种假设：

| 假设 | 后果 |
| --- | --- |
| 局域网 = RFC1918，且**优先 `en0`/`eth0`/`wlan0`** | 永远先命中物理网卡 |
| 异地 = **Tailscale**，必须是 `100.64.0.0/10` | EasyTier/OpenVPN 的 `10.x` 一律不算 |

而界面上的二维码与复制链接直接取自这个地址。实测某台同时开着 EasyTier 和
OpenVPN 的机器，上游返回的是：

```json
{
  "tailscaleIp": null,
  "lanIp": "192.168.3.29",            ← 播发的是它，手机扫到的就是它
  "networkIps": [
    { "name": "en0",   "ip": "192.168.3.29" },
    { "name": "utun5", "ip": "10.126.126.11" },   ← EasyTier，真正可达
    { "name": "utun6", "ip": "10.8.0.2" }         ← OpenVPN，真正可达
  ]
}
```

隧道网卡**明明被枚举出来了**，却因为网卡名优先级被 `en0` 顶掉 —— 手机拿到的是
那个"出了这个 Wi-Fi 就连不上"的地址。这就是"网络打通了却访问不了"的根因。

> 顺带说明：门禁本身并不拦 EasyTier/OpenVPN。`isLanIp()` 对 `10.x` 返回 `true`，
> 认证 token 也不绑 IP。真正的断点是**播发地址错了**，以及 **Cookie 按 origin 隔离**
> （换地址要重新配对一次）。

## 2. 能力

**认证网关（继承自上游）**
- RSA-2048 端到端加密传输配对凭据，防中间人窃听
- 6 位一次性配对码 + 365 天长效 Cookie
- 长期密码（加盐哈希存储）
- 防暴力破解：滑动窗口限频、连续失败锁定、单 IP 熔断审计
- 透明接管 DSH 底座 connection 鉴权，PC/移动端访问无需再带官方 token
- 上下文虚拟化桥接，兼容只允许回环的其它插件

**通用地址探测（本插件改造）**
- 按 *网卡名 + 网段 + `ifconfig` 对端提示* 三重打分，识别
  EasyTier、OpenVPN、ZeroTier、WireGuard、NetBird，也支持任意自定义网段
- 播发地址可手动固定，或按类型指定（只要 EasyTier / 只要 OpenVPN / 只要局域网）
- 免密直连**默认收窄**到当前地址所属的虚拟网段，不像"局域网免密"那样
  一次放开整片 RFC1918
- 地址选择页：列出全部候选与判定依据，一键固定

**对外可达监听（本插件改造）**
- 新版 `dsh-host-webserver` 拒绝绑定 `0.0.0.0`（会暴露 RCE），profile 只能绑回环；
  这时手机走局域网/虚拟网本来就进不来。插件改为在**本机每个非回环 IPv4** 上追加监听
  （局域网网卡 + `utun*`/`tun*` 隧道网卡），连接建立后把 socket **直接交给宿主的 http.Server**
- 不走 TCP 反向代理：反代会把来源地址变成 `127.0.0.1`，门禁会当成本机请求无条件放行，
  等于把鉴权拆掉。直接交接 socket 时 `remoteAddress` 保持真实来源，门禁与审计照常生效
- 隧道随时上下线（EasyTier 重连、OpenVPN 掉线），监听每 10 秒重扫一次，跟着网卡变化增减
- 宿主自己已绑通配地址时不再重复监听（那些接口本就可达）

**浏览器兼容层（本插件改造）**
- 注入 ES2024 平台 API shim（`AbortSignal.any` / `Promise.withResolvers` / `AbortSignal.timeout` / `throwIfAborted`）：
  DSH 客户端 connection 依赖它们，旧手机内核（Chromium < 116/119）缺失时会一直卡在「重新连接中」
- 非安全上下文（HTTP + 外部 IP）下的 `crypto.randomUUID` / `navigator.clipboard` 降级
- shim 均先探测原生实现，新内核上完全空转；脚本注入在 `<head>` 最前，先于任何模块脚本执行

## 3. 安装

```bash
cd ~/.dsh/profiles/web

# 1) 让 profile 能找到插件
ln -s /Users/sonoma/code/openvpn-remote-control node_modules/dsh-remote-anynet
```

2) 编辑 `~/.dsh/profiles/web/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-remote-anynet": "link:/Users/sonoma/code/openvpn-remote-control"
    //  ★ 同时删除 "dsh-remote-mobile"：两者注册同一批路由，共存会冲突
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-remote-anynet"
        //  ★ 同时删除 "dsh-remote-mobile"
      ]
    }
  }
}
```

3) 重启 DSH Web（`dsh web`）。启动横幅：

```
┌────────────────────────────────────────────────────────────────────────
│ [dsh-remote-anynet] 远程接入网关已就绪（含异地虚拟网地址修正）
│   • 本机回环:   http://127.0.0.1:3080
│   • 局域网:     http://192.168.3.29:3080 (同 Wi-Fi 可达)
│   • 对外播发:   http://10.126.126.11:3080   (auto)
│     判定依据:   命中预设网段：EasyTier；虚拟/隧道网卡；对端 10.8.8.8 指向 EasyTier
│   • 本机候选:
│     * 10.126.126.11   utun5 [easytier]
│       10.8.0.2        utun6 [openvpn]
│       192.168.3.29    en0
│   - 地址选择与说明: http://127.0.0.1:3080/remote-anynet
└────────────────────────────────────────────────────────────────────────
```

### 从 dsh-remote-mobile 迁移

**已配对的手机会自动继承，不需要重新扫码。** 插件首次启动时会把旧数据目录
`~/.dsh/remote-mobile/` 里的 `devices.json` 与 `rsa-keys.json` **逐文件**复制到
新的 `~/.dsh/remote-anynet/`（只补缺失的文件，绝不反向覆盖）。

## 4. 使用

1. 本机浏览器打开 **http://127.0.0.1:3080/remote-anynet** 确认/固定对外地址
2. 回到 DSH →「设置」→「远程与移动端」→「访问」，二维码此时指向的就是正确地址
3. 手机（异地）扫码 → 配对 → **365 天免登录**

> `/remote-anynet` 这个页面与 `/api/remote-anynet/*` 不在门禁白名单里：
> 本机回环可直连，异地需先配对。这是刻意姿态 —— 不新增未认证的对外入口。

### 地址选择规则

优先级：`pinnedAddress`（手动固定） > `prefer`（指定类型） > 自动打分。

自动打分（`lib/nets.js` → `detectCandidates`）：

| 因素 | 分值 | 说明 |
| --- | --- | --- |
| 命中虚拟网预设网段 | +120 | 如 `10.126.0.0/16` → EasyTier |
| 命中自定义网段 | +100 | `customCidrs` |
| 网卡名像隧道网卡 | +60 | `utun*` / `tun*` / `tap*` / `wg*` / `zt*` |
| `ifconfig` 对端提示命中 | +30 | 如 EasyTier 对端 `10.8.8.8` |
| 是 CGNAT 地址 | +20 | `100.64.0.0/10` |
| 网卡名像物理网卡 | +10 | `en0` / `eth0` / `wlan0` |
| 链路本地 `169.254/16` | −40 | 并标记为不可用 |

同分时按预设优先级（EasyTier 10 → OpenVPN 20 → WireGuard 30 → …）再按地址升序，
结果稳定可复现。

## 5. 配置

配置与上游共用同一份 `~/.dsh/remote-anynet/settings.json`（权限 0600），
重启与刷新都不会丢：

```jsonc
{
  "allowOverlay": false,        // 虚拟网免密直连总开关（界面上切换）
  "allowLan": false,            // 局域网免密（覆盖全部 RFC1918，风险高）
  "prefer": "auto",             // auto | easytier | openvpn | wireguard
                                // | zerotier | netbird | custom | lan | public
  "pinnedAddress": "",          // 最高优先级，留空=自动；只接受合法 IPv4
  "customCidrs": [],            // 参与打分，也可配合 prefer=custom
  "overlayCidrs": []            // 免密放行网段；留空=自动收窄到当前地址所属虚拟网
  "lanListen": true              // 在局域网/虚拟网卡上追加监听（关掉就只有本机能连）
}
```

## 6. 验证

```bash
cd /Users/sonoma/code/openvpn-remote-control
node --test test/*.test.js
```

- **`test/nets.test.js`（22 项）**：CIDR 解析与边界、地址分类、打分排序、
  `pinnedAddress`/`prefer` 回落、免密网段收窄、缓存失效。
- **`test/headless.test.js`（4 项）**：**无头端到端**。伪造最小 cordis ctx +
  真 `http.Server`，按线上完全一致的时序调用插件的 `apply()`，然后发真实 HTTP 请求：
  - 回环放行，播发的确实是隧道地址而非物理网卡
  - 异地未配对 → `401`／主文档 `302 /auth`，`/auth` 公开；走完配对码换 Cookie 后放行
  - **虚拟网免密**：不开 → `401`；只开开关但不给网段 → 仍 `401`；
    精确放行来源网段 → `200`（证明是收窄放行而非整片放开）
  - `pinnedAddress` 通过接口生效并同步到上游 status，非法值归为"不固定"

测试全程使用临时 `devicesFile`，不会读写 `~/.dsh` 下的真实设备与密钥。

手动核对线上：

```bash
curl -s http://127.0.0.1:3080/api/remote-mobile/status | python3 -m json.tool | grep -E 'overlayIp|lanIp'
```

`overlayIp` 应等于你的 EasyTier/OpenVPN 地址。

## 7. 安全说明

- **不新增未认证入口**：`/remote-anynet` 与 `/api/remote-anynet/*` 与主门禁一致。
- **免密默认关闭，且默认收窄**。`overlayCidrs` 留空时会自动解析为
  "当前播发地址所属的虚拟网段"（例如 `10.126.126.11` → `10.126.0.0/16`）；
  无法归类时退回到该网卡自己的直连网段。绝不会因为留空就放开一切。
- **回环永远不算虚拟网来源**，避免把本机请求当成免密来源。
- **失败即退让**：配置损坏时回落默认并记录原因；探测异常时 status 仍返回
  合法 JSON，不会把接口弄坏。
- 数据文件以 `0600` 写入；`devices.json` 里是会话 token，请勿外传。

## 8. 排错

| 现象 | 处理 |
| --- | --- |
| 设置里出现「检测到其他远程接入插件」 | 说明 `dsh-remote-mobile` 还开着。按第 3 节把它从 `bundles` 与 `dependencies` 移除后重启 |
| 横幅提示"当前仅监听 127.0.0.1" | 正常且无需处理：新版 webserver 禁止绑 `0.0.0.0`，对外可达由本插件的追加监听提供。打开 `/remote-anynet` 看「对外可达监听」里列出的地址 |
| 手机连不上、但本机 `127.0.0.1` 正常 | 看 `/remote-anynet` 的「对外可达监听」：列表为空说明开关关了或网卡不在；有「绑定失败」说明端口被其他进程占着 |
| 播发地址是 `192.168.x.x` | 隧道没起来。打开 `/remote-anynet` 看候选；或直接手动固定一个地址 |
| 换了地址要重新扫码 | 正常：Cookie 按 origin 隔离。建议固定一个地址长期使用 |
| 配对后手机仍被拦 | 确认访问的是"对外播发"那个地址，而不是二维码里可能残留的旧地址 |
| 手机端一直显示「重新连接中」 | 手机内核太旧（如 Chromium 115）缺少 `AbortSignal.any` / `Promise.withResolvers`。本插件会注入 shim（`<script id="dsh-es2024-polyfill">`）；若页面里没有这个标签，说明服务没重启到新版插件 |

## 9. 相对上游去掉了什么

- 删除 `lib/auth/tailscale.js`（含 `tailscale ip -4` 子进程调用），
  由 `lib/nets.js` + `lib/auth/overlay.js` 取代
- 删除 Tailscale/CGNAT 专属判定，改为通用的 `isOverlayIp(ip, cidrs)`
- `allowTailscale` → `allowOverlay`，语义从"某个特定软件"变为"已放行的虚拟网段"
- 界面文案中的 Overlay/Tailscale 表述改为"虚拟网"
- 移除对上游 npm 包的版本检查（本地分支比对上游版本没有意义）
- 界面里的"关于"按钮改为明确标注**基于上游 dsh-remote-mobile (MIT)**
- 测试从零重写（原测试依赖的是改造前的模块结构）

保留：认证、配对、加密、限流、审计、上下文虚拟化、桥接共存裁决等全部能力。

## License

MIT。认证网关部分内联自 dsh-remote-mobile（Copyright (c) IceApriler，
MIT License），详见 [NOTICE](NOTICE)。EasyTier、OpenVPN、ZeroTier、WireGuard、
NetBird、Tailscale 分别为其各自所有者的商标，本项目与上述组织无隶属关系。

## 移动端体验说明

- **允许双指缩放**：客户端不再把 viewport meta 写死成
  `maximum-scale=1.0, user-scalable=no`（手机上既看不清又放不大），
  现在只设 `width=device-width, initial-scale=1.0, viewport-fit=cover`。
- **工作台（第三方面板类插件）的窄屏适配由插件自己负责**：本插件注入的
  `preset-sidebar / preset-settings / preset-main` 只适配宿主自己的 class
  （`_frame` / `_sidebarCol` / `_centerCol` / markdown…）。窄屏下工作台这类
  自绘外壳需要它自己按 `@media (max-width: 900px)` 适配（tokensave 工作台已按此
  断点把三栏改成单栏 + 覆盖式抽屉）。
- **旧内核兜底**：注入 ES2024 shim（`AbortSignal.any` / `Promise.withResolvers` /
  `AbortSignal.timeout` / `throwIfAborted`）。缺了它们时 DSH 客户端 connection 的
  generation 第一步就抛 TypeError，旧内核手机（如 Chromium 115 的系统 WebView）
  会永远停在「重新连接中」而不是报错。新内核上这些 shim 完全空转。

