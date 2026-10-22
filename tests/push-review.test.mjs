import test from "node:test";
import assert from "node:assert/strict";
import { validatePushEvent, collectPushReviewPayload, handleDefaultBranchPush } from "../src/push-review.mjs";

const base="a".repeat(40), head="b".repeat(40);
const payload={ref:"refs/heads/main",before:base,after:head,installation:{id:7},repository:{full_name:"team/app"}};
function make() {
 const updates=[], github={
  async installationToken(){return "token";},
  async repository(){return {full_name:"team/app",default_branch:"main",visibility:"private"};},
  async compareCommits(){return {status:"ahead",base_commit:{sha:base},merge_base_commit:{sha:base},files:[
   {filename:"src/app.mjs",status:"modified",patch:"@@ -1 +1 @@\n-old\n+new"}
  ]};},
  async tree(){return ["src/app.mjs"];},
  async fileContent(){return "export const value = 1;";},
  async createCheck(){return {id:87};},
  async updateCheck(repo,id,token,data){updates.push(data);}
 };
 const config={maxFiles:100,maxWorkflows:20,maxWorkflowBytes:100000,maxSecurityFiles:100,
   maxSecurityFileBytes:100000,maxSecurityBytes:300000,reviewerApiUrl:"https://example.invalid",
   reviewerApiToken:"test",reviewTimeoutMs:1000};
 return {github,config,updates};
}
test("push main gets an exact-range review and updates check",async()=>{
 const f=make();let seen;
 const result=await handleDefaultBranchPush({github:f.github,config:f.config,payload,
  submit:async (args)=>{seen=args.payload;return {reviewId:"r1",failed:false,report:"ok",findings:[]};}});
 assert.equal(result.accepted,true);
 assert.equal(seen.pullRequest,null);
 assert.equal(seen.headSha,head);
 assert.equal(seen.baseSha,base);
 assert.equal(f.updates[0].conclusion,"success");
});
test("feature branch skips review",async()=>{
 const f=make();
 const out=await handleDefaultBranchPush({github:f.github,config:f.config,payload:{...payload,ref:"refs/heads/test"}});
 assert.equal(out.accepted,false);
 assert.equal(f.updates.length,0);
});
test("non-fast-forward push fails closed",async()=>{
 const f=make();
 await assert.rejects(()=>handleDefaultBranchPush({github:f.github,config:f.config,payload:{...payload,forced:true}}));
 assert.equal(f.updates[0].conclusion,"failure");
});
test("truncated compare is rejected",async()=>{
 const f=make();f.github.compareCommits=async()=>({status:"ahead",base_commit:{sha:base},
  merge_base_commit:{sha:base},files:Array.from({length:300},()=>({filename:"a.js",status:"modified",patch:"+safe"}))});
 await assert.rejects(()=>collectPushReviewPayload({github:f.github,repo:"team/app",token:"token",
  before:base,after:head,visibility:"private",config:f.config}),/truncated/);
});
test("bad or zero baseline must not pass",()=>{
 assert.throws(()=>validatePushEvent({...payload,before:"0".repeat(40)},
  {full_name:"team/app",default_branch:"main"}),/invalid/);
});
