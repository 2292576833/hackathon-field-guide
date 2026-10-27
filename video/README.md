# 项目纪录视频（Remotion）

《草根黑客松情报局》项目纪录短片：讲清**项目为什么存在**和**已经解决了什么**。

- **成品（4K）**：`../docs/宣传/项目纪录视频-4K.mp4`
- **成品（1080p，首版）**：`../docs/宣传/项目纪录视频.mp4`
- **脚本（含每条内容的依据）**：`脚本.md`
- **音乐**：`public/music.mp3`（艾拉拉_Luv4 - 千年之后，320kbps ≈ 134.4 秒）
- **规格**：**3840×2160** / 30fps / **3540 帧（118 秒）** / h264 + aac

## 清晰度是怎么保证的

1. **原生 4K 渲染**：`WIDTH/HEIGHT = 3840×2160`，文字与矢量元素按 4K 渲染，不是放大 1080p。
2. **页面截图 2 倍像素**：`public/shots4k/*.png` 是 **3840×2160** 的真实截图。
   采集要点（两个都必须设，否则仍是 1920 宽）：
   - 自建上下文时传 `deviceScaleFactor: 2`（夹具自带的 `page()` 固定 dpr=1，不能用）；
   - `page.screenshot({ scale: "device" })` —— **Playwright 默认按 CSS 像素输出**。

## 节奏与连贯性

- **入场曲线**：`theme.REVEAL_FRAMES = 13`（0.42 秒），从首版的 0.75 秒收紧；内容提前上屏，留白压到 2~4 秒。
- **幕间过渡**：`ui.SceneFrame` 包住每一幕，入场 0.15 秒淡入、收尾 0.25 秒淡出，
  避免深色幕与纸色幕硬切"闪一下"；第一幕与第六幕的背景已统一到同一纸面底。
- **音乐淡出**：`ProjectRecord` 用 `volume` 回调在最后 300 帧淡出，画面收在 118 秒，
  不留"画面已结束还在放歌"的空白。

## 目录结构

```
video/
├─ 脚本.md                 分幕脚本 + 每句话的依据来源
├─ package.json            独立依赖（不进入主项目，避免影响 Next.js 构建）
├─ remotion.config.ts      渲染配置（jpeg 中间帧、concurrency 2、swangle 软件渲染）
├─ tsconfig.json
├─ public/
│  ├─ music.mp3            背景音乐
│  ├─ shots4k/             4K 真实截图（3840×2160，视频在用）
│  └─ shots/               1080p 旧截图（首版使用，保留备查）
└─ src/
   ├─ index.ts             registerRoot
   ├─ Root.tsx             Composition 注册（id: ProjectRecord）
   ├─ ProjectRecord.tsx    时间轴 + 音频淡出 + 时间轴自检
   ├─ theme.ts             设计令牌、4K 规格、时长、入场曲线常量
   ├─ ui.tsx               背景 / 幕间过渡 / 淡入上移 / 逐行出现 / 标签 / 标题
   ├─ SceneProblem.tsx     ① 问题
   ├─ SceneIntro.tsx       ② 它是什么
   ├─ SceneJourney.tsx     ③ 参赛主路径（六段）
   ├─ SceneSpace.tsx       ④ 团队空间（九类组件）
   ├─ SceneCapabilities.tsx⑤ 今天能用的
   ├─ SceneHonesty.tsx     ⑥ 诚实的边界（真实未完成项）
   └─ SceneOutro.tsx       ⑦ 收尾（真实统计数字）
```

## 时间轴（118 秒）

| 幕 | 起始帧 | 时长 |
| --- | --- | --- |
| 问题 | 0 | 420（14 秒） |
| 它是什么 | 420 | 420（14 秒） |
| 参赛主路径 | 840 | 522（17.4 秒） |
| 团队空间 | 1362 | 870（29 秒） |
| 今天能用的 | 2232 | 588（19.6 秒） |
| 诚实的边界 | 2820 | 330（11 秒） |
| 收尾 | 3150 | 390（13 秒） |
| **合计** | | **3540（118 秒）** |

`ProjectRecord.tsx` 里的 `assertTimeline()` 会在渲染时校验总和：**任何改动导致总和不是 3540 帧就直接报错**，
避免出现黑帧或结尾被截断（首版就是靠它抓出 6 帧配平误差）。

## 常用命令

在 `video/` 目录下：

```powershell
npm.cmd install                              # 依赖（独立于主项目）

npm.cmd run studio                           # 本地预览
npx remotion render src/index.ts ProjectRecord ..\docs\宣传\项目纪录视频-4K.mp4 --codec=h264 --crf=18 --concurrency=2
npx remotion still src/index.ts ProjectRecord out.png --frame=1500   # 单帧排查排版
```

**渲染浏览器**：本机没有 Chrome，Remotion 默认会去下载 Chromium（约 100+ MB）。
本机用系统 Edge 代替，渲染前设置：

```powershell
$env:REMOTION_BROWSER_EXECUTABLE = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
```

## 截图从哪来

`public/shots4k/*.png` 由 `tests/e2e/zz-record-shots4k.spec.ts` 用 Playwright 在**真实站点**上采集
（3840×2160），不包含任何合成或示意图形。
截图里出现的是隔离测试空间的示例数据，不是真实用户数据。

## 内容原则（写脚本时必须遵守）

1. **每一句都要有依据**：数字来自仓库实际统计，能力只列已实现并验证过的。
2. **未完成就说未完成**：第六幕专门列真实未完成项，不把它们说成已完成。
3. **不出现**：编造的用户数、获奖、合作方；真实用户隐私信息。
4. 配色沿用项目设计令牌（纸色 `#f6f3eb`、墨色 `#21201c`、品牌 `#ef4d2e`、动作 `#b8351e`），
   与网站是同一种气质。

## 已知边界

- 本片是**无声旁白**版：只有音乐铺底，正文以画面文字呈现。若后续要配音，需要在每幕加
  `<Audio>` 人声轨并按本表时间轴对齐。
- 音乐为第三方作品（艾拉拉_Luv4 - 千年之后），仅作本项目内部纪录用途；
  对外发布前请自行确认授权。
- 4K 渲染对机器要求较高：本机用 Edge 软件渲染（swangle），3540 帧约需 20~40 分钟。

