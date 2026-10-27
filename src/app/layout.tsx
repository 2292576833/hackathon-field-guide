import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "草根黑客松情报局",
  description: "看懂比赛、找到工具、分好任务，把想法一步步做出来。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
