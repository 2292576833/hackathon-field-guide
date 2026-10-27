import assert from "node:assert/strict";
import test from "node:test";
import {verifyOrganizerSmtpCredentials} from "./organizer-smtp-verify.ts";
const config={host:"smtp.qq.com",port:465,secure:true,user:"fixture@qq.com",password:"FIXTURE_ONLY"};
test("SMTP account validation authenticates without sending mail, with TLS and safe diagnostics",async()=>{
  let closed=0;
  assert.equal(await verifyOrganizerSmtpCredentials(config,{signal:new AbortController().signal},options=>{assert.equal(options.secure,true);assert.equal(options.logger,false);assert.equal(options.tls?.rejectUnauthorized,true);return {async verify(){return true;},close(){closed++;}};}),true);
  assert.equal(closed,1);
  await assert.rejects(verifyOrganizerSmtpCredentials(config,{signal:new AbortController().signal},()=>({async verify(){throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");},close(){}})),error=>error instanceof Error&&!error.message.includes("PRIVATE_PROVIDER_DIAGNOSTIC"));
});
test("SMTP verification rejects arbitrary hosts and cancels an unfinished login",async()=>{
  let calls=0,closed=0;const controller=new AbortController();
  await assert.rejects(verifyOrganizerSmtpCredentials({...config,host:"127.0.0.1"},{signal:controller.signal},()=>{calls++;throw new Error();}));assert.equal(calls,0);
  const running=verifyOrganizerSmtpCredentials(config,{signal:controller.signal},()=>({verify:()=>new Promise(()=>{}),close(){closed++;}}));controller.abort();await assert.rejects(running);assert.ok(closed>=1);
});
