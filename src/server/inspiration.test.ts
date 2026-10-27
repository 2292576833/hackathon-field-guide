import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "./database.ts";
import { createInspirationService } from "./inspiration.ts";
import { inspirationSeed } from "./inspiration-catalog.ts";
import { PostgresDiscoveryLedger } from "../modules/operations/discovery-postgres.ts";

test("inspiration read stays pending until model-generated cards are durably saved; revisions reject stale overwrite", async () => {
  const database = await createDatabase({});
  let now = new Date("2026-10-09T01:00:00Z");
  try {
    await database.migrate();
    const service = createInspirationService(database,{now:()=>now},{mode:"local",origin:"http://localhost:3000",codePepper:"test",emailFrom:"test"});
    const empty = await service.snapshot();
    assert.equal(empty.items.length,0); assert.equal(empty.pendingItems.length,21);
    assert.equal("description" in empty.pendingItems[0]!,false);
    assert.equal((await database.query("SELECT * FROM operations_discovery_state")).rows.length,0);
    const card = { ...inspirationSeed[0]!, description:"模型夹具：用途",useWhen:"模型夹具：使用场景",usageNote:"模型夹具：使用说明",checkedAt:now.toISOString() };
    const saved=await service.save(card); assert.equal(saved.revision,1);
    const feed=await service.snapshot(); assert.equal(feed.items.length,1); assert.equal(feed.pendingItems.length,20);
    assert.equal(feed.items[0]!.description,card.description);
    now=new Date("2026-10-09T01:01:00Z");
    assert.equal((await service.save({...card,checkedAt:now.toISOString()})).revision,1);
    assert.equal((await service.save({...card,description:"模型夹具：已改说明",checkedAt:now.toISOString()})).revision,2);
    assert.equal((await service.save(card)).revision,2);
    assert.equal((await database.query("SELECT * FROM inspiration_versions")).rows.length,2);
    assert.equal((await service.snapshot()).items[0]!.description,"模型夹具：已改说明");
    await assert.rejects(service.save({...card,name:"伪造站点"}),{code:"INVALID_INSPIRATION"});
    await assert.rejects(service.save({...card,evidenceUrls:["https://elsewhere.invalid/"]}),{code:"INVALID_INSPIRATION"});
    await assert.rejects(service.save({...card,checkedAt:"2030-10-09T01:00:00Z"}),{code:"INVALID_INSPIRATION"});
    await assert.rejects(service.setPaused({userId:"missing",platformRoles:[]} as never,{expectedRevision:1,paused:true}),{code:"FORBIDDEN"});
  } finally {await database.close();}
});

test("an active inspiration reservation reports analysis in progress before considering the next call's quota", async () => {
  const database = await createDatabase({});
  let now = new Date("2026-10-09T01:00:00Z");
  try {
    await database.migrate();
    const ledger = new PostgresDiscoveryLedger({database,clock:{now:()=>now},id:"inspiration-catalog"});
    const started = await ledger.beginCycle({workerId:"isolated-inspiration",now:now.toISOString(),minimumIntervalMs:60000,leaseMs:60000,
      limits:{maxSearchCallsPerDay:0,maxModelCallsPerDay:1,maxEstimatedCostMicrosPerDay:100,currency:"USD"},reservation:{searchCalls:0,modelCalls:1,estimatedCostMicros:80}});
    assert.ok("lease" in started);
    await database.query("INSERT INTO backend_worker_heartbeats(worker_id,kind,status,last_seen_at) VALUES('isolated-inspiration','inspiration','running',$1)",[now.toISOString()]);
    const service = createInspirationService(database,{now:()=>now},{mode:"local",origin:"http://localhost:3000",codePepper:"test",emailFrom:"test",dsh:{} as never,
      inspiration:{modelCostReservationMicrosPerCall:60,limits:{maxModelCallsPerDay:1,maxEstimatedCostMicrosPerDay:100}} as never});
    assert.match((await service.snapshot()).status.message,/正在读取官网并分析/);
    await ledger.finishCycle({token:started.lease.token,now:now.toISOString(),consumed:{searchCalls:0,modelCalls:1,estimatedCostMicros:80},errorCode:null});
    now = new Date(now.getTime()+1001);
    assert.match((await service.snapshot()).status.message,/剩余额度不足/);
  } finally {await database.close();}
});
