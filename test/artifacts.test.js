/**
 * lib/artifacts.js 的单元测试。
 *
 * 这块逻辑出错的后果很隐蔽：产物面板会多出几个莫名其妙的老文件，或者漏掉
 * 真正产出的那个。两种都不会报错，只能靠测试把边界钉住。
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { snapshotTree, diffTree, SKIP_DIRS } = require("../lib/artifacts");

const snap = (entries) => ({ files: new Map(entries), truncated: false });

test("diffTree：新增 / 修改 / 未变", () => {
  const before = snap([
    ["/a/old.txt", 1000],
    ["/a/touched.txt", 1000],
    ["/a/same.txt", 1000],
  ]);
  const after = snap([
    ["/a/old.txt", 1000],
    ["/a/touched.txt", 2000],
    ["/a/same.txt", 1000],
    ["/a/new.txt", 3000],
  ]);
  const { added, changed } = diffTree(before, after);
  assert.deepStrictEqual(added, ["/a/new.txt"]);
  assert.deepStrictEqual(changed, ["/a/touched.txt"]);
});

test("diffTree：mtime 不变或倒退都不算修改", () => {
  const before = snap([["/a/x", 5000]]);
  // 倒退可能来自时钟回拨或恢复备份，不该报成"刚改过"
  assert.deepStrictEqual(diffTree(before, snap([["/a/x", 4000]])).changed, []);
  assert.deepStrictEqual(diffTree(before, snap([["/a/x", 5000]])).changed, []);
});

test("diffTree：1ms 容差，避免文件系统精度导致一直误报", () => {
  const before = snap([["/a/x", 1000]]);
  // 恰好 +1ms 属于精度抖动，不算改
  assert.deepStrictEqual(diffTree(before, snap([["/a/x", 1001]])).changed, []);
  // +2ms 才是真的写了
  assert.deepStrictEqual(diffTree(before, snap([["/a/x", 1002]])).changed, ["/a/x"]);
});

test("diffTree：删除的文件不报（面板只关心产出了什么）", () => {
  const before = snap([["/a/gone", 1000]]);
  const { added, changed } = diffTree(before, snap([]));
  assert.deepStrictEqual(added, []);
  assert.deepStrictEqual(changed, []);
});

test("diffTree：空快照对空快照", () => {
  const { added, changed } = diffTree(snap([]), snap([]));
  assert.deepStrictEqual(added, []);
  assert.deepStrictEqual(changed, []);
});

test("snapshotTree：真实目录里能扫到新写的文件", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-art-"));
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "1");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "2");

    const before = await snapshotTree(dir);
    assert.ok(before.files.has(path.join(dir, "a.txt")));
    assert.ok(before.files.has(path.join(dir, "sub", "b.txt")));
    assert.strictEqual(before.truncated, false);

    // 等 5ms 再写，保证 mtime 确实变大（同毫秒内写入在部分文件系统上无差异）
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(path.join(dir, "c.txt"), "3");
    const after = await snapshotTree(dir);

    const { added, changed } = diffTree(before, after);
    assert.deepStrictEqual(added, [path.join(dir, "c.txt")]);
    assert.deepStrictEqual(changed, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotTree：跳过 node_modules / .git 之类的目录", () => {
  // 断言这几个名字在集合里，防止有人"优化"时误删 —— 删掉的后果是
  // 每次扫大仓库都要遍历十几万个文件，然后因为预算耗尽直接截断
  for (const d of ["node_modules", ".git", "dist", "__pycache__"]) {
    assert.ok(SKIP_DIRS.has(d), `${d} 应该在跳过列表里`);
  }
});

test("snapshotTree：maxFiles 触顶时标记 truncated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-art2-"));
  try {
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
    const s = await snapshotTree(dir, { maxFiles: 3 });
    assert.strictEqual(s.truncated, true);
    assert.ok(s.files.size <= 3, `最多 3 个，实际 ${s.files.size}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshotTree：不存在的目录返回空快照而不是抛错", async () => {
  const s = await snapshotTree("/definitely/not/here/at/all");
  assert.strictEqual(s.files.size, 0);
  assert.strictEqual(s.truncated, false);
});
