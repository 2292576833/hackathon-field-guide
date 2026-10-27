"use client";
import { useEffect, useRef, useState } from "react";
import type { SupervisionReason, SupervisionState } from "./model.ts";
import type { SupervisionApiClient } from "./ports.ts";
import { createSupervisionApiClient, SupervisionApiError } from "./client.ts";
import styles from "./supervision.module.css";
const defaultClient=createSupervisionApiClient();
const LABELS: Record<SupervisionReason,string>={disabled:"自动AI建议未开启",membership_changed:"重新入队后需本人再次开启",archived:"归档只读",responsibility_unconfirmed:"先确认本人职责",plan_unavailable:"等待当前生效计划",plan_stale:"计划依据已变化，先核对",idle:"等待关键记录变化",unchanged:"本版本已经检查",cooldown:"等待下次可分析时间",daily_limit:"今日自动建议次数已用完",running:"请求处理中，请到空间AI查看",hold:"上次结果待核查，自动建议已暂停",assistant_busy:"空间AI正在处理上一条请求",not_configured:"DSH尚未配置",failed:"本次建议未完成，请到空间AI核对",suggested:"有新的DSH建议"};
export function TeamSupervisionPanel({projectId,accountKey,archived=false,client=defaultClient,onOpenAssistant}: {projectId:string;accountKey:string;archived?:boolean;client?:SupervisionApiClient;onOpenAssistant?:()=>void}) {
  const [state,setState]=useState<SupervisionState|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const current=useRef(state);current.current=state;
  // 注入的 client 只从 ref 读取，**不进 effect 依赖**：
  // 调用方每次渲染都会传一个新的 client 对象，若把它列进依赖，父组件每次重渲染都会重建 effect，
  // 而 effect 首行会清空 error —— 结果就是"读取失败"的提示一闪而过、用户根本看不到。
  const clientRef=useRef(client);clientRef.current=client;
  const flight=useRef(false),generation=useRef(0),uncertain=useRef(false);
  async function run(action:"read"|"check"|"enable"|"disable",token=generation.current) {
    const api=clientRef.current;
    if(flight.current)return;flight.current=true;setBusy(true);
    try {
      const result=action==="read"?await api.get(projectId):action==="check"?await api.check(projectId):await api.settings(projectId,{enabled:action==="enable",expectedRevision:current.current?.revision??0});
      if(token===generation.current){current.current=result;setState(result);setError("");uncertain.current=false;}
    } catch(reason){
      if(token===generation.current){
        // 对 `instanceof` 加防御：`SupervisionApiError` 来自被注入的模块，若该模块被替换或未导出这个类，
        // 直接写 `instanceof SupervisionApiError` 会抛 "Right-hand side of 'instanceof' is not an object"，
        // 使 catch 在 setError 之前中断——用户就再也看不到失败提示了。
        const status=typeof SupervisionApiError==="function"&&reason instanceof SupervisionApiError?reason.status:0;
        if([401,403,404].includes(status)){current.current=null;setState(null);}
        setError(reason instanceof Error?reason.message:"状态待核对。");uncertain.current=true;
      }
    }
    finally{if(token===generation.current){flight.current=false;setBusy(false);}}
  }
  useEffect(()=>{
    const token=++generation.current;flight.current=false;uncertain.current=false;current.current=null;setState(null);setError("");
    void run("read",token);
    const tick=()=>{
      if(document.visibilityState!=="visible"||archived)return;
      const value=current.current;
      if(value?.reason==="archived")return;
      // Startup and visibility restoration are read-only; only the 30s tick can check enabled automation.
      const check=value?.enabled&&!uncertain.current&&!["hold","running","archived","membership_changed","responsibility_unconfirmed","plan_unavailable","plan_stale"].includes(value.reason);
      void run(check?"check":"read",token);
    };
    const visible=()=>{if(document.visibilityState==="visible"&&!archived&&current.current?.reason!=="archived")void run("read",token);};
    const timer=window.setInterval(tick,30_000);document.addEventListener("visibilitychange",visible);
    return()=>{generation.current++;window.clearInterval(timer);document.removeEventListener("visibilitychange",visible);};
  },[projectId,accountKey,archived]);
  return <section className={styles.root} aria-label="团队协作护航">
    <div className={styles.head}><strong>团队护航</strong><details><summary aria-label="护航设置">⋯</summary><div className={styles.options}>
      <p>开启后，DSH根据关键记录变化给你建议，间隔至少10分钟，每天最多24次，继续受模型预算限制。建议保存在你的空间AI对话，共享须由你选择。</p>
      <button type="button" disabled={busy||archived||state?.reason==="archived"||!state} onClick={()=>void run(state?.enabled?"disable":"enable")}>{state?.enabled?"关闭自动AI建议":"开启自动AI建议"}</button>
      <button type="button" disabled={busy} onClick={()=>void run("read")}>刷新记录</button>
    </div></details></div>
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {!state&&!error&&<p role="status">正在核对协作记录…</p>}
    {state&&<>
      <p className={styles.status} role="status">{error?"协作记录待核对":LABELS[state.reason]}</p>
      {!!state.hints.length&&<><span className={styles.source}>{error?"规则提示 · 上次记录，当前待核对":"规则提示 · 当前记录"}</span><ul>{state.hints.slice(0,4).map(hint=><li key={hint.id}><strong>{hint.title}</strong><span>{hint.detail}</span></li>)}</ul>
        {state.hints.length>4&&<details><summary>其余{state.hints.length-4}项</summary><ul>{state.hints.slice(4).map(hint=><li key={hint.id}><strong>{hint.title}</strong><span>{hint.detail}</span></li>)}</ul></details>}</>}
      {state.report&&<details data-provider="dsh"><summary>DSH生成的建议 {(state.report.stale||!!error)&&"· 依据已变化或待核对"}</summary><p className={styles.report}>{state.report.content}</p></details>}
      {(state.holdRequestId||state.report||state.reason==="running"||state.reason==="assistant_busy")&&onOpenAssistant&&<button className={styles.link} type="button" onClick={onOpenAssistant}>到空间AI查看</button>}
    </>}
  </section>;
}
