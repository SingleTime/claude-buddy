/**
 * Claude Buddy — Electron 主进程
 *
 * 把 `claude` CLI 的 stream-json 双向通道包装成桌面应用：
 *   - 每个会话一个常驻子进程（首轮新建，后续 --resume 恢复）
 *   - 逐行解析 NDJSON 事件，转成渲染层友好的增量事件
 *   - 会话与统计持久化到 userData/sessions.json
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

app.setName("Claude Buddy");

/* ------------------------------------------------------------------ */
/* 应用私有运行时                                                      */
/* ------------------------------------------------------------------ */

/**
 * claude 装在哪。
 *
 * 不走 `npm install -g`：那会往全局 prefix（/opt/homebrew、/usr/local、nvm 的
 * 版本目录）里塞 260MB，没准还要 sudo，卸载时也容易漏。
 * 这里装进应用自己的目录，一个 `rm -rf` 就等于干净卸载，不碰 shell profile、
 * 不动 PATH、不留任何系统级痕迹。
 *
 *   开发模式 → <项目>/.claude-runtime
 *   打包之后 → ~/Library/Application Support/Claude Buddy/runtime
 *              （.app 内部是只读的，写不进去，只能落到 userData）
 *
 * 想放到别处就设 CLAUDE_BUDDY_RUNTIME。
 */
function runtimeDir() {
  const override = process.env.CLAUDE_BUDDY_RUNTIME;
  if (override) return path.resolve(override);

  // 开发模式直接放项目里，方便看一眼装了什么；打包后 __dirname 在 app.asar 内
  if (!__dirname.includes(".asar")) return path.join(__dirname, ".claude-runtime");

  try {
    return path.join(app.getPath("userData"), "runtime");
  } catch {
    return path.join(os.homedir(), ".claude-buddy", "runtime");
  }
}

/**
 * 私有运行时里的 claude。
 *
 * postinstall 没跑（--ignore-scripts、--omit=optional）时，`.bin/claude` 指向的
 * 只是一个 500 字节的提示脚本；它虽然可执行，跑起来只会打印错误然后退出 1。
 * 所以不能只看存在与否 —— 真实的原生二进制有 260MB 以上，用体积区分。
 */
function runtimeClaudeBin() {
  const link = path.join(runtimeDir(), "node_modules", ".bin", "claude");
  try {
    const real = fs.realpathSync(link);
    if (fs.statSync(real).size > 1024 * 1024) return link;
  } catch {
    /* 没装过 */
  }
  return null;
}

/** 单引号包裹，供只拼自家路径的 shell 命令使用 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 定位 claude 可执行文件。
 *
 * 不能只靠 PATH：从 Finder / Dock 启动的 GUI 应用拿不到 shell 的 PATH
 * （通常只有 /usr/bin:/bin:/usr/sbin:/sbin），homebrew 装的 claude 会找不到。
 * 所以先探常见安装位置，再退回 PATH，最后交给 spawn 自己解析。
 */
function claudeCandidates() {
  const home = os.homedir();
  const list = [
    "/opt/homebrew/bin/claude", // Apple Silicon + Homebrew
    "/usr/local/bin/claude", // Intel + Homebrew
    path.join(home, ".claude/local/claude"), // claude 自带本地安装
    path.join(home, ".local/bin/claude"), // 官方安装脚本的默认位置
    path.join(home, ".bun/bin/claude"),
    path.join(home, ".npm-global/bin/claude"),
    path.join(home, ".volta/bin/claude"),
  ];
  // nvm / fnm 装的 node，全局 bin 在版本目录里，静态列表够不着
  for (const root of [".nvm/versions/node", ".fnm/node-versions"]) {
    try {
      for (const v of fs.readdirSync(path.join(home, root))) {
        list.push(path.join(home, root, v, "bin", "claude"));
        list.push(path.join(home, root, v, "installation", "bin", "claude")); // fnm 的目录结构
      }
    } catch {
      /* 没装这个版本管理器 */
    }
  }
  return list;
}

function resolveClaudeBin() {
  // 显式指定优先，但路径失效时要退回去自动探测：
  // 否则「CLAUDE_BIN 指错了 → 装完新的也永远用旧的」这种死局解不开
  const explicit = process.env.CLAUDE_BIN;
  if (explicit) {
    try {
      if (fs.existsSync(explicit)) return explicit;
    } catch {
      /* 无效路径，继续探测 */
    }
  }

  // 应用自己装的那份优先：它跟着 app 走，版本可预期，也不用猜用户的 PATH
  const own = runtimeClaudeBin();
  if (own) return own;

  for (const p of claudeCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略无权限目录 */
    }
  }

  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      if (fs.statSync(path.join(dir, "claude")).isFile()) return path.join(dir, "claude");
    } catch {
      /* 找不到就下一个 */
    }
  }
  return "claude";
}

let CLAUDE_BIN = resolveClaudeBin();

/** 是否真的定位到了可执行文件（裸名 "claude" 视为未找到） */
function claudeReady() {
  try {
    return CLAUDE_BIN.includes(path.sep) && fs.existsSync(CLAUDE_BIN);
  } catch {
    return false;
  }
}

/** 安装完成后重新扫描，返回找到的路径或 null */
function rescanClaudeBin() {
  CLAUDE_BIN = resolveClaudeBin();
  return claudeReady() ? CLAUDE_BIN : null;
}

/**
 * 问一次用户的登录 shell：某个命令到底在哪。
 *
 * resolveClaudeBin() 查的是写死的位置列表 + 本进程的 PATH，而 GUI 进程的 PATH
 * 只有 /usr/bin:/bin:/usr/sbin:/sbin。凡是靠版本管理器（nvm / fnm / asdf / volta）
 * 或自定义 PATH 装上的东西，静态列表都可能漏掉。
 *
 * 漏掉时不能让用户再装一份 —— 那会变成全局两份、版本还不知道哪个在前。
 * 所以让登录 shell 自己报出来（它会加载 .zshrc / .bash_profile 里的 PATH）。
 * 只有真的问不到，才认为「本机没有」。
 */
function probeViaShell(name) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || safeUserShell() || "/bin/bash";
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };

    let proc;
    try {
      proc = spawn(shell, ["-lc", `command -v ${name}`], {
        env: childEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return finish(null);
    }

    // 某些人的 rc 文件里挂着网络请求或慢操作，不能无限等
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已经退出 */
      }
      finish(null);
    }, 8000);

    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (c) => {
      out += c;
    });
    proc.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      // command -v 可能返回别名或函数定义，只要绝对路径那一行
      const found = out
        .split("\n")
        .map((s) => s.trim())
        .find((s) => s.startsWith("/") && !s.includes(" "));
      if (!found) return finish(null);
      try {
        if (fs.statSync(found).isFile()) return finish(found);
      } catch {
        /* 报了个不存在的路径 */
      }
      finish(null);
    });
  });
}

const probeClaudeViaShell = () => probeViaShell("claude");

function safeUserShell() {
  try {
    const s = os.userInfo().shell;
    return s && fs.existsSync(s) ? s : "";
  } catch {
    return "";
  }
}

/**
 * 确认 claude 是否可用：先看已解析的路径，再问一次登录 shell。
 * 找到就把 CLAUDE_BIN 换上，后续 spawn 直接用。
 */
async function ensureClaude() {
  if (claudeReady()) return CLAUDE_BIN;

  const found = await probeClaudeViaShell();
  if (found) {
    CLAUDE_BIN = found;
    return found;
  }
  return null;
}

/**
 * 默认用哪种方式装。
 *
 * 优先 npm：它一次下载 + 硬链接铺开，而且可以 `--prefix` 指定目录，
 * 装进应用私有运行时，不碰全局 prefix、不改 PATH、不需要 sudo。
 * 官方脚本只会装到 ~/.local/bin，绕不开用户家目录，所以只作兜底。
 *
 * 但 npm 只在已经装了 Node 时才有意义 —— 没有就退回官方脚本（不依赖 Node）。
 */
async function pickInstallMethod() {
  const npm = await probeViaShell("npm");
  return npm ? "npm" : "script";
}

/** 给子进程补齐 PATH，保证 claude 内部调用 node / git / 其它 CLI 也能命中 */
function childEnv() {
  const extra = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    path.join(os.homedir(), ".local/bin"),
  ];
  const current = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const merged = [...current];
  for (const p of extra) if (!merged.includes(p)) merged.push(p);
  return { ...process.env, PATH: merged.join(path.delimiter) };
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"];

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

let storePath = null;
let store = {
  version: 2,
  sessions: [],
  activeId: null,
  tasks: [],
  config: {
    cwd: os.homedir(),
    model: "", // 空 = 用 settings.json 里的默认
    permissionMode: "default",
  },
};

function loadStore() {
  storePath = path.join(app.getPath("userData"), "sessions.json");
  try {
    if (fs.existsSync(storePath)) {
      const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
      store = { ...store, ...raw };
      store.config = { ...{ cwd: os.homedir(), model: "", permissionMode: "default" }, ...(raw.config || {}) };
      if (!Array.isArray(store.tasks)) store.tasks = [];
      if (!Array.isArray(store.sessions)) store.sessions = [];
    }
  } catch (e) {
    console.error("[store] 读取失败，使用空存储:", e.message);
  }
}

let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
    } catch (e) {
      console.error("[store] 写入失败:", e.message);
    }
  }, 300);
}

const newId = () => crypto.randomUUID();

function getSession(id) {
  return store.sessions.find((s) => s.id === id) || null;
}

function createSession(cwd) {
  const s = {
    id: newId(),
    sessionId: null, // claude 侧 session_id
    title: "新对话",
    cwd: cwd || store.config.cwd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    totals: { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0 },
  };
  store.sessions.unshift(s);
  store.activeId = s.id;
  saveStore();
  return s;
}

/* ------------------------------------------------------------------ */
/* claude 子进程管理                                                    */
/* ------------------------------------------------------------------ */

/** sessionLocalId -> { proc, buf, stderr, pending } */
const runners = new Map();
let mainWindow = null;

function emit(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("evt", payload);
  }
}

function killAllRunners() {
  for (const [, r] of runners) {
    try {
      r.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  runners.clear();
}

function killOthers(keepId) {
  for (const [id, r] of [...runners]) {
    if (id === keepId) continue;
    try {
      r.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    runners.delete(id);
  }
}

function spawnRunner(session, overrides = {}) {
  const wantedMode = overrides.permissionMode || store.config.permissionMode;
  const mode = PERMISSION_MODES.includes(wantedMode) ? wantedMode : "default";

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    mode,
  ];
  // 定时任务每次都开干净上下文：累积 resume 会让 token 成本指数上涨
  if (session.sessionId && !overrides.noResume) args.push("--resume", session.sessionId);
  const model = overrides.model !== undefined ? overrides.model : store.config.model;
  if (model) args.push("--model", model);
  // 无人值守场景必须显式放行工具，否则 MCP / Bash 调用会被静默拒绝
  const allowed = (overrides.allowedTools || "").replace(/\s+/g, "").replace(/,+/g, ",").trim();
  if (allowed && allowed !== ",") args.push("--allowedTools", allowed);

  // 附件存在 userData 下，不在 cwd 里，Read 会被权限拦下来。
  // 显式把附件目录加进可访问目录，模型才读得到；放最后是因为它吃多个值。
  const attDir = attachmentsDir(session.id);
  try {
    fs.mkdirSync(attDir, { recursive: true });
    args.push("--add-dir", attDir);
  } catch {
    /* 建不出来就只走图片内联 */
  }

  const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();

  let proc;
  try {
    proc = spawn(CLAUDE_BIN, args, {
      cwd,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    emit({ type: "error", sessionId: session.id, message: `无法启动 claude：${e.message}` });
    return null;
  }

  const runner = { proc, buf: "", stderr: "", session };
  runners.set(session.id, runner);

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    runner.buf += chunk;
    let idx;
    while ((idx = runner.buf.indexOf("\n")) >= 0) {
      const line = runner.buf.slice(0, idx).trim();
      runner.buf = runner.buf.slice(idx + 1);
      if (!line) continue;
      try {
        handleClaudeEvent(session, JSON.parse(line));
      } catch {
        /* 忽略非 JSON 行 */
      }
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    runner.stderr += chunk;
    if (runner.stderr.length > 8000) runner.stderr = runner.stderr.slice(-8000);
  });

  proc.on("exit", (code, signal) => {
    // 只清理自己这条：改了模型/权限后会起新进程，旧进程退出时不能把新的从表里删掉，
    // 否则后续写入全部落空，界面还会把新一轮的 busy 状态重置掉
    const cur = runners.get(session.id);
    const isCurrent = !!cur && cur.proc === proc;
    if (isCurrent) runners.delete(session.id);
    if (code !== 0 && code !== null && runner.stderr.trim()) {
      emit({
        type: "error",
        sessionId: session.id,
        message: runner.stderr.trim().slice(0, 1200),
      });
    }
    // 任务执行途中进程挂掉（没等到 result），在这里兜底记账
    if (pendingTaskRuns.has(session.id)) {
      finishTaskRun(session.id, {
        ok: code === 0,
        error:
          runner.stderr.trim().slice(0, 300) || `子进程异常退出（code=${code}, signal=${signal}）`,
      });
    }
    emit({ type: "proc_exit", sessionId: session.id, code, signal, current: isCurrent });
  });

  proc.on("error", (e) => {
    emit({ type: "error", sessionId: session.id, message: `子进程错误：${e.message}` });
  });

  return runner;
}

function getRunner(session) {
  const existing = runners.get(session.id);
  if (existing && existing.proc && !existing.proc.killed && existing.proc.exitCode === null) {
    return existing;
  }
  killOthers(session.id);
  return spawnRunner(session);
}

function killRunner(sessionId) {
  const r = runners.get(sessionId);
  if (!r) return false;
  try {
    r.proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  runners.delete(sessionId);
  return true;
}

/** 建会话但不抢走用户当前的 activeId（定时任务要用） */
function createSessionSilent(cwd) {
  const prev = store.activeId;
  const s = createSession(cwd);
  store.activeId = prev;
  return s;
}

/* ------------------------------------------------------------------ */
/* 事件解析                                                            */
/* ------------------------------------------------------------------ */

/** 当前轮次的块缓冲，用于把 stream_event 拼成完整消息 */
const turnState = new Map(); // sessionLocalId -> { text, thinking, tools, current }

function turnOf(sessionId) {
  if (!turnState.has(sessionId)) {
    turnState.set(sessionId, { text: "", thinking: "", tools: [], current: null });
  }
  return turnState.get(sessionId);
}

/**
 * 解析工具入参。
 *
 * 正常情况下是完整 JSON。但对接非官方端点时，最后一段 input_json_delta 可能
 * 没送到（模型侧被截断），JSON.parse 直接挂掉 —— 整张工具卡片就只剩一个
 * `_raw` 字符串，产物路径也提取不到。这里退一步，用正则从半截 JSON 里捞
 * 常用字段，至少让界面和产物面板还能用。
 */
function parseToolInput(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    /* 半截 JSON，往下捞字段 */
  }
  const out = { _raw: raw, _partial: true };
  for (const key of ["file_path", "notebook_path", "path", "command", "pattern", "url"]) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (!m) continue;
    try {
      out[key] = JSON.parse(`"${m[1]}"`);
    } catch {
      out[key] = m[1];
    }
  }
  return out;
}

function handleClaudeEvent(session, e) {
  const sid = session.id;

  switch (e.type) {
    case "system": {
      if (e.subtype === "init") {
        session.sessionId = e.session_id;
        session.model = e.model || session.model;
        saveStore();
        emit({
          type: "init",
          sessionId: sid,
          claudeSessionId: e.session_id,
          model: e.model,
          cwd: e.cwd,
          tools: e.tools || [],
        });
      } else if (e.subtype === "thinking_tokens") {
        emit({ type: "thinking_tokens", sessionId: sid, tokens: e.estimated_tokens });
      } else if (e.subtype === "status") {
        emit({ type: "status", sessionId: sid, text: e.status || e.message || "" });
      }
      return;
    }

    case "stream_event": {
      handleStreamEvent(sid, e.event);
      return;
    }

    case "assistant": {
      // 完整消息，用于校正增量结果
      emit({ type: "assistant_message", sessionId: sid, message: e.message });
      return;
    }

    case "user": {
      // Claude Code 把工具结果放在 user 消息里
      const content = e.message?.content;
      if (Array.isArray(content)) {
        const st = turnOf(sid);
        for (const block of content) {
          if (block.type === "tool_result") {
            const normalized = normalizeToolResult(block.content);
            const rec = st.tools.find((t) => t.id === block.tool_use_id);
            if (rec) {
              rec.result = normalized;
              rec.isError = !!block.is_error;
            }
            emit({
              type: "tool_result",
              sessionId: sid,
              toolUseId: block.tool_use_id,
              content: normalized,
              isError: !!block.is_error,
            });
          }
        }
      }
      return;
    }

    case "result": {
      const cost = e.total_cost_usd || 0;
      const u = e.usage || {};
      session.totals.cost += cost;
      session.totals.inputTokens += u.input_tokens || 0;
      session.totals.outputTokens += u.output_tokens || 0;
      session.totals.cacheRead += u.cache_read_input_tokens || 0;
      if (!session.sessionId && e.session_id) session.sessionId = e.session_id;
      session.updatedAt = Date.now();

      // 组装本轮 assistant 消息并持久化
      const st = turnOf(sid);
      if (st.text.trim() || st.tools.length > 0) {
        session.messages.push({
          role: "assistant",
          text: st.text,
          thinking: st.thinking,
          tools: st.tools.map((t) => ({
            name: t.name,
            input: t.input,
            result: t.result || "",
            isError: !!t.isError,
          })),
          at: Date.now(),
        });
      }
      const turnMeta = {
        cost,
        durationMs: e.duration_api_ms,
        usage: u,
      };
      turnState.delete(sid);
      saveStore();

      emit({
        type: "result",
        sessionId: sid,
        cost,
        durationMs: e.duration_api_ms,
        usage: u,
        totals: session.totals,
        isError: !!e.is_error,
        stopReason: e.stop_reason,
        turnText: st.text,
      });

      // 若是定时任务触发的这一轮，回收结果并更新任务状态
      finishTaskRun(sid, { ok: !e.is_error, text: st.text, cost, error: e.stop_reason });
      return;
    }

    default:
      return;
  }
}

function normalizeToolResult(content) {
  if (typeof content === "string") return content.slice(0, 6000);
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.text || JSON.stringify(c)))
      .join("\n")
      .slice(0, 6000);
  }
  return JSON.stringify(content ?? "").slice(0, 6000);
}

function handleStreamEvent(sid, ev) {
  if (!ev || !ev.type) return;
  const st = turnOf(sid);

  switch (ev.type) {
    case "message_start": {
      // 注意：一轮对话会产生多个 message（工具调用前 / 后），
      // 这里绝不能清空 text/thinking/tools，它们是整轮累积的结果。
      st.current = null;
      emit({ type: "turn_start", sessionId: sid });
      return;
    }

    case "content_block_start": {
      const b = ev.content_block || {};
      if (b.type === "text") {
        st.current = { kind: "text", text: "" };
        emit({ type: "block_start", sessionId: sid, kind: "text" });
      } else if (b.type === "thinking") {
        st.current = { kind: "thinking", text: "" };
        emit({ type: "block_start", sessionId: sid, kind: "thinking" });
      } else if (b.type === "tool_use") {
        st.current = { kind: "tool", name: b.name, id: b.id, json: "" };
        emit({
          type: "tool_start",
          sessionId: sid,
          toolUseId: b.id,
          name: b.name,
        });
      } else {
        st.current = { kind: b.type || "unknown" };
      }
      return;
    }

    case "content_block_delta": {
      const d = ev.delta || {};
      if (!st.current) return;
      if (d.type === "text_delta") {
        st.current.text += d.text || "";
        st.text += d.text || "";
        emit({ type: "text_delta", sessionId: sid, text: d.text || "" });
      } else if (d.type === "thinking_delta") {
        st.current.text += d.thinking || "";
        st.thinking += d.thinking || "";
        emit({ type: "thinking_delta", sessionId: sid, text: d.thinking || "" });
      } else if (d.type === "input_json_delta") {
        st.current.json += d.partial_json || "";
        emit({ type: "tool_input_delta", sessionId: sid, text: d.partial_json || "" });
      }
      return;
    }

    case "content_block_stop": {
      if (st.current && st.current.kind === "tool") {
        const parsed = parseToolInput(st.current.json);
        st.tools.push({ id: st.current.id, name: st.current.name, input: parsed });
        emit({
          type: "tool_input",
          sessionId: sid,
          toolUseId: st.current.id,
          name: st.current.name,
          input: parsed,
        });
      }
      st.current = null;
      return;
    }

    case "message_delta": {
      const u = ev.usage;
      if (u) emit({ type: "message_usage", sessionId: sid, usage: u });
      return;
    }

    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* 定时任务调度                                                        */
/* ------------------------------------------------------------------ */

/** claude 侧会话 id -> { taskId, runId, startedAt, timer } */
const pendingTaskRuns = new Map();
/** taskId -> true，防重入 */
const runningTasks = new Set();

const TASK_TIMEOUT_MS = 15 * 60 * 1000; // 单次运行最长 15 分钟
const MAX_RUNS_KEPT = 20;

function getTask(id) {
  return store.tasks.find((t) => t.id === id) || null;
}

function normalizeTask(input, existing) {
  const t = existing || { id: newId(), createdAt: Date.now(), runs: [] };
  t.name = String(input.name || "未命名任务").trim().slice(0, 60);
  t.prompt = String(input.prompt || "").trim();
  t.enabled = input.enabled !== false;
  t.cwd = input.cwd || store.config.cwd;
  t.permissionMode = input.permissionMode || "acceptEdits";
  t.model = input.model || "";
  t.allowedTools = String(input.allowedTools || "").trim().slice(0, 600);
  t.schedule = {
    type: input.schedule?.type || "daily",
    time: input.schedule?.time || "09:00",
    days: Array.isArray(input.schedule?.days) ? input.schedule.days : [1, 3, 5],
    everyMinutes: Math.max(1, Number(input.schedule?.everyMinutes) || 120),
  };
  t.nextRunAt = computeNext(t, Date.now());
  return t;
}

/** 按当前时间推算下一次运行时间戳 */
function computeNext(task, from) {
  const s = task.schedule || {};
  const base = new Date(from);

  if (s.type === "interval") {
    const mins = Math.max(1, Number(s.everyMinutes) || 120);
    // 抹掉秒再相加：保持严格 N 分钟间隔，又不会因为余数累积漂移
    return Math.floor(from / 60000) * 60000 + mins * 60000;
  }

  const [hh, mm] = String(s.time || "09:00")
    .split(":")
    .map((x) => parseInt(x, 10) || 0);

  if (s.type === "weekly") {
    const days = (s.days || []).filter((d) => d >= 0 && d <= 6);
    const list = days.length ? days : [1];
    for (let i = 0; i <= 7; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      d.setHours(hh, mm, 0, 0);
      if (list.includes(d.getDay()) && d.getTime() > from) return d.getTime();
    }
    return from + 7 * 86400000;
  }

  // daily（默认）
  const d = new Date(base);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function taskView(t) {
  return {
    id: t.id,
    name: t.name,
    prompt: t.prompt,
    enabled: t.enabled,
    cwd: t.cwd,
    permissionMode: t.permissionMode,
    model: t.model,
    allowedTools: t.allowedTools || "",
    schedule: t.schedule,
    nextRunAt: t.nextRunAt,
    lastRunAt: t.lastRunAt || null,
    lastStatus: t.lastStatus || null,
    lastError: t.lastError || null,
    lastHint: t.lastHint || null,
    lastCost: t.lastCost || 0,
    runCount: (t.runs || []).length,
    running: runningTasks.has(t.id),
    sessionId: t.sessionId || null,
    runs: (t.runs || []).slice(0, 5),
  };
}

function emitTasks() {
  saveStore();
  emit({ type: "tasks", tasks: store.tasks.map(taskView) });
}

/** 执行一个任务：起新进程、干净上下文、跑完记结果 */
async function runTask(task, trigger = "manual") {
  if (!task || runningTasks.has(task.id)) {
    return { ok: false, error: "该任务正在运行中" };
  }
  if (!task.prompt) return { ok: false, error: "任务没有填写提示词" };

  const runId = newId().slice(0, 8);
  runningTasks.add(task.id);
  task.lastStatus = "running";
  task.lastError = null;
  emitTasks();

  // 每个任务固定一个会话，历史都堆在这里，方便回看
  let session = task.sessionId ? getSession(task.sessionId) : null;
  if (!session) {
    session = createSessionSilent(task.cwd);
    session.title = "⏱ " + task.name;
    session.kind = "task";
    task.sessionId = session.id;
  }

  const cwdOk = task.cwd && fs.existsSync(task.cwd);
  session.cwd = cwdOk ? task.cwd : os.homedir();

  const text = task.prompt;
  session.messages.push({
    role: "user",
    text,
    at: Date.now(),
    viaTask: { taskId: task.id, runId, trigger },
  });
  session.updatedAt = Date.now();
  saveStore();

  // 强制新进程：不复用旧 runner，也不 resume（保持上下文干净）
  killRunner(session.id);
  const runner = spawnRunner(session, {
    permissionMode: task.permissionMode,
    model: task.model,
    allowedTools: task.allowedTools,
    noResume: true,
  });
  if (!runner) {
    runningTasks.delete(task.id);
    task.lastStatus = "error";
    task.lastError = "无法启动 claude 子进程";
    emitTasks();
    return { ok: false, error: task.lastError };
  }

  const rec = { taskId: task.id, runId, startedAt: Date.now(), trigger, timer: null };
  pendingTaskRuns.set(session.id, rec);

  // 超时兜底
  rec.timer = setTimeout(() => {
    const pend = pendingTaskRuns.get(session.id);
    if (pend && pend.runId === runId) {
      killRunner(session.id);
      finishTaskRun(session.id, {
        ok: false,
        error: `运行超时（>${TASK_TIMEOUT_MS / 60000} 分钟）`,
      });
    }
  }, TASK_TIMEOUT_MS);

  try {
    runner.proc.stdin.write(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n",
    );
  } catch (e) {
    clearTimeout(rec.timer);
    pendingTaskRuns.delete(session.id);
    runningTasks.delete(task.id);
    task.lastStatus = "error";
    task.lastError = `写入失败：${e.message}`;
    emitTasks();
    return { ok: false, error: task.lastError };
  }

  emit({ type: "task_started", taskId: task.id, sessionId: session.id, runId, trigger });
  return { ok: true, sessionId: session.id, runId };
}

/** result / 超时 / 进程退出时统一收口 */
function finishTaskRun(sessionId, outcome) {
  const pend = pendingTaskRuns.get(sessionId);
  if (!pend) return;
  pendingTaskRuns.delete(sessionId);
  if (pend.timer) clearTimeout(pend.timer);

  const task = getTask(pend.taskId);
  runningTasks.delete(pend.taskId);

  const session = getSession(sessionId);
  const excerpt = (outcome.text || "").trim().slice(0, 200);

  if (task) {
    // 记"触发时刻"而不是"完成时刻"：否则运行耗时会被算进间隔里，看起来像延迟
    task.lastRunAt = pend.startedAt;
    task.lastStatus = outcome.ok ? "ok" : "error";
    task.lastError = outcome.ok ? null : String(outcome.error || "未知错误").slice(0, 300);
    // 模型在被拦、或工具没连上时，仍会正常返回一段文字，退出码是 0，只能从内容识别
    if (outcome.ok) {
      const perm = /未获授权|权限提示|权限尚未|待批准|需要批准|permission denied|not granted/i;
      const missing = /工具不存在|没有.{0,8}这个工具|未配置|未接入|没有连接|没有.{0,4}可用.{0,4}工具/i;
      task.lastHint = perm.test(excerpt)
        ? "响应里提到了权限/批准，工具被拦截了。补全工具白名单后重试。"
        : missing.test(excerpt)
          ? "模型说找不到工具，多半是 MCP 冷启动超时。重跑一次，仍失败就检查 MCP 是否 Connected。"
          : null;
    } else {
      task.lastHint = null;
    }
    task.lastCost = outcome.cost || 0;
    task.runs = task.runs || [];
    task.runs.unshift({
      at: pend.startedAt,
      finishedAt: Date.now(),
      runId: pend.runId,
      trigger: pend.trigger,
      status: task.lastStatus,
      cost: task.lastCost,
      error: task.lastError,
      excerpt,
      elapsedMs: Date.now() - pend.startedAt,
    });
    task.runs = task.runs.slice(0, MAX_RUNS_KEPT);
    task.nextRunAt = computeNext(task, Date.now());
  }

  emit({
    type: "task_done",
    taskId: pend.taskId,
    sessionId,
    runId: pend.runId,
    ok: !!outcome.ok,
    error: task ? task.lastError : null,
    excerpt,
    cost: outcome.cost || 0,
  });
  emitTasks();
}

/** 每分钟检查一次，到点就跑 */
let tickTimer = null;
function startScheduler() {
  const tick = () => {
    const now = Date.now();
    let dirty = false;

    for (const t of store.tasks) {
      if (!t.enabled) continue;
      if (!t.nextRunAt) {
        t.nextRunAt = computeNext(t, now);
        dirty = true;
        continue;
      }
      if (now < t.nextRunAt) continue;
      if (runningTasks.has(t.id)) {
        // 上次还在跑，顺延到下一周期，避免堆叠
        t.nextRunAt = computeNext(t, now);
        dirty = true;
        continue;
      }

      // 错过太久（比如合盖一整天）只在 6 小时内补跑，防止一开机连跑十几个
      const lateBy = now - t.nextRunAt;
      const shouldRun = lateBy <= 6 * 3600 * 1000;

      const scheduledFor = t.nextRunAt;
      t.nextRunAt = computeNext(t, now);
      dirty = true;

      if (shouldRun) {
        runTask(t, "schedule").catch((e) => {
          console.error("[task] 执行失败:", e.message);
          runningTasks.delete(t.id);
          emitTasks();
        });
      } else {
        t.runs = t.runs || [];
        t.runs.unshift({
          at: now,
          runId: "-",
          trigger: "skip",
          status: "skipped",
          error: `错过超过 6 小时（原定 ${new Date(scheduledFor).toLocaleString("zh-CN")}），已跳过`,
          cost: 0,
        });
        t.runs = t.runs.slice(0, MAX_RUNS_KEPT);
      }
    }

    if (dirty) emitTasks();
  };

  tick();
  clearInterval(tickTimer);
  // 10 秒一次：每日任务无所谓，但分钟级间隔任务需要这个精度
  tickTimer = setInterval(tick, 10000);
}

/* ------------------------------------------------------------------ */
/* 附件                                                                */
/* ------------------------------------------------------------------ */

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
]);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 单图上限
const MAX_ATTACH_BYTES = 64 * 1024 * 1024; // 单个附件上限
const MAX_PREVIEW_BYTES = 800 * 1024; // 文本预览上限

/** 附件落在 userData 下，不往用户的工作目录里扔东西 */
function attachmentsDir(sessionId) {
  return path.join(app.getPath("userData"), "attachments", String(sessionId));
}

function attachMeta(filePath) {
  const st = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  return {
    id: crypto.randomUUID(),
    name: path.basename(filePath),
    path: filePath,
    size: st.size,
    mediaType: IMAGE_TYPES.get(ext) || "",
    isImage: IMAGE_TYPES.has(ext) && st.size <= MAX_IMAGE_BYTES,
  };
}

/** 把外部文件拷进会话附件目录，返回元数据（失败的带 error） */
function importAttachments(sessionId, paths) {
  const dir = attachmentsDir(sessionId);
  const out = [];
  for (const src of Array.isArray(paths) ? paths : []) {
    try {
      const st = fs.statSync(src);
      if (!st.isFile()) {
        out.push({ error: `${path.basename(src)} 不是文件` });
        continue;
      }
      if (st.size > MAX_ATTACH_BYTES) {
        out.push({ error: `${path.basename(src)} 超过 64MB` });
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      let dest = path.join(dir, path.basename(src));
      // 同名不覆盖：加时间戳前缀，避免把自己刚拷进去的文件当成源
      if (fs.existsSync(dest)) dest = path.join(dir, `${Date.now()}-${path.basename(src)}`);
      fs.copyFileSync(src, dest);
      out.push(attachMeta(dest));
    } catch (e) {
      out.push({ error: `${path.basename(src)}: ${e.message}` });
    }
  }
  return out;
}

/** 粘贴进来的图片是 data URL，直接落盘 */
function saveDataUrl(sessionId, name, dataUrl) {
  const m = /^data:([^;]+);base64,([\s\S]+)$/.exec(String(dataUrl || ""));
  if (!m) return { error: "不是合法的图片数据" };
  const mediaType = m[1];
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > MAX_IMAGE_BYTES) return { error: "图片超过 4MB" };
  const ext = [...IMAGE_TYPES].find(([, t]) => t === mediaType)?.[0] || ".png";
  const dir = attachmentsDir(sessionId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${String(name || "pasted").replace(/[^\w.-]/g, "_")}${ext}`);
    fs.writeFileSync(file, buf);
    return attachMeta(file);
  } catch (e) {
    return { error: e.message };
  }
}

/** target 是否在 parent 目录内（不含 parent 本身） */
function isUnder(parent, target) {
  const rel = path.relative(parent, target);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 只读预览一个文件。
 *
 * 路径必须落在工作目录或附件目录里 —— 渲染层的绝对路径来自工具调用，
 * 而工具调用是模型给的，不能让它顺手把 ~/.ssh 读进界面。
 */
function previewFile(filePath, sessionId) {
  const p = path.resolve(String(filePath || ""));
  const roots = [store.config.cwd, attachmentsDir(sessionId || "")];
  for (const s of store.sessions) if (s.cwd) roots.push(s.cwd);

  if (!roots.some((r) => r && (p === r || isUnder(r, p)))) {
    return { ok: false, error: "只能预览工作目录或附件目录里的文件" };
  }
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!st.isFile()) return { ok: false, error: "不是文件" };

  const mediaType = IMAGE_TYPES.get(path.extname(p).toLowerCase());
  if (mediaType && st.size <= MAX_IMAGE_BYTES) {
    try {
      const b64 = fs.readFileSync(p).toString("base64");
      return { ok: true, kind: "image", path: p, name: path.basename(p), size: st.size, dataUrl: `data:${mediaType};base64,${b64}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  if (st.size > MAX_PREVIEW_BYTES) {
    return { ok: true, kind: "binary", path: p, name: path.basename(p), size: st.size, error: "文件太大，不内联预览" };
  }
  try {
    const buf = fs.readFileSync(p);
    // 有 NUL 字节就当二进制，别往界面塞乱码
    if (buf.includes(0)) {
      return { ok: true, kind: "binary", path: p, name: path.basename(p), size: st.size };
    }
    return { ok: true, kind: "text", path: p, name: path.basename(p), size: st.size, text: buf.toString("utf8") };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* 发送消息                                                            */
/* ------------------------------------------------------------------ */

async function sendMessage(session, text, attachments) {
  const atts = (Array.isArray(attachments) ? attachments : []).filter(
    (a) => a && a.path && fs.existsSync(a.path),
  );
  // 只发文件不带字也要能发：拿文件名当占位，不替用户编话
  const body = text.trim() || atts.map((a) => a.name).join("、");

  // 首条消息拿来当标题
  if (session.title === "新对话" && body.trim()) {
    session.title = body.trim().slice(0, 30);
  }

  session.messages.push({
    role: "user",
    text: body,
    at: Date.now(),
    attachments: atts.map((a) => ({ name: a.name, path: a.path, isImage: !!a.isImage, size: a.size })),
  });
  session.updatedAt = Date.now();
  saveStore();

  const runner = getRunner(session);
  if (!runner) return { ok: false, error: "子进程启动失败" };

  // 图片走 content block 内联（模型直接看见），其他文件给路径让 Read 自己读
  const content = [{ type: "text", text: body }];
  const files = [];
  for (const a of atts) {
    if (a.isImage) {
      try {
        const b64 = fs.readFileSync(a.path).toString("base64");
        const mediaType = a.mediaType || IMAGE_TYPES.get(path.extname(a.path).toLowerCase()) || "image/png";
        content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: b64 } });
      } catch {
        files.push(a.path);
      }
    } else {
      files.push(a.path);
    }
  }
  if (files.length) {
    content[0].text += `\n\n附件（请用 Read 工具读取）：\n${files.map((f) => `- ${f}`).join("\n")}`;
  }

  const payload = { type: "user", message: { role: "user", content } };
  try {
    runner.proc.stdin.write(JSON.stringify(payload) + "\n");
  } catch (e) {
    return { ok: false, error: `写入失败：${e.message}` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 窗口与 IPC                                                          */
/* ------------------------------------------------------------------ */

function buildMenu() {
  const template = [
    {
      role: "appMenu",
      submenu: [
        { role: "about", label: "关于 Claude Buddy" },
        { type: "separator" },
        { role: "hide", label: "隐藏 Claude Buddy" },
        { role: "hideOthers", label: "隐藏其他" },
        { type: "separator" },
        { role: "quit", label: "退出 Claude Buddy" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "安装 Claude Code…", click: () => openInstaller() },
        {
          label: "重新检测 claude",
          click: async () => {
            const bin = (await ensureClaude()) || rescanClaudeBin();
            dialog.showMessageBox(mainWindow, {
              type: bin ? "info" : "warning",
              message: bin ? "已找到 claude" : "仍然没找到 claude",
              detail: bin || `已检查常见位置和登录 shell PATH。\n可从「帮助 → 安装 Claude Code…」自动安装。`,
              buttons: ["好"],
            });
          },
        },
        { type: "separator" },
        {
          label: "项目主页",
          click: () => shell.openExternal("https://github.com/SingleTime/claude-buddy"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* Claude Code 安装向导                                                */
/* ------------------------------------------------------------------ */

/**
 * 只有这两条命令。路径由代码自己拼，用户输入永远不进 shell ——
 * 这是无人值守场景能接受的最低安全线。
 * cmd 是函数：npm 那条要带上运行时目录，而目录在打包前后不一样。
 */
const INSTALL_METHODS = {
  script: {
    label: "官方安装脚本",
    // 官方脚本只会装到 ~/.local/bin，绕不开用户家目录
    cmd: () => "curl -fsSL https://claude.ai/install.sh | bash",
  },
  npm: {
    label: "npm 本地安装",
    cmd: () =>
      `npm install --prefix ${shellQuote(runtimeDir())} --no-audit --no-fund ` +
      `--loglevel=http @anthropic-ai/claude-code`,
  },
};

let installWin = null;
let installProc = null;
let installMethod = ""; // 空 = 打开时按环境自动选

function installSend(channel, payload) {
  if (installWin && !installWin.isDestroyed()) installWin.webContents.send(channel, payload);
}

function openInstaller(method) {
  if (method) installMethod = method;

  if (installWin && !installWin.isDestroyed()) {
    installWin.focus();
    return;
  }

  installWin = new BrowserWindow({
    width: 780,
    height: 580,
    minWidth: 620,
    minHeight: 420,
    resizable: true,
    title: "安装 Claude Code",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  installWin.loadFile(path.join(__dirname, "renderer", "installer.html"));
  installWin.webContents.on("did-finish-load", () => startInstall());

  installWin.on("closed", () => {
    installWin = null;
    // 窗口关了就别让安装进程在后台裸奔
    if (installProc) {
      try {
        installProc.kill();
      } catch {
        /* 已经退出 */
      }
      installProc = null;
    }
  });
}

async function startInstall(method) {
  if (method) installMethod = method;
  if (installProc) return;

  // 先按环境定方式（有 npm 走 npm，没有才走官方脚本），这样界面上显示的
  // 标签一开始就是真的，不会先显示"官方脚本"再跳成"npm 全局安装"
  let autoPicked = false;
  if (!installMethod) {
    installMethod = await pickInstallMethod();
    autoPicked = true;
  }

  // 装之前先确认一遍。用户可能已经从别的终端装好了（向导开着的时候），
  // 也可能本来就装着、只是静态列表没探到 —— 这两种都别再装第二份。
  installSend("install:state", {
    phase: "checking",
    method: installMethod,
    label: INSTALL_METHODS[installMethod].label,
    cmd: "",
  });
  installSend("install:log", { stream: "sys", text: "先检查本机是否已安装…" });

  const existing = await ensureClaude();
  if (existing) {
    installSend("install:log", { stream: "ok", text: `已存在：${existing}` });
    installSend("install:state", { phase: "present", bin: existing });
    return;
  }

  if (autoPicked) {
    installSend("install:log", {
      stream: "sys",
      text:
        installMethod === "npm"
          ? `检测到 npm，装到应用私有目录：${runtimeDir()}`
          : "没装 npm，用官方脚本安装（会装到 ~/.local/bin）",
    });
  }
  installSend("install:log", { stream: "sys", text: "未检测到 claude，开始安装" });

  if (installProc) return;

  const m = INSTALL_METHODS[installMethod];
  const cmd = m.cmd();
  installSend("install:state", {
    phase: "running",
    method: installMethod,
    label: m.label,
    cmd,
  });
  installSend("install:log", { stream: "sys", text: `$ ${cmd}` });
  if (installMethod === "npm") {
    installSend("install:log", {
      stream: "sys",
      text: "不写全局 prefix、不改 shell profile，卸载时删掉这个目录即可",
    });
  }

  let proc;
  try {
    proc = spawn("/bin/bash", ["-lc", cmd], {
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    installSend("install:state", { phase: "error", message: `无法启动安装进程：${e.message}` });
    return;
  }
  installProc = proc;

  const timer = setTimeout(
    () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* 已经退出 */
      }
      installSend("install:log", { stream: "err", text: "超过 10 分钟未完成，已终止" });
    },
    10 * 60 * 1000,
  );

  const pipe = (stream) => (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      // npm 把下载进度（npm http …）写到 stderr，这不是错误，别标红吓人
      const progress = /^npm (http|warn) /.test(line);
      installSend("install:log", { stream: progress ? "out" : stream, text: line });
    }
  };
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", pipe("out"));
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", pipe("err"));

  proc.on("error", (e) => {
    clearTimeout(timer);
    installProc = null;
    installSend("install:state", { phase: "error", message: `安装进程启动失败：${e.message}` });
  });

  proc.on("close", async (code) => {
    clearTimeout(timer);
    installProc = null;

    // 不信任退出码，只认磁盘上真的有没有：curl | bash 会在权限/网络问题下
    // 中途放弃却仍然返回 0。私有运行时同理 —— npm 可能只铺了一半。
    let bin = rescanClaudeBin() || (await ensureClaude());

    if (bin) {
      installSend("install:log", { stream: "ok", text: `找到 claude：${bin}` });
      if (installMethod === "npm") {
        installSend("install:log", {
          stream: "sys",
          text: `私有运行时：${runtimeDir()}（删掉这个目录就等于卸载）`,
        });
      }
      installSend("install:state", { phase: "success", bin });
      return;
    }

    // 走到了这里说明磁盘上确实没有可用的 claude。区分几种失败原因，
    // 别让用户对着「退出码 0」发懵。
    let message;
    if (installMethod === "npm") {
      const link = path.join(runtimeDir(), "node_modules", ".bin", "claude");
      if (fs.existsSync(link)) {
        message =
          "依赖下载了，但原生二进制没铺开（postinstall 没跑成）。\n" +
          `手动补一下：node ${path.join(runtimeDir(), "node_modules/@anthropic-ai/claude-code/install.cjs")}`;
      } else {
        message =
          code === 0
            ? "命令已执行完，但私有运行时里没有 claude"
            : `安装退出码 ${code}（详情见上方日志）`;
      }
    } else {
      message =
        code === 0 ? "命令已执行完，但仍没找到 claude 可执行文件" : `安装退出码 ${code}`;
    }
    installSend("install:state", { phase: "error", message });
  });
}

/** 启动自检：claude 不存在时给出明确指引，避免每条消息都静默失败 */
async function warnIfClaudeMissing() {
  // 先问一次登录 shell 再决定要不要报缺：装在版本管理器里的 claude
  // 静态列表看不到，但不代表本机没有 —— 这种情况不该提示用户去装
  if (await ensureClaude()) return;

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "找不到 claude",
    message: "Claude Buddy 需要 Claude Code CLI 才能工作",
    detail:
      "已检查常见安装位置，也问过你的登录 shell，都没有找到 claude。\n\n" +
      "可以让它自动安装（约 260MB 下载，视网络情况需要几分钟）：\n" +
      `有 npm 就装进应用私有目录（${runtimeDir()}），不污染系统；\n` +
      "没有 npm 才用官方脚本（装到 ~/.local/bin）。\n\n" +
      "也可以自己装：\n" +
      "  npm install -g @anthropic-ai/claude-code\n" +
      "  curl -fsSL https://claude.ai/install.sh | bash",
    buttons: ["自动安装", "手动安装说明", "稍后"],
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 0) openInstaller();
  else if (response === 1) shell.openExternal("https://claude.com/claude-code");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  loadStore();
  buildMenu();

  ipcMain.handle("app:init", () => ({
    sessions: store.sessions.map((s) => ({
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
      totals: s.totals,
    })),
    activeId: store.activeId,
    config: store.config,
    tasks: store.tasks.map(taskView),
    permissionModes: PERMISSION_MODES,
    platform: process.platform,
    claudeBin: CLAUDE_BIN,
  }));

  /* ---------------- 定时任务 ---------------- */

  ipcMain.handle("task:list", () => store.tasks.map(taskView));

  ipcMain.handle("task:save", (_e, input) => {
    if (!input || !String(input.prompt || "").trim()) {
      return { ok: false, error: "提示词不能为空" };
    }
    const existing = input.id ? getTask(input.id) : null;
    const t = normalizeTask(input, existing);
    if (!existing) store.tasks.push(t);
    saveStore();
    emitTasks();
    return { ok: true, task: taskView(t) };
  });

  ipcMain.handle("task:delete", (_e, id) => {
    const t = getTask(id);
    if (t && t.sessionId) {
      const r = runners.get(t.sessionId);
      if (r) {
        try {
          r.proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        runners.delete(t.sessionId);
      }
      pendingTaskRuns.delete(t.sessionId);
    }
    store.tasks = store.tasks.filter((x) => x.id !== id);
    runningTasks.delete(id);
    saveStore();
    emitTasks();
    return true;
  });

  ipcMain.handle("task:toggle", (_e, { id, enabled }) => {
    const t = getTask(id);
    if (!t) return { ok: false };
    t.enabled = !!enabled;
    if (t.enabled) t.nextRunAt = computeNext(t, Date.now());
    saveStore();
    emitTasks();
    return { ok: true, task: taskView(t) };
  });

  ipcMain.handle("task:run", async (_e, id) => {
    const t = getTask(id);
    if (!t) return { ok: false, error: "任务不存在" };
    return runTask(t, "manual");
  });

  ipcMain.handle("task:stop", (_e, id) => {
    const t = getTask(id);
    if (!t || !t.sessionId) return { ok: false };
    killRunner(t.sessionId);
    if (pendingTaskRuns.has(t.sessionId)) {
      finishTaskRun(t.sessionId, { ok: false, error: "已手动停止" });
    }
    return { ok: true };
  });

  ipcMain.handle("session:new", (_e, cwd) => {
    const s = createSession(cwd);
    return {
      id: s.id,
      title: s.title,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
      totals: s.totals,
    };
  });

  ipcMain.handle("session:load", (_e, id) => {
    const s = getSession(id);
    if (!s) return null;
    store.activeId = id;
    saveStore();
    return s;
  });

  ipcMain.handle("session:delete", (_e, id) => {
    const r = runners.get(id);
    if (r) {
      try {
        r.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      runners.delete(id);
    }
    store.sessions = store.sessions.filter((s) => s.id !== id);
    if (store.activeId === id) store.activeId = store.sessions[0]?.id || null;
    saveStore();
    // 会话删了，附件也别留着占 260MB 的带宽
    try {
      fs.rmSync(attachmentsDir(id), { recursive: true, force: true });
    } catch {
      /* 没附件目录就算了 */
    }
    return true;
  });

  ipcMain.handle("session:send", async (_e, { id, text, attachments }) => {
    const s = getSession(id);
    if (!s) return { ok: false, error: "会话不存在" };
    const r = await sendMessage(s, text, attachments);
    // 首条消息会顺手把标题定下来，回传给渲染层，标题栏不用等下次重开
    return { ...r, title: s.title };
  });

  /* ---------------- 附件 ---------------- */

  ipcMain.handle("file:pick", async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "选择要发给它的文件",
      properties: ["openFile", "multiSelections"],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle("attachment:import", (_e, { sessionId, paths }) => {
    if (!getSession(sessionId)) return [];
    return importAttachments(sessionId, paths);
  });

  ipcMain.handle("attachment:saveDataUrl", (_e, { sessionId, name, dataUrl }) => {
    if (!getSession(sessionId)) return { error: "会话不存在" };
    return saveDataUrl(sessionId, name, dataUrl);
  });

  ipcMain.handle("file:preview", (_e, { path: p, sessionId }) => previewFile(p, sessionId));

  // 暂存阶段读缩略图：路径来自用户自己拖进来/选的文件，还没进会话目录，
  // 所以不受「工作目录内」限制，但只回图片，不回文本。
  ipcMain.handle("attachment:thumb", (_e, p) => {
    try {
      const st = fs.statSync(p);
      const mediaType = IMAGE_TYPES.get(path.extname(p).toLowerCase());
      if (!mediaType || !st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
      return {
        dataUrl: `data:${mediaType};base64,${fs.readFileSync(p).toString("base64")}`,
        size: st.size,
      };
    } catch {
      return null;
    }
  });

  /* ---------------- 会话搜索 ---------------- */

  ipcMain.handle("session:search", (_e, q) => {
    const kw = String(q || "").trim().toLowerCase();
    if (!kw) return [];
    const hits = [];
    for (const s of store.sessions) {
      const title = String(s.title || "");
      const titleHit = title.toLowerCase().includes(kw);
      let snippet = "";
      let at = s.updatedAt || 0;
      // 倒序找最近一条命中的消息
      for (let i = (s.messages || []).length - 1; i >= 0; i--) {
        const m = s.messages[i];
        const t = String(m.text || "");
        const idx = t.toLowerCase().indexOf(kw);
        if (idx >= 0) {
          const from = Math.max(0, idx - 30);
          snippet = (from > 0 ? "…" : "") + t.slice(from, idx + kw.length + 50).replace(/\n/g, " ");
          at = m.at || at;
          break;
        }
      }
      if (titleHit || snippet) {
        hits.push({ id: s.id, title: title || "新对话", snippet, at, cwd: s.cwd });
      }
      if (hits.length >= 50) break;
    }
    return hits.sort((a, b) => b.at - a.at);
  });

  ipcMain.handle("session:stop", (_e, id) => {
    const r = runners.get(id);
    if (r) {
      try {
        r.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      runners.delete(id);
    }
    return true;
  });

  ipcMain.handle("config:update", (_e, patch) => {
    store.config = { ...store.config, ...patch };
    saveStore();
    // 配置变了，重启活跃进程以生效
    const active = getSession(store.activeId);
    if (active) {
      const r = runners.get(active.id);
      if (r) {
        try {
          r.proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        runners.delete(active.id);
      }
    }
    return store.config;
  });

  ipcMain.handle("dialog:pickDir", async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: store.config.cwd,
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle("shell:openPath", (_e, p) => shell.openPath(p));

  /* ---------------- 安装向导 ---------------- */

  ipcMain.handle("install:start", (_e, method) => {
    startInstall(method);
    return true;
  });

  ipcMain.handle("install:close", () => {
    if (installWin && !installWin.isDestroyed()) installWin.close();
  });

  ipcMain.handle("install:docs", () => shell.openExternal("https://github.com/SingleTime/claude-buddy"));

  ipcMain.handle("install:recheck", () => ({ bin: rescanClaudeBin() }));

  createWindow();
  startScheduler();
  warnIfClaudeMissing();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  killAllRunners();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  clearInterval(tickTimer);
  for (const pend of pendingTaskRuns.values()) if (pend.timer) clearTimeout(pend.timer);
  killAllRunners();
});
