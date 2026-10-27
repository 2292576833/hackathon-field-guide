# 参赛名片与招募（R01）

提供默认私人参赛职责、目的、简历和作品链接，选填MBTI/年龄/头像；DSH归纳仅生成本人可编辑预览。公开名片由本人明确发布独立快照，私人资料/头像变更不自动影响公开快照，可撤回。公开名单只显示当前发布且账号活跃的投影，不返回邮箱、原始画像或简历。年龄/MBTI不用于筛选、评分或AI推断。

活跃空间管理员明确发布本人填写的招募描述；申请、撤回、审核、明确加入分别持久保存。批准不自动授予成员权。申请人确认加入时再次复核空间、申请、批准者当前管理权和账号；根`RecruitingProjectsPort.joinApproved`同事务组合M02的限本人member邀请/接受。已经使用的申请不能在退出后重新加入。批准/加入名额在帖子行锁下检查，重复申请操作标识不可用于不同内容。

## 根组合

`index.ts`为服务出口，`ui.ts`为客户端界面出口，两者分开避免客户端加载数据库服务。使用`createRecruitingService({database,identity,participant,projects,ai,clock,ids})`。ai为共享`PersonalAiPort`，`profile_summary`请求由`recruitingSummaryRequest`给出，只有明确生成调用会访问模型；根保留持久预算/私有artifact/未知结果hold。

SQL建议：`migrations/001_recruiting.sql`，仅由根复制为新的真实迁移号并应用。每个身份、画像、项目Port必须使用传入executor及约定锁序，不能打开独立连接或读取未经授权的私人表。

头像保存会使用已有Next.js依赖`sharp`完成本地真实解码（本轮未安装任何依赖），拒绝仅伪造文件头或损坏压缩内容。仅服务端导入，客户端不读取它。生产依赖打包由根统一复核。

`createRecruitingHttpHandlers`由根注入`resolveSession(request)`返回`{actor,guard}`，每次私有动作都会复核当前会话；写操作由根`authorizeMutation`执行CSRF/origin检查。`recruitingHttpRoute`识别`/api/v1`之后的路径；不存在自动收费GET。JSON普通64KB，头像传输720KB；头像本体限制512KB、2048×2048、PNG/JPEG/静态WebP，不接收SVG、外链或可执行内容。图片输出固定MIME、nosniff、sandbox、no-store，公开图片必须核对发布状态和revision；公开撤回后旧地址404。

## 验证边界

Node内置测试配合独立内存PGlite，既不打开生产PGlite，也不调用真实模型/邮件。该引擎验证SQL及事务回滚，但不能代替真实多连接PostgreSQL的并发验收。实际入口、根DSH和M02适配、真实模型质量、375px/桌面浏览器完整走查均由主会话组合验收。详细结果见`docs/协作/交付/recruiting.md`。
