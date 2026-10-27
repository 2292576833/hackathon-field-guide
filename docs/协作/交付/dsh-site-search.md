# DSH 站内关键词检索交付

交付日期：2026-10-09。仅新增 `src/server/site-search.ts`、`src/server/site-search.test.ts` 和本报告；导航员、应用组合、来源 reader、公开接口和 UI 由主会话及其最新授权代理完成。本轮交付后停止编辑，授权文件交还。

## 已完成

- 导出 `SiteSearchDocument`、`SiteSearchItem`、`SiteSearchResult`、`getSiteSearchDocuments()`、`searchSiteDocuments(query, documents?)` 以及 `SITE_SEARCH_MAX_RESULT_BYTES=12288`。
- 内置 17 份资料：6 篇 `LIBRARY_ARTICLES` 原创全文及 steps，11 份明确标记为“网站功能说明”的入口介绍；原始文章日期从原记录读取，自写说明不编造更新时间。
- 中文关键词/短语、相关词别名和英文整词检索，NFKC 支持全角英文。示例拉队友/链接邀请/二维码/先干什么→团队空间，Git 冲突/拉取→GitHub 与实际协作指南，PPT 模板、路演讲稿、报名、新人均有相关资料。
- 标題、摘要、正文与关键词分字段加权，稳定排序；score 仅检索排序，不是个人能力或匹配概率。常见中英文停用词不会让所有文档命中。
- 摘录为所提供 summary/body 中连续的真实片段，不用生成回答充当原文；NFKC 匹配映射回原文位置，保留原全角/中文内容。
- 确定性只读纯函数：不读数据库、不扫描文件系统或 docs/AGENTS/env、不调模型、不联网、不执行来源内容、不写任务进度。
- 有界：查询 ≤2000 UTF-16 字符，输入集合前 512 份（覆盖根受控来源 320+17+10），正文最多 16000 字符、每源 64 段、关键词 32 个；输出最多 6 条，摘录 ≤760 UTF-8 字节，完整结果 JSON ≤12KiB。
- 无命中明确返回空 items 与说明；范围只表示传入集合，不声称检索全站所有资料。
- href 限合法站内读取/导航入口，拒绝外链、协议相对链接、反斜线/控制字符、未知路由、API/后台、路径穿越、双编码/编码分隔符、未知或重复参数。

## 契约

```ts
interface SiteSearchDocument {
  id: string; title: string; href: string; sourceType: string;
  summary: string; body?: string | readonly string[];
  keywords?: readonly string[]; updatedAt?: string;
  scope: "public" | "current_project";
}
interface SiteSearchItem {
  id: string; title: string; href: string; sourceType: string;
  scope: "public" | "current_project"; excerpt: string;
  matchedTerms: readonly string[]; score: number; updatedAt?: string;
}
interface SiteSearchResult {
  items: readonly SiteSearchItem[]; notices: readonly string[];
  coverage: {
    searchedDocuments: number; returnedDocuments: number;
    scope: "provided_documents";
  };
}
```

所有字段在实际导出类型中为 readonly；主会话如需合并来源不可读 notices，构造新对象，不能赋值 readonly 字段。`searchSiteDocuments(query, documents)` 仅使用完整显式集合，不自动添加其他静态或私密来源；默认参数才使用内置资料。重复 ID 保留首个有效文档。

静态 ID：`library:<slug>`；功能入口 `site:journey/app/github/events/resources/inspiration/skills/roadshow/ppt/account/participation`。这不是新建真实文章或认证来源的声明。

## NEEDS_INTERFACE

1. 根 reader 仅提供可公开持久数据；当前项目摘要须在读取前后校验活跃成员与请求会话。检索函数不自行判断 Actor 权限，绝不能把请求 JSON 当已授权语料。
2. 额外来源文本、元数据、摘录、用户关键词都当不可信数据。DSH 固定系统提示不能被来源中的操作要求覆盖，模型仍没有执行权限。
3. 结果链接只用已给定 IDs 选择。当前空间结果 href 仅接受 `scope:current_project` 的 `/app/projects/<id>` 及 rules/team/assessment/plan/delivery/resources/retrospective 子路由和安全锚点。
4. 已确认动态赛事卡片没有 `/events/<discoveryId>` 详情，来源 reader 使用真实 `/participation?event=<64位hex>`；技能固定版本 `/skills/<id>?versionId=<固定版本>`；路演/PPT/GitHub 可带安全 projectId。灵感 `/inspiration`、资源 `/resources/<id>`；其他公开页不添加未知 query。
5. 本模块返回的完整 JSON 已预算到 12KiB。根后续若增加 notices/coverage/包装，应再次控制最终模型引用字节；不得把原 body 全量追加回模型输入。
6. 当前错误 `INVALID_SITE_SEARCH_QUERY` / `INVALID_SITE_SEARCH_CORPUS` 为 422。无命中是正常空结果，不自动重试收费模型。

## 已验证

- `node --experimental-strip-types --test src/server/site-search.test.ts`：13/13 通过。
- 最终 `npm run typecheck` 通过（根导航员/reader接入同时在目录中）。
- 隔离测试覆盖原文保真、中文与英文/全角、Git/PPT/路演检索、停用词与无命中、英文边界、显式权限语料隔离和输入不变、不可信文字、危险 href、合法动态链接、347 份来源尾部覆盖、512 上限、Unicode 字节预算及重复 ID。

浏览器及真实 DSH 调用由主会话统一验收；本代理没有 build/start/restart、访问生产 PGlite 或调用外部服务。无新增环境变量。
