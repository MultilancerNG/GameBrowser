import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import {
  FollowerQueue, applyMirrorAction, normalizeMirrorAction, runWorker, validateSyncConfiguration,
} from "./browser-sync-worker.mjs";

const config = () => ({
  type: "start",
  admin: { id: "admin", engine: "chromium", endpoint: "http://127.0.0.1:9001" },
  followers: [{ id: "follower", engine: "firefox", endpoint: "ws://127.0.0.1:9002/private" }],
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("mirroring accepts only distinct locally owned endpoints and a Chromium Admin", () => {
  expect(validateSyncConfiguration(config())).toEqual(config());
  expect(validateSyncConfiguration({ ...config(), alignOnStart: false }).alignOnStart).toBe(false);
  for (const value of [
    { ...config(), admin: { ...config().admin, engine: "firefox" } },
    { ...config(), admin: { ...config().admin, endpoint: "https://outside.example" } },
    { ...config(), followers: [{ ...config().followers[0], endpoint: config().admin.endpoint }] },
    { ...config(), followers: [{ ...config().followers[0], id: "admin" }] },
    { ...config(), followers: [] },
    { ...config(), alignOnStart: "false" },
  ]) expect(() => validateSyncConfiguration(value)).toThrow();
});

test("mirror action validation rejects oversized input and arbitrary browser commands", () => {
  expect(normalizeMirrorAction({ type: "input", selector: "#text", value: "typing" }))
    .toEqual({ type: "input", selector: "#text", value: "typing" });
  expect(() => normalizeMirrorAction({ type: "input", selector: "#text", value: "x".repeat(65_537) })).toThrow();
  expect(() => normalizeMirrorAction({ type: "evaluate", source: "arbitrary()" })).toThrow();
  expect(() => normalizeMirrorAction({ type: "click", x: 1.1, y: 0.2, button: 0, modifiers: [] })).toThrow();
  expect(() => normalizeMirrorAction({ type: "key", key: "F12; code()" })).toThrow();
});

test("follower actions stay ordered and overflow is visible instead of silently dropping input", async () => {
  const seen: number[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const reasons: string[] = [];
  let failed = 0;
  const queue = new FollowerQueue(async (action: number) => { seen.push(action); if (action === 1) await blocked; }, (reason: string) => { failed++; reasons.push(reason); }, 2);
  queue.enqueue(1); queue.enqueue(2); queue.enqueue(3);
  expect(queue.enqueue(4)).toBe(false);
  expect(failed).toBe(1);
  expect(reasons).toEqual(["queue-overflow"]);
  release(); await tick();
  expect(seen).toEqual([1]);
  expect(queue.enqueue(5)).toBe(false);
});

test("a follower failure does not interrupt the other follower queue", async () => {
  const seen: string[] = [];
  let failed = 0;
  const broken = new FollowerQueue(async () => { throw new Error("private action details"); }, () => { failed++; });
  const healthy = new FollowerQueue(async (value: string) => { seen.push(value); }, () => { throw new Error("unexpected failure"); });
  broken.enqueue("a"); healthy.enqueue("a"); healthy.enqueue("b");
  await tick();
  expect(failed).toBe(1);
  expect(seen).toEqual(["a", "b"]);
  healthy.stop(); expect(healthy.enqueue("c")).toBe(false);
});

test("follower application changes DOM fields without copying account state", async () => {
  const calls: unknown[] = [];
  const locator = {
    first() { return this; }, async fill(value: string) { calls.push(["fill", value]); },
    async setChecked(value: boolean) { calls.push(["check", value]); },
    async selectOption(value: string[]) { calls.push(["select", value]); },
  };
  const page = { isClosed: () => false, mainFrame: () => ({ url: () => "https://site.test", locator: () => locator }) };
  const context = { pages: () => [page] };
  const pages = new Map();
  await applyMirrorAction(context, pages, { type: "input", pageId: 0, framePath: [], sourceUrl: "https://site.test", selector: "#text", value: "typed" });
  await applyMirrorAction(context, pages, { type: "check", pageId: 0, framePath: [], sourceUrl: "https://site.test", selector: "#check", checked: true });
  expect(calls).toEqual([["fill", "typed"], ["check", true]]);
  await expect(applyMirrorAction(context, pages, { type: "input", pageId: 0, framePath: [], sourceUrl: "https://site.test/different", selector: "#text", value: "blocked" })).rejects.toThrow("workflow");
  await expect(applyMirrorAction(context, pages, { type: "input", pageId: 0, framePath: [], sourceUrl: "https://other.test", selector: "#text", value: "blocked" })).rejects.toThrow("workflow");
  await applyMirrorAction(context, pages, { type: "input", pageId: 0, framePath: [], sourceUrl: "https://site.test?identity=admin", selector: "#text", value: "query differs" });
  expect(calls).toEqual([["fill", "typed"], ["check", true], ["fill", "query differs"]]);
});

test("malformed worker commands emit a generic error without printing private input", async () => {
  const input = new PassThrough(); const output = new PassThrough();
  let text = ""; output.on("data", (part) => { text += part; });
  const run = runWorker(input, output);
  input.end('{"type":"secret-command","password":"PRIVATE_VALUE"}\n');
  await run;
  expect(text).toContain('"type":"failure"');
  expect(text).toContain('"reason":"invalid-command"');
  expect(text).not.toContain("PRIVATE_VALUE");
  expect(text).not.toContain("secret-command");
});

const browserIntegration = String.raw`
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const roots=[]; const contexts=[];
let child; let server;
const wait=async(fn)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('browser mirroring assertion timed out');};
try {
 let submissions=0;
 const html='<!doctype html><html><body><input id="text"><textarea id="multi"></textarea><input id="check" type="checkbox"><select id="choice"><option value="one">One</option><option value="two">Two</option></select><button id="counter" type="button">0</button><div id="surface" style="width:200px;height:100px;background:gray"></div><form method="POST" action="/submitted"><input id="formText" name="text"><button id="submit" type="submit">Submit</button></form><a id="next" href="/two">Next</a><a id="hash" href="#tab">Tab</a><div style="height:1800px">Space</div><script>document.querySelector("#counter").onclick=()=>{const b=document.querySelector("#counter");b.textContent=String(Number(b.textContent)+1)};window.selectChanges=0;document.querySelector("#choice").onchange=()=>window.selectChanges++;window.multiInputs=0;document.querySelector("#multi").oninput=()=>window.multiInputs++;document.querySelector("#surface").onclick=e=>{e.currentTarget.dataset.point=Math.round(e.offsetX)+","+Math.round(e.offsetY)};</script></body></html>';
 server=createServer((req,res)=>{const identity=req.headers.cookie?.includes('identity=admin')?'admin':'follower';const submitted=req.url==='/submitted'&&req.method==='POST';if(submitted)submissions++;const deliver=()=>{if(submitted){res.writeHead(303,{Location:'/submitted?identity='+identity});res.end();return;}res.writeHead(200,{'Content-Type':'text/html'});res.end(html);};if(identity==='follower'&&(submitted||req.url==='/two'))setTimeout(deliver,1200);else deliver();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const endpoints=[];
 for(const identity of ['admin','follower']) {
   const root=mkdtempSync(join(tmpdir(),'gamebrowser-sync-'));roots.push(root);
   const context=await chromium.launchPersistentContext(root,{executablePath:process.env.GAMEBROWSER_SYNC_BROWSER,headless:true,args:['--no-sandbox','--remote-debugging-port=0'],viewport:{width:900,height:700}});contexts.push(context);
   const port=readFileSync(join(root,'DevToolsActivePort'),'utf8').split('\n')[0];endpoints.push('http://127.0.0.1:'+port);
   await context.addCookies([{name:'identity',value:identity,url:base}]);
   await context.pages()[0].goto(base+'/one?identity='+identity+'#'+identity);
 }
 const admin=contexts[0].pages()[0], follower=contexts[1].pages()[0];
 const events=[];let stdout='';let stderr='';
 child=spawn(process.execPath,[process.env.SYNC_WORKER],{stdio:['pipe','pipe','pipe']});
 child.stdout.on('data',chunk=>{stdout+=chunk;let end;while((end=stdout.indexOf('\n'))>=0){events.push(JSON.parse(stdout.slice(0,end)));stdout=stdout.slice(end+1);}});
 child.stderr.on('data',chunk=>{stderr+=chunk;});
 child.stdin.write(JSON.stringify({type:'start',admin:{id:'admin',engine:'chromium',endpoint:endpoints[0]},followers:[{id:'follower',engine:'chromium',endpoint:endpoints[1]}]})+'\n');
 await wait(()=>events.some(e=>e.type==='ready'));await new Promise(r=>setTimeout(r,150));
 assert.equal(admin.url(),base+'/one?identity=admin#admin');assert.equal(follower.url(),base+'/one?identity=follower#follower');
 await admin.locator('#hash').click();await wait(()=>follower.url()===base+'/one?identity=follower#tab');assert.equal(admin.url(),base+'/one?identity=admin#tab');
 await admin.goto(base+'/one?identity=admin#manual');await wait(()=>follower.url()===base+'/one?identity=follower#manual');
 assert.equal(await admin.evaluate(()=>Object.keys(globalThis).some(k=>k.startsWith('__gamebrowser_sync_'))),false);
 await admin.locator('#text').fill('separate accounts, shared actions');
 await wait(async()=>await follower.locator('#text').inputValue()==='separate accounts, shared actions');
 await follower.locator('#surface').evaluate(el=>{el.style.width='400px';el.style.height='200px';});
 await admin.locator('#surface').click({position:{x:35,y:21}});await wait(async()=>await follower.locator('#surface').getAttribute('data-point')==='70,42');
 await admin.locator('#counter').click();await wait(async()=>await follower.locator('#counter').innerText()==='1');
 await admin.locator('#counter').press('Enter');await wait(async()=>await follower.locator('#counter').innerText()==='2');
 await new Promise(r=>setTimeout(r,150));assert.equal(await follower.locator('#counter').innerText(),'2');
 await admin.locator('#check').check();await wait(async()=>await follower.locator('#check').isChecked());
 await admin.locator('#multi').fill('first');await wait(async()=>await follower.locator('#multi').inputValue()==='first');
 await admin.evaluate(()=>window.multiInputs=0);await follower.evaluate(()=>window.multiInputs=0);
 await admin.locator('#multi').press('Enter');await wait(async()=>await follower.locator('#multi').inputValue()===await admin.locator('#multi').inputValue());
 await new Promise(r=>setTimeout(r,150));assert.equal(await admin.evaluate(()=>window.multiInputs),1);assert.equal(await follower.evaluate(()=>window.multiInputs),1);
 await admin.locator('#choice').press('ArrowDown');await wait(async()=>await follower.locator('#choice').inputValue()==='two');
 await new Promise(r=>setTimeout(r,150));assert.equal(await admin.evaluate(()=>window.selectChanges),1);assert.equal(await follower.evaluate(()=>window.selectChanges),1);
 await admin.evaluate(()=>{const input=document.querySelector('#text');input.value='forged action';input.dispatchEvent(new InputEvent('input',{bubbles:true}));});
 await new Promise(r=>setTimeout(r,150));
 assert.equal(await follower.locator('#text').inputValue(),'separate accounts, shared actions');
 for(let i=0;i<2;i++) { const cookie=(await contexts[i].cookies()).find(c=>c.name==='identity');assert.equal(cookie.value,i===0?'admin':'follower'); }
 await admin.locator('#submit').click();await wait(()=>submissions===2&&follower.url()===base+'/submitted?identity=follower');await new Promise(r=>setTimeout(r,300));assert.equal(submissions,2);assert.equal(admin.url(),base+'/submitted?identity=admin');assert.equal(follower.url(),base+'/submitted?identity=follower');
 await admin.locator('#formText').fill('form Enter');await wait(async()=>await follower.locator('#formText').inputValue()==='form Enter');
 await admin.locator('#formText').press('Enter');await admin.locator('#text').fill('after slow same-path submit');await wait(async()=>await follower.locator('#text').inputValue()==='after slow same-path submit');await wait(()=>submissions===4);await new Promise(r=>setTimeout(r,300));assert.equal(submissions,4);assert.equal(admin.url(),base+'/submitted?identity=admin');assert.equal(follower.url(),base+'/submitted?identity=follower');
 await admin.locator('#next').click();await admin.locator('#text').fill('after slow link navigation');await wait(async()=>await follower.locator('#text').inputValue()==='after slow link navigation');
 await admin.locator('#counter').click();await admin.goto(base+'/manual');await wait(()=>follower.url()===base+'/manual');
 await admin.goto(base+'/manual?search=shared#find');await wait(()=>follower.url()===base+'/manual?search=shared#find');
 await admin.locator('#text').fill('after navigation');await wait(async()=>await follower.locator('#text').inputValue()==='after navigation');
 assert.equal(events.some(e=>e.type==='follower-error'||e.type==='failure'),false);
 child.stdin.write('{"type":"stop"}\n');await new Promise(r=>child.once('exit',r));
 await admin.locator('#text').fill('after stop');await new Promise(r=>setTimeout(r,200));assert.equal(await follower.locator('#text').inputValue(),'after navigation');
 assert.equal(contexts.every(c=>c.pages().length>0),true);
 assert.equal(stderr,'');
 const reconnectEvents=[];
 const startObserver=async(alignOnStart=true)=>{
   child=spawn(process.execPath,[process.env.SYNC_WORKER],{stdio:['pipe','pipe','pipe']});let pending='';
   child.stdout.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\n'))>=0){reconnectEvents.push(JSON.parse(pending.slice(0,end)));pending=pending.slice(end+1);}});
   child.stdin.write(JSON.stringify({type:'start',alignOnStart,admin:{id:'admin',engine:'chromium',endpoint:endpoints[0]},followers:[{id:'follower',engine:'chromium',endpoint:endpoints[1]}]})+'\n');
   await wait(()=>reconnectEvents.some(e=>e.type==='ready'));
 };
 await follower.goto(base+'/independent');await startObserver(false);await new Promise(r=>setTimeout(r,150));assert.equal(follower.url(),base+'/independent');
 await admin.locator('#text').fill('blocked on a different workflow');await wait(()=>reconnectEvents.some(e=>e.type==='follower-error'&&e.reason==='action-failed'));assert.equal(await follower.locator('#text').inputValue(),'');
 child.stdin.write('{"type":"stop"}\n');await new Promise(r=>child.once('exit',r));reconnectEvents.length=0;await startObserver(false);await contexts[1].close();await wait(()=>reconnectEvents.some(e=>e.type==='follower-error'&&e.reason==='follower-disconnected'));
 child.stdin.write('{"type":"stop"}\n');await new Promise(r=>child.once('exit',r));
 contexts[1]=await chromium.launchPersistentContext(roots[1],{executablePath:process.env.GAMEBROWSER_SYNC_BROWSER,headless:true,args:['--no-sandbox','--remote-debugging-port=0'],viewport:{width:900,height:700}});
 endpoints[1]='http://127.0.0.1:'+readFileSync(join(roots[1],'DevToolsActivePort'),'utf8').split('\n')[0];reconnectEvents.length=0;
 await startObserver();await contexts[0].close();await wait(()=>reconnectEvents.some(e=>e.type==='failure'&&e.reason==='admin-disconnected'));
 assert.equal(contexts[1].pages().length>0,true);
 child.stdin.write('{"type":"stop"}\n');await new Promise(r=>child.once('exit',r));
 console.log('mirroring integration passed: trusted click, typing, selection, checkbox, navigation, scaled local click coordinates, no duplicate button Enter/form Enter/select changes, delayed link and same-path submit preserve immediate input, separate startup/query and hash-link/manualhash identity, separate cookies, explicit query navigation follows, no main-world binding, clean stop');
} finally {
 if(child&&!child.killed)child.kill();
 await Promise.allSettled(contexts.map(c=>c.close()));
 if(server)await new Promise(r=>server.close(r));
 for(const root of roots)rmSync(root,{recursive:true,force:true});
}
`;

test.skipIf(!process.env.GAMEBROWSER_SYNC_BROWSER)("real browser mirroring preserves identity and stops cleanly", async () => {
  const child = Bun.spawn(["node", "--input-type=module", "--eval", browserIntegration], {
    env: { ...process.env, PLAYWRIGHT_MODULE: join(import.meta.dir, "..", "node_modules", "playwright-core", "index.mjs"), SYNC_WORKER: join(import.meta.dir, "browser-sync-worker.mjs") },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("mirroring integration passed");
}, 60_000);
