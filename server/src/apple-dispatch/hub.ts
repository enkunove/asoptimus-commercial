// @aso/server/apple-dispatch — реестр живых клиент-коннектов (WSS) + маршрутизация
// job.result → ожидающему промису. Один инстанс Фазы 1 → sticky-WS не нужен (BUILD-PLAN §5).

import type { ServerToClient, JobResult } from "@aso/shared";

export interface ClientConnection {
  userId: string;
  deviceFp: string;
  send(msg: ServerToClient): void;
}

interface Pending {
  resolve: (r: JobResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ClientHub {
  /** userId → соединение (последнее победило; реконнект перекрывает). */
  private conns = new Map<string, ClientConnection>();
  /** job_id → ожидающий диспатч. */
  private pending = new Map<string, Pending>();

  register(conn: ClientConnection) {
    this.conns.set(conn.userId, conn);
  }

  unregister(userId: string) {
    this.conns.delete(userId);
    // Живого клиента нет → все ожидающие джобы обрываются (D7: fetch невозможен → paused).
    for (const [jobId, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ClientGoneError());
      this.pending.delete(jobId);
    }
  }

  hasClient(userId: string): boolean {
    return this.conns.has(userId);
  }

  /** Отправить job.dispatch и ждать job.result по job_id (таймаут → reject). */
  dispatchJob(userId: string, jobId: string, msg: ServerToClient, timeoutMs = 120_000): Promise<JobResult> {
    const conn = this.conns.get(userId);
    if (!conn) return Promise.reject(new ClientGoneError());
    return new Promise<JobResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        reject(new Error(`job ${jobId} timeout`));
      }, timeoutMs);
      this.pending.set(jobId, { resolve, reject, timer });
      conn.send(msg);
    });
  }

  /** Клиент вернул результат джобы. */
  resolveJob(result: JobResult) {
    const p = this.pending.get(result.job_id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(result.job_id);
    p.resolve(result);
  }

  /** Клиент сообщил об ошибке джобы. */
  rejectJob(jobId: string, reason: string, throttle?: boolean) {
    const p = this.pending.get(jobId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    p.reject(new JobError(reason, throttle));
  }

  broadcast(userId: string, msg: ServerToClient) {
    this.conns.get(userId)?.send(msg);
  }
}

export class ClientGoneError extends Error {
  constructor() { super("клиент-коннект потерян — трата невозможна (D7)"); this.name = "ClientGoneError"; }
}
export class JobError extends Error {
  constructor(reason: string, public throttle?: boolean) { super(reason); this.name = "JobError"; }
}
