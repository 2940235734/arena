import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
let listener;
const events = { addListener() {} };
const stored = {history:[]};
globalThis.chrome = {
 runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onInstalled:events,onMessage:{addListener:fn=>listener=fn},sendMessage:async()=>{},getPlatformInfo:async()=>({})},
 action:{onClicked:events},contextMenus:{onClicked:events},
 storage:{local:{get:async()=>stored,set:async value=>Object.assign(stored,value)}}
};
const bank=JSON.parse(await readFile(new URL('../unified_bank.json',import.meta.url)));
globalThis.fetch=async url=>{assert.equal(url,'chrome-extension://test/unified_bank.json');return {json:async()=>bank};};
await import('../background.js');
function send(message,url='chrome-extension://test/dashboard.html') {
 return new Promise(resolve=>listener(message,{id:'test',url,tab:{id:42}},resolve));
}
test('dashboard extension tab can analyze, history omits key, webpage cannot invoke API',async()=>{
 let responded=false;
 assert.equal(listener({type:'recognize'},{id:'test',url:'https://arena.ai/agent',tab:{id:1}},()=>responded=true),undefined);
 assert.equal(responded,false);
 const text=Array.from({length:300},(_,i)=>(i*13)%355+1).join(',');
 const result=await send({type:'analyze-samples',jobId:'analysis',config:{apiKey:'secret'},samples:Array.from({length:3},()=>({text})),startedAt:Date.now()});
 assert.equal(result.ok,true);assert.equal(stored.history.length,1);assert.equal('apiKey' in stored.history[0].config,false);
 assert.equal(result.result.verification.provider,'Ikaleio Fingerpoint Detector');
 assert.equal(result.result.verification.url,'https://lm.ikale.io/');
});
test('all three rounds must meet minimum, rather than silently dropping weak rounds',async()=>{
 const text=Array(200).fill('9').join(',');
 const result=await send({type:'analyze-samples',jobId:'invalid',config:{},samples:[{text},{text},{text:'1,2,3'}]});
 assert.equal(result.ok,false);assert.match(result.error,/第 3 组有效数字不足/);
});
