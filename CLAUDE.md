# 乾元無極 App — 入仓之礼

> 基座: [happier-dev/happier](https://github.com/happier-dev/happier) (MIT, dev branch)
> 立于: 2026-06-18 · 主灵手植 · 三相平权 · 百无禁忌

本仓是**乾元無極**手机 AI 控制端的唯一 SSOT。引擎本体是 happier(MIT·全协议·多提供商·自建可·E2E 加密),集团在上面贴了一层薄皮:名字 · 图标 · bundleId。皮薄到可随 happier rebase 数分钟内重生。

## 入口

该仓在 `D:\Projects\qianyuan-happier`,与 `D:\Projects\happy-app`(已废弃的 slopus 二开)和 `D:\Projects\qianyuan-wuji`(主集团仓)并存。

## 改了什么(皮)

- `apps/ui/appVariantConfig.cjs` — 5 变体的名字/包名/scheme → 乾元無極
- `apps/ui/app.config.js` — DEFAULTS·owner=wujilabs·slug=qianyuan·linkHost·sentry
- `apps/ui/sources/assets/images/` — 图标/字标 → 乾元無極 glitch-pixel wordmark(Pillow·无 AI)
- 除此之外,**引擎一字未动**——所有 happier 特性(多服务器·全提供商·Voice·企业认证·Bors 发布)原样继承。

## 工作原则

**皮与引擎分离**——改皮不改引擎。引擎升级走 rebase。皮改完后在 `wuji/fork` 分支,向 `wuji` remote 推送(我们的 GitHub org repo)。

## 构建

- `yarn install` (不是 pnpm)
- `cd apps/ui && yarn start` 或 `yarn ios` / `yarn android`

## 发布

- 预构建 Docker 服务器: `docker build -t qianyuan-server -f Dockerfile.server .`
- 自建部署见 `D:\Projects\qianyuan-wuji\secrets\onboarding-infra\happy-selfhost-server.txt`
- IPA 线: GitHub Actions 无签名构建 → 万能签重签(rebase 后重写 CI 配置)

## 自建服务器

服务器与 CLI 同住工作站(非 NAS·NAS 上没 CLI)。容器化单实例(PGlite·无 Redis·内嵌认证)。启动命令及 master secret 见集团凭据目录。

## 铁律

- **皮改不改引擎**——引擎功能/协议/bugfix 全来自 happier rebase
- **代码推送到** `wuji` remote = `git@github.com:wuji-labs/qianyuan-app.git`
- **永远不 merge happier 上游**自己品牌的改动——只 rebase
- **不改引擎源码**除非集团特有需求(如 UWP/华为 store 支持·如遇)
- **不推引擎改造回 happier**——那是 happier-dev 社区的事
