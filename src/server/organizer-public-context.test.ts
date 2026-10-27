import assert from "node:assert/strict";
import test from "node:test";
import {isPublicApiRead} from "../shared/public-api.ts";
import {safeAuthReturnTo} from "../modules/auth/service.ts";

test("anonymous identity failure does not erase exact official public projections",()=>{
 for(const path of ["/competitions","/competitions/event-a","/organizer/templates","/competitions/event-a/registration-form","/competitions/event-a/results","/competitions/event-a/teams/public","/competitions/event-a/announcements","/competitions/event-a/faq","/competitions/event-a/schedule"]) assert.equal(isPublicApiRead(path),true,path);
 for(const path of ["/competitions/event-a/my-registration","/competitions/event-a/my-submissions","/competitions/event-a/results/mine","/competitions/event-a/teams","/competitions/event-a/services","/competitions/event-a/tickets","/organizer/events/event-a","/organizer/templates/private","/me/competitions"]) assert.equal(isPublicApiRead(path),false,path);
});
test("staff can return to precise managed event and participant list without arbitrary query navigation",()=>{
 for(const path of ["/me/competitions","/organizers/workspace?event=event-a","/competitions/event-a/submit?receipt=receipt-a",...['registration','teams','communication','schedule','services','judging'].map(section=>`/organizers/workspace/event-a/${section}`)]) assert.equal(safeAuthReturnTo(path),path);
 for(const path of ["/organizers/workspace?event=event-a&event=event-b","/organizers/workspace?event=event-a&token=secret","/organizers/workspace?event=%2fevil","/organizers/workspace/event-a/judging?token=secret","/organizers/workspace/event-a/unknown","/me/competitions?next=https://evil.test"]) assert.equal(safeAuthReturnTo(path),"/app");
});
