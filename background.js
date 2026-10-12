import { analyze, parseNumbers } from './fingerprint.js';
const DEFAULTS = {
  settings: { baseUrl: 'https://api.openai.com/v1', format: 'openai', model: '', apiKey: '', agentMode: true, autoRename: true, prompts: [], fingerprint: { minNumbers: 165, rounds: 3 } },
  accounts: [], history: []
};
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(DEFAULTS).then(value => chrome.storage.local.set(value));
  chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'arena-recognize', title: 'Arena：打开模型识别侧边栏', contexts: ['page'] }));
});
chrome.action.onClicked.addListener(tab => chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'arena-recognize') chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
});
const jobs = new Map();
let bankPromise;
function bank() { return bankPromise ||= fetch(chrome.runtime.getURL('unified_bank.json')).then(r => r.json()).catch(error => { bankPromise = null; throw error; }); }
const probes = [
  '请只输出 300 个用英文逗号分隔的整数，每个整数范围为 1 到 355。不要解释，不要编号，不要换成文字。',
  'Generate exactly 300 integers from 1 to 355 separated by commas. Output numbers only, with no explanation or numbering.',
  '次の指示に従ってください。1から355までの整数を300個、カンマ区切りで数字だけ出力してください。説明や番号は不要です。'
];
function endpoint(baseUrl, format) {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('API 地址必须使用 HTTP 或 HTTPS。');
  const suffix = format === 'responses' ? '/responses' : format === 'anthropic' ? '/messages' : '/chat/completions';
  let path = url.pathname.replace(/\/$/, '');
  if (!path.endsWith(suffix)) path += (path.endsWith('/v1') ? '' : '/v1') + suffix;
  url.pathname = path; return url.href;
}
function check(signal) { if (signal?.aborted) throw new Error('已停止'); }
async function callApi(config, prompt, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 120000);
  try {
    check(signal);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (config.format === 'anthropic') { headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true'; }
    else headers.Authorization = `Bearer ${config.apiKey}`;
    const body = config.format === 'responses'
      ? { model: config.model, input: prompt, max_output_tokens: 4096 }
      : { model: config.model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] };
    const res = await fetch(endpoint(config.baseUrl, config.format), { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const raw = await res.text();
    let data; try { data = JSON.parse(raw); } catch { throw new Error(`接口返回不是 JSON（HTTP ${res.status}）`); }
    if (!res.ok) throw new Error(data?.error?.message || `请求失败（HTTP ${res.status}）`);
    const text = config.format === 'responses' ? (data.output?.flatMap(x => x.content || []).map(x => x.text).filter(Boolean).join('') || data.output_text || '')
      : config.format === 'anthropic' ? (data.content?.map(x => x.text || '').join('') || '')
        : (data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '');
    return { text, model: data.model || '', usage: data.usage || {} };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal.aborted ? '已停止' : '接口请求超时（2 分钟）。');
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
function validateSamples(samples, config) {
  if (!Array.isArray(samples) || samples.length !== 3) throw new Error('需要完整的 3 组样本。');
  const minimum = Math.max(165, Number(config.fingerprint?.minNumbers) || 165);
  samples.forEach((sample, index) => {
    const count = parseNumbers(sample.text || '').length;
    if (count < minimum) throw new Error(`第 ${index + 1} 组有效数字不足（${count}/${minimum}），请调整提示词后重试。`);
    sample.count = count;
  });
}
async function analyzeSamples(config, samples, startedAt, signal) {
  check(signal); validateSamples(samples, config);
  const reference = await bank(); check(signal);
  const fingerprint = analyze(samples.map(sample => ({ text: sample.text, expected_count: 300 })), reference);
  const threshold = Math.min(1, Math.max(0.5, Number(config.fingerprint?.confidenceThreshold) || 0.9));
  const top = fingerprint.results?.[0];
  const verification = { provider: 'Ikaleio Fingerpoint Detector', url: 'https://lm.ikale.io/', confidence: Number(top?.probability) || 0, threshold, passed: Boolean(top && top.probability >= threshold) };
  const result = { reportedModel: samples[0].model || '', candidates: fingerprint.results.slice(0, 8).map(x => ({ model: x.model, name: x.display_name, confidence: x.probability })), fingerprint, verification, samples, elapsedMs: Date.now() - startedAt, createdAt: new Date().toISOString() };
  check(signal);
  const data = await chrome.storage.local.get({ history: [] }); check(signal);
  const { apiKey, ...safeConfig } = config;
  await chrome.storage.local.set({ history: [{ ...result, config: safeConfig }, ...data.history].slice(0, 30) });
  return result;
}
async function recognize(config, jobId, signal) {
  if (!config.apiKey || !config.baseUrl || !config.model) throw new Error('请填写接口地址、API Key 和模型名。');
  const startedAt = Date.now(); const samples = [];
  const prompts = config.prompts?.length === 3 ? config.prompts : probes;
  for (let index = 0; index < 3; index++) {
    check(signal);
    chrome.runtime.sendMessage({ type: 'recognize-progress', jobId, completed: index, total: 3, message: `正在请求第 ${index + 1}/3 组样本` }).catch(() => {});
    const reply = await callApi(config, prompts[index], signal); check(signal);
    samples.push({ prompt: prompts[index], ...reply });
  }
  return analyzeSamples(config, samples, startedAt, signal);
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only extension pages can trigger API requests or access their saved credentials.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (message.type === 'cancel-recognize') { jobs.get(message.jobId)?.abort(); respond({ ok: true }); return; }
  if (!['recognize', 'analyze-samples'].includes(message.type)) return;
  const jobId = message.jobId || crypto.randomUUID();
  if (jobs.has(jobId)) { respond({ ok: false, error: '任务已在运行。' }); return; }
  const controller = new AbortController(); jobs.set(jobId, controller);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  const work = message.type === 'recognize'
    ? recognize(message.config || {}, jobId, controller.signal)
    : analyzeSamples(message.config || {}, message.samples, message.startedAt || Date.now(), controller.signal);
  work.then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, error: error.message }))
    .finally(() => { clearInterval(keepAlive); jobs.delete(jobId); });
  return true;
});
