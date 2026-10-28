/**
 * 任务调度计算。
 *
 * 只有纯函数，不碰 fs / electron —— 主进程和 headless 执行器共用，
 * 免得两边各写一套「下次该什么时候跑」然后慢慢跑偏。
 */

/** 错过超过这个时长就不补跑，防止一开机连跑十几轮 */
const MISS_LIMIT_MS = 6 * 3600 * 1000;

/** 单次任务执行上限。主进程和后台执行器共用同一个值，否则「前台 15 分钟、后台 10 分钟」会让人以为任务随机失败 */
const TASK_TIMEOUT_MS = 15 * 60 * 1000;

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

/**
 * 现在该不该跑这个任务。
 *
 * 返回 { run, nextRunAt }：
 *   run=true  到点且没错过太久，去执行
 *   run=false 但 nextRunAt 变了，说明只是顺延/跳过，把新时间写回去就行
 */
function dueState(task, now) {
  if (!task || !task.enabled) return { run: false, nextRunAt: null };

  if (!task.nextRunAt) return { run: false, nextRunAt: computeNext(task, now) };
  if (now < task.nextRunAt) return { run: false, nextRunAt: null };

  const scheduledFor = task.nextRunAt;
  const lateBy = now - scheduledFor;
  return {
    run: lateBy <= MISS_LIMIT_MS,
    nextRunAt: computeNext(task, now),
    scheduledFor,
    lateBy,
  };
}

module.exports = { computeNext, dueState, MISS_LIMIT_MS, TASK_TIMEOUT_MS };
