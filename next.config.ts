import type { NextConfig } from "next";
const privateRuntimeFiles = [".runtime/**", ".env", ".env.*"];
// Build a review version without overwriting the output of the running website.
const buildDirectory=process.env.FIELD_GUIDE_BUILD_DIRECTORY;
if(buildDirectory&&!/^\.next(?:-[a-z0-9-]{1,40})?$/.test(buildDirectory)) throw new Error("Invalid build directory.");
const config: NextConfig = { ...(buildDirectory?{distDir:buildDirectory}:{}), agentRules: false, serverExternalPackages: ["@electric-sql/pglite", "pg", "nodemailer"],
  async headers() { return [
    // 代码更新后，浏览器若仍用缓存的旧 HTML/JS，会表现为"按钮点了没反应"这类假故障。
    // 因此页面 HTML 一律不缓存；带指纹的静态资源（/_next/static）不受影响。
    { source: "/((?!_next/static|_next/image).*)", headers: [{ key: "Cache-Control", value: "private, no-store, must-revalidate" }] },
    { source: "/app/join/:token", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "Cache-Control", value: "private, no-store" }] },
  ]; },
  // Instrumentation has no leading route slash, so the app-route glob does not cover it.
  outputFileTracingExcludes: { "/**": privateRuntimeFiles, instrumentation: privateRuntimeFiles, "next-server": privateRuntimeFiles } };
export default config;
