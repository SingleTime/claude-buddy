/* Claude Buddy — 渲染进程 */

const $ = (id) => document.getElementById(id);

const els = {
  sessionList: $("sessionList"),
  newChat: $("newChat"),
  cwdBtn: $("cwdBtn"),
  cwdLabel: $("cwdLabel"),
  chatTitle: $("chatTitle"),
  modelBadge: $("modelBadge"),
  togglePanel: $("togglePanel"),
  panel: $("panel"),
  messages: $("messages"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  stopBtn: $("stopBtn"),
  hint: $("hint"),
  modelSelect: $("modelSelect"),
  modeSelect: $("modeSelect"),
  statCost: $("statCost"),
  statTotalCost: $("statTotalCost"),
  statIn: $("statIn"),
  statCache: $("statCache"),
  statOut: $("statOut"),
  statDur: $("statDur"),
  statProc: $("statProc"),
  statSid: $("statSid"),
  toolTags: $("toolTags"),
  toolCount: $("toolCount"),
  // 定时任务
  tabChats: $("tabChats"),
  tabTasks: $("tabTasks"),
  paneChats: $("paneChats"),
  paneTasks: $("paneTasks"),
  taskList: $("taskList"),
  taskCount: $("taskCount"),
  newTask: $("newTask"),
  taskModal: $("taskModal"),
  // 附件 / 队列
  attachBar: $("attachBar"),
  attachBtn: $("attachBtn"),
  queueBar: $("queueBar"),
  dropMask: $("dropMask"),
  // 搜索
  searchInput: $("searchInput"),
  searchClear: $("searchClear"),
  // 产物 / 预览
  artifactList: $("artifactList"),
  artifactEmpty: $("artifactEmpty"),
  artifactCount: $("artifactCount"),
  previewModal: $("previewModal"),
  previewBody: $("previewBody"),
  previewTitle: $("previewTitle"),
  previewMeta: $("previewMeta"),
  previewOpen: $("previewOpen"),
  previewClose: $("previewClose"),
};

const state = {
  config: {},
  sessions: [],
  activeId: null,
  active: null,
  busy: false,
  turn: null,
  tasks: [],
  tab: "chats",
  editing: null, // 正在编辑的任务（null = 新建）
  draft: null, // 弹窗内的临时值
  attachments: [], // 待发送附件
  queue: [], // 忙碌时排队的消息
  artifacts: new Map(), // 本会话产出的文件 path -> meta
  searchHits: null, // 非 null 表示正在展示搜索结果
};

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function mdRender(src) {
  const lines = String(src || "").split("\n");
  let html = "";
  let i = 0;
  let inCode = false;
  let codeBuf = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      if (inCode) {
        html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
        closeList();
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    // 表格
    if (
      /^\s*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])
    ) {
      closeList();
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      html +=
        "<table><thead><tr>" +
        header.map((h) => `<th>${inline(h)}</th>`).join("") +
        "</tr></thead><tbody>";
      for (const r of rows) {
        html += "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      }
      html += "</tbody></table>";
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const n = Math.min(h[1].length, 3);
      html += `<h${n}>${inline(h[2])}</h${n}>`;
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      html += "<hr>";
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      html += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`;
      i++;
      continue;
    }

    const li = line.match(/^\s*[-*+]\s+(.*)$/) || line.match(/^\s*\d+\.\s+(.*)$/);
    if (li) {
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${inline(li[1])}</li>`;
      i++;
      continue;
    }

    closeList();

    if (!line.trim()) {
      i++;
      continue;
    }

    html += `<p>${inline(line)}</p>`;
    i++;
  }

  if (inCode) html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
  closeList();
  return html;
}

/* ------------------------------------------------------------------ */
/* 渲染辅助                                                            */
/* ------------------------------------------------------------------ */

function nearBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
}

function scrollIfNear(wasNear) {
  if (wasNear) els.messages.scrollTop = els.messages.scrollHeight;
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function fmtCost(n) {
  return "$" + (Number(n) || 0).toFixed(4);
}

function fmtNum(n) {
  return (Number(n) || 0).toLocaleString("en-US");
}

function fmtDur(ms) {
  if (!ms) return "—";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
}

function clearMessages() {
  els.messages.innerHTML = "";
}

function showWelcome() {
  clearMessages();
  const w = el("div", "welcome");
  w.innerHTML = `
    <div class="welcome-logo">✳</div>
    <h1>Claude Buddy</h1>
    <p>由 Claude Code harness 驱动的本地 AI 助手</p>
    <div class="chips">
      <button class="chip" data-prompt="介绍一下你当前能用的工具">你能干什么</button>
      <button class="chip" data-prompt="用 finance-data 查一下 03690 和 600519 的行情">查港股和A股行情</button>
      <button class="chip" data-prompt="列出当前目录的文件结构，简要说明这个项目是做什么的">看看当前项目</button>
    </div>`;
  els.messages.appendChild(w);
  w.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => send(c.dataset.prompt)),
  );
}

function appendUserMsg(text, viaTask, attachments) {
  const wrap = el("div", "msg user");
  const tag = viaTask
    ? `<div class="msg-task-tag">⏱ 定时触发${
        viaTask.trigger === "manual" ? "（手动）" : ""
      }</div>`
    : "";
  wrap.innerHTML = `
    <div class="msg-avatar">你</div>
    <div class="msg-body">${tag}<div class="md">${mdRender(text)}</div></div>`;

  const body = wrap.querySelector(".msg-body");
  if (attachments && attachments.length) {
    const bar = el("div", "msg-atts");
    for (const a of attachments) {
      const chip = el("div", "msg-att");
      const ico = el("div", "attach-ico", isImageName(a.name) ? "🖼" : "📄");
      chip.appendChild(ico);
      chip.appendChild(el("span", "", escapeHtml(a.name)));
      chip.title = a.path || a.name;
      // 图片从磁盘读出来才能显示（CSP 只放行 data:）
      if (isImageName(a.name) && a.path) {
        buddy.previewFile(a.path, state.activeId).then((r) => {
          if (r && r.ok && r.kind === "image") {
            const img = new Image();
            img.src = r.dataUrl;
            chip.replaceChild(img, ico);
          }
        });
      }
      chip.addEventListener("click", () => a.path && openPreview(a.path));
      bar.appendChild(chip);
    }
    body.appendChild(bar);
  }

  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
}

/** 从历史消息渲染一条 assistant（含 thinking / 工具卡片） */
function appendAssistantFromHistory(msg) {
  const wrap = el("div", "msg assistant");
  wrap.innerHTML = `<div class="msg-avatar">✳</div><div class="msg-body"></div>`;
  const body = wrap.querySelector(".msg-body");

  if (msg.thinking) {
    body.appendChild(makeThinkBlock(msg.thinking));
  }

  for (const t of msg.tools || []) {
    body.appendChild(makeToolCard(t));
  }

  if (msg.text) {
    const md = el("div", "md");
    md.innerHTML = mdRender(msg.text);
    body.appendChild(md);
  }

  els.messages.appendChild(wrap);
}

function makeThinkBlock(text) {
  const box = el("div", "think");
  box.innerHTML = `
    <div class="think-head"><span class="arrow">▶</span><span>思考过程</span></div>
    <div class="think-body"></div>`;
  box.querySelector(".think-body").textContent = text;
  box.querySelector(".think-head").addEventListener("click", () => box.classList.toggle("open"));
  return box;
}

function makeToolCard(t) {
  const box = el("div", "tool");
  const statusCls = t.isError ? "err" : "done";
  const statusText = t.isError ? "失败" : "完成";
  box.innerHTML = `
    <div class="tool-head">
      <span class="tool-icon">⚙</span>
      <span class="tool-name">${escapeHtml(t.name || "tool")}</span>
      <span class="tool-status ${statusCls}">${statusText}</span>
    </div>
    <div class="tool-body">
      <div class="tool-label">参数</div>
      <pre class="tool-pre">${escapeHtml(JSON.stringify(t.input ?? {}, null, 1))}</pre>
      ${
        t.result
          ? `<div class="tool-label">结果</div><pre class="tool-pre">${escapeHtml(t.result)}</pre>`
          : ""
      }
    </div>`;
  box.querySelector(".tool-head").addEventListener("click", () => box.classList.toggle("open"));
  return box;
}

/* ------------------------------------------------------------------ */
/* 当前轮次 DOM                                                        */
/* ------------------------------------------------------------------ */

function ensureTurn() {
  if (state.turn) return state.turn;

  const wrap = el("div", "msg assistant");
  wrap.innerHTML = `<div class="msg-avatar">✳</div><div class="msg-body"></div>`;
  const body = wrap.querySelector(".msg-body");
  els.messages.appendChild(wrap);

  state.turn = {
    wrap,
    body,
    textEl: null,
    textBuf: "",
    mdEl: null,
    thinkEl: null,
    thinkBuf: "",
    tools: new Map(),
    started: false,
  };
  return state.turn;
}

function endTurn() {
  state.turn = null;
}

function renderTextStream() {
  const t = state.turn;
  if (!t) return;
  if (!t.mdEl) {
    t.mdEl = el("div", "md");
    t.body.appendChild(t.mdEl);
  }
  t.mdEl.innerHTML = mdRender(t.textBuf) + '<span class="cursor"></span>';
}

/* ------------------------------------------------------------------ */
/* 事件处理                                                            */
/* ------------------------------------------------------------------ */

let renderTimer = null;
function scheduleTextRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderTextStream();
    scrollIfNear(true);
  }, 90);
}

function onEvent(evt) {
  // 任务类事件跟当前会话无关，先处理掉
  if (evt.type === "tasks") {
    state.tasks = evt.tasks || [];
    renderTaskList();
    return;
  }
  if (evt.type === "task_started") {
    state.tasks = state.tasks.map((t) =>
      t.id === evt.taskId ? { ...t, running: true, lastStatus: "running" } : t,
    );
    renderTaskList();
    if (evt.trigger === "schedule") toast("⏱ 定时任务开始执行");
    return;
  }
  if (evt.type === "task_done") {
    toast(
      evt.ok ? "✅ 定时任务完成" + (evt.cost ? `  ${fmtCost(evt.cost)}` : "") : "❌ 定时任务失败",
      !evt.ok,
    );
    // 如果用户正好打开着这个任务的会话，刷新出最新内容
    if (evt.sessionId && evt.sessionId === state.activeId) {
      openSession(evt.sessionId);
    } else {
      refreshSessionList();
    }
    return;
  }

  if (evt.sessionId !== state.activeId) return;
  const wasNear = nearBottom();

  switch (evt.type) {
    case "init": {
      els.statProc.textContent = "运行中";
      els.statProc.style.color = "var(--green)";
      els.statSid.textContent = (evt.claudeSessionId || "").slice(0, 8) || "—";
      els.statSid.title = evt.claudeSessionId || "";
      if (evt.model) els.modelBadge.textContent = evt.model;
      renderTools(evt.tools || []);
      break;
    }

    case "turn_start": {
      // 一轮对话里可能有多个 message_start（工具调用后模型会继续输出），
      // 只有第一次需要清掉 send() 建的占位，后续必须保留已渲染的工具卡片。
      if (!state.turn) ensureTurn();
      const t = state.turn;
      if (!t.started) {
        t.body.innerHTML = "";
        t.started = true;
      }
      t.textBuf = "";
      t.thinkBuf = "";
      t.mdEl = null;
      t.thinkEl = null;
      els.stopBtn.hidden = false;
      break;
    }

    case "block_start": {
      const t = ensureTurn();
      if (evt.kind === "thinking") {
        t.thinkEl = makeThinkBlock("");
        t.body.appendChild(t.thinkEl);
        t.thinkBuf = "";
      } else if (evt.kind === "text") {
        t.mdEl = el("div", "md");
        t.body.appendChild(t.mdEl);
        t.textBuf = "";
      }
      break;
    }

    case "thinking_delta": {
      const t = ensureTurn();
      t.thinkBuf += evt.text || "";
      if (t.thinkEl) {
        t.thinkEl.querySelector(".think-body").textContent = t.thinkBuf;
      }
      break;
    }

    case "text_delta": {
      const t = ensureTurn();
      t.textBuf += evt.text || "";
      scheduleTextRender();
      break;
    }

    case "tool_start": {
      const t = ensureTurn();
      const card = makeToolCard({ name: evt.name, input: {}, result: "" });
      const status = card.querySelector(".tool-status");
      status.className = "tool-status running";
      status.textContent = "运行中";
      card.classList.add("open");
      t.body.appendChild(card);
      t.tools.set(evt.toolUseId, { el: card, name: evt.name });
      scrollIfNear(wasNear);
      break;
    }

    case "tool_input": {
      const t = state.turn;
      const rec = t && t.tools.get(evt.toolUseId);
      if (rec) {
        rec.el.querySelector(".tool-pre").textContent = JSON.stringify(
          evt.input ?? {},
          null,
          1,
        );
        // 写入类工具的 file_path 就是这轮的产物
        if (WRITE_TOOLS.has(rec.name)) {
          addArtifact(toolPath(evt.input), rec.name);
        }
      }
      break;
    }

    case "tool_result": {
      const t = state.turn;
      const rec = t && t.tools.get(evt.toolUseId);
      if (rec) {
        const status = rec.el.querySelector(".tool-status");
        status.className = "tool-status " + (evt.isError ? "err" : "done");
        status.textContent = evt.isError ? "失败" : "完成";
        const body = rec.el.querySelector(".tool-body");
        const label = el("div", "tool-label", "结果");
        const pre = el("pre", "tool-pre");
        pre.textContent = evt.content || "";
        body.appendChild(label);
        body.appendChild(pre);
      }
      break;
    }

    case "result": {
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      const t = state.turn;
      if (t) {
        if (t.mdEl) {
          t.mdEl.innerHTML = mdRender(t.textBuf);
        }
        // 追加轮次统计
        const meta = el("div", "turn-meta");
        const u = evt.usage || {};
        meta.textContent = [
          fmtCost(evt.cost),
          `${fmtDur(evt.durationMs)}`,
          `in ${fmtNum(u.input_tokens)}`,
          u.cache_read_input_tokens ? `cache ${fmtNum(u.cache_read_input_tokens)}` : "",
          `out ${fmtNum(u.output_tokens)}`,
        ]
          .filter(Boolean)
          .join("  ·  ");
        t.body.appendChild(meta);
      }
      if (evt.totals) updateStats(evt.totals);
      els.statCost.textContent = fmtCost(evt.cost);
      els.statDur.textContent = fmtDur(evt.durationMs);
      if (evt.isError) {
        appendError("本轮返回错误状态：" + (evt.stopReason || "unknown"));
      }
      state.busy = false;
      updateBusy();
      endTurn();
      scrollIfNear(wasNear);
      refreshSessionList();
      flushQueue();
      break;
    }

    case "error": {
      appendError(evt.message);
      state.busy = false;
      updateBusy();
      endTurn();
      break;
    }

    case "proc_exit": {
      // 旧进程（换模型/换权限时被杀掉的那条）退出，不影响当前这一轮
      if (evt.current === false) break;
      els.statProc.textContent = "已退出";
      els.statProc.style.color = "var(--text-faint)";
      if (state.busy) {
        state.busy = false;
        updateBusy();
        endTurn();
      }
      flushQueue();
      break;
    }

    default:
      break;
  }
}

function appendError(msg) {
  const e = el("div", "msg-error");
  e.textContent = String(msg || "未知错误");
  els.messages.appendChild(e);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderTools(tools) {
  els.toolCount.textContent = tools.length;
  els.toolTags.innerHTML = "";
  for (const t of tools.slice(0, 60)) {
    els.toolTags.appendChild(el("span", "tool-tag", escapeHtml(t)));
  }
}

function updateStats(totals) {
  els.statTotalCost.textContent = fmtCost(totals.cost);
  els.statIn.textContent = fmtNum(totals.inputTokens);
  els.statCache.textContent = fmtNum(totals.cacheRead);
  els.statOut.textContent = fmtNum(totals.outputTokens);
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

async function refreshSessionList() {
  const init = await buddy.init();
  state.sessions = init.sessions;
  renderSessionList();
}

function renderSessionList() {
  if (state.searchHits !== null) return; // 正在看搜索结果，别被后台刷新冲掉
  els.sessionList.innerHTML = "";
  for (const s of state.sessions) {
    const item = el("div", "session-item" + (s.id === state.activeId ? " active" : ""));
    item.innerHTML = `<span class="session-title">${escapeHtml(s.title || "新对话")}</span><span class="session-del">×</span>`;
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("session-del")) return;
      openSession(s.id);
    });
    item.querySelector(".session-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      await buddy.deleteSession(s.id);
      await refreshSessionList();
      if (s.id === state.activeId) {
        state.activeId = null;
        state.active = null;
        els.chatTitle.textContent = "新对话";
        els.statProc.textContent = "未启动";
        els.statSid.textContent = "—";
        clearMessages();
        showWelcome();
        updateStats({ cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0 });
      }
    });
    els.sessionList.appendChild(item);
  }
}

async function openSession(id) {
  const s = await buddy.loadSession(id);
  if (!s) return;
  state.activeId = id;
  state.active = s;
  state.busy = false;
  endTurn();

  els.chatTitle.textContent = s.title || "新对话";
  els.statCost.textContent = fmtCost(0);
  els.statDur.textContent = "—";
  els.statProc.textContent = "未启动";
  els.statProc.style.color = "";
  els.statSid.textContent = (s.sessionId || "").slice(0, 8) || "—";

  updateStats(s.totals || { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0 });

  clearMessages();
  state.queue = [];
  renderQueue();
  rebuildArtifacts(s);
  if (!s.messages || s.messages.length === 0) {
    showWelcome();
  } else {
    for (const m of s.messages) {
      if (m.role === "user") appendUserMsg(m.text, m.viaTask, m.attachments);
      else appendAssistantFromHistory(m);
    }
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  renderSessionList();
  updateBusy();
  els.input.focus();
}

async function newSession() {
  const s = await buddy.newSession(state.config.cwd);
  await refreshSessionList();
  await openSession(s.id);
  els.input.focus();
}

/* ------------------------------------------------------------------ */
/* 发送                                                                */
/* ------------------------------------------------------------------ */

function updateBusy() {
  els.sendBtn.disabled = false; // 忙碌时也点得动 —— 点了就是排队
  els.sendBtn.textContent = state.busy ? "排队" : "发送";
  els.stopBtn.hidden = !state.busy;
  els.hint.textContent = state.busy
    ? "正在生成… 现在发送会排进队列，等这轮结束自动接着发"
    : "Enter 发送 · Shift+Enter 换行 · 可拖入文件或粘贴截图";
}

async function send(text) {
  const t = (text ?? els.input.value).trim();
  if (!t && state.attachments.length === 0) return;

  // 忙碌时不丢弃也不打断：排进队列，等这一轮 result 再发
  if (state.busy) {
    state.queue.push({ text: t, attachments: state.attachments.slice() });
    state.attachments = [];
    els.input.value = "";
    autoGrow();
    renderAttachBar();
    renderQueue();
    return;
  }

  // 同步占位：连点两次「发送」时，第二次必须走队列而不是并发出两条
  state.busy = true;
  updateBusy();

  const atts = state.attachments.slice();
  state.attachments = [];
  els.input.value = "";
  autoGrow();
  renderAttachBar();
  await sendNow(t, atts);
}

async function sendNow(text, atts) {
  if (!state.activeId) {
    await newSession();
  }
  if (!state.activeId) return;

  // 附件先落盘到会话目录，拿到最终路径再发
  const staged = await commitAttachments(atts || []);

  const welcome = els.messages.querySelector(".welcome");
  if (welcome) welcome.remove();

  appendUserMsg(text, null, staged);
  state.busy = true;
  updateBusy();
  ensureTurn();

  const res = await buddy.send(state.activeId, text, staged);
  if (res && res.title) {
    els.chatTitle.textContent = res.title;
    if (state.active) state.active.title = res.title;
  }
  if (!res || !res.ok) {
    appendError((res && res.error) || "发送失败");
    state.busy = false;
    updateBusy();
    endTurn();
    flushQueue();
  }
}

/** 队列里有东西就接着发一条 */
function flushQueue() {
  if (state.busy) return;
  const next = state.queue.shift();
  if (!next) return;
  state.busy = true;
  updateBusy();
  renderQueue();
  sendNow(next.text, next.attachments || []);
}

async function commitAttachments(atts) {
  if (!atts.length) return [];
  const out = [];
  const paths = atts.filter((a) => a.kind === "file").map((a) => a.path);
  if (paths.length) {
    const rs = await buddy.attachFiles(state.activeId, paths);
    for (const r of rs || []) {
      if (r && r.error) appendError(`附件：${r.error}`);
      else if (r) out.push(r);
    }
  }
  for (const a of atts.filter((x) => x.kind === "dataUrl")) {
    const r = await buddy.attachDataUrl(state.activeId, a.name, a.dataUrl);
    if (r && r.error) appendError(`附件：${r.error}`);
    else if (r) out.push(r);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 附件：选择 / 拖拽 / 粘贴                                            */
/* ------------------------------------------------------------------ */

function isImageName(name) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(name || ""));
}

function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  return (b / 1024 / 1024).toFixed(1) + " MB";
}

function addAttachments(list) {
  for (const a of list) {
    if (!a) continue;
    // 同一个文件不重复贴
    if (a.kind === "file" && state.attachments.some((x) => x.path === a.path)) continue;
    state.attachments.push(a);
  }
  renderAttachBar();
}

function renderAttachBar() {
  const list = state.attachments;
  els.attachBar.hidden = list.length === 0;
  els.attachBar.innerHTML = "";
  list.forEach((a, i) => {
    const chip = el("div", "attach-chip");
    if (a.kind === "dataUrl") {
      const img = new Image();
      img.src = a.dataUrl;
      chip.appendChild(img);
    } else if (isImageName(a.name) && a.dataUrl) {
      const img = new Image();
      img.src = a.dataUrl;
      chip.appendChild(img);
    } else {
      chip.appendChild(el("div", "attach-ico", isImageName(a.name) ? "🖼" : "📄"));
    }
    const name = el("span", "attach-name", escapeHtml(a.name));
    name.title = `${a.name}${a.size ? " · " + fmtSize(a.size) : ""}`;
    chip.appendChild(name);
    const x = el("button", "attach-x", "×");
    x.title = "移除";
    x.addEventListener("click", () => {
      state.attachments.splice(i, 1);
      renderAttachBar();
    });
    chip.appendChild(x);
    els.attachBar.appendChild(chip);
  });
}

/** 外部文件 → 暂存项。图片顺手读一份 dataUrl 用来显示缩略图 */
async function stagePaths(paths) {
  const list = [];
  for (const p of paths || []) {
    if (!p) continue;
    const name = p.split("/").pop();
    const item = { kind: "file", name, path: p, size: 0, dataUrl: null };
    if (isImageName(name)) {
      const r = await buddy.thumb(p);
      if (r && r.dataUrl && r.dataUrl.length < 3 * 1024 * 1024) item.dataUrl = r.dataUrl;
      if (r && r.size) item.size = r.size;
    }
    list.push(item);
  }
  return list;
}

function renderQueue() {
  const q = state.queue;
  els.queueBar.hidden = q.length === 0;
  els.queueBar.innerHTML = "";
  q.forEach((item, i) => {
    const row = el("div", "queue-item");
    row.appendChild(el("span", "q-idx", String(i + 1)));
    const t = el("span", "q-text", escapeHtml(item.text || `（${item.attachments.length} 个附件）`));
    t.title = item.text || "";
    row.appendChild(t);
    const x = el("button", "q-x", "×");
    x.title = "从队列移除";
    x.addEventListener("click", () => {
      state.queue.splice(i, 1);
      renderQueue();
    });
    row.appendChild(x);
    els.queueBar.appendChild(row);
  });
}

/** 拖拽整窗投放 */
function wireDrop() {
  let depth = 0;
  const show = () => (els.dropMask.hidden = false);
  const hide = () => {
    depth = 0;
    els.dropMask.hidden = true;
  };

  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    depth++;
    show();
  });
  window.addEventListener("dragover", (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", () => {
    depth--;
    if (depth <= 0) hide();
  });
  window.addEventListener("drop", async (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    hide();
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    const paths = files.map((f) => buddy.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    addAttachments(await stagePaths(paths));
  });
}

/** 粘贴截图 */
function wirePaste() {
  els.input.addEventListener("paste", (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgs = items.filter((i) => i.type && i.type.startsWith("image/"));
    if (!imgs.length) return; // 纯文本就走默认粘贴
    e.preventDefault();
    for (const it of imgs) {
      const file = it.getAsFile();
      if (!file) continue;
      const fr = new FileReader();
      fr.onload = () => {
        const ext = (it.type.split("/")[1] || "png").replace("jpeg", "jpg");
        addAttachments([
          {
            kind: "dataUrl",
            name: `粘贴的图片-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${ext}`,
            dataUrl: String(fr.result),
            size: file.size,
          },
        ]);
      };
      fr.readAsDataURL(file);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 产物面板                                                            */
/* ------------------------------------------------------------------ */

const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "create_file",
  "write_file",
  "str_replace_editor",
]);

/** 从工具入参里取文件路径（兼容旧数据里的 _raw 半截 JSON） */
function toolPath(inp) {
  if (!inp) return "";
  let p = inp.file_path || inp.notebook_path || inp.path;
  if (!p && typeof inp._raw === "string") {
    const m = /"(?:file_path|notebook_path|path)"\s*:\s*"([^"]+)"/.exec(inp._raw);
    if (m) p = m[1];
  }
  return typeof p === "string" ? p : "";
}

function addArtifact(p, tool) {
  if (!p || typeof p !== "string") return;
  if (!p.startsWith("/")) return;
  if (state.artifacts.has(p)) return;
  state.artifacts.set(p, {
    path: p,
    name: p.split("/").pop(),
    tool: tool || "",
    at: Date.now(),
  });
  renderArtifacts();
}

function rebuildArtifacts(session) {
  state.artifacts = new Map();
  for (const m of session.messages || []) {
    if (m.role !== "assistant" || !Array.isArray(m.tools)) continue;
    for (const t of m.tools) {
      if (!WRITE_TOOLS.has(t.name)) continue;
      const p = toolPath(t.input);
      if (p.startsWith("/") && !state.artifacts.has(p)) {
        state.artifacts.set(p, { path: p, name: p.split("/").pop(), tool: t.name, at: 0 });
      }
    }
  }
  renderArtifacts();
}

function renderArtifacts() {
  const list = [...state.artifacts.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
  els.artifactCount.hidden = list.length === 0;
  els.artifactCount.textContent = String(list.length);
  els.artifactEmpty.hidden = list.length > 0;
  els.artifactList.innerHTML = "";

  for (const a of list) {
    const row = el("div", "artifact-item");
    const ext = (a.name.split(".").pop() || "").toLowerCase();
    row.appendChild(el("div", "a-ico", isImageName(a.name) ? "🖼" : ext.slice(0, 3) || "📄"));
    const main = el("div", "a-main");
    main.appendChild(el("div", "a-name", escapeHtml(a.name)));
    const dir = a.path.slice(0, a.path.lastIndexOf("/"));
    main.appendChild(el("div", "a-sub", escapeHtml(shortPath(dir))));
    row.appendChild(main);
    row.title = a.path;
    row.addEventListener("click", () => openPreview(a.path));
    els.artifactList.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* 文件预览                                                            */
/* ------------------------------------------------------------------ */

let previewPath = null;

async function openPreview(p) {
  previewPath = p;
  els.previewTitle.textContent = p.split("/").pop() || "预览";
  els.previewBody.innerHTML = '<div class="muted">读取中…</div>';
  els.previewMeta.textContent = shortPath(p);
  els.previewModal.hidden = false;

  const r = await buddy.previewFile(p, state.activeId);
  if (!r || !r.ok) {
    els.previewBody.innerHTML = "";
    const tip = el("div", "artifact-empty");
    tip.textContent = (r && r.error) || "无法预览";
    els.previewBody.appendChild(tip);
    return;
  }

  els.previewMeta.textContent = `${shortPath(p)} · ${fmtSize(r.size)}`;
  els.previewBody.innerHTML = "";

  if (r.kind === "image") {
    const img = new Image();
    img.src = r.dataUrl;
    els.previewBody.appendChild(img);
  } else if (r.kind === "text") {
    const pre = el("pre");
    pre.textContent = r.text;
    els.previewBody.appendChild(pre);
  } else {
    const tip = el("div", "artifact-empty");
    tip.textContent = `${r.error || "二进制文件，不内联预览"}（${fmtSize(r.size)}）`;
    els.previewBody.appendChild(tip);
  }
}

function closePreview() {
  els.previewModal.hidden = true;
  els.previewBody.innerHTML = "";
  previewPath = null;
}

/* ------------------------------------------------------------------ */
/* 会话搜索                                                            */
/* ------------------------------------------------------------------ */

let searchTimer = null;

function renderSearchHits() {
  const hits = state.searchHits;
  if (hits === null) {
    renderSessionList();
    return;
  }
  els.sessionList.innerHTML = "";
  if (!hits.length) {
    els.sessionList.appendChild(el("div", "artifact-empty", "没有匹配的会话"));
    return;
  }
  for (const h of hits) {
    const row = el("div", "search-hit");
    row.innerHTML = `<div class="search-hit-title">${escapeHtml(h.title)}</div>
      <div class="search-hit-sub">${h.snippet ? escapeHtml(h.snippet) : escapeHtml(shortPath(h.cwd || ""))}</div>`;
    row.addEventListener("click", () => {
      els.searchInput.value = "";
      els.searchClear.hidden = true;
      state.searchHits = null;
      openSession(h.id);
    });
    els.sessionList.appendChild(row);
  }
}

function wireSearch() {
  els.searchInput.addEventListener("input", () => {
    const q = els.searchInput.value.trim();
    els.searchClear.hidden = !q;
    clearTimeout(searchTimer);
    if (!q) {
      state.searchHits = null;
      renderSearchHits();
      return;
    }
    searchTimer = setTimeout(async () => {
      state.searchHits = (await buddy.searchSessions(q)) || [];
      renderSearchHits();
    }, 180);
  });

  els.searchClear.addEventListener("click", () => {
    els.searchInput.value = "";
    els.searchClear.hidden = true;
    state.searchHits = null;
    renderSearchHits();
    els.searchInput.focus();
  });
}

/* ------------------------------------------------------------------ */
/* 右栏 tab                                                            */
/* ------------------------------------------------------------------ */

function switchPanelTab(name) {
  for (const b of document.querySelectorAll(".panel-tab")) {
    b.classList.toggle("active", b.dataset.ptab === name);
  }
  for (const pane of document.querySelectorAll("[data-pane]")) {
    pane.hidden = pane.dataset.pane !== name;
  }
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
}

/* ------------------------------------------------------------------ */
/* 定时任务 UI                                                          */
/* ------------------------------------------------------------------ */

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 把时间戳变成「今天 09:05」「明天 09:05」「周四 09:05」「11-03 09:05」 */
function fmtWhen(ts) {
  if (!ts) return "未安排";
  const d = new Date(ts);
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((dd - day0) / 86400000);
  const clock = fmtClock(ts);
  if (diffDays === 0) return `今天 ${clock}`;
  if (diffDays === 1) return `明天 ${clock}`;
  if (diffDays === 2) return `后天 ${clock}`;
  if (diffDays > 2 && diffDays < 7) {
    return `周${"日一二三四五六"[d.getDay()]} ${clock}`;
  }
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

function scheduleLabel(t) {
  const s = t.schedule || {};
  if (s.type === "interval") {
    const m = s.everyMinutes || 60;
    if (m < 60) return `每 ${m} 分钟`;
    if (m % 60 === 0) return `每 ${m / 60} 小时`;
    return `每 ${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  }
  if (s.type === "weekly") {
    const map = ["日", "一", "二", "三", "四", "五", "六"];
    const days = (s.days || []).slice().sort((a, b) => a - b);
    return `每周${days.map((d) => map[d]).join("/")} ${s.time}`;
  }
  return `每天 ${s.time}`;
}

function renderTaskList() {
  els.taskList.innerHTML = "";
  const tasks = state.tasks || [];

  const on = tasks.filter((t) => t.enabled).length;
  if (on > 0) {
    els.taskCount.hidden = false;
    els.taskCount.textContent = String(on);
  } else {
    els.taskCount.hidden = true;
  }

  if (tasks.length === 0) {
    const empty = el("div", "task-empty");
    empty.innerHTML =
      "还没有定时任务<br />点上方「新建任务」，<br />让它每天替你跑一遍固定的事";
    els.taskList.appendChild(empty);
    return;
  }

  for (const t of tasks) {
    const card = el("div", "task-item" + (t.enabled ? "" : " off"));

    const top = el("div", "task-top");
    const dot = el("span", "task-dot " + (t.running ? "running" : t.lastStatus || ""));
    top.appendChild(dot);
    const name = el("span", "task-name", escapeHtml(t.name));
    name.title = t.prompt;
    top.appendChild(name);

    const sw = el("span", "switch" + (t.enabled ? " on" : ""));
    sw.title = t.enabled ? "点击停用" : "点击启用";
    sw.addEventListener("click", async (e) => {
      e.stopPropagation();
      const r = await buddy.toggleTask(t.id, !t.enabled);
      if (r && r.ok) {
        state.tasks = state.tasks.map((x) => (x.id === t.id ? r.task : x));
        renderTaskList();
      }
    });
    top.appendChild(sw);
    card.appendChild(top);

    const when = el("div", "task-when");
    const parts = [`<span>${scheduleLabel(t)}</span>`];
    if (t.running) {
      parts.push(`<span style="color:var(--yellow)">正在运行…</span>`);
    } else if (t.enabled) {
      parts.push(`<span>下次 ${fmtWhen(t.nextRunAt)}</span>`);
    } else {
      parts.push(`<span>已停用</span>`);
    }
    if (t.lastRunAt) {
      const okMark = t.lastStatus === "ok" ? "✓" : t.lastStatus === "error" ? "✕" : "·";
      const color =
        t.lastStatus === "ok"
          ? "var(--green)"
          : t.lastStatus === "error"
            ? "var(--red)"
            : "var(--text-faint)";
      parts.push(
        `<span style="color:${color}">${okMark} 上次 ${fmtWhen(t.lastRunAt)}</span>`,
      );
    }
    when.innerHTML = parts.join('<span class="sep">·</span>');
    card.appendChild(when);

    if (t.lastError && t.lastStatus === "error") {
      const err = el("div", "task-when");
      err.innerHTML = `<span style="color:var(--red)">${escapeHtml(String(t.lastError).slice(0, 80))}</span>`;
      card.appendChild(err);
    }

    if (t.lastHint) {
      const hint = el("div", "task-when");
      hint.innerHTML = `<span style="color:var(--yellow)">⚠ ${escapeHtml(t.lastHint)}</span>`;
      card.appendChild(hint);
    }

    if (!t.allowedTools) {
      const warn = el("div", "task-when");
      warn.innerHTML = `<span style="color:var(--yellow)">⚠ 未设工具白名单，任务里调工具会被拒</span>`;
      card.appendChild(warn);
    }

    const acts = el("div", "task-actions");

    const runBtn = el("button", "task-btn primary", t.running ? "停止" : "立即运行");
    runBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (t.running) {
        await buddy.stopTask(t.id);
        return;
      }
      runBtn.textContent = "启动中…";
      const r = await buddy.runTask(t.id);
      if (!r || !r.ok) {
        toast("启动失败：" + ((r && r.error) || "未知错误"), true);
        runBtn.textContent = "立即运行";
      }
    });
    acts.appendChild(runBtn);

    if (t.sessionId) {
      const viewBtn = el("button", "task-btn", "查看记录");
      viewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openSession(t.sessionId);
      });
      acts.appendChild(viewBtn);
    }

    const editBtn = el("button", "task-btn", "编辑");
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openTaskModal(t);
    });
    acts.appendChild(editBtn);

    const delBtn = el("button", "task-btn", "删除");
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`删除任务「${t.name}」？已生成的会话记录会保留。`)) return;
      await buddy.deleteTask(t.id);
      state.tasks = state.tasks.filter((x) => x.id !== t.id);
      renderTaskList();
    });
    acts.appendChild(delBtn);

    card.appendChild(acts);
    els.taskList.appendChild(card);
  }
}

function switchTab(name) {
  state.tab = name;
  els.tabChats.classList.toggle("active", name === "chats");
  els.tabTasks.classList.toggle("active", name === "tasks");
  els.paneChats.hidden = name !== "chats";
  els.paneTasks.hidden = name !== "tasks";
  if (name === "tasks") refreshTasks();
}

async function refreshTasks() {
  try {
    state.tasks = await buddy.listTasks();
    renderTaskList();
  } catch (e) {
    console.error("拉取任务失败", e);
  }
}

/* ---------------- 弹窗 ---------------- */

function setSegType(type) {
  state.draft.type = type;
  for (const b of document.querySelectorAll("#fType .seg-btn")) {
    b.classList.toggle("active", b.dataset.type === type);
  }
  $("rowTime").hidden = type === "interval";
  $("rowDays").hidden = type !== "weekly";
  $("rowInterval").hidden = type !== "interval";
}

function renderDays(days) {
  state.draft.days = days;
  for (const b of document.querySelectorAll("#fDays .day")) {
    b.classList.toggle("on", days.includes(Number(b.dataset.d)));
  }
}

/** 新建任务时预填的只读工具白名单——不给的话，无人值守时模型什么都调不动 */
const DEFAULT_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "mcp__finance-data__quote",
  "mcp__finance-data__bars",
  "mcp__finance-data__portfolio",
  "mcp__finance-data__orders",
  "mcp__finance-data__accounts",
  "mcp__finance-data__fundamental",
  "mcp__finance-data__market_status",
].join(", ");

function openTaskModal(task) {
  state.editing = task || null;
  const s = task?.schedule || {
    type: "daily",
    time: "09:05",
    days: [1, 2, 3, 4, 5],
    everyMinutes: 120,
  };
  state.draft = {
    type: s.type || "daily",
    days: (s.days || [1, 2, 3, 4, 5]).slice(),
    cwd: task?.cwd || state.config.cwd || "~",
  };

  $("modalTitle").textContent = task ? "编辑定时任务" : "新建定时任务";
  $("fName").value = task?.name || "";
  $("fPrompt").value = task?.prompt || "";
  $("fTime").value = s.time || "09:05";
  $("fEvery").value = s.everyMinutes || 120;
  $("fMode").value = task?.permissionMode || "acceptEdits";
  $("fModel").value = task?.model || "";
  $("fAllowed").value = task ? task.allowedTools || "" : DEFAULT_ALLOWED;
  $("fCwd").value = state.draft.cwd;

  setSegType(state.draft.type);
  renderDays(state.draft.days);

  els.taskModal.hidden = false;
  setTimeout(() => $("fName").focus(), 50);
}

function closeTaskModal() {
  els.taskModal.hidden = true;
  state.editing = null;
}

async function saveTask() {
  const payload = {
    id: state.editing?.id,
    name: $("fName").value.trim() || "未命名任务",
    prompt: $("fPrompt").value.trim(),
    cwd: $("fCwd").value,
    permissionMode: $("fMode").value,
    model: $("fModel").value,
    allowedTools: $("fAllowed").value.trim(),
    enabled: state.editing ? state.editing.enabled : true,
    schedule: {
      type: state.draft.type,
      time: $("fTime").value || "09:00",
      days: state.draft.days,
      everyMinutes: Number($("fEvery").value) || 120,
    },
  };

  if (!payload.prompt) {
    toast("提示词不能为空", true);
    $("fPrompt").focus();
    return;
  }

  const r = await buddy.saveTask(payload);
  if (!r || !r.ok) {
    toast("保存失败：" + ((r && r.error) || "未知错误"), true);
    return;
  }
  closeTaskModal();
  await refreshTasks();
  toast("已保存：" + r.task.name);
}

/* ---------------- 轻提示 ---------------- */

let toastTimer = null;
function toast(msg, isErr) {
  let box = document.getElementById("toastBox");
  if (!box) {
    box = document.createElement("div");
    box.id = "toastBox";
    box.style.cssText = [
      "position:fixed",
      "bottom:26px",
      "left:50%",
      "transform:translateX(-50%)",
      "padding:9px 16px",
      "border-radius:10px",
      "font-size:12.5px",
      "z-index:200",
      "pointer-events:none",
      "transition:opacity .25s, transform .25s",
      "box-shadow:0 8px 24px rgba(0,0,0,.4)",
    ].join(";");
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.style.background = isErr ? "rgba(248,113,113,.16)" : "rgba(74,222,128,.14)";
  box.style.color = isErr ? "#f87171" : "#86efac";
  box.style.border = `1px solid ${isErr ? "rgba(248,113,113,.4)" : "rgba(74,222,128,.35)"}`;
  box.style.opacity = "1";
  box.style.transform = "translateX(-50%) translateY(0)";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.style.opacity = "0";
    box.style.transform = "translateX(-50%) translateY(8px)";
  }, 2600);
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

function shortPath(p) {
  const home = "/Users/" + (p.split("/Users/")[1] || "").split("/")[0];
  return p.replace(home, "~");
}

async function bootstrap() {
  const init = await buddy.init();
  state.config = init.config;
  state.sessions = init.sessions;
  state.activeId = init.activeId;
  state.tasks = init.tasks || [];
  renderTaskList();

  els.cwdLabel.textContent = shortPath(init.config.cwd || "~");
  els.cwdLabel.title = init.config.cwd;
  els.modelSelect.value = init.config.model || "";
  els.modeSelect.value = init.config.permissionMode || "default";
  els.modelBadge.textContent = init.config.model || "默认模型";

  renderSessionList();

  if (state.activeId) await openSession(state.activeId);
  else {
    showWelcome();
    updateStats({ cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0 });
  }

  buddy.onEvent(onEvent);

  els.sendBtn.addEventListener("click", () => send());
  els.stopBtn.addEventListener("click", async () => {
    if (state.activeId) await buddy.stop(state.activeId);
    state.busy = false;
    updateBusy();
    endTurn();
  });

  els.input.addEventListener("input", autoGrow);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  els.newChat.addEventListener("click", newSession);

  els.cwdBtn.addEventListener("click", async () => {
    const dir = await buddy.pickDir();
    if (!dir) return;
    state.config.cwd = dir;
    els.cwdLabel.textContent = shortPath(dir);
    els.cwdLabel.title = dir;
    await buddy.updateConfig({ cwd: dir });
  });

  els.modelSelect.addEventListener("change", async () => {
    state.config.model = els.modelSelect.value;
    els.modelBadge.textContent = els.modelSelect.value || "默认模型";
    await buddy.updateConfig({ model: els.modelSelect.value });
  });

  els.modeSelect.addEventListener("change", async () => {
    state.config.permissionMode = els.modeSelect.value;
    await buddy.updateConfig({ permissionMode: els.modeSelect.value });
  });

  els.togglePanel.addEventListener("click", () => els.panel.classList.toggle("hidden"));

  /* ---- 附件 / 队列 / 搜索 / 产物 ---- */
  els.attachBtn.addEventListener("click", async () => {
    const paths = await buddy.pickFiles();
    if (paths && paths.length) addAttachments(await stagePaths(paths));
  });

  wireDrop();
  wirePaste();
  wireSearch();
  renderAttachBar();
  renderQueue();
  renderArtifacts();

  for (const b of document.querySelectorAll(".panel-tab")) {
    b.addEventListener("click", () => switchPanelTab(b.dataset.ptab));
  }

  els.previewClose.addEventListener("click", closePreview);
  els.previewModal.addEventListener("click", (e) => {
    if (e.target === els.previewModal) closePreview();
  });
  els.previewOpen.addEventListener("click", () => {
    if (previewPath) buddy.openPath(previewPath);
  });

  /* ---- 定时任务 ---- */
  els.tabChats.addEventListener("click", () => switchTab("chats"));
  els.tabTasks.addEventListener("click", () => switchTab("tasks"));
  els.newTask.addEventListener("click", () => openTaskModal(null));

  $("modalClose").addEventListener("click", closeTaskModal);
  $("modalCancel").addEventListener("click", closeTaskModal);
  $("modalSave").addEventListener("click", saveTask);
  els.taskModal.addEventListener("click", (e) => {
    if (e.target === els.taskModal) closeTaskModal();
  });

  for (const b of document.querySelectorAll("#fType .seg-btn")) {
    b.addEventListener("click", () => setSegType(b.dataset.type));
  }
  for (const b of document.querySelectorAll("#fDays .day")) {
    b.addEventListener("click", () => {
      const d = Number(b.dataset.d);
      const cur = state.draft.days || [];
      const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d];
      renderDays(next);
    });
  }
  $("fPickDir").addEventListener("click", async () => {
    const dir = await buddy.pickDir();
    if (dir) {
      $("fCwd").value = dir;
      state.draft.cwd = dir;
    }
  });

  $("fAllowedFill").addEventListener("click", () => {
    const cur = $("fAllowed")
      .value.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const merged = [...new Set([...cur, ...DEFAULT_ALLOWED.split(",").map((s) => s.trim())])];
    $("fAllowed").value = merged.join(", ");
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.taskModal.hidden) closeTaskModal();
    if (e.key === "Escape" && !els.previewModal.hidden) closePreview();
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !els.taskModal.hidden) {
      e.preventDefault();
      saveTask();
    }
  });

  els.input.focus();
}

bootstrap().catch((e) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f87171">启动失败：${e.message}</pre>`;
});
