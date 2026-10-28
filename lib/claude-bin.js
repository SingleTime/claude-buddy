/**
 * 定位 claude 可执行文件。
 *
 * 主进程和 headless 执行器都要找 claude，而且必须找同一个：headless 是 launchd
 * 起的，环境比 GUI 更干净（PATH 只有系统目录），两份实现一旦漂移就会出现
 * 「应用里能跑、后台说不装 claude」这种最难查的故障。所以只留这一份。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** 单引号包裹，供只拼自家路径的 shell 命令使用 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 私有运行时里的 claude。
 *
 * postinstall 没跑（--ignore-scripts、--omit=optional）时，`.bin/claude` 指向的
 * 只是一个 500 字节的提示脚本；它虽然可执行，跑起来只会打印错误然后退出 1。
 * 所以不能只看存在与否 —— 真实的原生二进制有 260MB 以上，用体积区分。
 */
function runtimeClaudeBin(runtimeDir) {
  if (!runtimeDir) return null;
  const link = path.join(runtimeDir, "node_modules", ".bin", "claude");
  try {
    const real = fs.realpathSync(link);
    if (fs.statSync(real).size > 1024 * 1024) return link;
  } catch {
    /* 没装过 */
  }
  return null;
}

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

/**
 * 找 claude。
 *
 * 不能只靠 PATH：从 Finder / Dock（或者 launchd）起的进程拿不到 shell 的 PATH，
 * 通常只有 /usr/bin:/bin:/usr/sbin:/sbin，homebrew 装的会漏掉。
 *
 * 返回绝对路径；实在找不到返回 "claude"（交给 spawn 自己解析 PATH）。
 */
function resolve({ runtimeDir } = {}) {
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
  const own = runtimeClaudeBin(runtimeDir);
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

/** 是否真的定位到了可执行文件（裸名 "claude" 视为未找到） */
function ready(bin) {
  try {
    return !!bin && bin.includes(path.sep) && fs.existsSync(bin);
  } catch {
    return false;
  }
}

function safeUserShell() {
  try {
    const s = os.userInfo().shell;
    return s && fs.existsSync(s) ? s : "";
  } catch {
    return "";
  }
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

/**
 * 问一次用户的登录 shell：某个命令到底在哪。
 *
 * resolve() 查的是写死的位置列表 + 本进程的 PATH，而 launchd / GUI 进程的 PATH
 * 只有系统四目录。凡是靠版本管理器（nvm / fnm / asdf / volta）或自定义 PATH 装上
 * 的东西，静态列表都可能漏掉。漏掉时不能让用户再装一份，让登录 shell 自己报出来
 * （它会加载 .zshrc / .bash_profile 里的 PATH）。
 */
function probeViaShell(name) {
  return new Promise((resolvePath) => {
    const shell = process.env.SHELL || safeUserShell() || "/bin/bash";
    let settled = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolvePath(v);
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

/**
 * 确认 claude 是否可用：先看已解析的路径，再问一次登录 shell。
 * 找到就返回新的路径，否则 null。
 */
async function ensure(bin, runtimeDir) {
  if (ready(bin)) return bin;
  const found = await probeViaShell("claude");
  if (found) return found;
  return runtimeDir ? runtimeClaudeBin(runtimeDir) : null;
}

module.exports = {
  resolve,
  ready,
  ensure,
  probeViaShell,
  childEnv,
  shellQuote,
  runtimeClaudeBin,
  claudeCandidates,
  safeUserShell,
};
