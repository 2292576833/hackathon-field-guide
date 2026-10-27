# 赛事首屏读取性能 · 交付登记

日期：2026-10-12。本轮精确授权：`event-discoveries.tsx`、`realtime-discovery.spec.ts`，可新增纯算法`event-feed-refresh.ts/.test.ts`，以及本交付。根处理通用请求去重、导航员按需加载、服务器压缩与接口组合。本会话不构建/重启或操作生产登录/数据库。

## NEEDS_INTERFACE · 已先登记，根已接收

`GET /api/v1/event-discoveries?limit=60[&cursor=...]` 的原数据增加`version: string`，保持`items`和`nextCursor`不变。

- `version`使用与`GET /api/v1/event-discoveries/live`完全相同的**全部active卡片**版本算法：按id排序，以`id:revision:last_analyzed_at`聚合后生成当前版本值。它不是本页、limit、query或cursor的局部版本。
- 列表卡片及此版本须来自同一次数据库读取快照（例如单SQL的共同CTE）。不可在列表完成后单独读取/拼上live缓存版本，后者会把列表未包含的并发更新误当已读取，漏掉首屏加载竞争。
- 接口保持公开只读；不初始化账本、不触发采集/模型，不按日期、报名或开赛状态过滤。live原有一秒只读缓存与3秒客户端可见轮询继续保留。
- 客户端可兼容旧响应无version：为避免漏更新仅保守补读一次。稳定首屏一次大列表读取的收益以根组合新字段为条件。

基线`.runtime/performance-baseline.json`中的`/events`出现两次`event-discoveries?limit=60`，每次decoded 117345 bytes、transfer 117645 bytes；开始时刻82ms与143ms。首次live在82ms开始、19ms后返回，原`previous===null`触发第二次大列表读取。

主会话已确认接收该接口，并由根负责在同一SQL语句中组合全部active版本及分页卡片；空列表也返回版本。本会话未修改服务器实现。

## 已完成

- `event-discoveries.tsx`比较列表快照版本与live版本，稳定首屏不再因首次live响应触发第二次大列表读取；列表先返回、live先返回、空列表均覆盖。
- 同一页的列表请求合并；手动重试和live检查复用在途读取，不重复调用通用`useApi.reload`取消自己。换页或卸载时终止旧页读取，旧响应不能覆盖当前页。
- 本地观察序号记录列表开始后收到的版本变化。列表完成后，若仍有未覆盖的新版本，立即补读；连续更新或隐藏后恢复也不会丢掉已观察的更新。服务器版本是不可排序的hash，不能当作时间序号。
- 读取开始前的观察在成功后确认已处理，避免live一秒缓存返回较旧hash时持续重读；缺少version的旧服务响应保留一次保守补读。
- 保留可见页3秒轮询、10秒读取超时、失败后同版本自动重试、原卡片与展开状态，以及历史页的新结果提示和明确返回最新操作。所有操作均为GET，已截止、报名不明等真实保存卡片继续显示。
- `realtime-discovery.spec.ts`夹具将卡片与version共同冻结后再延迟传输，能实际复现列表旧快照与新live交错；移除了对已取消的公开后台状态面板的旧断言。

## 已验证与边界

- `node --experimental-strip-types --test src/components/event-feed-refresh.test.ts`：6/6通过。覆盖相同/空版本、在途新版本、缓存旧hash、失败重试、历史页、旧响应兼容。
- `node node_modules/typescript/bin/tsc --noEmit`：全项目类型检查通过。当前环境`npm run typecheck`的`tsc`命令shim不可用，因此直接使用已安装的同一TypeScript入口完成检查；未安装或更换依赖。
- `realtime-discovery.spec.ts`：17/17浏览器用例通过，38.6秒。使用临时HTTP夹具装载本次实际赛事组件、实际client-api/刷新算法/报名时间函数；页面壳、认领组件、Next Link与CSS为隔离替身，API由Playwright路由夹具提供。此结果证明组件请求与阅读行为，不代表整站生产构建、视觉或真实后端验收。
- 临时编译/服务脚本及测试输出位于系统临时目录，没有执行网站build、重启生产服务、访问生产登录/数据库或调用真实模型。隔离服务器验收后关闭。
- 稳定首屏列表读取从基线2次变为夹具验证1次。未声称公网耗时改善幅度；根需将服务器version与压缩、通用请求合并一起构建，复测真实`/events`网络传输和页面加载。

## 未接入 / 所需环境变量

- 无新增环境变量。浏览器验收通过既有`E2E_BASE_URL`指向隔离测试服务；不含真实密钥。
- 服务器接口、压缩、应用构建/切换与真实性能复测由主会话组合。本会话交还上述四个代码/测试文件及本交付，不沿用旧授权继续编辑。

**STOP：本轮修改与隔离验收完成，停止编辑，文件交还主会话。**
