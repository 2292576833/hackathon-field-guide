import nodemailer, { type SMTPTransportOptions } from "nodemailer";
import { connect, type TLSSocket } from "node:tls";
import type { SmtpMailConfiguration } from "./smtp-mail.ts";
import { DomainError } from "../shared/errors.ts";

interface VerificationTransport { verify():Promise<boolean>;close():void }
export async function verifyOrganizerSmtpCredentials(config:SmtpMailConfiguration,{signal}:{signal:AbortSignal},factory:(options:SMTPTransportOptions)=>VerificationTransport=options=>nodemailer.createTransport(options)):Promise<boolean> {
  const error=()=>new DomainError("ORGANIZER_MAIL_VERIFICATION_FAILED","邮箱认证未完成，请核对授权码与SMTP设置后再试。",{status:503});
  if(!["smtp.qq.com","smtp.163.com","smtp.126.com","smtp.gmail.com"].includes(config.host)||config.port!==465||!config.secure||signal.aborted)throw error();
  let socket:TLSSocket|undefined,transport:VerificationTransport|undefined,rejectAbort:(reason:Error)=>void=()=>{};
  const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});void aborted.catch(()=>{});
  const stop=()=>{socket?.destroy();try{transport?.close();}catch{}rejectAbort(error());};
  signal.addEventListener("abort",stop,{once:true});
  try {
    transport=factory({host:config.host,port:465,secure:true,pool:false,auth:{user:config.user,pass:config.password},tls:{servername:config.host,rejectUnauthorized:true,minVersion:"TLSv1.2"},connectionTimeout:6000,greetingTimeout:6000,socketTimeout:6000,dnsTimeout:6000,logger:false,debug:false,transactionLog:false,disableFileAccess:true,disableUrlAccess:true,
      getSocket(_options,callback){
        if(signal.aborted)return callback(error());
        try {
          const current=connect({host:config.host,port:465,servername:config.host,rejectUnauthorized:true,minVersion:"TLSv1.2"});socket=current;
          let finished=false;
          const complete=(failure:Error|null)=>{if(finished)return;finished=true;current.removeListener("secureConnect",ready);if(failure||signal.aborted){current.destroy();callback(error());}else callback(null,{connection:current,secured:true});};
          const ready=()=>complete(null);
          current.on("error",()=>complete(error()));current.once("close",()=>{if(!finished)complete(error());});current.once("secureConnect",ready);current.setTimeout(6000,()=>current.destroy(error()));
          if(signal.aborted){current.destroy();complete(error());}
        }catch{callback(error());}
      }});
    if(signal.aborted)throw error();
    return await Promise.race([transport.verify(),aborted])===true;
  }catch{throw error();}finally{signal.removeEventListener("abort",stop);socket?.destroy();try{transport?.close();}catch{}}
}
