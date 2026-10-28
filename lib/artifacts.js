/**
 * 产物识别：用文件系统快照对比出一轮里到底改了什么。
 *
 * 为什么不看工具调用：Write/Edit/MultiEdit/NotebookEdit 都带 file_path，
 * 但 `python gen.py`、`pytest --cov`、`prettier --write`、`cmd > out.txt`
 * 这些产生的文件没有任何工具参数能反映出来 —— 而它们恰恰是跑脚本类任务时
 * 最常见的产出。快照对比不看是谁写的，只看落没落盘。
 *
 * 代价是要扫目录，所以给了预算上限：宁可少报，不能为了产物面板让发送卡住。
 * 扫描是异步的（readdir + stat 都是 promise 版），几千个文件也不会把主进程
 * 的事件循环堵住 —— 同步 API 在这里就是一次肉眼可见的掉帧。
 */

const path = require("node:path");
const fs = require("node:fs");

/** 进去纯属浪费时间，也扫不出用户会关心的产物 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".claude-runtime",
  ".Trash",
]);

const SCAN_MAX_FILES = 8000;
const SCAN_MAX_DEPTH = 5;
const SCAN_BUDGET_MS = 400;

/**
 * 记一份 { files: Map<路径, mtimeMs>, truncated } 快照。
 *
 * truncated 表示因为文件数或时间预算提前收工。两次扫描都截断时，调用方应当
 * 放弃对比 —— 两次遍历顺序不完全一致，扫到的集合不同会被误判成"新增"，
 * 而误报比漏报更让人不信任这个面板。
 */
async function snapshotTree(
  root,
  { maxFiles = SCAN_MAX_FILES, maxDepth = SCAN_MAX_DEPTH, budget = SCAN_BUDGET_MS } = {},
) {
  const files = new Map();
  const out = { files, truncated: false };
  if (!root) return out;

  const deadline = Date.now() + budget;
  let count = 0;
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    if (count >= maxFiles || Date.now() > deadline) {
      out.truncated = true;
      break;
    }
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 权限不足 / 扫描途中被删
    }
    for (const ent of entries) {
      if (count >= maxFiles) {
        out.truncated = true;
        break;
      }
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth >= maxDepth || SKIP_DIRS.has(ent.name)) continue;
        stack.push({ dir: p, depth: depth + 1 });
      } else if (ent.isFile()) {
        try {
          const st = await fs.promises.stat(p);
          files.set(p, st.mtimeMs);
          count++;
        } catch {
          /* 同上 */
        }
      }
    }
  }
  return out;
}

/**
 * 前后两份快照的差。
 *
 * mtime 只往大走才算出变化，留 1ms 容差 —— 不同文件系统的时间精度不一样，
 * APFS 上是纳秒截断到毫秒，FAT/exFAT 上是 2 秒，用严格不等号会一直误报。
 */
function diffTree(before, after, tolerance = 1) {
  const added = [];
  const changed = [];
  for (const [p, m] of after.files) {
    const prev = before.files.get(p);
    if (prev === undefined) added.push(p);
    else if (m > prev + tolerance) changed.push(p);
  }
  return { added, changed };
}

module.exports = {
  snapshotTree,
  diffTree,
  SKIP_DIRS,
  SCAN_MAX_FILES,
  SCAN_MAX_DEPTH,
  SCAN_BUDGET_MS,
};
