/**
 * 后台守护：用 launchd 让定时任务在应用没开的时候也能跑。
 *
 * 为什么是 LaunchAgent 而不是常驻进程：
 *   - 应用没开的时候没人能起进程，只有 launchd 会在登录后一直活着
 *   - StartInterval=60 让它每分钟拉一次执行器，没有到点的任务就直接退出，
 *     不会留一个常驻内存的 daemon
 *
 * 写在 ~/Library/LaunchAgents/，属于用户级、可一键卸载，不碰 /Library。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const LABEL = "com.claudebuddy.tasks";

function plistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPlist({ execPath, runnerPath, logPath, errPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(execPath)}</string>
    <string>${xmlEscape(runnerPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errPath || logPath)}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  try {
    return {
      ok: true,
      out: execFileSync("/bin/launchctl", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      }),
    };
  } catch (e) {
    return {
      ok: false,
      out: `${e.stdout || ""}${e.stderr || ""}`.trim() || e.message,
    };
  }
}

function domain() {
  return `gui/${process.getuid()}`;
}

/** 已装 = plist 在；已加载 = launchctl 里能看到这个 label */
function status() {
  const p = plistPath();
  const installed = fs.existsSync(p);
  let loaded = false;
  if (installed) {
    const r = launchctl("list", LABEL);
    loaded = r.ok && r.out.includes(LABEL);
  }
  return { installed, loaded, plistPath: p, label: LABEL, execPath: readExecPath() };
}

function envValue(xml, key) {
  // 只用来读回自己写的那两个值，不需要通用 XML 解析
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  const m = re.exec(xml);
  return m ? m[1] : "";
}

function readExecPath() {
  try {
    const xml = fs.readFileSync(plistPath(), "utf8");
    const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
    if (!argsBlock) return "";
    const items = [...argsBlock[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    return items[0] || "";
  } catch {
    return "";
  }
}

function readRunnerPath() {
  try {
    const xml = fs.readFileSync(plistPath(), "utf8");
    const argsBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
    if (!argsBlock) return "";
    const items = [...argsBlock[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    return items[1] || "";
  } catch {
    return "";
  }
}

let lastError = "";

/**
 * 安装（幂等）。
 *
 * 每次装都先 bootout 再 bootstrap：launchd 不允许同 label 重复加载，
 * 直接 bootstrap 会报 "service already loaded"。
 */
function install({ execPath, runnerPath, logPath, errPath }) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "后台守护目前只支持 macOS" };
  }
  if (!execPath || !runnerPath) {
    return { ok: false, error: "缺少执行路径" };
  }
  if (!fs.existsSync(runnerPath)) {
    return { ok: false, error: `找不到后台执行器：${runnerPath}` };
  }

  const p = plistPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(p, buildPlist({ execPath, runnerPath, logPath, errPath }), "utf8");
  } catch (e) {
    lastError = `写入 plist 失败：${e.message}`;
    return { ok: false, error: lastError };
  }

  // 先卸掉旧的（可能不存在，失败无所谓）
  launchctl("bootout", `${domain()}/${LABEL}`);

  let r = launchctl("bootstrap", domain(), p);
  if (!r.ok) {
    // 老系统（< 10.13）没有 bootstrap 子命令
    r = launchctl("load", "-w", p);
  }
  if (!r.ok) {
    // 权限/目录异常时的最后一条路；上面两条任意一条成功就不会走到这里
    lastError = `launchctl 拒绝加载：${r.out.slice(0, 300)}`;
    return { ok: false, error: lastError, plistPath: p };
  }

  lastError = "";
  return { ok: true, ...status() };
}

function uninstall() {
  if (process.platform !== "darwin") return { ok: false, error: "仅支持 macOS" };
  const p = plistPath();
  launchctl("bootout", `${domain()}/${LABEL}`);
  launchctl("unload", "-w", p); // 老系统兜底，失败忽略
  try {
    fs.unlinkSync(p);
  } catch {
    /* 本来就没有 */
  }
  return { ok: true, ...status() };
}

/**
 * plist 里的可执行路径会随应用被移动而失效（/Applications → 别处，或者换台机器）。
 * 应用每次启动时对一遍，不一致就重写。
 */
function needsRewrite({ execPath, runnerPath }) {
  if (!fs.existsSync(plistPath())) return false;
  return readExecPath() !== execPath || readRunnerPath() !== runnerPath;
}

function lastErrorText() {
  return lastError;
}

module.exports = {
  LABEL,
  plistPath,
  status,
  install,
  uninstall,
  needsRewrite,
  buildPlist,
  lastErrorText,
};
