/**
 * lib/schedule.js 的单元测试。
 *
 * 调度算错的表现是「任务莫名不跑」或「一开机连跑十几轮」，两者都很难
 * 从界面上看出来，所以「下次什么时候跑」必须由测试钉住。
 *
 * 全部用本地时间构造日期：computeNext 内部也是 setHours，两边口径一致，
 * CI runner 是 UTC 也不影响。
 *
 *   node --test test/
 */

const test = require("node:test");
const assert = require("node:assert");
const { computeNext, dueState, MISS_LIMIT_MS, TASK_TIMEOUT_MS } = require("../lib/schedule");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 2026-01-05 是周一 */
const MON_10 = new Date(2026, 0, 5, 10, 0, 0).getTime();

test("interval：严格 N 分钟，秒被抹掉", () => {
  const from = MON_10 + 37 * 1000; // 10:00:37
  const next = computeNext({ schedule: { type: "interval", everyMinutes: 30 } }, from);
  assert.strictEqual(new Date(next).getSeconds(), 0);
  assert.strictEqual(next - from, 30 * MIN - 37 * 1000);
});

test("interval：连续推十轮不累积漂移", () => {
  let from = MON_10;
  for (let i = 0; i < 10; i++) {
    const next = computeNext({ schedule: { type: "interval", everyMinutes: 7 } }, from);
    assert.strictEqual(next - from, 7 * MIN);
    from = next;
  }
});

test("interval：缺省 120 分钟，0 视同缺省，负数兜底到 1 分钟", () => {
  const every = (v) =>
    computeNext({ schedule: { type: "interval", everyMinutes: v } }, MON_10) - MON_10;

  // 0 是 falsy，走 `|| 120` 默认分支 —— 与「没填」等价，不是「每分钟」
  assert.strictEqual(every(0), 120 * MIN);
  assert.strictEqual(every(undefined), 120 * MIN);
  // Math.max(1, ...) 只对负数起作用
  assert.strictEqual(every(-5), 1 * MIN);
});

test("daily：当天时间未到 → 就在今天", () => {
  const next = computeNext({ schedule: { type: "daily", time: "18:30" } }, MON_10);
  assert.strictEqual(next, new Date(2026, 0, 5, 18, 30, 0).getTime());
});

test("daily：当天时间已过 → 顺延到明天", () => {
  const next = computeNext({ schedule: { type: "daily", time: "09:00" } }, MON_10);
  assert.strictEqual(next, new Date(2026, 0, 6, 9, 0, 0).getTime());
});

test("daily：时间正好等于 now 时顺延（不能原地打转）", () => {
  const from = new Date(2026, 0, 5, 9, 0, 0).getTime();
  const next = computeNext({ schedule: { type: "daily", time: "09:00" } }, from);
  assert.strictEqual(next, from + DAY);
  assert.ok(next > from, "下次必须严格大于 now，否则调度器会立刻再跑一次");
});

test("weekly：命中今天之后的第一个选中日", () => {
  // 周一 10:00 起，选周三
  const next = computeNext({ schedule: { type: "weekly", days: [3], time: "08:00" } }, MON_10);
  assert.strictEqual(next, new Date(2026, 0, 7, 8, 0, 0).getTime());
});

test("weekly：今天就是选中日但已过点 → 下一周同一天", () => {
  // 周一 10:00 起，选周一 09:00
  const next = computeNext({ schedule: { type: "weekly", days: [1], time: "09:00" } }, MON_10);
  assert.strictEqual(next, new Date(2026, 0, 12, 9, 0, 0).getTime());
});

test("weekly：空/非法 days 退回周一而不是永不触发", () => {
  const a = computeNext({ schedule: { type: "weekly", days: [], time: "09:00" } }, MON_10);
  const b = computeNext({ schedule: { type: "weekly", days: [99, -1], time: "09:00" } }, MON_10);
  const expected = new Date(2026, 0, 12, 9, 0, 0).getTime();
  assert.strictEqual(a, expected);
  assert.strictEqual(b, expected);
});

test("dueState：未启用的任务永不运行", () => {
  const s = dueState({ enabled: false, nextRunAt: MON_10 }, MON_10);
  assert.deepStrictEqual(s, { run: false, nextRunAt: null });
});

test("dueState：首次见到任务只算下次时间，不立刻跑", () => {
  const s = dueState(
    { enabled: true, schedule: { type: "daily", time: "18:00" } },
    MON_10,
  );
  assert.strictEqual(s.run, false);
  assert.strictEqual(s.nextRunAt, new Date(2026, 0, 5, 18, 0, 0).getTime());
});

test("dueState：还没到点 → 不动 nextRunAt", () => {
  const s = dueState(
    { enabled: true, nextRunAt: MON_10 + HOUR, schedule: { type: "daily", time: "11:00" } },
    MON_10,
  );
  assert.strictEqual(s.run, false);
  assert.strictEqual(s.nextRunAt, null);
});

test("dueState：到点就运行，并推进下次时间", () => {
  const s = dueState(
    { enabled: true, nextRunAt: MON_10, schedule: { type: "daily", time: "10:00" } },
    MON_10 + 5 * 1000,
  );
  assert.strictEqual(s.run, true);
  assert.strictEqual(s.scheduledFor, MON_10);
  assert.strictEqual(s.lateBy, 5 * 1000);
  assert.ok(s.nextRunAt > MON_10, "下次时间必须推进，否则同一任务会被反复触发");
});

test("dueState：错过刚好 6 小时仍运行，超过则跳过但推进时间", () => {
  const task = { enabled: true, nextRunAt: MON_10, schedule: { type: "daily", time: "10:00" } };

  const atLimit = dueState(task, MON_10 + MISS_LIMIT_MS);
  assert.strictEqual(atLimit.run, true, "边界值算在容忍范围内");

  const beyond = dueState(task, MON_10 + MISS_LIMIT_MS + 1000);
  assert.strictEqual(beyond.run, false, "超过 6 小时不补跑，否则一开机连跑十几轮");
  assert.ok(beyond.nextRunAt > MON_10, "跳过时也必须推进时间，不然下一轮还是它");
});

test("超时常量与 15 分钟一致（前台与后台必须同值）", () => {
  assert.strictEqual(TASK_TIMEOUT_MS, 15 * 60 * 1000);
  assert.ok(MISS_LIMIT_MS > TASK_TIMEOUT_MS, "容忍窗口要比单次超时长，否则长任务会被自己判成过期");
});
