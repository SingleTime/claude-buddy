#!/usr/bin/env node
/**
 * Claude Buddy 后台执行器（无窗口）
 *
 * launchd 每分钟拉起一次，做的事很少：
 *   1. 拿调度锁（拿不到说明应用开着，它自己会调度，直接退出）
 *   2. 读到点的任务，串行跑完
 *   3. 原子写回 sessions.json
 *
 * 纯 node 内置模块，不 require electron —— launchd 里没有 GUI 环境，
 * 打包后靠 `ELECTRON_RUN_AS_NODE=1 <app 可执行文件> runner.js` 跑起来。
 *
 * 为什么不是常驻 daemon：常驻进程要和应用抢同一份 sessions.json，两边同时写
 * 必然丢数据。改成「用完就退 + 锁互斥」，任何时刻只有一个调度者在写盘。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { computeNext, dueState, MISS_LIMIT_MS, TASK_TIMEOUT_MS } = require("./lib/schedule");
const claudeBin = require("./lib/claude-bin");

const MAX_RUNS_KEPT = 200;
const LOG_MAX_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 路径：必须与 Electron 的 app.getPath("userData") 一致               */
/* ------------------------------------------------------------------ */

function userDataDir() {
  const override = process.env.CLAUDE_BUDDY_USER_DATA;
  if (override) return path.resolve(override);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude Buddy");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude Buddy");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude Buddy");
}

const DATA_DIR = userDataDir();
const STORE_PATH = path.join(DATA_DIR, "sessions.json");
const LOCK_PATH = path.join(DATA_DIR, "scheduler.lock");
const LOG_PATH = path.join(DATA_DIR, "logs", "runner.log");
const ERR_PATH = path.join(DATA_DIR, "logs", "runner.err");

/** 与主进程 runtimeDir() 对齐：打包后是 userData/runtime */
function runtimeDir() {
  return path.join(DATA_DIR, "runtime");
}

function attachmentsDir(sessionId) {
  return path.join(DATA_DIR, "attachments", String(sessionId));
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const log = (...a) => {
  const t = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${t}]`, ...a);
};

/**
 * 日志文件别无限涨：截断而不是删除，launchd 打开的 fd 才不会失效。
 *
 * runner.err 单独存是为了隔离 Electron 每次启动都会扔的那条
 * 「task_name_for_pid: (os/kern) failure (5)」—— 未签名二进制在 launchd 下
 * 拿不到进程名的正常现象，混在主日志里会把真正的错误埋掉。
 */
function trimLog() {
  for (const f of [LOG_PATH, ERR_PATH]) {
    try {
      if (fs.statSync(f).size > LOG_MAX_BYTES) fs.truncateSync(f, 0);
    } catch {
      /* 还没生成 */
    }
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 存在但没权限（不是自己的进程）
  }
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 拿调度锁。wx 是原子的：两个 runner 同时起也只有一个能创建成功。
 *
 * 陈旧锁（进程已死）自动清掉 —— 应用崩溃或被强杀时锁会残留在磁盘上，
 * 不清的话后台就再也不干活了，这种"静默失效"最难查。
 */
function acquireLock() {
  for (let i = 0; i < 3; i++) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        LOCK_PATH,
        JSON.stringify({ pid: process.pid, kind: "headless", at: Date.now() }),
        { flag: "wx" },
      );
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") {
        log("锁创建失败:", e.message);
        return false;
      }
      const cur = readLock();
      if (cur && pidAlive(cur.pid)) return false;
      try {
        fs.unlinkSync(LOCK_PATH);
      } catch {
        /* 别人先删了 */
      }
    }
  }
  return false;
}

function releaseLock() {
  const cur = readLock();
  if (cur && cur.pid === process.pid) {
    try {
      fs.unlinkSync(LOCK_PATH);
    } catch {
      /* ignore */
    }
  }
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    log("sessions.json 解析失败:", e.message);
    return null;
  }
}

/** 原子写：先写临时文件再 rename，写到一半断电也不会留半截 JSON */
function writeStore(store) {
  const tmp = `${STORE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, STORE_PATH);
}

/* ------------------------------------------------------------------ */
/* 执行一个任务                                                        */
/* ------------------------------------------------------------------ */

function newId() {
  return crypto.randomUUID();
}

function normalizeTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    input: t.input,
    result: t.result || "",
    isError: !!t.isError,
  }));
}

/**
 * -p + stream-json 起一个干净上下文跑完这个任务。
 * 不 resume：定时任务每轮独立，累积上下文会让 token 成本指数上涨。
 */
/** 还活着的 claude 子进程：退出前要清干净，别留孤儿进程 */
const liveProcs = new Set();

function execTask(session, task) {
  return new Promise((resolve) => {
    const mode = ["default", "acceptEdits", "plan", "bypassPermissions"].includes(task.permissionMode)
      ? task.permissionMode
      : "acceptEdits";

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      mode,
    ];
    if (task.model) args.push("--model", task.model);

    const allowed = String(task.allowedTools || "")
      .replace(/\s+/g, "")
      .replace(/,+/g, ",")
      .trim();
    if (allowed && allowed !== ",") args.push("--allowedTools", allowed);

    // 附件在 cwd 之外，不显式授权的话 Read 会被拦（headless 没人能点「允许」）
    const attDir = attachmentsDir(session.id);
    try {
      fs.mkdirSync(attDir, { recursive: true });
      args.push("--add-dir", attDir);
    } catch {
      /* 建不出来就算了 */
    }

    const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();

    let proc;
    try {
      proc = spawn(CLAUDE_BIN, args, {
        cwd,
        env: claudeBin.childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ ok: false, error: `无法启动 claude：${e.message}` });
    }
    liveProcs.add(proc);
    proc.on("close", () => liveProcs.delete(proc));

    let buf = "";
    let stderr = "";
    let text = "";
    let finalText = null;
    let cost = 0;
    let isError = false;
    let stopReason = null;
    let gotResult = false;
    const tools = [];
    const byId = new Map();
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* 已经退出 */
          }
        }, 5000);
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        text: text || finalText || "",
        tools: normalizeTools(tools),
        error: `运行超时（>${TASK_TIMEOUT_MS / 60000} 分钟）`,
      });
    }, TASK_TIMEOUT_MS);

    const onLine = (line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }

      if (e.type === "assistant" && e.message) {
        for (const block of e.message.content || []) {
          if (block.type === "text" && block.text) text += block.text;
          if (block.type === "tool_use") {
            const rec = { name: block.name, input: block.input, result: "", isError: false };
            tools.push(rec);
            byId.set(block.id, rec);
          }
        }
        return;
      }

      if (e.type === "user" && e.message) {
        for (const block of e.message.content || []) {
          if (block.type !== "tool_result") continue;
          const rec = byId.get(block.tool_use_id);
          if (!rec) continue;
          const c = block.content;
          rec.result = (
            typeof c === "string"
              ? c
              : Array.isArray(c)
                ? c.map((x) => (typeof x === "string" ? x : x?.text || JSON.stringify(x))).join("\n")
                : JSON.stringify(c ?? "")
          ).slice(0, 6000);
          rec.isError = !!block.is_error;
        }
        return;
      }

      if (e.type === "result") {
        gotResult = true;
        cost = e.total_cost_usd || 0;
        isError = !!e.is_error;
        stopReason = e.stop_reason || null;
        if (typeof e.result === "string" && e.result.trim()) finalText = e.result;
        if (e.session_id && !session.sessionId) session.sessionId = e.session_id;

        // result 是这一轮最后一个事件，必须在这里收口。
        // 不能等 close：stdin 是我们保持打开的（照着常驻会话的写法），
        // claude 读到 result 之后会继续等下一条消息，永远不退出 ——
        // 表现出来就是任务一直「正在运行」，直到 10 分钟超时才报错。
        try {
          proc.stdin.end(); // 发 EOF，让它自己体面退出
        } catch {
          /* 已经关了 */
        }
        const killer = setTimeout(() => {
          try {
            proc.kill("SIGTERM");
          } catch {
            /* ignore */
          }
        }, 3000);
        if (killer.unref) killer.unref();

        finish({
          ok: !isError,
          text: (finalText || text).trim(),
          tools: normalizeTools(tools),
          cost,
          error: isError ? stopReason || "模型返回错误" : null,
        });
        return;
      }
    };

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) onLine(line);
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c) => {
      stderr += c;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    proc.on("error", (e) => {
      finish({ ok: false, text, tools: normalizeTools(tools), error: `子进程错误：${e.message}` });
    });

    proc.on("close", (code, signal) => {
      const outText = (finalText || text).trim();
      if (gotResult) {
        return finish({
          ok: !isError,
          text: outText,
          tools: normalizeTools(tools),
          cost,
          error: isError ? stopReason || "模型返回错误" : null,
        });
      }
      // 没等到 result 就退出：stderr 才是原因，别拿「退出码 0」糊弄过去
      finish({
        ok: false,
        text: outText,
        tools: normalizeTools(tools),
        cost,
        error:
          stderr.trim().slice(0, 500) ||
          `子进程退出但没返回结果（code=${code}, signal=${signal}）`,
      });
    });

    try {
      proc.stdin.write(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: task.prompt }] },
        }) + "\n",
      );
    } catch (e) {
      finish({ ok: false, text: "", tools: [], error: `写入失败：${e.message}` });
    }
  });
}

/* ------------------------------------------------------------------ */
/* 跑一个到期任务                                                      */
/* ------------------------------------------------------------------ */

function taskSession(store, task) {
  let session = task.sessionId ? (store.sessions || []).find((s) => s.id === task.sessionId) : null;
  if (!session) {
    session = {
      id: newId(),
      sessionId: null,
      title: "⏱ " + task.name,
      kind: "task",
      cwd: task.cwd || store.config?.cwd || os.homedir(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      totals: { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0 },
    };
    store.sessions = store.sessions || [];
    store.sessions.unshift(session);
    task.sessionId = session.id;
  }
  session.cwd = task.cwd && fs.existsSync(task.cwd) ? task.cwd : os.homedir();
  return session;
}

const PERM_HINT = /未获授权|权限提示|权限尚未|待批准|需要批准|permission denied|not granted/i;
const MISSING_HINT = /工具不存在|没有.{0,8}这个工具|未配置|未接入|没有连接|没有.{0,4}可用.{0,4}工具/i;

function hintFor(excerpt) {
  if (PERM_HINT.test(excerpt)) return "响应里提到了权限/批准，工具被拦截了。补全工具白名单后重试。";
  if (MISSING_HINT.test(excerpt)) return "模型说找不到工具，多半是 MCP 冷启动超时。重跑一次，仍失败就检查 MCP 是否 Connected。";
  return null;
}

async function runOne(store, task, now) {
  const session = taskSession(store, task);
  const runId = newId().slice(0, 8);
  const startedAt = Date.now();

  session.messages.push({
    role: "user",
    text: task.prompt,
    at: startedAt,
    viaTask: { taskId: task.id, runId, trigger: "schedule" },
  });
  session.updatedAt = startedAt;

  // 先推进下次时间再执行：中途崩溃也不会让同一个任务被反复触发
  task.lastStatus = "running";
  task.nextRunAt = computeNext(task, now);
  task.lastError = null;
  writeStore(store);

  log(`跑任务「${task.name}」run=${runId}`);
  const outcome = await execTask(session, task);

  const excerpt = (outcome.text || "").trim().slice(0, 200);
  session.messages.push({
    role: "assistant",
    text: outcome.text || "",
    tools: outcome.tools || [],
    at: Date.now(),
    viaTask: { taskId: task.id, runId },
  });
  session.updatedAt = Date.now();
  if (outcome.cost) {
    session.totals.cost += outcome.cost;
  }

  task.lastRunAt = startedAt;
  task.lastStatus = outcome.ok ? "ok" : "error";
  task.lastError = outcome.ok ? null : String(outcome.error || "未知错误").slice(0, 300);
  task.lastHint = outcome.ok ? hintFor(excerpt) : null;
  task.lastCost = outcome.cost || 0;
  task.runs = task.runs || [];
  task.runs.unshift({
    at: startedAt,
    finishedAt: Date.now(),
    runId,
    trigger: "schedule",
    status: task.lastStatus,
    cost: task.lastCost,
    error: task.lastError,
    excerpt,
    elapsedMs: Date.now() - startedAt,
  });
  task.runs = task.runs.slice(0, MAX_RUNS_KEPT);

  writeStore(store);
  log(
    `任务「${task.name}」${outcome.ok ? "成功" : "失败"}` +
      (outcome.error ? `：${outcome.error}` : "") +
      `（${Math.round((Date.now() - startedAt) / 1000)}s）`,
  );
  return outcome;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let CLAUDE_BIN = "";

/**
 * 收口时把还挂着的子进程请走。
 * 正常情况下 stdin.end() 之后它会自己退，这里只兜那 3 秒没退掉的。
 */
async function killStragglers() {
  if (!liveProcs.size) return;
  for (const p of liveProcs) {
    try {
      p.stdin.end();
    } catch {
      /* 已经关了 */
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
  for (const p of liveProcs) {
    try {
      p.kill("SIGTERM");
    } catch {
      /* 已经退了 */
    }
  }
  await new Promise((r) => setTimeout(r, 600));
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--doctor")) {
    CLAUDE_BIN = claudeBin.resolve({ runtimeDir: runtimeDir() });
    const store = readStore();
    const tasks = (store?.tasks || []).map((t) => ({
      name: t.name,
      enabled: !!t.enabled,
      nextRunAt: t.nextRunAt ? new Date(t.nextRunAt).toLocaleString("zh-CN") : null,
    }));
    console.log(
      JSON.stringify(
        {
          userDataDir: DATA_DIR,
          storeExists: fs.existsSync(STORE_PATH),
          claudeBin: CLAUDE_BIN,
          claudeReady: claudeBin.ready(CLAUDE_BIN),
          lock: readLock(),
          tasks,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!fs.existsSync(STORE_PATH)) return 0;

  if (!acquireLock()) {
    // 应用开着（或上一个 runner 还在跑），让路
    return 0;
  }

  try {
    const store = readStore();
    if (!store) return 0;

    const now = Date.now();
    const due = [];
    let dirty = false;

    for (const t of store.tasks || []) {
      const st = dueState(t, now);
      if (st.nextRunAt) {
        t.nextRunAt = st.nextRunAt;
        dirty = true;
      }
      if (!st.run) continue;
      if (now - (st.scheduledFor || now) > MISS_LIMIT_MS) {
        t.runs = t.runs || [];
        t.runs.unshift({
          at: now,
          runId: "-",
          trigger: "skip",
          status: "skipped",
          error: `错过超过 6 小时（原定 ${new Date(st.scheduledFor).toLocaleString("zh-CN")}），已跳过`,
          cost: 0,
        });
        t.runs = t.runs.slice(0, MAX_RUNS_KEPT);
        dirty = true;
        continue;
      }
      due.push(t);
    }

    if (!due.length) {
      if (dirty) writeStore(store);
      return 0;
    }

    // 任务要跑之前才去解析 claude：没任务的时候不做无用功
    CLAUDE_BIN = claudeBin.resolve({ runtimeDir: runtimeDir() });
    if (!claudeBin.ready(CLAUDE_BIN)) {
      CLAUDE_BIN = (await claudeBin.ensure(CLAUDE_BIN, runtimeDir())) || CLAUDE_BIN;
    }
    if (!claudeBin.ready(CLAUDE_BIN)) {
      for (const t of due) {
        t.lastStatus = "error";
        t.lastError = "找不到 claude 可执行文件";
        t.nextRunAt = computeNext(t, now);
      }
      writeStore(store);
      log("找不到 claude，全部跳过");
      return 1;
    }

    // 串行：并发跑多个任务会同时拉起多个 claude 进程，机器和额度都吃不消
    for (const t of due) {
      await runOne(store, t, Date.now());
    }
    return 0;
  } catch (e) {
    log("执行器异常:", e && e.stack ? e.stack : String(e));
    return 1;
  } finally {
    releaseLock();
  }
}

/* launchd 在关机/退出时会 SIGTERM：清掉锁再走，否则下次启动要等陈旧锁判定 */
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    releaseLock();
    process.exit(0);
  });
}

trimLog();
main().then(
  async (code) => {
    await killStragglers();
    process.exit(code || 0);
  },
  (e) => {
    log("未捕获异常:", e && e.stack ? e.stack : String(e));
    releaseLock();
    process.exit(1);
  },
);
