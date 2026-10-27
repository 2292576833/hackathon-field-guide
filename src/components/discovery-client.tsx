"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { PageResult } from "../shared/contracts.ts";
import type { PublicEvent, ProjectRuleConfirmation, ProjectRuleChanges } from "../modules/events/model.ts";
import type { EventRuleVersion } from "../modules/events/domain.ts";
import { EventRulesPanel } from "../modules/events/EventRulesPanel.tsx";
import { EventCorrectionPanel, RuleChangesPanel } from "../modules/events/components.tsx";
import type { Resource, ResourceBookmark, ResourceBookmarkView, ResourceQuery } from "../modules/resources/domain.ts";
import { readResourceLocation, resourceCatalogHref, resourceDetailHref, resourceLocationParams } from "../modules/resources/navigation.ts";
import { findResourceBookmarks } from "../modules/resources/bookmark-lookup.ts";
import { ResourceCard, ResourceDetail, ResourceFilters, ResourceList, ResourceBookmarkEditor, ResourceProjectShare } from "../modules/resources/components.tsx";
import type { Project, ProjectResourceBookmark } from "../modules/projects/model.ts";
import type { ProjectDetail } from "./projects-client.tsx";
import type { Me } from "./site-shell.tsx";
import { ApiError, api, dateText, message, safeLink, useApi } from "./client-api.ts";
import { Empty, Feedback, Field, Loading, PageTitle, SiteShell } from "./site-shell.tsx";
import { EventDiscoveryFeed } from "./event-discoveries.tsx";
import { ProjectDiscoveryPanel } from "./project-discovery.tsx";
import { ResourceHub } from "./resource-hub.tsx";
import { ResourceFeedback, ResourceFeedbackHistory } from "./resource-feedback.tsx";
import styles from "./site.module.css";

function PublicNextSteps() {
  return <div className={styles.actions}><Link href="/library" className={styles.button}>先看新手教程</Link><Link href="/inspiration" className={styles.secondary}>找设计灵感</Link></div>;
}

/** Do not label a server-default timezone as the visitor's own time. */
function useRuleDisplayTimeZone(enabled=true) {
  const identity=useApi<Me>(enabled?"/me":null,{timeoutMs:10000});
  const [browser,setBrowser]=useState<{zone:string;fallback:boolean}|null>(null);
  useEffect(()=>{if(!enabled)return;try{const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;if(!zone)throw new Error();new Intl.DateTimeFormat("zh-CN",{timeZone:zone});setBrowser({zone,fallback:false});}catch{setBrowser({zone:"Asia/Shanghai",fallback:true});}},[enabled]);
  const accountZone=identity.data?.profile.timezone;
  let timeZone=browser?.zone??"Asia/Shanghai";
  if(accountZone){try{new Intl.DateTimeFormat("zh-CN",{timeZone:accountZone});timeZone=accountZone;}catch{/* Keep the explicitly labelled browser timezone if the account value is invalid. */}}
  const ready=!enabled||(!identity.loading&&browser!==null);
  const label=accountZone===timeZone?`时间换算使用你的账号时区：${timeZone}。`:browser?.fallback?"无法确定浏览器时区，以下换算明确使用北京时间。":`时间换算使用浏览器时区：${timeZone}。`;
  const localTimeLabel: "账号时间"|"浏览器时间"|"北京时间"=accountZone===timeZone?"账号时间":browser?.fallback?"北京时间":"浏览器时间";
  return {ready,timeZone,label,localTimeLabel,viewerId:identity.data?.profile.id??null};
}

export function EventsClient({eventId}:{eventId?:string}){
  const displayTime=useRuleDisplayTimeZone(Boolean(eventId));
  const detail=useApi<PublicEvent>(eventId?`/events/${encodeURIComponent(eventId)}`:null);
  return <SiteShell>
    <PageTitle eyebrow="01 / 准备参赛" title={eventId?"看懂这场比赛":"找到适合你的比赛"}>
      {eventId?"每项结论保留规则依据，缺失或冲突的信息明确标出。":"先看时间和报名入口，感兴趣再展开信息与建议；具体要求以主办方公告为准。"}
    </PageTitle>
    <p className={styles.muted}>选好比赛后要做什么？<Link className={styles.link} href="/journey">查看参赛路线图：准备、协作、展示与复盘 →</Link></p>
    {!eventId?<EventDiscoveryFeed/>:<>
      <Feedback error={detail.error}/>{detail.loading&&<Loading/>}
      {detail.data&&<section className={styles.panel}>{displayTime.ready?<><p className={styles.muted}>{displayTime.label}</p><EventRulesPanel rules={detail.data.rules} userTimeZone={displayTime.timeZone} localTimeLabel={displayTime.localTimeLabel}/></>:<p className={styles.muted} role="status">正在确认时间显示所用的时区…</p>}<div className={styles.actions}><Link href="/app" className={styles.button}>到项目中确认这场比赛</Link><Link href="/events" className={styles.secondary}>返回赛事列表</Link></div>{displayTime.ready&&eventId&&<EventCorrectionPanel eventId={eventId} currentEvent={detail.data} viewerId={displayTime.viewerId}/>}</section>}
    </>}
  </SiteShell>;
}
export interface ConfirmedRules {confirmation:ProjectRuleConfirmation|null;rules:EventRuleVersion|null}
export function RulesPanel({detail}:{detail:ProjectDetail}){
  const displayTime=useRuleDisplayTimeZone();
  const base=`/projects/${encodeURIComponent(detail.project.id)}`;
  const current=useApi<ConfirmedRules>(`${base}/rules`);
  const comparison=useApi<ProjectRuleChanges>(`${base}/rules/changes`);
  const events=useApi<PageResult<PublicEvent>>("/events?limit=50");
  const [selection,setSelection]=useState("");const [checked,setChecked]=useState(false);
  const [pending,setPending]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");
  const selected=events.data?.items.find(item=>item.event.id===selection);
  const latestRules=events.data?.items.find(item=>item.event.id===comparison.data?.confirmation?.eventId&&item.rules.version===comparison.data.latestVersion)?.rules??null;
  const readonly=detail.membership.role!=="manager"||detail.project.stage==="archived";
  async function refreshRules(){await Promise.all([current.reload(),comparison.reload(),events.reload()]);}
  async function confirmRules(){
    if(!selected||readonly||pending||!checked||!displayTime.ready||current.error||comparison.error)return;
    setPending(true);setError("");setNotice("");
    try{
      await api(`${base}/rules/confirm`,{method:"POST",body:{eventId:selected.event.id,rulesVersion:selected.rules.version,expectedRevision:current.data?.confirmation?.revision??0,analysisId:null}});
      window.dispatchEvent(new CustomEvent("hackathon:project-input-changed",{detail:{projectId:detail.project.id}}));
      setNotice("要求版本已确认。现有分工和计划需重新检查，不会自动覆盖。");setChecked(false);
      await refreshRules();
    }catch(reason){setError(message(reason));}finally{setPending(false);}
  }
  return <>
    <ProjectDiscoveryPanel projectId={detail.project.id} readonly={readonly}/>
    <Feedback error={error||current.error||events.error} notice={notice}/>
    <section className={styles.panel}>
      <h2>当前已确认的赛事要求</h2>
      {current.loading?<Loading/>:current.error?<><p>当前要求暂未能读取，不能据此判断队伍还没有确认规则。</p><button type="button" className={styles.secondary} onClick={()=>void refreshRules()}>重新读取规则</button></>:current.data?.rules?displayTime.ready?<><p className={styles.muted}>{displayTime.label}</p><EventRulesPanel rules={current.data.rules} userTimeZone={displayTime.timeZone} localTimeLabel={displayTime.localTimeLabel}/></>:<p role="status" className={styles.muted}>正在确认时间显示所用的时区…</p>:<Empty>还没有确认比赛要求。团队手填截止仍可用于人工规划，但不代表官方规则已核验。</Empty>}
    </section>
    <section className={styles.panel}>
      <h2>检查规则有没有更新</h2>
      <p className={styles.muted}>这里对比队伍已确认的版本与最新公开版本。查看变化不会自动修改规则或任务计划。</p>
      <button type="button" className={styles.secondary} disabled={pending||comparison.loading||current.loading||events.loading} onClick={()=>void refreshRules()}>刷新版本与变化</button>
      <Feedback error={comparison.error}/>
      {comparison.loading?<Loading/>:comparison.error?<p>变化暂未能读取，不代表没有变化。请重新读取后再确认新版本。</p>:comparison.data?displayTime.ready?<><p className={styles.muted}>{displayTime.label}</p><RuleChangesPanel comparison={comparison.data} currentRules={current.data?.rules} latestRules={latestRules} timeZone={displayTime.timeZone}/></>:<p role="status" className={styles.muted}>正在确认比较时间使用的时区…</p>:<p>尚未读取到规则比较结果。</p>}
    </section>
    <section className={styles.panel}>
      <h2>选择并确认规则版本</h2>
      <Field label="已发布赛事"><select value={selection} disabled={readonly||pending||events.loading} onChange={event=>{setSelection(event.target.value);setChecked(false);setNotice("");}}><option value="">请选择</option>{events.data?.items.map(item=><option key={item.event.id} value={item.event.id}>{item.rules.metadata.name} · 版本 {item.rules.version}</option>)}</select></Field>
      {!events.loading&&!events.error&&events.data?.items.length===0&&<div className={styles.notice}><p>本站还没有可确认的正式赛事要求。你可以先设置团队目标时间、人工安排任务；报名资格和正式提交仍需到主办方核对。</p><div className={styles.actions}><a className={styles.link} href={`/app/projects/${encodeURIComponent(detail.project.id)}#project-goal`}>设置团队目标时间 →</a><Link className={styles.link} href={`/app/projects/${encodeURIComponent(detail.project.id)}/plan`}>先安排内部任务 →</Link></div></div>}
      {selected&&<>
        {displayTime.ready?<><p className={styles.muted}>{displayTime.label}</p><EventRulesPanel rules={selected.rules} userTimeZone={displayTime.timeZone} localTimeLabel={displayTime.localTimeLabel}/></>:<p role="status" className={styles.muted}>正在确认时间显示所用的时区…</p>}
        <label className={styles.check}><input type="checkbox" disabled={readonly||pending||!displayTime.ready||Boolean(current.error)||Boolean(comparison.error)} checked={checked} onChange={event=>setChecked(event.target.checked)}/>我已阅读资格、截止、AI 使用规则和必交材料；未知事项会另行核实。</label>
        <button type="button" className={styles.button} disabled={readonly||pending||!checked||!displayTime.ready||current.loading||comparison.loading||Boolean(current.error)||Boolean(comparison.error)} onClick={()=>void confirmRules()}>确认本项目使用此规则版本</button>
      </>}
    </section>
  </>;
}
/** Private resource reads are scoped to the identity that requested them. */
function usePrivateResourceRead<T>(scope:string|null,load:(signal:AbortSignal)=>Promise<T>){
  const [state,setState]=useState<{scope:string|null;data:T|null;error:Error|null;loading:boolean}>({scope:null,data:null,error:null,loading:false});
  const generation=useRef(0);const controller=useRef<AbortController|null>(null);
  const reload=useCallback(async()=>{
    const current=++generation.current;controller.current?.abort();
    if(!scope){setState({scope:null,data:null,error:null,loading:false});return;}
    const request=new AbortController();controller.current=request;
    setState(previous=>({scope,data:previous.scope===scope?previous.data:null,error:null,loading:true}));
    try{const data=await load(request.signal);if(current===generation.current&&!request.signal.aborted)setState({scope,data,error:null,loading:false});}
    catch(reason){if(current===generation.current&&!request.signal.aborted)setState(previous=>({...previous,data:reason instanceof ApiError&&[401,403,404].includes(reason.status)?null:previous.data,error:reason instanceof Error?reason:new Error("读取失败，请重试。"),loading:false}));}
  },[scope,load]);
  useEffect(()=>{void reload();return()=>{generation.current++;controller.current?.abort();};},[reload]);
  useEffect(()=>{const clear=()=>{generation.current++;controller.current?.abort();setState({scope:null,data:null,error:null,loading:false});};window.addEventListener("hackathon:unauthenticated",clear);return()=>window.removeEventListener("hackathon:unauthenticated",clear);},[]);
  const matches=Boolean(scope)&&state.scope===scope;
  return {data:matches?state.data:null,error:matches?state.error:null,loading:Boolean(scope)&&(!matches||state.loading),reload};
}
export function ResourcesClient({resourceId}:{resourceId?:string}){
  return <SiteShell><Suspense fallback={<Loading/>}><ResourcesContent resourceId={resourceId}/></Suspense></SiteShell>;
}
function ResourcesContent({resourceId}:{resourceId?:string}){
  const [feedbackOpen,setFeedbackOpen]=useState(false);
  const router=useRouter();const searchParams=useSearchParams();const {query,cursor}=readResourceLocation(new URLSearchParams(searchParams.toString()));const params=resourceLocationParams(query,cursor);
  const catalogHref=resourceCatalogHref(query,cursor);const currentHref=resourceId?resourceDetailHref(resourceId,query,cursor):catalogHref;const loginHref=`/login?returnTo=${encodeURIComponent(currentHref)}`;
  const list=useApi<PageResult<Resource>>(resourceId?null:`/resources?${params.toString()}`);const detail=useApi<Resource>(resourceId?`/resources/${encodeURIComponent(resourceId)}`:null);const me=useApi<Me>("/me");const identityKey=me.data?.profile.id??null;
  const targetKey=JSON.stringify(resourceId?[resourceId]:list.data?.items.map(item=>item.id).sort()??[]);
  const readBookmarks=useCallback(async(signal:AbortSignal)=>({items:await findResourceBookmarks(JSON.parse(targetKey) as string[],async cursor=>{
    return api<PageResult<ResourceBookmarkView>>(`/me/resource-bookmarks?limit=50${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,{signal});
  },{signal,ownerId:identityKey??undefined}),nextCursor:null}),[targetKey,identityKey]);
  const bookmarks=usePrivateResourceRead(identityKey?JSON.stringify([identityKey,targetKey]):null,readBookmarks);const bookmark=bookmarks.data?.items.find(item=>item.resource.id===resourceId)?.bookmark;
  const readProjects=useCallback((signal:AbortSignal)=>api<Project[]>("/projects",{signal}),[]);
  const projects=usePrivateResourceRead(resourceId&&identityKey?JSON.stringify([identityKey,resourceId]):null,readProjects);
  const hasFilters=(["search","type","stage","stack","prerequisite","use","costType"] as const).some(key=>Boolean(query[key]?.trim()));
  const inventory=useApi<PageResult<Resource>>(!resourceId&&list.data?.items.length===0&&(hasFilters||cursor)?"/resources?limit=1":null);
  const noInventory=hasFilters||cursor?inventory.data?inventory.data.items.length===0:null:list.data?list.data.items.length===0:null;
  function applyResourceFilters(next:ResourceQuery,nextCursor=""){router.push(resourceCatalogHref(next,nextCursor),{scroll:false});}
  function clearResourceFilters(){applyResourceFilters({});}
  return <>
    <PageTitle title={resourceId?"了解资源，再开始使用":"工具与资料"}>
      {resourceId?"看清用途、费用和使用条件，再决定是否加入项目。":"先选现在要做的事，再找到工具、灵感、AI 技能或教程。"}
    </PageTitle>
    {!resourceId && <><ResourceHub/><ResourceFeedbackHistory key={identityKey??"guest"} identityKey={identityKey} identityLoading={me.loading} loginHref={loginHref}/></>}
    {resourceId && <p><Link className={styles.link} href={catalogHref}>← 返回工具列表{hasFilters||cursor?"（保留筛选）":""}</Link></p>}
    <Feedback error={list.error??detail.error}/>
    {resourceId&&identityKey&&bookmarks.data&&bookmarks.error&&<><Feedback error={bookmarks.error}/><button className={styles.secondary} onClick={()=>void bookmarks.reload()}>重新读取收藏</button></>}
    {resourceId&&identityKey&&projects.data&&projects.error&&<><Feedback error={projects.error}/><button className={styles.secondary} onClick={()=>void projects.reload()}>重新读取团队空间</button></>}
    {resourceId?<>{detail.loading&&<Loading/>}{detail.data&&<ResourceDetail resource={detail.data} onReport={()=>setFeedbackOpen(true)}
      bookmarkEditor={identityKey&&!bookmarks.data&&(bookmarks.loading||bookmarks.error)?<section className={styles.panel}><h2>个人收藏</h2>{bookmarks.loading?<Loading/>:<><Feedback error={bookmarks.error}/><button className={styles.secondary} onClick={()=>void bookmarks.reload()}>重新读取收藏</button></>}</section>:<ResourceBookmarkEditor resource={detail.data} identityKey={identityKey} isAuthenticated={Boolean(identityKey)} bookmark={bookmark}
        loginHref={loginHref}
        onSave={async input=>{const saved=await api<ResourceBookmark>(input.bookmarkId?`/me/resource-bookmarks/${input.bookmarkId}`:"/me/resource-bookmarks",{method:input.bookmarkId?"PATCH":"POST",body:input.bookmarkId?{purposeNote:input.purposeNote,expectedRevision:input.expectedRevision}:{resourceId:input.resourceId,purposeNote:input.purposeNote}});await bookmarks.reload();return saved;}}
        onRemove={async input=>{await api(`/me/resource-bookmarks/${input.bookmarkId}`,{method:"DELETE"});await bookmarks.reload();}}/>}
      projectShare={identityKey&&!projects.data&&(projects.loading||projects.error)?<section className={styles.panel}><h2>分享到团队空间</h2>{projects.loading?<Loading/>:<><Feedback error={projects.error}/><button className={styles.secondary} onClick={()=>void projects.reload()}>重新读取团队空间</button></>}</section>:<ResourceProjectShare resource={detail.data} identityKey={identityKey} isAuthenticated={Boolean(identityKey)} projects={projects.data?.filter(project=>project.stage!=="archived")??[]} loginHref={loginHref}
        onShare={async input=>api(`/resources/${input.resourceId}/share`,{method:"POST",body:{projectId:input.projectId,resourceVersion:input.resourceVersion,purposeNote:input.purposeNote}})}/>}/>} {detail.data&&<ResourceFeedback resource={detail.data} identityKey={identityKey} identityLoading={me.loading} loginHref={loginHref} open={feedbackOpen} onToggle={setFeedbackOpen}/>}</>
      :<section aria-labelledby="resource-tools-title" className={styles.activity}>
        <h2 id="resource-tools-title">工具与外部资料</h2>
        <p className={styles.muted}>这里保留人工审核的工具和外部资料；官网分析在“找灵感”，本站原创说明在“新手教程”。登录后可私人收藏，分享给队友需单独选择项目。</p>
        <ResourceFilters value={query} loading={list.loading} resultCount={list.data?.items.length} onApply={next=>applyResourceFilters(next)}/>
        {identityKey&&bookmarks.error&&<><Feedback error={bookmarks.error}/><button className={styles.secondary} onClick={()=>void bookmarks.reload()}>重新读取收藏</button></>}
        <ResourceList resources={list.data?.items??[]} loading={list.loading||(list.data?.items.length===0&&inventory.loading)} error={list.error?.message}
          onRetry={()=>void list.reload()} onClearFilters={clearResourceFilters}
          emptyState={<>
            <h2>{noInventory===true?"工具正在整理中":noInventory===false?(hasFilters?"没有符合条件的工具或资料":"这一页没有工具或资料"):"暂时没有可显示的工具或资料"}</h2>
            <p>{noInventory===true?"工具核验后会显示在这里。你可以先看新手教程或找设计灵感。":noInventory===false?(hasFilters?"试试更短的关键词，或清除筛选查看其他工具。":"可以返回第一页继续查看。"):"你可以先看新手教程或找设计灵感，稍后再来查看。"}</p>
            <Feedback error={inventory.error}/>
            {(hasFilters||cursor)&&noInventory!==true&&<button type="button" className={styles.secondary} onClick={hasFilters?clearResourceFilters:()=>applyResourceFilters(query)}>{hasFilters?"清除筛选":"返回第一页"}</button>}
            <PublicNextSteps/>
          </>}
          renderCard={resource=><ResourceCard resource={resource} identityKey={identityKey} detailHref={resourceDetailHref(resource.id,query,cursor)}
            bookmarkState={identityKey&&!bookmarks.data?(bookmarks.error?"error":"loading"):"ready"}
            bookmark={bookmarks.data?.items.find(item=>item.resource.id===resource.id)?.bookmark} loginHref={`/login?returnTo=${encodeURIComponent(resourceDetailHref(resource.id,query,cursor))}`}
            onBookmark={async input=>{const result=await api<ResourceBookmark>("/me/resource-bookmarks",{method:"POST",body:input});await bookmarks.reload();return result;}}/>}/>
        {(cursor||list.data?.nextCursor)&&<div className={styles.actions} aria-label="工具列表分页">
          {cursor&&<button className={styles.secondary} disabled={list.loading} onClick={()=>applyResourceFilters(query,String(Math.max(0,Number(cursor)-(query.limit??20))))}>上一页</button>}
          {cursor&&<button className={styles.secondary} disabled={list.loading} onClick={()=>applyResourceFilters(query)}>返回第一页</button>}
          {list.data?.nextCursor&&<button className={styles.secondary} disabled={list.loading} onClick={()=>applyResourceFilters(query,list.data?.nextCursor??"")}>下一页</button>}
        </div>}
      </section>}
  </>;
}
export function ProjectResourcesPanel({detail}:{detail:ProjectDetail}){const state=useApi<ProjectResourceBookmark[]>(`/projects/${detail.project.id}/resources`);const [title,setTitle]=useState("");const [url,setUrl]=useState("");const [purpose,setPurpose]=useState("");const [error,setError]=useState("");const [notice,setNotice]=useState("");const [pending,setPending]=useState(false);return <><Feedback error={error||state.error} notice={notice}/><section className={styles.panel}><h2>空间资料</h2><p className={styles.muted}>这里的成员参考不代表已审核资源。私人收藏只有显式共享才会出现在这里。</p>{state.loading&&<Loading/>}<ul className={styles.list}>{state.data?.map(item=><li key={item.id}><strong>{item.title}</strong> <span className={styles.tag}>{item.sourceStatus==="reviewed_resource"?"已审核资源引用 · 当前状态另核对":"成员参考 · 待核验"}</span><p>{item.purposeNote}</p>{item.resourceId?<Link className={styles.link} href={`/resources/${encodeURIComponent(item.resourceId)}`}>查看当前资源状态</Link>:safeLink(item.url)&&<a href={safeLink(item.url)!} target="_blank" rel="noopener noreferrer" className={styles.link}>访问成员参考（新窗口）</a>}</li>)}</ul>{state.data?.length===0&&<Empty>尚无共享资料。可以从工具库显式加入，或在下面记录参考链接。</Empty>}</section><section className={styles.panel}><h2>记录成员参考链接</h2><form className={styles.form} onSubmit={async event=>{event.preventDefault();setPending(true);setError("");try{const fresh=await api<ProjectDetail>(`/projects/${detail.project.id}`);await api(`/projects/${detail.project.id}/resources`,{method:"POST",body:{expectedRevision:fresh.project.revision,url,title,purposeNote:purpose}});setNotice("成员参考已保存，尚未经过运营核验。");setTitle("");setUrl("");setPurpose("");await state.reload();}catch(reason){setError(message(reason));}finally{setPending(false);}}}><Field label="资料名称"><input required value={title} maxLength={200} onChange={event=>setTitle(event.target.value)}/></Field><Field label="HTTP(S) 参考链接"><input type="url" required value={url} onChange={event=>setUrl(event.target.value)}/></Field><Field label="准备用它完成什么"><textarea value={purpose} maxLength={2000} onChange={event=>setPurpose(event.target.value)}/></Field><button className={styles.button} disabled={pending||detail.project.stage==="archived"}>保存到空间资料</button></form></section></>;}
