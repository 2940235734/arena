const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = { accounts: [], history: [], settings: {} };

function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2400); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function load() {
  const data = await chrome.storage.local.get({ accounts: [], history: [], settings: { baseUrl: 'https://api.openai.com/v1', format: 'openai', model: '', apiKey: '' } });
  state.accounts = data.accounts; state.history = data.history; state.settings = data.settings;
  renderAccounts(); renderSettings(); renderHistory();
  if (new URLSearchParams(location.search).get('run') === '1') { showView('recognize'); setTimeout(() => $('#startRecognize').click(), 200); }
}
function renderAccounts() {
  $('#accountCount').textContent = state.accounts.length;
  const q = ($('#search')?.value || '').toLowerCase();
  const rows = state.accounts.filter(a => `${a.name} ${a.email}`.toLowerCase().includes(q));
  $('#emptyAccounts').classList.toggle('hidden', rows.length > 0);
  $('#accountsBody').innerHTML = rows.map(a => `<tr data-id="${esc(a.id)}"><td><input type="checkbox"></td><td><div class="account-cell"><div class="avatar">▥</div><div><span class="account-name">${esc(a.name)}</span><span class="account-sub">${esc(a.email || a.id)}</span></div></div></td><td><span class="usage">未知</span></td><td>${a.lastOpened ? `<span class="status">● 曾打开</span>` : '<span class="muted">未验证</span>'}</td><td><span class="muted">默认</span></td><td><div class="row-actions"><button data-open="${esc(a.id)}">打开 Arena</button><button data-copy="${esc(a.id)}">复制账号</button><button data-delete="${esc(a.id)}">删除</button></div></td></tr>`).join('');
  $$('#accountsBody [data-open]').forEach(b => b.onclick = () => { const a = state.accounts.find(x => x.id === b.dataset.open); if (a) { chrome.tabs.create({ url: a.platform || 'https://arena.ai' }); a.lastOpened = new Date().toISOString(); chrome.storage.local.set({ accounts: state.accounts }); renderAccounts(); } });
  $$('#accountsBody [data-copy]').forEach(b => b.onclick = async () => { const a = state.accounts.find(x => x.id === b.dataset.copy); await navigator.clipboard.writeText(a?.email || ''); toast('账号已复制'); });
  $$('#accountsBody [data-delete]').forEach(b => b.onclick = async () => { state.accounts = state.accounts.filter(x => x.id !== b.dataset.delete); await chrome.storage.local.set({ accounts: state.accounts }); renderAccounts(); toast('账号已删除'); });
}
function renderSettings() { $('#format').value = state.settings.format || 'openai'; $('#baseUrl').value = state.settings.baseUrl || ''; $('#apiKey').value = state.settings.apiKey || ''; $('#model').value = state.settings.model || ''; }
function renderHistory() {
  if (!state.history.length) { $('#historyList').innerHTML = '<div class="empty">暂无日志</div>'; return; }
  $('#historyList').innerHTML = state.history.map(h => `<div class="log-item"><div><div class="log-title">模型识别：${esc(h.reportedModel || '未知模型')}</div><div class="log-detail">${new Date(h.createdAt).toLocaleString()} · ${h.samples?.length || 0} 组探测 · ${h.elapsedMs || 0}ms</div></div><span class="status">已完成</span></div>`).join('');
}
function showView(id) { $$('.view').forEach(v => v.classList.toggle('hidden', v.id !== id)); $$('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === id)); }
function configFromForm() { return { ...state.settings, format: $('#format').value, baseUrl: $('#baseUrl').value.trim(), apiKey: $('#apiKey').value.trim(), model: $('#model').value.trim(), autoVerify: true }; }
function saveSettings() { state.settings = configFromForm(); return chrome.storage.local.set({ settings: state.settings }).then(() => toast('配置已保存')); }
function renderResult(result) {
  const top = result.candidates?.[0];
  $('#runStatus').textContent = `完成 · ${result.samples.length} 组样本 · ${result.elapsedMs}ms`;
  $('#resultArea').innerHTML = `<div class="result-main"><div class="eyebrow">TOP CANDIDATE</div><h3 class="result-model">${esc(top?.model || result.reportedModel || '未知')}</h3><div class="confidence"><i style="width:${Math.round((top?.confidence || 0) * 100)}%"></i></div><div class="result-meta"><span>相对置信度 ${Math.round((top?.confidence || 0) * 100)}%</span><span>接口返回：${esc(result.reportedModel || '未提供')}</span></div></div>`;
  $('#probeList').innerHTML = result.samples.map((s, i) => `<div class="probe"><strong>样本 ${i + 1} · ${s.count} 个有效数字</strong><span>${esc(s.text.slice(0, 145))}${s.text.length > 145 ? '…' : ''}</span></div>`).join('');
}

$$('.nav').forEach(n => n.onclick = () => showView(n.dataset.view));
$('#search').oninput = renderAccounts;
$('#refreshAccounts').onclick = () => { renderAccounts(); toast('账号列表已刷新'); };
$('#theme').onclick = () => { document.body.classList.toggle('dark'); };
$('#openDocs').onclick = () => window.open('https://lm.ikale.io/#/?mode=api', '_blank');
$('#toggleKey').onclick = () => { const input = $('#apiKey'); input.type = input.type === 'password' ? 'text' : 'password'; $('#toggleKey').textContent = input.type === 'password' ? '显示' : '隐藏'; };
$('#saveSettings').onclick = saveSettings;
$('#startRecognize').onclick = async () => {
  const config = configFromForm(); await chrome.storage.local.set({ settings: config });
  $('#startRecognize').disabled = true; $('#runStatus').textContent = '正在发送探测提示词…'; $('#resultArea').innerHTML = '<div class="result-placeholder"><div class="big-mark">◌</div><strong>正在识别</strong><span>请保持此页面打开</span></div>';
  try { const response = await chrome.runtime.sendMessage({ type: 'recognize', config }); if (!response?.ok) throw new Error(response?.error || '识别失败'); state.history.unshift({ ...response.result, config: { ...config, apiKey: undefined } }); state.history = state.history.slice(0, 30); renderResult(response.result); renderHistory(); toast('模型识别完成'); } catch (e) { $('#runStatus').textContent = '识别失败'; $('#resultArea').innerHTML = `<div class="result-placeholder"><div class="big-mark">!</div><strong>${esc(e.message)}</strong><span>请检查配置、额度和跨域设置</span></div>`; toast(e.message); } finally { $('#startRecognize').disabled = false; }
};
$('#clearHistory').onclick = async () => { state.history = []; await chrome.storage.local.set({ history: [] }); renderHistory(); toast('日志已清空'); };
$('#addAccount').onclick = () => { $('#modal').classList.remove('hidden'); $('#newName').focus(); };
$('#batchAdd').onclick = () => { $('#modal').classList.remove('hidden'); $('#newName').value = '批量账号'; $('#newEmail').value = ''; $('#newEmail').focus(); };
$('#closeModal').onclick = $('#cancelModal').onclick = () => $('#modal').classList.add('hidden');
$('#saveAccount').onclick = async () => { const name = $('#newName').value.trim() || '新账号'; const email = $('#newEmail').value.trim(); const platform = $('#newPlatform').value.trim() || 'https://arena.ai'; state.accounts.push({ id: crypto.randomUUID(), name, email, platform, createdAt: new Date().toISOString() }); await chrome.storage.local.set({ accounts: state.accounts }); $('#modal').classList.add('hidden'); $('#newName').value = ''; $('#newEmail').value = ''; renderAccounts(); toast('账号已添加'); };
load();

