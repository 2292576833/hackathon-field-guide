# S3 · 流程指引重设计交付

日期：2026-10-12。依据规划28、宪法v1.17.0和主会话本轮精确授权。

## 已完成

- `SpacePathCanvas`新增`presentation?: "steps" | "canvas"`，默认`canvas`兼容旧调用。steps使用紧凑有序六步，窄手机单列；独立于画布坐标，不改写已有私人位置。
- canvas普通浏览不拖动；点击“调整流程布局”才出现独立移动抓手。节点正文可正常选取/复制，原生按钮onClick支持Enter和Space。抓手支持方向键移动，取消指针操作不保存。
- 新纯函数`deriveSpaceStepState`区分已有记录、需要复核、读取失败、读取中、尚未读取、当前建议与按需准备。只有非空步骤且全部fact为recorded才有`allRecorded: true`；UI使用“已有记录”，从不把阶段标为完成。review用复核提示，不显示“有人等你”或红色阻塞。
- 节点弹窗说明何时做、具体行动、怎样确认、下一步，并按需显示本节点入口和工具。关闭/Escape返回原触发控件焦点。
- 删除错误的`AvailabilityBlock`分钟数写入，复用根导出的`MyAvailabilityPanel`，由真实本人windows/timezone/availability revision契约保存。
- 比赛要求段复用`OfficialTrackPanel`。分工时间段就地选择职责与本人时间，并提供明确的完整职责分工/任务计划入口。执行段提供正式交接与检查页面入口。
- 新`findSpaceStepForNode`接受六阶段ID和树中真实行动ID。通过`onReady?: (openStep: (nodeId: string) => void) => void`向根暴露就地打开入口，覆盖goal、duties-time、applied-plan、start-task、handoff、check-unlock等；未知ID不打开错误节点。
- 归档时明确只读，并沿用已有组件的真实权限/归档写保护，不创建另一套任务或完成状态。

## 已验证

- Node内置测试：`step-state.test.ts`、`guide-tree.test.ts`、`canvas-layout.test.ts`合计32项通过。
- `node node_modules/typescript/bin/tsc --noEmit`通过；仅调用类型检查，没有生产构建、启停或数据库操作。
- 新测试覆盖unknown/loading/error不会变为成功、规则复核语义、混合事实优先级、空集合、当前建议不制造完成以及行动ID映射。

## 模拟测试与未接入

- 上述纯函数验证使用隔离事实夹具。未在本会话运行真实浏览器/375px实体手机、生产构建、重启或真实本人时间写入；由主会话整体验收记录结果。
- 现有guide-tree中的recorded表示“依据已保存”，不等于整个阶段任务完成。因此本轮严格使用“已有记录”，具体任务完成继续由有效检查事实判断。
- 完整分工与计划仍复用现有页面；这里的职责/时间表单不会把建议自动变为生效计划。

## NEEDS_INTERFACE

无需新增后台接口或迁移。已读取主会话提供的`MyAvailabilityPanel`公共组件导出。根应按默认协作视图传`presentation="steps"`，通过稳定`onReady`回调保存打开函数，并把待办的真实nodeId传给它。

## 文件与环境

仅修改本轮授权：

- `src/components/space-path-canvas.tsx`
- `src/components/space-canvas.module.css`
- 新`src/modules/space-workflow/step-state.ts`
- 新`src/modules/space-workflow/step-state.test.ts`
- 本交付文档

未新增依赖或环境变量，未安装、构建、迁移、启停、打开生产数据库。

状态：**交付，STOP。文件交还主会话，不沿用本轮授权继续编辑。**

## 追加 · 本人画布持久正确性

主会话追加仅授权`src/server/space-canvas-layouts.ts`、新`src/server/space-canvas-layouts.test.ts`与本交付记录。实际画布表确认来自`063_space_canvas_items.sql`，本轮未修改迁移。

- 读写事务复核真实active账号，账号与空间`FOR SHARE`；读取本人活跃成员`FOR SHARE`，保存本人活跃成员`FOR UPDATE`，在布局行尚不存在时也有可序列化的锁。账号停用或成员撤销后旧Actor不能继续读写。
- 请求及摆放项严格校验对象与allowed keys，拒绝伪造userId/业务完成状态、未知组件、错误类型、非法坐标/尺寸/版本、重复实例和控制字符。保存列表最多100项。
- 保存使用实际`INSERT/UPDATE ... RETURNING`结果，并校验实际影响一行。零行触发器导致409，没有假保存回执；同版本后来的保存也409，不覆盖赢家。
- GET仍只读且不初始化；归档空间允许本人私人摆放，不改任务、文档、归档或提交事实。
- 10项新测试在独立内存PGlite应用**真实063迁移**，覆盖本人/空间隔离、GET不初始化、初次并发、同版本并发、停用撤销、严格字段、归档偏好、零行INSERT/UPDATE与实际返回内容。全部通过；全局类型检查通过。
- PGlite自身序列化事务；上述并发测试不替代远程多连接PostgreSQL锁验收。未读取生产数据库目录、未实际迁移、未增依赖/配置、未构建或启停。

追加状态：**已交付，STOP。两份代码文件及本交付说明再次交还主会话。**
