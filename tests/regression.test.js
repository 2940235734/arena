import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { PROTOCOL, activeTab, ensureConnection, sendToArena, isArenaUrl } from '../bridge.js';
import { analyze } from '../fingerprint.js';
import { analyzeGlobalOutputs } from '../vendor/fingerprint-core.js';

function mockApi(connected = false) {
  const state = { connected, injections: 0, sends: 0, active: 1 };
  return { state, tabs: {
    get: async id => ({ id, url: 'https://arena.ai/agent' }),
    query: async () => [{ id: state.active, url: 'https://arena.ai/agent' }],
    sendMessage: async (_, message) => {
      if (message.type === 'arena-ping') {
        if (!state.connected) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { protocol: PROTOCOL, ok: true };
      }
      state.sends++; throw new Error('The message port closed before a response was received.');
    }
  }, scripting: { executeScript: async () => { state.injections++; state.connected = true; } } };
}
test('missing receiver injects once and verifies handshake', async () => {
  const api = mockApi(); await ensureConnection(1, api); await ensureConnection(1, api);
  assert.equal(api.state.injections, 1);
});
test('existing receiver avoids reinjection', async () => {
  const api = mockApi(true); await ensureConnection(1, api); assert.equal(api.state.injections, 0);
});
test('ambiguous business delivery never resends', async () => {
  const api = mockApi(); await assert.rejects(sendToArena(1, { type: 'arena-sample-round' }, api), /port closed/);
  assert.equal(api.state.sends, 1);
});
test('active tab is resolved on each operation', async () => {
  const api = mockApi(); assert.equal((await activeTab(api)).id, 1);
  api.state.active = 2; assert.equal((await activeTab(api)).id, 2);
});
test('host validation rejects spoofed names and non-web protocols', () => {
  for (const url of ['https://arena.ai','https://www.lmarena.ai/chat','https://chat.lmsys.org/']) assert.equal(isArenaUrl(url), true);
  for (const url of ['https://evil-arena.ai','https://arena.ai.evil.test','https://evil.test/?arena.ai','chrome://extensions','file:///arena.ai']) assert.equal(isArenaUrl(url), false);
});
test('injection failure is surfaced and no business message is sent', async () => {
  const api = mockApi(); api.scripting.executeScript = async () => { throw new Error('Missing host permission'); };
  await assert.rejects(sendToArena(1, { type: 'arena-sample-round' }, api), /permission/);
  assert.equal(api.state.sends, 0);
});
test('fingerprint uses upstream engine exactly and rejects inadequate samples', async () => {
  assert.equal(analyze, analyzeGlobalOutputs);
  const bank = JSON.parse(await readFile(new URL('../unified_bank.json', import.meta.url)));
  const outputs = Array.from({ length: 3 }, (_, j) => ({ expected_count: 300, text: Array.from({length:300}, (_, i) => ((i * (j + 13) + 51) % 355) + 1).join(',') }));
  const result = analyze(outputs, bank);
  assert.equal(result.used_outputs, 3); assert.equal(result.results.length, bank.models.length);
  assert.ok(result.results.every(x => Number.isFinite(x.probability)));
  assert.ok(Math.abs(result.results.reduce((sum, x) => sum + x.probability, 0) - 1) < 1e-10);
  assert.throws(() => analyze([{ text: '1,2,3', expected_count: 300 }], bank), /没有可用回答/);
});

async function contentDom(html) {
  const dom = new JSDOM(html, { url: 'https://arena.ai/agent/session-one', runScripts: 'outside-only', pretendToBeVisual: true });
  const listeners = new Set();
  dom.window.HTMLElement.prototype.getBoundingClientRect = function() { return { width: this.hidden ? 0 : 200, height: this.hidden ? 0 : 50 }; };
  dom.window.chrome = { runtime: { id: 'test', sendMessage: () => Promise.resolve(), onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
  const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');
  dom.window.eval(source);
  const send = message => new Promise(resolve => { for (const listener of listeners) listener(message, { id: 'test' }, resolve); });
  return { dom, listeners, source, send };
}
test('content reinjection is idempotent; rename cannot overwrite composer', async () => {
  const {dom,listeners,source,send} = await contentDom('<main><button role="combobox">Agent</button><textarea>my draft</textarea></main>');
  dom.window.eval(source); assert.equal(listeners.size, 1);
  assert.equal((await send({type:'arena-ping'})).agent,true);
  const result = await send({type:'arena-rename-conversation',jobId:'unknown',name:'MODEL'});
  assert.equal(result.ok,false); assert.equal(dom.window.document.querySelector('textarea').value,'my draft'); dom.window.close();
});
test('conversation three-dot menu renames a high-confidence result', async () => {
  const html = '<nav><div data-state="active"><a href="/agent/session-one">原标题</a><button aria-label="More options">...</button></div></nav><main><button role="combobox">Agent</button><form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>';
  const {dom,send} = await contentDom(html); const doc = dom.window.document; const clock = Date.now(); let ticks = 0;
  dom.window.Date.now = () => clock + (ticks++ * 1000);
  doc.querySelector('[aria-label="More options"]').addEventListener('pointerdown', () => doc.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">Rename</button></div>'));
  doc.querySelector('[aria-label="Send message"]').onclick = () => {
    doc.querySelector('textarea').value = '';
    const reply = doc.createElement('div'); reply.dataset.messageAuthorRole = 'assistant'; reply.textContent = Array(180).fill('7').join(','); doc.querySelector('main').append(reply);
  };
  doc.addEventListener('click', event => {
    if (event.target.textContent !== 'Rename') return;
    doc.body.insertAdjacentHTML('beforeend','<div role="dialog"><input type="text"><button>Save</button></div>');
    const dialog = doc.querySelector('[role="dialog"]');
    dialog.querySelector('button').onclick = () => { doc.querySelector('a[href="/agent/session-one"]').textContent = dialog.querySelector('input').value; dialog.remove(); };
  });
  const sample = await send({type:'arena-sample-round',jobId:'rename-high',prompt:'probe',minNumbers:165});
  assert.equal(sample.ok,true,sample.error);
  const result = await send({type:'arena-rename-conversation',jobId:'rename-high',name:'mimo-v2.5',url:sample.url});
  assert.equal(result.ok,true,result.error); assert.equal(doc.querySelector('a[href="/agent/session-one"]').textContent,'mimo-v2.5'); dom.window.close();
});
test('hidden conversation three-dot button is revealed before rename', async () => {
  const html = '<nav><div data-state="active"><a href="/agent/session-one">原标题</a><button aria-label="More options" hidden>...</button></div></nav><main><button role="combobox">Agent</button><form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>';
  const {dom,send} = await contentDom(html); const doc = dom.window.document; const clock = Date.now(); let ticks = 0;
  dom.window.Date.now = () => clock + (ticks++ * 1000);
  const more = doc.querySelector('[aria-label="More options"]');
  more.addEventListener('pointerdown', () => doc.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">Rename</button></div>'));
  doc.querySelector('[aria-label="Send message"]').onclick = () => { doc.querySelector('textarea').value = ''; const reply = doc.createElement('div'); reply.dataset.messageAuthorRole = 'assistant'; reply.textContent = Array(180).fill('7').join(','); doc.querySelector('main').append(reply); };
  doc.addEventListener('click', event => { if (event.target.textContent !== 'Rename') return; doc.body.insertAdjacentHTML('beforeend','<div role="dialog"><input type="text"><button>Save</button></div>'); const dialog = doc.querySelector('[role="dialog"]'); dialog.querySelector('button').onclick = () => { doc.querySelector('a[href="/agent/session-one"]').textContent = dialog.querySelector('input').value; dialog.remove(); }; });
  const sample = await send({type:'arena-sample-round',jobId:'rename-hidden',prompt:'probe',minNumbers:165});
  assert.equal(sample.ok,true,sample.error); const result = await send({type:'arena-rename-conversation',jobId:'rename-hidden',name:'claude-haiku-5.5',url:sample.url});
  assert.equal(result.ok,true,result.error); assert.equal(doc.querySelector('a[href="/agent/session-one"]').textContent,'claude-haiku-5.5'); dom.window.close();
});
test('reply timeout is identified separately and stops current generation', async () => {
  const {dom,send} = await contentDom('<main><button role="combobox">Agent</button><form><textarea></textarea><button type="button" aria-label="Send message">Send</button><button type="button" aria-label="Stop generating" hidden>Stop</button></form></main>');
  const doc = dom.window.document; let stopped = 0;
  const clock = Date.now(); let ticks = 0, timingOut = false; dom.window.Date.now = () => clock + (timingOut ? ++ticks * 60000 : 0);
  doc.querySelector('[aria-label="Send message"]').onclick = () => { doc.querySelector('textarea').value = ''; doc.querySelector('[aria-label="Stop generating"]').hidden = false; timingOut = true; };
  doc.querySelector('[aria-label="Stop generating"]').onclick = () => stopped++;
  const result = await send({type:'arena-sample-round',jobId:'timeout-round',prompt:'probe',minNumbers:165,timeoutMs:60000});
  assert.equal(result.ok,false); assert.match(result.error,/MODEL_REPLY_TIMEOUT/); assert.equal(stopped,1); dom.window.close();
});
test('timeout cleanup deletes only the route-matched conversation', async () => {
  const html = '<nav><div><a href="/agent/session-one">Timed out</a><button aria-label="More options">...</button></div></nav><main></main>';
  const {dom,send} = await contentDom(html); const doc = dom.window.document;
  const more = doc.querySelector('[aria-label="More options"]'); let deleted = 0;
  more.addEventListener('pointerdown', () => doc.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">Delete</button></div>'));
  doc.querySelector('nav [role="menuitem"]')?.addEventListener('click', () => {});
  doc.addEventListener('click', event => { if (event.target.textContent === 'Delete') { deleted++; doc.querySelector('a[href="/agent/session-one"]').remove(); } });
  const result = await send({type:'arena-delete-conversation',jobId:'timeout-delete',url:'https://arena.ai/agent/session-one'});
  assert.equal(result.ok,true,result.error); assert.equal(deleted,1); dom.window.close();
});
test('timeout cleanup archives when Arena exposes Archive instead of Delete', async () => {
  const html = '<nav><div><a href="/agent/session-one">Timed out</a><button aria-label="More options">...</button></div></nav><main></main>';
  const {dom,send} = await contentDom(html); const doc = dom.window.document;
  const more = doc.querySelector('[aria-label="More options"]'); let archived = 0;
  more.addEventListener('pointerdown', () => doc.body.insertAdjacentHTML('beforeend','<div role="menu"><button role="menuitem">Archive</button></div>'));
  doc.addEventListener('click', event => { if (event.target.textContent === 'Archive') { archived++; doc.querySelector('a[href="/agent/session-one"]').remove(); } });
  const result = await send({type:'arena-delete-conversation',jobId:'timeout-archive',url:'https://arena.ai/agent/session-one'});
  assert.equal(result.ok,true,result.error); assert.equal(result.action,'archived'); assert.equal(archived,1); dom.window.close();
});
test('reply detection handles Arena message containers outside main', async () => {
  const {dom,send} = await contentDom('<button role="combobox">Agent</button><form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form>');
  const doc = dom.window.document; const clock = Date.now(); let ticks = 0; let sends = 0;
  dom.window.Date.now = () => clock + (ticks++ * 1000);
  doc.querySelector('[aria-label="Send message"]').onclick = () => {
    sends++; doc.querySelector('textarea').value = '';
    const reply = doc.createElement('div'); reply.className = 'message-content markdown';
    reply.textContent = Array(180).fill('7').join(','); doc.body.append(reply);
  };
  const result = await send({type:'arena-sample-round',jobId:'fallback-reply',prompt:'probe',minNumbers:165});
  assert.equal(result.ok,true,result.error); assert.equal(result.sample.count,180); assert.equal(sends,1); dom.window.close();
});
test('cancellation interrupts waiting and never returns old reply', async () => {
  const {dom,send} = await contentDom('<main><button role="combobox">Agent</button><div data-message-author-role="assistant">' + Array(300).fill('7').join(',') + '</div><form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  let sends = 0; dom.window.document.querySelector('[aria-label="Send message"]').onclick = () => { sends++; dom.window.document.querySelector('textarea').value=''; };
  const pending = send({type:'arena-sample-round',jobId:'job-1',prompt:'probe',minNumbers:165});
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await send({type:'cancel-sample',jobId:'job-1'})).ok,true);
  const result = await pending; assert.equal(result.ok,false); assert.equal(result.error,'已停止'); assert.equal(sends,1); dom.window.close();
});
test('Agent selector opens Battle menu, rather than claiming already enabled', async () => {
  const {dom,send} = await contentDom('<button role="combobox">Battle</button><div role="listbox"><button role="option">Agent Mode Built for complex tasks</button></div>');
  let opened=0, selected=0;
  dom.window.document.querySelector('[role="combobox"]').onclick=()=>opened++;
  dom.window.document.querySelector('[role="option"]').onclick=()=>selected++;
  assert.equal((await send({type:'arena-ping'})).agent,false);
  assert.equal((await send({type:'prepare-agent'})).ok,true);
  assert.equal(opened,1);assert.equal(selected,1);dom.window.close();
});
test('confirmed Agent mode survives navigation to a conversation with hidden selector', async () => {
  const {dom,send} = await contentDom('<main><button role="combobox">Agent</button><form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  let sends = 0;
  dom.window.document.querySelector('[aria-label="Send message"]').onclick = () => { sends++; };
  assert.equal((await send({type:'prepare-agent'})).ok,true);
  dom.window.history.replaceState({}, '', '/conversation/created-by-agent');
  dom.window.document.querySelector('[role="combobox"]').remove();
  assert.equal((await send({type:'arena-ping'})).agent,true);
  assert.equal((await send({type:'arena-send-test',jobId:'agent-navigation',prompt:'probe'})).ok,true);
  assert.equal(sends,1);dom.window.close();
});
test('side panel failure resets status/buttons and reports connection error', async () => {
  const html = await readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, {url:'https://extension.test/sidepanel.html',runScripts:'outside-only'});
  const api = mockApi(); api.scripting.executeScript = async () => { throw new Error('Missing host permission'); };
  api.storage = { local: { get: async defaults => defaults, set: async () => {} } };
  api.runtime = { onMessage: {addListener:()=>{}}, getURL: x=>x };
  Object.assign(globalThis, {document:dom.window.document,chrome:api});
  await import('../sidepanel.js');
  await new Promise(resolve=>setTimeout(resolve,10));
  await dom.window.document.querySelector('#start').onclick();
  assert.equal(dom.window.document.querySelector('#modelState').textContent,'识别失败');
  assert.equal(dom.window.document.querySelector('#start').disabled,false);
  assert.equal(dom.window.document.querySelector('#stop').disabled,true);
  assert.match(dom.window.document.querySelector('#statusLine').textContent,/允许访问 Arena/);
  await new Promise(resolve=>setTimeout(resolve,4100));
  dom.window.close();
});
test('side panel reads the Arena pulse quota in the page main world', async () => {
  const html = await readFile(new URL('../sidepanel.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, {url:'https://extension.test/sidepanel.html',runScripts:'outside-only'});
  let scriptDetails;
  const api = {
    tabs: { query: async () => [{id:7,url:'https://arena.ai/agent'}] },
    scripting: { executeScript: async details => { scriptDetails=details; return [{result:{status:200,pulse:1234,refreshedAt:'2026-10-11T00:00:00Z'}}]; } },
    storage: { local: { get: async defaults => defaults, set: async () => {} } },
    runtime: { onMessage: {addListener:()=>{}}, getURL: x=>x }
  };
  Object.assign(globalThis, {document:dom.window.document,chrome:api});
  await import('../sidepanel.js?quota-test');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(scriptDetails.world,'MAIN');
  assert.equal(scriptDetails.target.tabId,7);
  assert.equal(dom.window.document.querySelector('#quotaValue').textContent,'1,234');
  dom.window.close();
});
test('wrong task cannot cancel another task; completed reply excludes old messages and prompt', async () => {
  const sequence = Array.from({length:180}, (_,i)=>i+1).join(',');
  const {dom,send} = await contentDom('<main><button role="combobox">Agent</button><div data-message-author-role="assistant">OLD ' + Array(300).fill('7').join(',') + '</div><form><textarea></textarea><button type="button" aria-label="Send message">Send</button><button type="button" aria-label="Stop generating" hidden>Stop</button></form></main>');
  const doc=dom.window.document;
  const stop=doc.querySelector('[aria-label="Stop generating"]');
  const clock=Date.now(); let ticks=0;
  dom.window.Date.now=()=>clock+(ticks++*400);
  doc.querySelector('[aria-label="Send message"]').onclick=()=>{
    doc.querySelector('textarea').value='';stop.hidden=false;
    const user=doc.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=sequence;doc.querySelector('main').append(user);
    const reply=doc.createElement('div');reply.dataset.messageAuthorRole='assistant';reply.textContent=sequence;doc.querySelector('main').append(reply);
    setTimeout(()=>{reply.textContent=sequence+',181';stop.hidden=true;},500);
  };
  const pending=send({type:'arena-sample-round',jobId:'current',prompt:sequence,minNumbers:165});
  await new Promise(resolve=>setTimeout(resolve,40));
  await send({type:'cancel-sample',jobId:'other'});
  const result=await pending;
  assert.equal(result.ok,true);assert.equal(result.sample.count,181);assert.equal(result.sample.text,sequence+',181');dom.window.close();
});

const feedbackHtml = '<section id="feedback"><header><span>此任务成功了吗？</span><button aria-label="Close">Esc ×</button></header><button>是</button><button>否</button><button>继续工作</button></section>';
test('task feedback is dismissed with Escape before sending, without voting', async () => {
  const {dom,send}=await contentDom('<main>'+feedbackHtml+'<form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  const doc=dom.window.document; let escapes=0,sends=0,votes=0;
  doc.querySelectorAll('#feedback button').forEach(button=>button.onclick=()=>votes++);
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'){escapes++;doc.querySelector('#feedback')?.remove();}});
  doc.querySelector('[aria-label="Send message"]').onclick=()=>sends++;
  assert.equal((await send({type:'arena-ping'})).agent,true);
  const result=await send({type:'arena-send-test',jobId:'feedback-start',prompt:'probe'});
  assert.equal(result.ok,true);assert.equal(escapes,1);assert.equal(sends,1);assert.equal(votes,0);dom.window.close();
});
test('feedback close button is fallback when synthetic Escape is ignored', async () => {
  const {dom,send}=await contentDom('<main>'+feedbackHtml+'<form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  const doc=dom.window.document;let closes=0,votes=0;
  doc.querySelectorAll('#feedback button').forEach(button=>button.onclick=()=>votes++);
  doc.querySelector('#feedback [aria-label="Close"]').onclick=()=>{closes++;doc.querySelector('#feedback').remove();};
  const result=await send({type:'arena-send-test',jobId:'feedback-fallback',prompt:'probe'});
  assert.equal(result.ok,true);assert.equal(closes,1);assert.equal(votes,0);dom.window.close();
});
test('Japanese Agent completion feedback is dismissed with Escape before sending', async () => {
  const panel = '<section id="feedback"><header><span>このタスクは成功しましたか？</span><button aria-label="Close">Esc ×</button></header><button>はい</button><button>いいえ</button><button>作業を続ける</button></section>';
  const {dom,send}=await contentDom('<main>'+panel+'<form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  const doc=dom.window.document;let escapes=0,sends=0,votes=0;
  doc.querySelectorAll('#feedback button').forEach(button=>button.onclick=()=>votes++);
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'){escapes++;doc.querySelector('#feedback')?.remove();}});
  doc.querySelector('[aria-label="Send message"]').onclick=()=>sends++;
  const result=await send({type:'arena-send-test',jobId:'japanese-feedback',prompt:'probe'});
  assert.equal(result.ok,true);assert.equal(escapes,1);assert.equal(sends,1);assert.equal(votes,0);dom.window.close();
});
test('Spanish feedback is detected from page language and localized choices', async () => {
  const panel = '<section id="feedback"><header><span>¿Esta tarea tuvo éxito?</span><button aria-label="Close">Esc ×</button></header><button>Sí</button><button>No</button><button>Continuar</button></section>';
  const {dom,send}=await contentDom('<html lang="es"><body><main>'+panel+'<form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main></body></html>');
  const doc=dom.window.document;let escapes=0,votes=0;
  doc.querySelectorAll('#feedback button').forEach(button=>button.onclick=()=>votes++);
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'){escapes++;doc.querySelector('#feedback')?.remove();}});
  const result=await send({type:'arena-send-test',jobId:'spanish-feedback',prompt:'probe'});
  assert.equal(result.ok,true);assert.equal(escapes,1);assert.equal(votes,0);dom.window.close();
});
test('Korean feedback is detected from its script and localized choices', async () => {
  const panel = '<section id="feedback"><header><span>이 작업이 성공했나요?</span><button aria-label="Close">Esc ×</button></header><button>예</button><button>아니요</button><button>계속 작업</button></section>';
  const {dom,send}=await contentDom('<main>'+panel+'<form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  const doc=dom.window.document;let escapes=0;
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'){escapes++;doc.querySelector('#feedback')?.remove();}});
  const result=await send({type:'arena-send-test',jobId:'korean-feedback',prompt:'probe'});
  assert.equal(result.ok,true);assert.equal(escapes,1);dom.window.close();
});
test('feedback with icon-only choices is detected; ordinary questions remain untouched', async () => {
  const panel = '<section id="feedback"><header><span>Did this task work?</span><button aria-label="Close">Esc ×</button></header><button><svg class="lucide-check"></svg></button><button><svg class="lucide-circle-x"></svg></button><button><svg class="lucide-pencil"></svg></button></section>';
  const {dom,send}=await contentDom('<main><div role="dialog"><h2>Would you like to continue?</h2><button>OK</button><button>Cancel</button></div>'+panel+'<form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  const doc=dom.window.document;let escapes=0;
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'){escapes++;doc.querySelector('#feedback')?.remove();}});
  const result=await send({type:'arena-send-test',jobId:'icon-feedback',prompt:'probe'});
  assert.equal(result.ok,true);assert.equal(escapes,1);assert.ok(doc.querySelector('[role="dialog"]'));dom.window.close();
});
test('security verification pauses the reply timeout and resumes sampling after it disappears', async () => {
  const {dom,send}=await contentDom('<main><button role="combobox">Agent</button><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=test"></iframe><form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  const doc=dom.window.document;const clock=Date.now();let ticks=0,timingOut=false;
  dom.window.Date.now=()=>clock+(timingOut?++ticks*5000:0);
  doc.querySelector('[aria-label="Send message"]').onclick=()=>{
    timingOut=true;
    doc.querySelector('textarea').value='';
    const reply=doc.createElement('div');reply.dataset.messageAuthorRole='assistant';reply.textContent=Array(180).fill('7').join(',');doc.querySelector('main').append(reply);
    doc.querySelector('main').insertAdjacentHTML('beforeend','<div role="dialog"><h2>Security Verification</h2><p>Please complete this quick security check to continue.</p></div>');
    setTimeout(()=>doc.querySelector('[role="dialog"]')?.remove(),20);
  };
  const result=await send({type:'arena-sample-round',jobId:'challenge-resume',prompt:'probe',minNumbers:165,timeoutMs:60000});
  assert.equal(result.ok,true,result.error);assert.equal(result.sample.count,180);dom.window.close();
});
test('feedback appearing after each reply does not end the three-round task', async () => {
  const {dom,send}=await contentDom('<main><form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  const doc=dom.window.document;let sends=0,escapes=0;
  const clock=Date.now();let ticks=0;dom.window.Date.now=()=>clock+(ticks++*400);
  doc.addEventListener('keydown',event=>{if(event.key==='Escape'){escapes++;doc.querySelector('#feedback')?.remove();}});
  doc.querySelector('[aria-label="Send message"]').onclick=()=>{
    sends++;doc.querySelector('textarea').value='';
    const reply=doc.createElement('div');reply.dataset.messageAuthorRole='assistant';reply.textContent=Array(180).fill(sends).join(',');doc.querySelector('main').append(reply);
    doc.querySelector('main').insertAdjacentHTML('beforeend',feedbackHtml);
  };
  for(let round=0;round<3;round++) {
    const result=await send({type:'arena-sample-round',jobId:'three-rounds',prompt:'probe '+round,minNumbers:165});
    assert.equal(result.ok,true,result.error);assert.equal(result.sample.count,180);
  }
  assert.equal(sends,3);assert.equal(escapes,3);dom.window.close();
});
test('unrelated questions and dialogs do not trigger Escape', async () => {
  const {dom,send}=await contentDom('<main><div role="dialog"><h2>其他提示</h2><button>是</button><button>否</button><button>继续工作</button></div><div class="prose">'+feedbackHtml+'</div><form><textarea></textarea><button type="button" aria-label="Send message">Send</button></form></main>');
  let escapes=0;dom.window.document.addEventListener('keydown',()=>escapes++);
  const result=await send({type:'arena-send-test',jobId:'unrelated',prompt:'probe'});
  assert.equal(result.ok,true);assert.equal(escapes,0);dom.window.close();
});
