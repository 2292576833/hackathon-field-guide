# 持久化建议

路演使用共享 PersonalAiPort 已有的个人 artifact 存储，种类固定为 `roadshow`。本模块不新增表、不运行迁移，不保存另一份成功状态或重复用户输入。

协调服务应在同一个私人生成记录中保存 `RoadshowDocument { input, script }`，账号所有权、会话复核、DSH 来源、费用预算和未知请求 hold 由个人工作区实现承担。`input` 必须来自服务端 validator 闭包，不能采用模型给出的 wrapper。若当前根迁移尚未允许 `roadshow` kind，由主会话新增递增迁移，不重写已应用迁移。

恢复历史与 PPT 交接均通过当前账号的 owner-checked `get`；无公开查询与跨账号读取迁移需求。不可将 memory fixture 作为真实试用存储。
