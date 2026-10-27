import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { chromium } from "@playwright/test";
import type { SupervisionState } from "./model.ts";

test("isolated panel: GET startup, explicit consent, visible 30s check, hidden/archive pause, hold and account isolation",async()=>{
  const modules:Record<string,string>={};
  for(const[id,path]of[["react","react/cjs/react.development.js"],["react/jsx-runtime","react/cjs/react-jsx-runtime.development.js"],["react-dom","react-dom/cjs/react-dom.development.js"],["react-dom/client","react-dom/cjs/react-dom-client.development.js"],["scheduler","scheduler/cjs/scheduler.development.js"]])modules[id!]=readFileSync(new URL(`../../../node_modules/${path}`,import.meta.url),"utf8");
  modules.panel=ts.transpileModule(readFileSync(new URL("./TeamSupervisionPanel.tsx",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  modules["./client.ts"]="exports.createSupervisionApiClient=()=>({});exports.SupervisionApiError=class SupervisionApiError extends Error{constructor(message,status){super(message);this.status=status;}};";
  modules["./supervision.module.css"]="exports.__esModule=true;exports.default=new Proxy({},{get:(_,key)=>String(key)});";
  const css=readFileSync(new URL("./supervision.module.css",import.meta.url),"utf8");
  const runtime=`window.process={env:{NODE_ENV:'development'}};const sources=${JSON.stringify(modules)},cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;new Function('require','module','exports',sources[id])(require,m,m.exports);return m.exports;}
  window.calls=[];window.fail=false;window.hidden=false;Object.defineProperty(document,'visibilityState',{get:()=>window.hidden?'hidden':'visible',configurable:true});const interval=window.setInterval;window.setInterval=(fn,ms)=>{if(ms===30000){window.tick=fn;return 12345}return interval(fn,ms)};
  window.state={projectId:'p1',revision:0,enabled:false,reason:'disabled',membershipId:'m1',factsFingerprint:'f1',hints:[{id:'blocked:t',kind:'blocked',taskId:'t',title:'接口',detail:'等交接'}],report:null,holdRequestId:null,dailyUsed:0,dailyLimit:24,nextAllowedAt:null};
  window.client={get:async()=>{calls.push('GET');if(fail)throw Error('读取失败');return structuredClone(state)},settings:async(id,input)=>{calls.push('PUT');state={...state,revision:state.revision+1,enabled:input.enabled,reason:input.enabled?'idle':'disabled'};return structuredClone(state)},check:async()=>{calls.push('POST');return structuredClone(state)}};
  const app=require('react-dom/client').createRoot(document.getElementById('root'));window.render=(account='alice',archived=false)=>app.render(require('react').createElement(require('panel').TeamSupervisionPanel,{projectId:'p1',accountKey:account,archived,client}));window.render();`;
  const html=`<!doctype html><html><head><meta charset="utf-8"><style>:root{--paper:#fff;--line:#ccc;--action:#d43;--muted:#666}body{margin:12px}*{box-sizing:border-box}${css}</style></head><body><div id="root"></div><script>${runtime.replaceAll("</script","<\\/script")}</script></body></html>`;
  const browser=await chromium.launch({channel:"msedge",headless:true});
  try{
    const page=await browser.newPage({viewport:{width:375,height:844}});const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    await page.route("http://supervision.test/**",route=>route.fulfill({contentType:"text/html",body:html}));await page.goto("http://supervision.test/");
    await page.getByText("自动AI建议未开启",{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.calls),["GET"]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.evaluate(()=>window.tick());await page.waitForTimeout(30);assert.deepEqual(await page.evaluate(()=>window.calls),["GET","GET"]);
    await page.locator('summary[aria-label="护航设置"]').click();await page.getByRole("button",{name:"开启自动AI建议",exact:true}).click();await page.getByText("等待关键记录变化",{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.calls.filter((x:string)=>x==="POST").length),0);
    await page.evaluate(()=>window.tick());await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>window.calls.filter((x:string)=>x==="POST").length),1);
    await page.evaluate(()=>{window.hidden=true;window.tick();});await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>window.calls.filter((x:string)=>x==="POST").length),1);
    await page.evaluate(()=>{window.hidden=false;document.dispatchEvent(new Event("visibilitychange"));});await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>window.calls.at(-1)),"GET");
    await page.evaluate(()=>{window.state.reason="hold";window.state.holdRequestId="uncertain";document.dispatchEvent(new Event("visibilitychange"));});await page.getByText("上次结果待核查，自动建议已暂停",{exact:true}).waitFor();await page.evaluate(()=>window.tick());await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>window.calls.at(-1)),"GET");
    await page.evaluate(()=>{window.fail=true;window.tick();});await page.getByRole("alert").waitFor();assert.ok((await page.locator(".source").innerText()).includes("上次记录"));await page.evaluate(()=>{window.fail=false;});
    await page.evaluate(()=>window.render("alice",true));await page.waitForTimeout(50);const before=await page.evaluate(()=>window.calls.length);await page.evaluate(()=>window.tick());await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>window.calls.length),before);
    await page.evaluate(()=>{window.state={...window.state,reason:'disabled',enabled:false,report:null,holdRequestId:null};window.render('bob',false)});await page.getByText("自动AI建议未开启",{exact:true}).waitFor();assert.equal(await page.getByText("DSH建议").count(),0);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

declare global {interface Window {calls:string[];tick:()=>void;hidden:boolean;fail:boolean;render:(account?:string,archived?:boolean)=>void;state:SupervisionState}}
