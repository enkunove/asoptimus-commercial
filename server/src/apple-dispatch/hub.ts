// @aso/server/apple-dispatch — registry of live client connections (WSS) + routing of
// job.result → the awaiting promise. Single Phase 1 instance → no sticky-WS needed (BUILD-PLAN §5).

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
  /** userId → connection (last one wins; a reconnect overrides). */
  private conns = new Map<string, ClientConnection>();
  /** job_id → pending dispatch. */
  private pending = new Map<string, Pending>();

  register(conn: ClientConnection) {
    this.conns.set(conn.userId, conn);
  }

  unregister(userId: string) {
    this.conns.delete(userId);
    // No live client → all pending jobs abort (D7: fetch impossible → paused).
    for (const [jobId, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ClientGoneError());
      this.pending.delete(jobId);
    }
  }

  hasClient(userId: string): boolean {
    return this.conns.has(userId);
  }

  /** Send job.dispatch and await job.result by job_id (timeout → reject). */
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

  /** Client returned a job result. */
  resolveJob(result: JobResult) {
    const p = this.pending.get(result.job_id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(result.job_id);
    p.resolve(result);
  }

  /** Client reported a job error. */
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
  constructor() { super("client connection lost — spending impossible (D7)"); this.name = "ClientGoneError"; }
}
export class JobError extends Error {
  constructor(reason: string, public throttle?: boolean) { super(reason); this.name = "JobError"; }
}
