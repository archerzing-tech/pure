// src/shared/taskRegistry.ts
// 后台任务登记表（execute_command background:true 的会话级账本）。
// 模块级单例——GUI 每回合重建 agent（冻结链判例），登记必须住在模块层才
// 跨回合存活；CLI 单进程同理。只登记、不托管：进程是脱离式启动的，这里
// 不持有句柄，kill 走各侧原语（CLI=process.kill，GUI=Rust kill_process）。
// 探活函数由调用方注入：WebView 里没有 process 对象，GUI 走 Rust
// process_alive command，CLI 直接信号零探活。

export interface TaskEntry {
  pid: number;
  command: string;
  logFile: string;
  startedAt: number;
}

export interface TaskView extends TaskEntry {
  alive: boolean;
}

const tasks = new Map<number, TaskEntry>();

export function registerTask(pid: number, command: string, logFile: string): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  tasks.set(pid, { pid, command, logFile, startedAt: Date.now() });
}

export function unregisterTask(pid: number): void {
  tasks.delete(pid);
}

/** 列出登记的任务并逐个探活（isAlive 注入——两侧原语不同）。 */
export async function listTasks(isAlive: (pid: number) => boolean | Promise<boolean>): Promise<TaskView[]> {
  const out: TaskView[] = [];
  for (const entry of tasks.values()) {
    let alive = false;
    try {
      alive = await isAlive(entry.pid);
    } catch {
      alive = false; // 探活失败按死算（宁可信其无，与 gateway 死活判定同一纪律）
    }
    if (!alive) tasks.delete(entry.pid); // 死任务顺手清账，下次不再占列表
    out.push({ ...entry, alive });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export function taskCount(): number {
  return tasks.size;
}

/** 测试清场：关死登记表重灌通道（persist 型单例判例）。 */
export function resetTasksForTests(): void {
  tasks.clear();
}
