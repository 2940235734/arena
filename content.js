(() => {
  'use strict';
  const protocol = 'arena-assistant/1.2.9';
  const old = globalThis.__arenaAssistant;
  if (old?.protocol === protocol) return;
  old?.dispose?.();
  let activeJob = null;
  let lastSample = null;
  // Arena hides the mode selector after an Agent conversation is created.
  // Keep the verified mode for this document so later rounds do not regress
  // to a false non-Agent result when the URL changes to /conversation/....
  let agentModeConfirmed = false;
  const visible = el => !!el && el.getBoundingClientRect().width > 4 && el.getBoundingClientRect().height > 4 && getComputedStyle(el).visibility !== 'hidden';
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const label = el => `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`.trim();
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isAgent = () => {
    const controls = all('[role="combobox"],button').filter(el => !el.closest('[role="listbox"],[role="dialog"],[role="menu"]'));
    if (controls.some(el => /^(Agent|Agent Mode|智能体)(\s|$)/i.test(label(el)))) return true;
    if (controls.some(el => el.getAttribute('role') === 'combobox' && /^(Battle|Direct|Side by Side|对战)(\s|$)/i.test(label(el)))) return false;
    // Agent conversations hide the mode selector while displaying task feedback.
    return agentModeConfirmed || /^\/agent(?:\/|$)/.test(location.pathname);
  };
  const composer = () => all('textarea,[contenteditable="true"][role="textbox"],div[contenteditable="true"]').find(el => !el.closest('[role="dialog"]') && !el.disabled && !el.readOnly);
  function scope(box) {
    let node = box?.parentElement;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      if (node.querySelector('button[aria-label*="Send" i],button[aria-label*="发送"],button[type="submit"]')) return node;
    }
    return box?.closest('main') || document;
  }
  const stopButton = () => all('button').find(el => /^(stop( generating| generation| response)?|停止(生成|响应|回答)?)(\s|$)/i.test(label(el)) && !el.disabled);
  const sendButton = box => all('button', scope(box)).find(el => !el.disabled && (/^(send( message)?|发送|提交)(\s|$)/i.test(label(el)) || el.type === 'submit'));
  function fill(el, text) {
    el.focus();
    if ('value' in el) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    } else {
      // ProseMirror/Tiptap owns its DOM. Use the browser editing operation so its
      // editor state receives the same change as typing/paste.
      const selection = window.getSelection();
      const range = document.createRange(); range.selectNodeContents(el);
      selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('insertText', false, text)) el.textContent = text;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function check(job) {
    if (job.cancelled) throw new Error('已停止');
    if (!chrome.runtime?.id) throw new Error('扩展已更新，请刷新 Arena 页面。');
  }
  async function until(fn, timeout, job) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (job) check(job);
      const result = fn();
      if (result) return result;
      await delay(150);
    }
    return null;
  }
  function taskFeedback() {
    const normalize = value => (value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
    const languageOf = value => {
      if (/[\u3040-\u30ff]/u.test(value)) return 'ja';
      if (/[\uac00-\ud7af]/u.test(value)) return 'ko';
      if (/[\u4e00-\u9fff]/u.test(value)) return 'zh';
      if (/[\u0600-\u06ff]/u.test(value)) return 'ar';
      if (/[\u0900-\u097f]/u.test(value)) return 'hi';
      if (/[\u0e00-\u0e7f]/u.test(value)) return 'th';
      if (/[\u0400-\u052f]/u.test(value)) return 'ru';
      const declared = (document.documentElement.lang || '').toLowerCase().split('-')[0];
      if (choiceSets.some(set => set.lang === declared)) return declared;
      const latinSignals = [
        ['fr', /\b(?:oui|non|continuer)\b/i], ['es', /\b(?:sí|si|no|continuar)\b/i],
        ['pt', /\b(?:sim|não|nao|continuar)\b/i], ['de', /\b(?:ja|nein|weiterarbeiten|fortfahren)\b/i],
        ['it', /\b(?:sì|si|no|continua)\b/i], ['nl', /\b(?:ja|nee|doorgaan)\b/i],
        ['sv', /\b(?:ja|nej|fortsätt)\b/i], ['tr', /\b(?:evet|hayır|hayir)\b/i],
        ['id', /\b(?:ya|tidak|lanjutkan)\b/i], ['vi', /\b(?:có|không|tiếp tục)\b/i]
      ];
      const signal = latinSignals.find(([, pattern]) => pattern.test(value));
      if (signal) return signal[0];
      return 'latin';
    };
    const choiceSets = [
      { lang:'en', yes:['yes'], no:['no'], more:['continue working','keep working'] },
      { lang:'zh', yes:['是','是的'], no:['否','不是'], more:['继续工作','继续执行'] },
      { lang:'ja', yes:['はい','はい、成功しました'], no:['いいえ','いいえ、まだです'], more:['作業を続ける','作業を続行'] },
      { lang:'ko', yes:['예','네'], no:['아니요','아니오'], more:['계속 작업','계속 진행'] },
      { lang:'fr', yes:['oui'], no:['non'], more:['continuer','continuer le travail'] },
      { lang:'es', yes:['sí','si'], no:['no'], more:['continuar','seguir trabajando','continuar trabajando'] },
      { lang:'pt', yes:['sim'], no:['não','nao'], more:['continuar','continuar trabalhando'] },
      { lang:'de', yes:['ja'], no:['nein'], more:['weiterarbeiten','weiter arbeiten','fortfahren'] },
      { lang:'it', yes:['sì','si'], no:['no'], more:['continua','continua a lavorare','continuare'] },
      { lang:'ru', yes:['да'], no:['нет'], more:['продолжить','продолжить работу'] },
      { lang:'uk', yes:['так'], no:['ні'], more:['продовжити','продовжити роботу'] },
      { lang:'pl', yes:['tak'], no:['nie'], more:['kontynuuj','kontynuuj pracę'] },
      { lang:'nl', yes:['ja'], no:['nee'], more:['doorgaan','doorgaan met werken'] },
      { lang:'sv', yes:['ja'], no:['nej'], more:['fortsätt','fortsätt arbeta'] },
      { lang:'tr', yes:['evet'], no:['hayır','hayir'], more:['devam et','çalışmaya devam et'] },
      { lang:'ar', yes:['نعم'], no:['لا'], more:['متابعة','متابعة العمل'] },
      { lang:'hi', yes:['हाँ','हां'], no:['नहीं'], more:['जारी रखें','काम जारी रखें'] },
      { lang:'th', yes:['ใช่'], no:['ไม่','ไม่ใช่'], more:['ดำเนินการต่อ','ทำงานต่อ'] },
      { lang:'id', yes:['ya'], no:['tidak'], more:['lanjutkan','terus bekerja'] },
      { lang:'vi', yes:['có'], no:['không'], more:['tiếp tục','tiếp tục làm việc'] }
    ];
    const text = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const iconKind = el => {
      const iconText = [...el.querySelectorAll('svg,[class*="icon" i]')].map(icon =>
        `${icon.getAttribute('aria-label') || ''} ${icon.getAttribute('data-lucide') || ''} ${icon.getAttribute('class') || ''} ${icon.getAttribute('title') || ''}`).join(' ');
      return /check|circle-check|check-circle/i.test(iconText) ? 'yes' :
        /circle-x|x-circle|circle-close/i.test(iconText) ? 'no' :
          /pencil|edit|pen-line/i.test(iconText) ? 'more' : '';
    };
    const isFeedbackChoiceSet = controls => {
      const labels = controls.map(control => normalize(label(control)));
      const detected = languageOf(controls.map(control => label(control)).join(' '));
      const ordered = [...choiceSets].sort((a, b) => Number(b.lang === detected) - Number(a.lang === detected));
      if (ordered.some(set => labels.some(value => set.yes.includes(value)) && labels.some(value => set.no.includes(value)) && labels.some(value => set.more.includes(value)))) return true;
      const kinds = controls.map(iconKind);
      return kinds.includes('yes') && kinds.includes('no') && kinds.includes('more');
    };
    const questionLike = value => /[?？؟]\s*$/u.test(value) || /^¿/u.test(value) ||
      /^(?:was|is|did)\b.{0,120}\b(?:task|work)\b/i.test(value) || /このタスク/u.test(value);
    // Match the actual feedback question, never arbitrary dialogs or model prose.
    const headings = all('h1,h2,h3,h4,p,span,div,label').filter(el =>
      questionLike(normalize(text(el))) && text(el).length <= 180 && !el.closest('[data-message-author-role],[data-role="assistant"],[data-role="user"],.prose,[contenteditable="true"]'));
    for (const heading of headings) {
      let panel = heading.parentElement;
      for (let depth = 0; panel && panel !== document.body && depth < 6; depth++, panel = panel.parentElement) {
        if (text(panel).length > 1000) break;
        const controls = all('button,[role="button"],[role="option"],[role="radio"]', panel).filter(el =>
          !/^(?:Esc(?:ape)?\s*)?(?:Close|Dismiss|关闭|取消|×|✕|✖|Esc|Escape)(?:\s.*)?$/i.test(label(el)) &&
          !el.querySelector('svg.lucide-x,svg[data-lucide="x"]'));
        if (controls.length >= 3 && isFeedbackChoiceSet(controls)) return panel;
      }
    }
    return null;
  }
  async function dismissTaskFeedback(job) {
    if (job) check(job);
    const panel = taskFeedback();
    if (!panel) return false;
    const target = panel.contains(document.activeElement) ? document.activeElement : panel;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true }));
    }
    if (!taskFeedback() || await until(() => !taskFeedback(), 600, job)) return true;
    // Some page builds ignore synthetic key events; use only the same panel's X.
    const current = taskFeedback();
    const close = current && all('button,[role="button"]', current).find(el =>
      /^(?:Esc(?:ape)?\s*)?(?:Close|Dismiss|关闭|取消|×|✕|✖|Esc|Escape)(?:\s.*)?$/i.test(label(el)) ||
      el.querySelector('svg.lucide-x,svg[data-lucide="x"]'));
    if (close) close.click();
    if (taskFeedback() && !await until(() => !taskFeedback(), 1200, job)) throw new Error('未能关闭“此任务成功了吗？”反馈框，请按 Esc 关闭后重试。');
    return true;
  }
  async function prepareAgent() {
    await dismissTaskFeedback();
    if (isAgent()) { agentModeConfirmed = true; return { ok: true }; }
    const control = all('[role="combobox"],button').find(el => /^(Battle(?: Mode)?|Direct|Side by Side|竞技场|对战)(\s|$)/i.test(label(el)));
    if (!control) throw new Error('未找到模式菜单，请先打开 Arena 对话首页。');
    control.click();
    const option = await until(() => all('[role="option"],[role="menuitem"], [role="dialog"] button').find(el => /^(Agent|智能体)(\s|$)/i.test(label(el))), 3000);
    if (!option) throw new Error('当前页面未提供 Agent 模式，请检查登录状态或页面版本。');
    option.click();
    agentModeConfirmed = true;
    return { ok: true }; // The panel verifies the selected mode after navigation.
  }
  function numbers(text) {
    const runs = []; let run = [], end = 0;
    for (const match of String(text).matchAll(/\d+/g)) {
      if (run.length && /\p{L}/u.test(text.slice(end, match.index))) { runs.push(run); run = []; }
      const value = Number(match[0]); if (value >= 1 && value <= 355) run.push(value);
      end = match.index + match[0].length;
    }
    runs.push(run); return runs.reduce((a, b) => a.length > b.length ? a : b, []);
  }
  function replies() {
    const semantic = all('[data-message-author-role="assistant"],[data-role="assistant"],[data-testid="assistant-message"],[data-testid*="assistant-message" i]');
    // Arena builds vary between semantic message attributes and rendered
    // Markdown containers outside a <main> element. Keep both paths broad
    // enough to survive layout changes while excluding obvious user content.
    const nodes = semantic.length ? semantic : all('.prose,[class*="markdown" i],[data-testid*="message" i],[class*="message-content" i],[class*="response" i],[class*="whitespace-pre-wrap" i],[class*="text-content" i],article,[role="article"]');
    return nodes.filter(el => !el.closest('[data-message-author-role="user"],[data-role="user"],textarea,[contenteditable="true"]'))
      .filter(el => !nodes.some(other => other !== el && other.contains(el)))
      .map(el => ({ el, text: (el.innerText || el.textContent || '').trim() }));
  }
  async function sendPrompt(prompt, job) {
    await dismissTaskFeedback(job);
    if (!isAgent()) throw new Error('当前不是 Agent 模式，已停止发送。');
    if (stopButton()) throw new Error('页面仍在生成回复，请等待完成后再开始。');
    const box = await until(composer, 3000, job);
    if (!box) throw new Error('未找到输入框，请完成登录并打开可发送消息的 Agent 对话。');
    if ((box.value ?? box.textContent ?? '').trim()) throw new Error('输入框中有未发送内容，请先发送或清空后重试。');
    fill(box, prompt);
    const button = await until(() => sendButton(composer()), 3000, job);
    if (!button) throw new Error('发送按钮不可用，请检查登录状态、额度或验证码。');
    check(job);
    button.click(); // Exactly once; ambiguous delivery is never retried.
  }
  function verificationChallenge() {
    const challengeText = /security verification|verify (?:that )?you(?:'re| are) human|complete this quick security check|checking your browser|cloudflare|人机验证|安全验证|验证您是人类/i;
    const frames = all('iframe').some(frame => /recaptcha\/.*\/bframe|hcaptcha[^\s]*frame=challenge|challenges\.cloudflare\.com.*(?:challenge|turnstile)/i.test(`${frame.src} ${frame.title} ${frame.getAttribute('name') || ''}`));
    if (frames) return true;
    return all('[role="dialog"],[role="alertdialog"],[class*="challenge" i],[id*="challenge" i]').some(el => challengeText.test(el.innerText || el.textContent || ''));
  }
  function notifyChallenge(job, active) {
    chrome.runtime.sendMessage({ type: 'arena-challenge-state', jobId: job.id, active }).catch(() => {});
  }
  async function sample(message) {
    if (activeJob) throw new Error('此标签页已有任务正在运行。');
    const job = { id: message.jobId, cancelled: false };
    let conversationUrl = location.href;
    let mayCreateConversation = ['/', '/agent'].includes(location.pathname);
    activeJob = job;
    lastSample = null;
    const prior = replies();
    const baseline = new Map(prior.map(item => [item.el, item.text]));
    const oldTexts = new Set(prior.map(item => item.text));
    try {
      await sendPrompt(message.prompt, job);
      let started = Date.now(), challengeSince = null;
      let lastText = '', stableSince = Date.now(), sawGenerating = false;
      const timeoutMs = Number.isFinite(Number(message.timeoutMs)) ? Math.min(1800000, Math.max(60000, Number(message.timeoutMs))) : 180000;
      while (true) {
        check(job);
        if (location.href !== conversationUrl) {
          if (!mayCreateConversation) throw new Error('对话地址已变化，已停止抽样，避免混入其他对话。');
          conversationUrl = location.href;
          mayCreateConversation = false;
        }
        await dismissTaskFeedback(job);
        if (verificationChallenge()) {
          if (challengeSince === null) { challengeSince = Date.now(); notifyChallenge(job, true); }
          await delay(500);
          continue;
        }
        if (challengeSince !== null) {
          started += Date.now() - challengeSince;
          challengeSince = null;
          notifyChallenge(job, false);
        }
        if (Date.now() - started >= timeoutMs) break;
        const blockingDialog = all('[role="dialog"]').find(el => /sign in|log in|terms of use|privacy policy|登录|使用条款/i.test(el.textContent));
        if (blockingDialog) throw new Error('Arena 要求登录或确认使用条款，请先在页面完成后再开始。');
        const generating = !!stopButton();
        if (generating) sawGenerating = true;
        const changed = replies().filter(item => item.text !== baseline.get(item.el) && !oldTexts.has(item.text) && item.text !== message.prompt);
        const candidates = changed.filter(item => numbers(item.text).length >= message.minNumbers);
        if (candidates.length > 1) throw new Error('检测到多个模型回答，无法确定同一模型，请使用单一 Agent 对话。');
        const candidate = candidates[0];
        const text = candidate?.text || '';
        if (text !== lastText) { lastText = text; stableSince = Date.now(); }
        const box = composer();
        const ready = box && !box.disabled && !(box.value ?? box.textContent ?? '').trim();
        // Wait for generation to finish, not merely the first 80 numbers.
        if (text && !generating && Date.now() - stableSince > (sawGenerating ? 2000 : 6000) && (sawGenerating || ready)) {
          check(job);
          lastSample = { jobId: job.id, url: location.href, el: candidate.el, text };
          return { ok: true, sample: { prompt: message.prompt, text, count: numbers(text).length }, url: location.href };
        }
        await delay(400);
      }
      if (stopButton()) stopButton().click();
      const timeout = new Error(`MODEL_REPLY_TIMEOUT: 单个会话回复超过 ${Math.round(timeoutMs / 60000)} 分钟。`);
      timeout.code = 'MODEL_REPLY_TIMEOUT';
      throw timeout;
    } finally { activeJob = null; }
  }
  // This is the same identity check used by EasyAI.offline.exe.  A pathname
  // match alone is unsafe because a stale sidebar row can remain mounted while
  // Arena navigates to another conversation.
  const routeKey = value => {
    try {
      const url = new URL(value, location.href);
      const path = url.pathname.replace(/\/+$/, '');
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hostname !== 'arena.ai') return null;
      if (/^\/(?:agent|work)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path)) return url.origin + path.toLowerCase();
      // Kept for the local regression DOM and older Arena preview routes.
      if (/^\/(?:agent|work)\/[^/]+$/i.test(path)) return url.origin + path;
      return null;
    } catch { return null; }
  };
  const exactLabel = el => `${el.getAttribute('aria-label') || el.textContent || ''}`.replace(/\s+/g, ' ').trim();
  const conversationTitle = el => {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('svg,button,[role="tooltip"],[aria-hidden="true"]').forEach(node => node.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  };
  function currentConversationLink(target = location.href) {
    const expected = routeKey(target);
    const links = expected ? all('a[href]').filter(a => routeKey(a.href) === expected) : [];
    if (links.length === 1) return links[0];
    if (links.length > 1) return null;
    // Fallback only for old non-UUID preview links; never prefer an arbitrary
    // active row when a strict route identity is available.
    if (!expected) return all('a[aria-current="page"],a[aria-selected="true"],a[data-state="active"],a[data-active="true"]').find(Boolean);
    return null;
  }
  function currentConversationRow(link = currentConversationLink()) {
    if (!link) return null;
    const hasMenu = node => [...node.querySelectorAll('button,[role="button"]')].some(button =>
      /^(?:More options|更多选项|更多|菜单|操作)$/i.test(exactLabel(button)) ||
      button.getAttribute('aria-haspopup') === 'menu' ||
      button.querySelector('svg[data-lucide="more-horizontal"],svg[data-lucide="ellipsis"],svg.lucide-ellipsis,[class*="ellipsis" i]'));
    for (let node = link, depth = 0; node && depth < 8; node = node.parentElement, depth++) if (hasMenu(node)) return node;
    return link.closest('li,[data-sidebar="menu-item"],[role="listitem"],[data-state="active"],[data-active="true"]') || link.parentElement;
  }
  function rowMenuButton(link, row) {
    if (!link || !row) return null;
    // The EXE targets the button in the link's immediate row.  Dispatching
    // pointerdown is required by Arena's Radix menu; click() alone is ignored.
    const direct = [...(link.parentElement || row).querySelectorAll('button,[role="button"]')];
    const buttons = direct.length ? direct : [...row.querySelectorAll('button,[role="button"]')];
    return buttons.find(button => /^(?:More options|更多选项|更多|菜单|操作)$/i.test(exactLabel(button)) ||
      button.getAttribute('aria-haspopup') === 'menu' ||
      button.querySelector('svg[data-lucide="more-horizontal"],svg[data-lucide="ellipsis"],svg.lucide-ellipsis,[class*="ellipsis" i]')) || null;
  }
  function openRenameMenu(button) {
    button.scrollIntoView?.({ block: 'nearest' });
    const event = typeof PointerEvent === 'function'
      ? new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' })
      : new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    button.dispatchEvent(event);
  }
  async function rename(message) {
    if (!lastSample || lastSample.jobId !== message.jobId || lastSample.url !== location.href || message.url !== location.href || !lastSample.el.isConnected) {
      throw new Error('对话已切换或刷新，已跳过重命名。');
    }
    const name = String(message.name || '').trim().slice(0, 120);
    if (!name) throw new Error('模型名称为空。');
    const expected = routeKey(location.href);
    if (!expected || !currentConversationLink()) throw new Error('无法确认当前 Arena 会话，已跳过重命名。');
    const namedEditor = () => {
      const dialogs = all('[role="dialog"]');
      const dialog = dialogs.find(node => /^Rename chat\b|^重命名对话\b/i.test((node.innerText || node.textContent || '').trim())) ||
        (dialogs.length === 1 && all('input[type="text"],textarea', dialogs[0]).length === 1 ? dialogs[0] : null);
      if (!dialog) return null;
      return all('input,textarea', dialog).find(el => !el.disabled && !el.readOnly && el.type === 'text');
    };
    let editor = namedEditor();
    if (!editor) {
      let link = currentConversationLink();
      if (!link) {
        all('button').find(b => /^(Expand sidebar|Open sidebar|Show sidebar|展开侧边栏|打开侧边栏)$/i.test(exactLabel(b)))?.click();
        await delay(400);
        link = currentConversationLink();
      }
      const row = currentConversationRow(link);
      const menu = rowMenuButton(link, row);
      if (!menu) throw new Error('未找到当前对话的 More options 菜单，请展开 Arena 侧栏后重试。');
      openRenameMenu(menu);
      let renameButton = await until(() => all('[role="menuitem"]').find(b => /^(?:Rename|重命名)$/i.test(exactLabel(b))), 350);
      // Older Arena builds used a click handler while current builds use
      // Radix pointerdown.  The pointer event is always attempted first;
      // click is only the compatibility fallback when no menu appeared.
      if (!renameButton) {
        menu.click();
        renameButton = await until(() => all('[role="menuitem"]').find(b => /^(?:Rename|重命名)$/i.test(exactLabel(b))), 2150);
      }
      if (!renameButton) throw new Error('未找到当前对话的重命名菜单，请确认侧栏三点菜单已打开。');
      renameButton.click();
      editor = await until(namedEditor, 2500);
    }
    if (!editor) throw new Error('未找到标题编辑框，已跳过重命名。');
    // React controls the title input.  Use the native setter exactly as the
    // EXE does, then emit input/change so React commits the new value.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter && editor instanceof HTMLInputElement) setter.call(editor, name);
    else fill(editor, name);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.focus();
    const dialog = editor.closest('[role="dialog"]');
    const save = await until(() => all('button', dialog || document).find(b => /^(?:Rename|Save|保存|重命名)$/i.test(exactLabel(b)) && !b.disabled), 2500);
    if (!save) throw new Error('未找到标题保存按钮。');
    save.click();
    const persisted = await until(() => {
      const current = currentConversationLink();
      return (!dialog || !dialog.isConnected || !visible(dialog)) && current && conversationTitle(current).includes(name);
    }, 4000);
    if (!persisted) throw new Error('已提交标题修改，但页面未确认保存，请查看会话标题。');
    return { ok: true };
  }
  async function deleteConversation(message) {
    if (activeJob && activeJob.id !== message.jobId) throw new Error('标签页仍有其他任务，拒绝删除会话。');
    const expected = routeKey(message.url || location.href);
    if (!expected || expected !== routeKey(location.href) || !currentConversationLink(expected)) throw new Error('无法确认待删除的当前会话，已取消删除。');
    let link = currentConversationLink(expected);
    const row = currentConversationRow(link);
    const menu = rowMenuButton(link, row);
    if (!menu) throw new Error('未找到当前超时会话的菜单，已保留该会话。');
    openRenameMenu(menu);
    const cleanupItem = () => all('[role="menuitem"]').find(item => /^(?:Delete|删除|Archive|归档|存档)$/i.test(exactLabel(item)));
    let actionItem = await until(cleanupItem, 350);
    if (!actionItem) {
      menu.click();
      actionItem = await until(cleanupItem, 2150);
    }
    let action = 'deleted';
    if (actionItem && /^(?:Archive|归档|存档)$/i.test(exactLabel(actionItem))) {
      action = 'archived';
    }
    if (!actionItem) throw new Error('未找到删除或归档菜单项，已保留超时会话。');
    actionItem.click();
    const confirmation = await until(() => all('[role="alertdialog"],[role="dialog"]').find(dialog =>
      action === 'deleted'
        ? /delete (?:chat|conversation)|删除(?:对话|会话)/i.test(dialog.innerText || dialog.textContent || '')
        : /archive (?:chat|conversation)|归档(?:对话|会话)|存档(?:对话|会话)/i.test(dialog.innerText || dialog.textContent || '')), 1200);
    if (confirmation) {
      const actionPattern = action === 'deleted' ? /^(?:Delete|删除)$/i : /^(?:Archive|归档|存档)$/i;
      const confirmButtons = all('button', confirmation).filter(button => actionPattern.test(exactLabel(button)) && !button.disabled);
      if (confirmButtons.length !== 1) throw new Error(action === 'deleted' ? '删除确认按钮不唯一，已取消删除。' : '归档确认按钮不唯一，已取消归档。');
      confirmButtons[0].click();
    }
    const removed = await until(() => !currentConversationLink(expected), 4000);
    if (!removed) throw new Error(action === 'deleted' ? 'Arena 未确认会话删除，已停止后续抽取以避免误删其他会话。' : 'Arena 未确认会话归档，已停止后续抽取。');
    return { ok: true, action };
  }
  const listener = (message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === 'arena-ping') { respond({ ok: true, protocol, agent: isAgent(), busy: !!activeJob }); return; }
    if (message.type === 'cancel-sample') {
      if (activeJob?.id === message.jobId) { activeJob.cancelled = true; stopButton()?.click(); }
      respond({ ok: true }); return;
    }
    let work;
    if (message.type === 'prepare-agent') work = prepareAgent;
    if (message.type === 'arena-sample-round') work = () => sample(message);
    if (message.type === 'arena-rename-conversation') work = () => rename(message);
    if (message.type === 'arena-delete-conversation') work = () => deleteConversation(message);
    if (message.type === 'new-chat') work = async () => {
      if (activeJob) throw new Error('请先停止当前抽样任务。');
      const link = all('a[href]').find(a => /^(New chat|New conversation|新建会话|新对话)/i.test(label(a)) || new URL(a.href).pathname === '/agent');
      if (!link) throw new Error('未找到新建会话入口，请在 Arena 侧边栏中新建。');
      link.click(); return { ok: true };
    };
    if (message.type === 'arena-send-test') work = async () => {
      if (activeJob) throw new Error('请先停止当前抽样任务。');
      const job = { id: message.jobId, cancelled: false }; activeJob = job;
      try { await sendPrompt(message.prompt, job); return { ok: true }; } finally { activeJob = null; }
    };
    if (work) { Promise.resolve().then(work).then(respond).catch(error => respond({ ok: false, error: error.message })); return true; }
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis.__arenaAssistant = { protocol, dispose() { if (activeJob) activeJob.cancelled = true; chrome.runtime.onMessage.removeListener(listener); } };
})();

