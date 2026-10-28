#!/usr/bin/env node
/**
 * 开发期用 Chrome DevTools 协议操作正在运行的应用。
 *
 * 为什么需要它：验证界面改动时，靠截屏 + 猜坐标点击（osascript click at）
 * 既不可靠也看不出失败原因 —— 点歪了没有任何反馈，只能再截一张图比对。
 * CDP 能直接执行 JS、读 DOM、拿渲染后的文本，顺便还能精确截窗口。
 *
 * 前置：应用启动时带 --remote-debugging-port=9222
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --remote-debugging-port=9222
 *
 * 用法：
 *   node tools/cdp.js eval "document.title"
 *   node tools/cdp.js shot /tmp/app.png
 *   node tools/cdp.js click "#compactBtn"
 *   node tools/cdp.js text "[data-pane=mcp]"
 */

const PORT = Number(process.env.CDP_PORT || 9222);
const [, , cmd = "eval", arg = ""] = process.argv;

async function findTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === "page" && !/devtools/i.test(t.url));
  if (!page) throw new Error("没有找到页面 target（应用没开 remote debugging？）");
  return page;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiters = new Map();
    let seq = 0;
    ws.addEventListener("open", () =>
      resolve({
        send(method, params) {
          const id = ++seq;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            waiters.set(id, { res, rej });
            setTimeout(() => {
              if (waiters.has(id)) {
                waiters.delete(id);
                rej(new Error(`${method} 超时`));
              }
            }, 20000);
          });
        },
        close: () => ws.close(),
      }),
    );
    ws.addEventListener("error", (e) => reject(new Error(`连接失败: ${e.message || "unknown"}`)));
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const w = msg.id && waiters.get(msg.id);
      if (!w) return;
      waiters.delete(msg.id);
      if (msg.error) w.rej(new Error(msg.error.message));
      else w.res(msg.result);
    });
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description || d.text || "执行出错");
  }
  return r.result.value;
}

async function main() {
  const target = await findTarget();
  const cdp = await connect(target.webSocketDebuggerUrl);

  try {
    if (cmd === "eval") {
      const v = await evaluate(cdp, arg);
      console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    } else if (cmd === "click") {
      const ok = await evaluate(
        cdp,
        `(() => {
          const el = document.querySelector(${JSON.stringify(arg)});
          if (!el) return false;
          el.click();
          return true;
        })()`,
      );
      console.log(ok ? `clicked ${arg}` : `未找到 ${arg}`);
      if (!ok) process.exitCode = 1;
    } else if (cmd === "text") {
      const v = await evaluate(
        cdp,
        `(() => {
          const el = document.querySelector(${JSON.stringify(arg)});
          return el ? el.innerText : null;
        })()`,
      );
      console.log(v === null ? `未找到 ${arg}` : v);
      if (v === null) process.exitCode = 1;
    } else if (cmd === "shot") {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      const fs = require("node:fs");
      fs.writeFileSync(arg || "/tmp/cdp-shot.png", Buffer.from(data, "base64"));
      console.log(`saved ${arg || "/tmp/cdp-shot.png"}`);
    } else {
      console.error(`未知命令: ${cmd}（可用 eval / click / text / shot）`);
      process.exitCode = 2;
    }
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
