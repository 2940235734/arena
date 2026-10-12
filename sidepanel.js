import { activeTab, isArenaUrl, sendToArena, prepareAgent, friendlyError } from './bridge.js';
const $ = selector => document.querySelector(selector);
const defaultPrompts = [
  '请只输出 300 个用英文逗号分隔的整数，每个整数范围为 1 到 355。不要解释，不要编号，不要换成文字。',
  'Generate exactly 300 integers from 1 to 355 separated by commas. Output numbers only, with no explanation or numbering.',
  '次の指示に従ってください。1から355までの整数を300個、カンマ区切りで数字だけ出力してください。説明や番号は不要です。'
];
const pelicanTestPrompt = '创建一个新 HTML，使用 SVG 绘制一个鹈鹕骑自行车的 2D 动画。页面中只展示自动播放、循环播放的动画，不要解释、说明文字、按钮、菜单或任何交互功能，不需要任何测试。';
const defaults = { baseUrl: 'https://api.openai.com/v1', format: 'openai', model: '', apiKey: '', agentMode: true, autoRename: true, modelCount: 1, prompts: defaultPrompts, fingerprint: { minNumbers: 165, rounds: 3, confidenceThreshold: 0.9, timeoutMinutes: 3 } };
let settings = {}, job = null;
function normalizeThreshold(value) {
  let threshold = Number(value);
  if (!Number.isFinite(threshold)) threshold = 0.9;
  if (threshold > 1) threshold /= 100;
  return Math.min(1, Math.max(0.5, threshold));
}
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 4000); }
function config() {
  const prompts = $('#prompts').value.split('\n').map(x => x.trim()).filter(Boolean);
  if (prompts.length !== 3) throw new Error('请设置恰好 3 条提示词，每行一条。');
  const minNumbers = Number($('#minNumbers').value);
  if (!Number.isInteger(minNumbers) || minNumbers < 165 || minNumbers > 300) throw new Error('最少有效数字应为 165–300 的整数。');
  const modelCount = Number($('#modelCount').value);
  if (!Number.isInteger(modelCount) || modelCount < 1 || modelCount > 20) throw new Error('抽取模型数量应为 1–20 的整数。');
  const confidencePercent = Number($('#confidenceThreshold').value);
  if (!Number.isFinite(confidencePercent) || confidencePercent < 50 || confidencePercent > 100) throw new Error('自动重命名最低置信度应为 50–100%。');
  const timeoutMinutes = Number($('#timeoutMinutes').value);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 30) throw new Error('单个会话回复超时应为 1–30 分钟。');
  return { ...settings, format: $('#format').value, baseUrl: $('#baseUrl').value.trim(), apiKey: $('#apiKey').value.trim(), model: $('#model').value.trim(), agentMode: true, autoRename: $('#autoRename').checked, modelCount, prompts, fingerprint: { minNumbers, rounds: 3, confidenceThreshold: confidencePercent / 100, timeoutMinutes } };
}
function progress(completed, message, modelIndex = 0, modelTotal = 1) {
  $('#modelIndex').textContent = modelIndex;
  $('#modelTotal').textContent = modelTotal;
  $('#round').textContent = completed;
  const overall = modelTotal ? ((Math.max(0, modelIndex - 1) + completed / 3) / modelTotal) * 100 : 0;
  $('#progressBar').style.width = `${Math.min(100, overall)}%`;
  $('#statusLine').textContent = message;
}
function addModelResult(index, result) {
  const list = $('#modelResults');
  const item = document.createElement('li');
  if (result.error) { item.className = 'failed'; item.textContent = `第 ${index} 个模型：${result.error}`; }
  else {
    const confidence = Math.round(result.confidence * 100);
    const detail = result.renamed ? '已重命名' : !result.autoRename ? '未启用自动重命名' : result.confidence >= result.threshold ? `重命名失败${result.renameError ? `：${result.renameError}` : ''}` : `低于 ${Math.round(result.threshold * 100)}%，保留原标题`;
    item.innerHTML = `第 ${index} 个模型：<strong>${result.name}</strong> · ${confidence}% · ${detail}`;
  }
  list.append(item);
}
async function openAgentConversation(tabId, current) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !isArenaUrl(tab.url)) throw new Error('Arena 标签页已切换，请重新打开 Arena。');
  await chrome.tabs.update(tabId, { url: new URL('/agent', tab.url).href });
  // Let the old document detach before the handshake; otherwise its content
  // script can answer the ping while the new Agent page is still loading.
  await new Promise(resolve => setTimeout(resolve, 800));
  for (let attempt = 0; attempt < 40; attempt++) {
    check(current);
    try {
      const latest = await chrome.tabs.get(tabId);
      if (latest.status === 'complete' || latest.status === undefined) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await prepareAgent(tabId, () => check(current));
}
async function processModelResult(response, current, runConfig, tabId, sampleUrl, modelIndex, modelTotal) {
  check(current);
  if (!response?.ok) throw new Error(response?.error || '识别失败');
  const top = response.result?.fingerprint?.results?.[0];
  if (!top) throw new Error('Ikaleio 引擎没有返回可用模型结果。');
  const threshold = normalizeThreshold(runConfig.fingerprint?.confidenceThreshold);
  const confidence = Number(top.probability) || 0;
  const name = top.display_name || top.model || '未命名模型';
  let renamed = false;
  let renameError = '';
  if (runConfig.autoRename && current.arena && confidence >= threshold) {
    try {
      check(current);
      await sendToArena(tabId, { type: 'arena-rename-conversation', jobId: current.id, name, url: sampleUrl });
      renamed = true;
    } catch (error) { renameError = friendlyError(error); }
  }
  addModelResult(modelIndex, { name, confidence, threshold, renamed, autoRename: runConfig.autoRename, renameError });
  current.results.push({ name, confidence, renamed });
  $('#modelState').textContent = name;
  const suffix = renamed ? ' · 已重命名' : !runConfig.autoRename ? ' · 未启用自动重命名' : confidence >= threshold ? ` · 重命名失败${renameError ? `：${renameError}` : ''}` : ` · 低于 ${Math.round(threshold * 100)}%，未重命名`;
  progress(3, `第 ${modelIndex}/${modelTotal} 个模型完成 · 置信度 ${Math.round(confidence * 100)}%${suffix}`, modelIndex, modelTotal);
  return { name, confidence, renamed };
}
function buttons(running) {
  for (const id of ['start', 'newChat', 'sendTest', 'refresh']) $('#' + id).disabled = running;
  $('#stop').disabled = !running;
}
function check(current) { if (current.cancelled) throw new Error('已停止'); }
async function load() {
  const data = await chrome.storage.local.get({ settings: defaults });
  settings = { ...defaults, ...data.settings };
  for (const id of ['format', 'baseUrl', 'apiKey', 'model']) $('#' + id).value = settings[id];
  $('#autoRename').checked = settings.autoRename !== false;
  $('#modelCount').value = Math.min(20, Math.max(1, Number(settings.modelCount) || 1));
  $('#prompts').value = (settings.prompts?.length === 3 ? settings.prompts : defaultPrompts).join('\n');
  $('#minNumbers').value = Math.max(165, settings.fingerprint?.minNumbers || 165);
  $('#confidenceThreshold').value = Math.round(normalizeThreshold(settings.fingerprint?.confidenceThreshold) * 100);
  $('#timeoutMinutes').value = Math.min(30, Math.max(1, Number(settings.fingerprint?.timeoutMinutes) || 3));
  $('#accountLabel').textContent = '使用当前浏览器登录状态';
}
async function refreshQuota() {
  const value = $('#quotaValue');
  value.textContent = '查询中…';
  value.title = '';
  try {
    const tab = await activeTab();
    const url = new URL(tab.url || '');
    if (url.protocol !== 'https:' || !(url.hostname === 'arena.ai' || url.hostname.endsWith('.arena.ai'))) {
      throw new Error('请切换到 arena.ai 页面查询');
    }
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'MAIN',
      func: async () => {
        try {
          const response = await fetch('/api/me/pulse', { credentials: 'include', headers: { accept: 'application/json' } });
          const body = await response.json().catch(() => null);
          return { status: response.status, pulse: typeof body?.pulse === 'number' ? body.pulse : null, refreshedAt: typeof body?.refreshedAt === 'string' ? body.refreshedAt : null };
        } catch { return { status: 0, pulse: null, refreshedAt: null }; }
      }
    });
    const quota = execution?.result;
    if (!quota || quota.status === 0) throw new Error('额度查询网络失败');
    if (quota.status === 401) throw new Error('未登录');
    if (quota.status === 403) throw new Error('查询被网站拒绝');
    if (quota.status === 429) throw new Error('查询过于频繁，请稍后刷新');
    if (quota.status < 200 || quota.status >= 300) throw new Error(`额度查询失败（HTTP ${quota.status}）`);
    if (!Number.isFinite(quota.pulse)) throw new Error('额度数据无效');
    value.textContent = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(quota.pulse);
    if (quota.refreshedAt) {
      const refreshedAt = new Date(quota.refreshedAt);
      if (!Number.isNaN(refreshedAt.valueOf())) value.title = `更新时间：${refreshedAt.toLocaleString()}`;
    }
  } catch (error) {
    value.textContent = error.message || '额度查询失败';
  }
}
chrome.runtime.onMessage.addListener(message => {
  if (!job || job.cancelled || message.jobId !== job.id) return;
  if (message.type === 'recognize-progress') progress(message.completed, message.message);
  if (message.type === 'arena-challenge-state') {
    $('#statusLine').textContent = message.active ? '检测到安全验证，请在页面完成验证；任务已暂停计时' : '安全验证完成，继续等待当前模型回复';
    $('#loginNotice').textContent = message.active ? '检测到验证弹窗 · 请完成页面验证，插件会自动继续抽样' : '验证完成 · 已恢复当前模型抽样';
  }
});
$('#start').onclick = async () => {
  if (job) return;
  const current = { id: crypto.randomUUID(), tabId: null, cancelled: false, arena: false, results: [] };
  job = current; buttons(true); $('#modelState').textContent = '准备中…'; $('#modelResults').replaceChildren(); progress(0, '正在连接当前页面', 0, 1);
  try {
    settings = config(); const runConfig = structuredClone(settings);
    await chrome.storage.local.set({ settings });
    const tab = await activeTab(); check(current);
    current.tabId = tab.id; current.arena = isArenaUrl(tab.url);
    const modelTotal = current.arena ? runConfig.modelCount : 1;
    $('#modelTotal').textContent = modelTotal;
    if (!current.arena && runConfig.modelCount > 1) throw new Error('API 模式只能识别配置的一个模型；请切换到 Arena 页面后再批量抽取。');
    if (current.arena) {
      $('#loginNotice').textContent = `正在准备 Agent 模式，将抽取 ${modelTotal} 个独立会话`;
      await prepareAgent(tab.id, () => check(current)); check(current);
      $('#loginNotice').textContent = '已确认 Agent 模式 · 第一个模型使用当前会话，后续会自动创建新会话';
      let modelIndex = 0;
      const maxAttempts = modelTotal * 3;
      while (current.results.filter(result => !result.timeout).length < modelTotal) {
        modelIndex++;
        if (modelIndex > maxAttempts) throw new Error(`连续 ${maxAttempts} 个会话回复超时或失败，已停止批量抽取。`);
        check(current);
        if (modelIndex > 1) {
          progress(0, `正在打开第 ${current.results.filter(result => !result.timeout).length + 1}/${modelTotal} 个模型的新 Agent 会话（尝试 ${modelIndex}）`, modelIndex, modelTotal);
          await openAgentConversation(tab.id, current);
        }
        const successfulIndex = current.results.filter(result => !result.timeout).length + 1;
        $('#modelState').textContent = `第 ${successfulIndex}/${modelTotal} 个模型识别中…`;
        const samples = []; let sampleUrl = ''; const startedAt = Date.now();
        for (let index = 0; index < 3; index++) {
          check(current);
          if (sampleUrl && (await chrome.tabs.get(tab.id)).url !== sampleUrl) throw new Error('对话地址已变化，已停止后续抽样。');
          progress(index, `第 ${modelIndex}/${modelTotal} 个模型：等待第 ${index + 1}/3 组回复`, modelIndex, modelTotal);
          let sampled;
          try {
            sampled = await sendToArena(tab.id, { type: 'arena-sample-round', jobId: current.id, prompt: runConfig.prompts[index], minNumbers: runConfig.fingerprint.minNumbers, timeoutMs: runConfig.fingerprint.timeoutMinutes * 60 * 1000 });
          } catch (error) {
            if (!/MODEL_REPLY_TIMEOUT:/.test(error?.message || '')) throw error;
            check(current);
            const timeoutMessage = `第 ${successfulIndex}/${modelTotal} 个模型回复超时，正在停止并移除该会话`;
            progress(index, timeoutMessage, modelIndex, modelTotal);
            const cleanup = await sendToArena(tab.id, { type: 'arena-delete-conversation', jobId: current.id, url: sampleUrl || (await chrome.tabs.get(tab.id)).url });
            check(current);
            const cleanupLabel = cleanup?.action === 'archived' ? '已归档（当前页面未提供删除）' : '已删除';
            addModelResult(modelIndex, { error: `回复超过 ${runConfig.fingerprint.timeoutMinutes} 分钟，会话${cleanupLabel}，已跳过` });
            current.results.push({ timeout: true, cleanup: cleanup?.action || 'deleted' });
            $('#modelState').textContent = `会话超时，${cleanupLabel}，继续下一个模型`;
            break;
          }
          check(current); samples.push(sampled.sample); sampleUrl = sampled.url;
          progress(index + 1, `第 ${modelIndex}/${modelTotal} 个模型：已收到第 ${index + 1}/3 组回复`, modelIndex, modelTotal);
        }
        if (samples.length !== 3) continue;
        const response = await chrome.runtime.sendMessage({ type: 'analyze-samples', jobId: current.id, config: runConfig, samples, startedAt });
        await processModelResult(response, current, runConfig, tab.id, sampleUrl, modelIndex, modelTotal);
      }
      const recognizedCount = current.results.filter(result => !result.timeout).length;
      progress(3, `已完成 ${recognizedCount}/${modelTotal} 个模型的 Ikaleio 验证`, modelIndex, modelTotal);
      toast(`已完成 ${recognizedCount} 个模型识别`);
    } else {
      if (!runConfig.apiKey || !runConfig.baseUrl || !runConfig.model) throw new Error('请先切换到 Arena 对话，或填写完整 API 配置。');
      $('#loginNotice').textContent = 'API 模式 · 正在向所配置接口请求探测样本';
      $('#modelState').textContent = '识别中…';
      const response = await chrome.runtime.sendMessage({ type: 'recognize', jobId: current.id, config: runConfig });
      await processModelResult(response, current, runConfig, tab.id, '', 1, 1);
      toast('模型指纹分析完成');
    }
  } catch (error) {
    $('#modelState').textContent = current.cancelled ? '已停止' : '识别失败';
    $('#statusLine').textContent = current.cancelled ? '任务已停止，不再发送后续提示词。' : friendlyError(error);
    toast($('#statusLine').textContent);
  } finally { if (job === current) job = null; buttons(false); }
};
$('#stop').onclick = async () => {
  const current = job; if (!current) return;
  current.cancelled = true; $('#stop').disabled = true; $('#modelState').textContent = '正在停止…';
  try {
    if (current.arena && current.tabId) await sendToArena(current.tabId, { type: 'cancel-sample', jobId: current.id });
    else await chrome.runtime.sendMessage({ type: 'cancel-recognize', jobId: current.id });
    $('#statusLine').textContent = '已请求停止，正在结束当前步骤。';
  } catch (error) { $('#statusLine').textContent = `后续步骤已取消；${friendlyError(error)}`; }
};
async function save() { settings = config(); await chrome.storage.local.set({ settings }); }
$('#save').onclick = () => save().then(() => toast('配置已保存')).catch(error => toast(error.message));
$('#promptSettings').onclick = () => $('#promptModal').classList.remove('hidden');
$('#restorePrompts').onclick = () => { $('#prompts').value = defaultPrompts.join('\n'); toast('已恢复默认提示词，点击“完成”保存'); };
$('#fingerSettings').onclick = () => $('#fingerModal').classList.remove('hidden');
document.addEventListener('click', async event => {
  const id = event.target.dataset.close; if (!id) return;
  try { await save(); $('#' + id).classList.add('hidden'); } catch (error) { toast(error.message); }
});
$('#openFull').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
$('#refresh').onclick = () => Promise.all([load(), refreshQuota()]).then(() => toast('账号信息已刷新')).catch(error => toast(friendlyError(error)));
async function pageAction(type) {
  if (job) return;
  buttons(true); $('#stop').disabled = true;
  try {
    const tab = await activeTab();
    if (type === 'arena-send-test') await prepareAgent(tab.id, () => {});
    if (type === 'new-chat') {
      if (!isArenaUrl(tab.url)) throw new Error('请切换到 Arena 标签页。');
      await chrome.tabs.update(tab.id, { url: new URL('/agent', tab.url).href });
      toast('已打开新的 Agent 会话页面');
    } else {
      await sendToArena(tab.id, { type, jobId: crypto.randomUUID(), prompt: pelicanTestPrompt });
      toast('已点击发送鹈鹕骑自行车测试');
    }
  } catch (error) { toast(friendlyError(error)); $('#statusLine').textContent = friendlyError(error); }
  finally { buttons(false); }
}
$('#newChat').onclick = () => pageAction('new-chat');
$('#sendTest').onclick = () => pageAction('arena-send-test');
load().then(refreshQuota).catch(error => toast(friendlyError(error)));

