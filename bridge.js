export const PROTOCOL = 'arena-assistant/1.2.9';
export function isArenaUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && ['arena.ai', 'lmarena.ai', 'chat.lmsys.org'].some(host => url.hostname === host || (host !== 'chat.lmsys.org' && url.hostname.endsWith(`.${host}`)));
  } catch { return false; }
}
export function friendlyError(error) {
  const text = error?.message || String(error);
  if (/Receiving end does not exist|Could not establish connection|message port closed|message channel closed|Extension context invalidated/i.test(text)) return '页面连接已中断。请刷新 Arena 页面后再试；为避免重复发送，本次任务不会自动重发。';
  if (/No tab with id|Invalid tab ID/i.test(text)) return '任务标签页已关闭，请打开 Arena 对话后重试。';
  if (/Cannot access|Missing host permission|Cannot script/i.test(text)) return '无法连接此页面，请在扩展管理中允许访问 Arena 网站，并重新加载扩展。';
  return text;
}
export async function activeTab(api = chrome) {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('未找到当前标签页，请先打开 Arena。');
  return tab;
}
export async function ensureConnection(tabId, api = chrome) {
  const tab = await api.tabs.get(tabId);
  if (!isArenaUrl(tab.url)) throw new Error('请切换到 arena.ai 或 lmarena.ai 对话页面。');
  let pong;
  try { pong = await api.tabs.sendMessage(tabId, { type: 'arena-ping' }, { frameId: 0 }); } catch { /* Missing receiver after reload. */ }
  if (pong?.protocol === PROTOCOL) return pong;
  await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
  pong = await api.tabs.sendMessage(tabId, { type: 'arena-ping' }, { frameId: 0 });
  if (pong?.protocol !== PROTOCOL) throw new Error('页面脚本版本不一致，请刷新 Arena 页面再试。');
  return pong;
}
// Reconnect BEFORE an operation. Never retry a business message with uncertain delivery.
export async function sendToArena(tabId, message, api = chrome) {
  await ensureConnection(tabId, api);
  const result = await api.tabs.sendMessage(tabId, message, { frameId: 0 });
  if (!result?.ok) throw new Error(result?.error || result?.reason || '页面未确认操作成功。');
  return result;
}
export async function prepareAgent(tabId, checkCancelled, api = chrome) {
  if ((await ensureConnection(tabId, api)).agent) return;
  checkCancelled();
  try {
    const result = await api.tabs.sendMessage(tabId, { type: 'prepare-agent' }, { frameId: 0 });
    if (result && !result.ok) throw new Error(result.error);
  } catch (error) {
    // Agent selection can replace the document. Only read-only handshakes are retried.
    if (!/Receiving end|connection|port closed|channel closed/i.test(error.message)) throw error;
  }
  for (let i = 0; i < 30; i++) {
    checkCancelled();
    await new Promise(resolve => setTimeout(resolve, 400));
    try { if ((await ensureConnection(tabId, api)).agent) return; } catch { /* Navigation loading. */ }
  }
  throw new Error('未能确认 Agent 模式，请在 Arena 的模式下拉菜单中选择 Agent 后重试。');
}
