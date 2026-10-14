# dsh-remote-anynet

给 [dsh-remote-mobile](https://github.com/IceApriler/dsh-remote-mobile) 打一个**地址补丁**：
用 **EasyTier / OpenVPN / ZeroTier / WireGuard / NetBird** 之类打通异地网络后，
让 DSH 远程访问真正可用（北京 ↔ 上海那种真远程，不要求同一个局域网）。

本插件**不修改上游任何文件**，也不动 `node_modules`，只在 HTTP 响应层把上游算错的
"对外可达地址"换成正确的那个。

---

## 1. 问题：为什么"网络打通了还是访问不了"

上游插件把"对外可达地址"写死成两种假设：

| 假设 | 代码位置 | 后果 |
| --- | --- | --- |
| 局域网 = RFC1918，且**优先 `en0`/`eth0`/`wlan0`** | `lib/auth/tailscale.js` → `getLocalLanIp()` | 永远先命中真实网卡 |
| 异地 = **Tailscale**，必须是 `100.64.0.0/10` | `getLocalLanIp()` / `isTailscaleIp()` | EasyTier/OpenVPN 的 `10.x` 一律不算 |

而它的客户端用 `status.lanIp` 直接拼二维码和复制链接：

```js
// 上游 lib/client.js
const effectiveQrIp = selectedTab === "tailscale" && status.tailscaleIp
  ? status.tailscaleIp
  : status.lanIp || "127.0.0.1";
const directLink = `http://${effectiveQrIp}:${port}/auth?token=${status.code || ""}`;
```

于是在一台同时开着 EasyTier 和 OpenVPN 的机器上，
`/api/remote-mobile/status` 实际返回的是：

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

`utun5`/`utun6` **明明被枚举出来了**，却因为网卡名优先级被 `en0` 顶掉。
这就是"网址不是这个"——手机拿到的是那个出了这个 Wi-Fi 就连不上的地址。

> 补充：门禁本身其实不拦 EasyTier/OpenVPN。`isLanIp()` 对 `10.x` 返回 `true`，
> 认证 token 也不绑 IP。真正的断点是**播发地址错了**，以及**Cookie 按 origin 隔离**
> （换地址就要重新配对一次）。

## 2. 它做了什么

1. **通用虚拟网探测**（`lib/nets.js`）
   按 *网卡名 + 网段 + ifconfig 对端提示* 给每张网卡打分，识别
   EasyTier(`10.126.0.0/16`)、OpenVPN(`10.8.0.0/24`)、ZeroTier、WireGuard、
   NetBird、Tailscale，也支持任意自定义网段。

2. **修正播发地址**（`lib/status.js` + `lib/rewrite.js`）
   把上游 `GET /api/remote-mobile/status` 响应体里的 `lanIp` 换成真正可达的地址，
   并附带一个 `anynet` 字段。上游客户端据此渲染的**二维码 / 复制链接 / 地址显示全部跟着变对**。

3. **可视化与一键固定**（`lib/routes.js`）
   提供 `/remote-anynet` 页面：列出全部候选地址、判定依据，支持一键固定、切换优先级。

### 为什么改 `lanIp` 而不是去 fork 上游

因为上游客户端**只有这一个数据来源**。改一个字段，二维码、复制链接、
设备列表高亮全部同时正确，而上游代码零改动、升级不受影响。

## 3. 安装

```bash
# 1) 让 profile 认识这个插件（link: 指向本目录）
cd ~/.dsh/profiles/web

# 手动方式（等价于 pnpm add link:）
ln -s /Users/sonoma/code/openvpn-remote-control node_modules/dsh-remote-anynet
```

然后在 `~/.dsh/profiles/web/package.json` 里补两处：

```jsonc
{
  "dependencies": {
    "dsh-remote-mobile": "^1.9.0",
    "dsh-remote-anynet": "link:/Users/sonoma/code/openvpn-remote-control"   // ← 加这行
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-remote-mobile",
        "dsh-remote-anynet"        // ← 加这行，放在 dsh-remote-mobile 之后
      ]
    }
  }
}
```

重启 DSH Web（`dsh web`）生效。启动横幅会打印类似：

```
┌────────────────────────────────────────────────────────────────────────
│ [dsh-remote-anynet] 异地虚拟网接入地址修正已就绪
│   • 对外播发地址: http://10.126.126.11:3080   (auto)
│     判定依据: 自动选择：命中预设网段：EasyTier；虚拟/隧道网卡
│   • 本机候选地址:
│     * 10.126.126.11   utun5 [easytier]
│       10.8.0.2        utun6 [openvpn]
│       192.168.3.29    en0
│   • 上游 dsh-remote-mobile 的二维码/链接已指向上面的地址
│   • 地址选择与说明: http://127.0.0.1:3080/remote-anynet
└────────────────────────────────────────────────────────────────────────
```

## 4. 使用

1. 本机浏览器打开 **http://127.0.0.1:3080/remote-anynet**
   （这个页面需要回环或已配对才能访问，是刻意的：不新增未认证的对外入口）
2. 确认"当前对外播发地址"是 EasyTier/OpenVPN 的地址；不对就点候选表里的**固定**
3. 回到上游「设置 → 远程与移动端」，二维码此时已指向正确地址
4. 手机（异地）扫码 → 配对 → **365 天免登录**

### 地址选择规则

优先级：`pinnedAddress`（手动固定） > `prefer`（指定网络类型） > 自动打分。

自动打分（`lib/nets.js` → `detectCandidates`，各因素累加）：

| 因素 | 分值 | 说明 |
| --- | --- | --- |
| 命中虚拟网预设网段 | +120 | 如 `10.126.0.0/16` → EasyTier |
| 网卡名像隧道网卡 | +60 | `utun*` / `tun*` / `tap*` / `wg*` / `zt*` |
| 命中自定义网段 | +100 | `customCidrs` 配置 |
| `ifconfig` 对端提示命中 | +30 | 如 EasyTier 对端 `10.8.8.8` |
| 是 CGNAT 地址 | +20 | `100.64.0.0/10` |
| 网卡名像物理网卡 | +10 | `en0` / `eth0` / `wlan0`，即"仅局域网可达" |
| 链路本地 `169.254/16` | −40 | 并标记为不可用 |

同分时按预设优先级（EasyTier 10 → OpenVPN 20 → WireGuard 30 → …）再按地址升序，
结果稳定可复现。

## 5. 配置

三层覆盖，后者优先：**代码默认值 → 插件行 `config` → `~/.dsh/remote-anynet/settings.json`**。

```yaml
- insert:
    - id: remote-anynet
      name: 'dsh-remote-anynet'
      inject: [webServer]
      config:
        prefer: auto            # auto | easytier | openvpn | wireguard | zerotier
                                # | netbird | tailscale | custom | lan | public
        pinnedAddress: ''       # 最高优先级；留空=自动
        customCidrs: []         # 例：['10.126.0.0/16']
        rewriteStatus: true     # 是否改写上游 status 里的地址
        bypass:
          enabled: false        # 见下方「安全说明」
          cidrs: []             # 留空=用当前地址所属预设网段，比上游的 allowLan 窄得多
```

## 6. 验证

```bash
cd /Users/sonoma/code/openvpn-remote-control
node --test test/*.test.js
```

覆盖：
- **34 个用例**：CIDR 解析/边界、地址分类、打分排序、`pinnedAddress`/`prefer` 回落、
  配置三层覆盖与损坏文件容错。
- **端到端**（`test/integration.test.js`）：起真实 `http.Server`，按上游
  `patchHttpServerWithVirtualizer` 的真实行为布置监听器，发真实 HTTP 请求断言改写生效。
  覆盖**两种挂载时序**（本插件先/后于上游打补丁）、非目标路径不受影响、
  关闭时完全 no-op、显式 `Content-Length` 不截断、gzip 响应不被破坏。

手动验证线上效果：

```bash
curl -s http://127.0.0.1:3080/api/remote-mobile/status | python3 -m json.tool | grep -E 'lanIp|anynet'
```

`lanIp` 应等于你的 EasyTier/OpenVPN 地址，而不是 `en0` 的 `192.168.x.x`。

## 7. 安全说明

- **不新增未认证入口**。`/remote-anynet` 与 `/api/remote-anynet/*` 与上游门禁保持一致：
  回环免认证，异地需先配对。地址改写只在已放行的响应上做文本替换。
- **免密（`bypass`）默认关闭**。上游的「局域网免密」一次放开整个 RFC1918
  （含咖啡馆 Wi-Fi），本插件的 `bypass.cidrs` 可以只放开你自己的隧道网段。
  但注意：**上游门禁不读本插件的开关**，它只认自己的 `allowTailscale` / `allowLan`。
  本插件不重复实现门禁（那会和上游打架），所以真要开免密，请在上游设置页开对应开关。
  常规做法是**配对一次**——Cookie 有效期 365 天，换地址才需要重新配对。
- **失败即退让**：响应结构不符、JSON 解析失败、响应已 gzip、headers 已 flush 时，
  一律原样透传并跳过改写。最坏情况等于"没装这个插件"，不会把接口弄坏。

## 8. 排错

| 现象 | 原因与处理 |
| --- | --- |
| 横幅没出现 | 插件未加载。检查 profile `package.json` 的 `bundles` 与 `node_modules` 软链；重启 DSH |
| `lanIp` 没变 | 打开 `/remote-anynet` 看候选；确认 `enabled`/`rewriteStatus` 为真；确认上游插件在运行 |
| 横幅提示"当前仅监听 127.0.0.1" | `webserver.host` 不是 `0.0.0.0`，异地连不进来。装 `dsh-lan-access` 或自行配置 |
| 地址对了，手机还是连不上 | 检查对端是否真的能 ping 通该地址；确认两端 EasyTier/OpenVPN 同一虚拟网 |
| 换了地址后要重新扫码 | 正常现象：Cookie 按 origin 隔离。建议固定一个地址长期使用 |

## 9. 与上游的分工

| | dsh-remote-mobile | dsh-remote-anynet（本插件） |
| --- | --- | --- |
| 认证 / 配对 / 防暴破 | ✅ 负责 | ❌ 不碰 |
| 地址探测与播发 | 只认 Tailscale + en0 | ✅ 通用虚拟网，可固定 |
| 二维码 / 链接 | 渲染 | ✅ 通过修正数据源间接纠正 |
| 修改上游文件 | — | ❌ 零改动 |

建议一起使用；本插件单独安装也不会有副作用（只是地址探测的结果没人消费）。

## License

MIT。本插件是独立实现，不包含、不修改 dsh-remote-mobile 的任何源代码。
EasyTier / OpenVPN / ZeroTier / WireGuard / NetBird / Tailscale 为其各自所有者的商标。
