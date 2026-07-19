# voicedrop.cn 备案接入点(EdgeOne 方案)

**目标:替换掉 infra/voicedrop-cn 的腾讯云 VPS + Caddy 反代。本目录是全部真相。**

## 为什么换

- VPS 跨境回源 CF 只有 ~60KB/s,照片被迫 302 到 jianshuo.dev 直连,微信里加载慢且不稳;
  EO 把照片缓存到国内边缘节点,是真正解决而不是绕行。
- VPS 是单点,「机器随时可能释放」;EO 无机器要养,证书自动,自带防护。
- 备案接入保持国内(域名已备案:沪ICP备06019413号-118),微信不弹提示这一点不变。

## 架构

```
微信用户 → voicedrop.cn (DNS CNAME → EdgeOne 调度域名, 国内解析, 备案一致)
        → EO 边缘函数 (本目录 edge-function.js, 替代 Caddyfile 全部路径逻辑)
        → EO 缓存(照片/静态资源命中) 或 回源
        → Cloudflare Pages (jianshuo-dev.pages.dev, 内容唯一真源)
```

映射规则与 Caddy 时代完全一致:`voicedrop.cn/*` = `jianshuo.dev/voicedrop/*`,
`/files/*` 透传,`/voicedrop/...` 一律 301 去前缀,`X-Forwarded-Host` 带给 Pages。

## 前置条件

- EO 套餐需含**边缘函数**能力(免费版不含,下单前确认套餐)。
- voicedrop.cn DNS 在 Cloudflare(zone `206722cd14c10dbaa28f35e9d933e287`),
  CNAME 接入模式不用换 NS,只要加 TXT 验证 + 两条 CNAME。

## 搭建步骤

1. **添加站点**:EO 控制台 → 添加站点 `voicedrop.cn` → 选含边缘函数的套餐 →
   **CNAME 接入** → 按提示在 Cloudflare 加 TXT 记录验证归属权。
2. **添加加速域名**:`voicedrop.cn` 和 `www.voicedrop.cn`,源站选 IP/域名:
   `jianshuo-dev.pages.dev`,回源 HOST 保持同名(默认)。
3. **部署边缘函数**:边缘函数 → 新建,粘贴 `edge-function.js` →
   触发规则:HOST `voicedrop.cn`、`www.voicedrop.cn`,PATH `/*`。
4. **缓存规则**(规则引擎/缓存配置,按客户端 URL 匹配,顺序即优先级):

   | 匹配 | 动作 |
   |---|---|
   | `/files/api/photo/*`、`/files/api/asset/*` | 缓存,**遵循源站 Cache-Control**(源站对缺失照片发 no-cache,见 `functions/files/api/[[path]].js`;命中后 TTL 建议 ≥1 天) |
   | `/files/api/*` 其余全部 | **不缓存**(Bearer 鉴权接口,缓存即串号——这是唯一会出安全事故的一条) |
   | 后缀 js/css/png/jpg/jpeg/ico/gif/svg/woff/woff2/apk | 缓存 1 天+ |
   | 默认(HTML、`/<分享id>`、`/.well-known/*`) | **不缓存**(分享页按访问打点 + og 动态渲染,见 `functions/voicedrop/[token].js`;Pages 发版即生效,无需 purge) |

5. **HTTPS**:EO 申请免费证书,强制 HTTPS,开 HTTP/2。
6. **DNS 切换**(Cloudflare,两条都 proxied=false,TTL 300):
   - `voicedrop.cn` CNAME → EO 分配的调度域名
   - `www` CNAME → 同上
   切换前旧 A 记录(49.235.147.96)先留着不删,方便回滚后改回。

## 验证清单(切换后逐项过)

```
curl -i https://voicedrop.cn/                     # 200,落地页,页脚备案号
curl -i https://voicedrop.cn/help/                # 200
curl -i https://voicedrop.cn/voicedrop/help/      # 301 → /help/(去前缀)
curl -i https://voicedrop.cn/.well-known/apple-app-site-association
                                                  # 200,application/json,无跳转
curl -i https://voicedrop.cn/<某分享id>            # 200,og 标签正确
curl -i https://voicedrop.cn/files/api/photo/<某张照片key>
                                                  # 200 且 EO-Cache-Status: HIT(第二次)
```

再人工过三项:**微信里打开分享页**(不弹「非官方网页」,照片秒开)、
**App 登录/上传**(POST 穿透,确认音频上传成功)、
**PostHog「分享页访问」事件**(确认 IP 不是 EO 节点——EO 回源默认带
EO-Connecting-IP / XFF,Pages 读 XFF 首段,应当是真客户端 IP)。

## 回滚(EO 出问题)

Cloudflare 把 `voicedrop.cn` 和 `www` 改回 A 记录 `49.235.147.96`(proxied=false)
——前提是 VPS 还在、Caddy 还在跑,见 `infra/voicedrop-cn/README.md`。
VPS 已释放则按那边的重建步骤先恢复,或临时切 CF 直连(那边 README 有命令)。

## 监控

voicedrop-agent worker 的 */5 cron 探活 `https://voicedrop.cn/`,与接入层无关,无需改动。

---

## 已部署状态(2026-07-20 凌晨,Claude 实施)

上面是方案,以下是实际部署产物(全部可用 eo.mjs 查询/复现):

| 项 | 值 |
|---|---|
| ZoneId | `zone-3sqpugiqdegc`(CNAME 接入,大陆区,个人版+按量边缘函数) |
| 加速域名 | `voicedrop.cn` / `www.voicedrop.cn`,源站 `jianshuo-dev.pages.dev`,HTTPS 回源,回源 HOST=pages.dev |
| EO CNAME | `voicedrop.cn.eo.dnse0.com` / `www.voicedrop.cn.eo.dnse0.com` |
| 边缘函数 | `ef-twt1wxxe`(内容=本目录 edge-function.js),触发规则 rule-t54qd0ec(两 host 全路径) |
| 缓存规则 | `rule-3sqtstkogxd7`(创建 payload=本目录 cache-rules.json,四分支 if/elif) |
| 强制 HTTPS | 301,全局 ModifyL7AccSetting;HTTP/2 默认已开 |
| 证书 | 腾讯云 SSL `ZKx0XVNA`(Let's Encrypt RSA2048,lego 经 CF DNS-01 签发,2026-10-18 到期) |
| DNS | Cloudflare 两条 CNAME → 上面 EO CNAME,proxied=false,TTL 300(2026-07-20 切换) |

**证书的坑:** `eofreecert` 免费证书在 DNS 未指向 EO 前会一直卡 `applying`(DCV 过不了)。
零中断做法 = 本机 `lego --dns cloudflare` 签 LE 证书 → ssl:UploadCertificate →
teo:ModifyHostsCertificate(Mode=sslcert) → 验证 → 切 DNS。切换稳定后可改回
`eofreecert` 让 EO 自动续期(否则 90 天后要手动续 LE)。

**条件表达式的坑(CreateL7AccRules):** 顶层 Branches 最多 1 个,elif 链放
SubRules[].Branches[];路径通配用 `${http.request.uri.path} in ['/xx/*']`(`like` 不支持);
默认分支 Condition 写 `"*"`。

**回滚:** Cloudflare 把两条记录改回 `A 49.235.147.96`(VPS Caddy 未动,仍可接管);
或按 infra/voicedrop-cn/README.md 重建。

**注意:** 那台 VPS 上还跑着 safari-proxy(国内出口正向代理 :8888,见记忆库
safari-proxy-cn)——释放机器前先确认不再需要它。
