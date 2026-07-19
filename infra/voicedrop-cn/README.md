# voicedrop.cn 备案接入点(腾讯云反代)

> **计划迁移到 EdgeOne 替代本机,方案见 `infra/voicedrop-cn-edgeone/`。**
> 迁移完成前本目录仍是线上真相;迁移后保留作回滚 runbook。

**这台机器随时可能释放——本目录是全部真相,照此可 10 分钟重建。**

## 架构

```
微信用户 → voicedrop.cn (DNS A → 腾讯云机器, 国内解析, 备案一致)
        → Caddy 反代 (本目录 Caddyfile)
        → Cloudflare Pages (jianshuo-dev.pages.dev, 内容唯一真源)
```

- 整站映射:`voicedrop.cn/*` = `jianshuo.dev/voicedrop/*`,对外只暴露干净路径
  (`/voicedrop/...` 一律 301 去前缀;`/files/*` 接口与图片透传;其余补前缀取内容)
- `X-Forwarded-Host` 带真实域名给 Pages Functions(og 标签 / host 路由)
- 分享短链 `voicedrop.cn/<id>` 由 files API mint(`share` 端点)
- 备案号页脚在 `voicedrop/index.html`(沪ICP备06019413号-118)

## 当前实例

- IP:`49.235.147.96`(腾讯云,用户 `ubuntu`,Claude 的 Mac 公钥已加 authorized_keys)
- 端口:80/443 已在腾讯云防火墙放行(重建时记得重新放行!)
- 证书:Caddy 自动 Let's Encrypt(HTTP-01,依赖 80 端口 + DNS 已指向本机)

## 重建(机器没了)

1. 新开一台 Ubuntu(腾讯云,保持国内接入 → 备案有效),防火墙放行 TCP 80/443
2. 把本目录拷上去,跑 `sudo bash setup.sh`
3. Cloudflare 改 DNS(zone `206722cd14c10dbaa28f35e9d933e287`):
   `voicedrop.cn` 和 `www` 的 A 记录 → 新 IP,proxied=false,TTL 300
4. 几分钟内 Caddy 自动签好证书,验证:
   `curl https://voicedrop.cn/`(落地页)、`/help/`、`/<某分享id>`、页脚备案号

## 回滚(不要箱子/箱子挂了,临时切回 CF 直连)

```
curl -X PUT "https://api.cloudflare.com/client/v4/zones/206722cd14c10dbaa28f35e9d933e287/dns_records/df5e6a24de7e7815d321e9c6c82d618f" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"CNAME","name":"voicedrop.cn","content":"jianshuo-dev.pages.dev","proxied":true}'
```
CF 直连下分享短链照常(functions/[token].js 兜底),整站映射退化为仅短链 + 根跳转;
微信可能恢复弹提示(域名解析出境)。

## Universal Links（2026-07-09）

- `https://voicedrop.cn/.well-known/apple-app-site-association` 走既有「补前缀」规则
  映射到 Pages 的 `voicedrop/.well-known/apple-app-site-association`（内容真源在
  jianshuo.dev repo），`_headers` 强制 application/json。重建机器后记得验证这条：
  `curl -i https://voicedrop.cn/.well-known/apple-app-site-association`（要 200 无跳转，
  Apple CDN 才取得到，App 里的链接拉起才工作）。
## 监控

voicedrop-agent worker 的 */5 cron 探活 `https://voicedrop.cn/`,连续 2 次不可达
→ APNs 推送报警到管理员 VoiceDrop(60 分钟静默去重),报警文案含本 README 指引。
