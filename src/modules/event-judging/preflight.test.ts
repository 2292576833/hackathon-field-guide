import assert from "node:assert/strict";
import test from "node:test";
import { blockingIssues, submissionPreflight } from "./preflight.ts";

const sha = (letter: string) => letter.repeat(64);
const good = { title: "校园助手", description: "一个可运行的演示，含登录与任务看板。",
  links: [{ label: "演示视频", url: "https://example.test/demo" }, { label: "代码仓库", url: "https://example.test/repo" }],
  files: [{ name: "提交说明.pdf", url: "https://example.test/spec.pdf", sizeBytes: "2048", sha256: sha("a"), mediaType: "application/pdf" }] };

test("合规的草稿不产生任何问题，也不产生多余请求前拦截", () => {
  assert.deepEqual(submissionPreflight(good), []);
  assert.deepEqual(blockingIssues(submissionPreflight(good)), []);
});

test("一次列出全部阻断问题，而不是只报第一个", () => {
  const issues = blockingIssues(submissionPreflight({ title: "   ", description: "", links: [{ label: "", url: "http://example.test/insecure" }, { label: "第二个", url: "ftp://example.test/x" }],
    files: [{ name: "", url: "https://example.test/a", sizeBytes: "-1", sha256: "abc", mediaType: "" }] }));
  const fields = issues.map(issue => issue.field);
  assert.ok(fields.includes("title"), "缺少作品名称应被列出");
  assert.ok(fields.includes("description"), "缺少作品说明应被列出");
  assert.ok(fields.includes("links.0.label"));
  assert.ok(fields.includes("links.0.url"), "非 HTTPS 应被列出");
  assert.ok(fields.includes("links.1.url"), "第二个链接的问题也必须一起列出");
  assert.ok(fields.includes("files.0.name"));
  assert.ok(fields.includes("files.0.sizeBytes"));
  assert.ok(fields.includes("files.0.sha256"));
  assert.ok(fields.includes("files.0.mediaType"));
  assert.ok(issues.length >= 9, `应一次列出至少 9 项，实际 ${issues.length} 项`);
});

test("超长与数量上限与服务器口径一致", () => {
  const many = Array.from({ length: 13 }, (_, index) => ({ label: `链接${index}`, url: `https://example.test/${index}` }));
  const files = Array.from({ length: 13 }, (_, index) => ({ name: `f${index}`, url: `https://example.test/f${index}`, sizeBytes: "10", sha256: sha("b"), mediaType: "text/plain" }));
  const issues = blockingIssues(submissionPreflight({ ...good, links: many, files }));
  assert.ok(issues.some(issue => issue.field === "links" && /最多提供 12 个链接/.test(issue.message)));
  assert.ok(issues.some(issue => issue.field === "files" && /最多提供 12 份/.test(issue.message)));
  const longTitle = blockingIssues(submissionPreflight({ ...good, title: "题".repeat(161) }));
  assert.deepEqual(longTitle.map(issue => issue.field), ["title"]);
  const longDescription = blockingIssues(submissionPreflight({ ...good, description: "说".repeat(12001) }));
  assert.ok(longDescription.some(issue => issue.field === "description"), "超过 12000 字必须拦住");
});

test("空行链接不算提交内容，但填了就必须合规", () => {
  assert.deepEqual(submissionPreflight({ ...good, links: [...good.links, { label: "", url: "   " }] }), []);
  const issues = blockingIssues(submissionPreflight({ ...good, links: [{ label: "写了名称但地址不完整", url: "example.test/demo" }] }));
  assert.deepEqual(issues.map(issue => issue.field), ["links.0.url"], "地址非空但不完整时必须拦住，而不是当成空行忽略");
  assert.match(issues[0]!.message, /不是完整地址/);
});

test("重复地址与重复文件哈希只提示、不阻断", () => {
  const issues = submissionPreflight({ ...good, links: [good.links[0]!, good.links[0]!], files: [good.files[0]!, { ...good.files[0]!, name: "副本.pdf" }] });
  assert.deepEqual(blockingIssues(issues), [], "重复登记不是服务器拒绝的理由，不能拦住提交");
  assert.equal(issues.filter(issue => issue.severity === "warn").length, 2);
  assert.ok(issues.every(issue => /重复出现|出现了两次/.test(issue.message)));
});

test("材料总长度超过 24KB 时阻断，并给出实际字节数", () => {
  const issues = blockingIssues(submissionPreflight({ ...good, description: "长".repeat(9000), links: [{ label: "说明", url: `https://example.test/${"x".repeat(2000)}` }] }));
  assert.ok(issues.some(issue => issue.field === "materials" && /超过 24000 字节/.test(issue.message)));
});

test("控制字符与带账号密码的地址都被拒绝", () => {
  assert.deepEqual(blockingIssues(submissionPreflight({ ...good, title: "标题\u0007" })).map(issue => issue.field), ["title"]);
  assert.deepEqual(blockingIssues(submissionPreflight({ ...good, links: [{ label: "带凭据", url: "https://user:secret@example.test/x" }] })).map(issue => issue.field), ["links.0.url"]);
});
