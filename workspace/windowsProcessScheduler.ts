/** Serialize Windows process-service helpers; native ownership checks take priority. */
export type ProcessScanPriority = "ownership" | "resources";
export interface ProcessScanControl {
  readonly signal: AbortSignal;
  /** Register only the helper created by this operation, never a rediscovered PID. */
  ownHelper(cancel: () => void, exited: Promise<unknown>): void;
}
interface PendingScan {
  priority: ProcessScanPriority;
  run(control: ProcessScanControl): Promise<unknown>;
  finish(value: unknown | null): void;
  controller: AbortController;
  cancelHelper?: () => void;
  helperExited?: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
}
export class WindowsProcessScheduler {
  private active?: PendingScan;
  private pending: PendingScan[] = [];
  private paused = false;
  private draining?: Promise<boolean>;
  private idleListeners = new Set<() => void>();
  schedule<T>(priority: ProcessScanPriority, run: (control: ProcessScanControl) => Promise<T>, queueTimeoutMs = 12_000): Promise<T | null> {
    if (!Number.isFinite(queueTimeoutMs) || queueTimeoutMs < 1 || queueTimeoutMs > 12_000) throw new Error("Native process queue timeout is invalid");
    if (this.paused || this.pending.length >= 64) return Promise.resolve(null);
    return new Promise<T | null>(finish => {
      const entry: PendingScan = { priority, run, controller: new AbortController(), finish: value => finish(value as T | null) };
      entry.timer = setTimeout(() => {
        const index = this.pending.indexOf(entry);
        if (index < 0) return;
        this.pending.splice(index, 1); entry.controller.abort(); entry.finish(null);
      }, queueTimeoutMs);
      entry.timer.unref?.();
      this.pending.push(entry); this.next();
    });
  }
  /** Temporarily stop work, cancel exact owned helpers, and confirm their exit.
   * A timeout never releases an unconfirmed helper lease or proves absence. */
  drain(timeoutMs = 4_000): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) throw new Error("Native helper drain timeout is invalid");
    if (this.draining) return this.draining;
    this.paused = true;
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer); entry.controller.abort(); entry.finish(null);
    }
    const active = this.active;
    if (active) {
      active.controller.abort(); active.finish(null);
      try { active.cancelHelper?.(); } catch { /* Exit confirmation remains mandatory. */ }
    }
    const waiting = !this.active ? Promise.resolve(true) : new Promise<boolean>(resolve => {
      const finish = (confirmed: boolean) => { clearTimeout(timer); this.idleListeners.delete(idle); resolve(confirmed); };
      const idle = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.idleListeners.add(idle);
    });
    const task = waiting.finally(() => {
      this.paused = false; if (this.draining === task) this.draining = undefined; this.next();
    });
    this.draining = task; return task;
  }
  private next(): void {
    if (this.active || this.paused || !this.pending.length) return;
    const owner = this.pending.findIndex(entry => entry.priority === "ownership");
    const entry = this.pending.splice(owner < 0 ? 0 : owner, 1)[0]!;
    clearTimeout(entry.timer); this.active = entry;
    const control: ProcessScanControl = {
      signal: entry.controller.signal,
      ownHelper: (cancel, exited) => {
        if (entry.helperExited) throw new Error("Native process operation already owns a helper");
        entry.cancelHelper = cancel; entry.helperExited = exited;
        // Close can occur while an operation awaits its local script read.
        if (entry.controller.signal.aborted) { try { cancel(); } catch {} }
      },
    };
    Promise.resolve().then(() => entry.controller.signal.aborted ? null : entry.run(control))
      .then(value => entry.finish(entry.controller.signal.aborted ? null : value), () => entry.finish(null)).then(async () => {
        // kill() is a request; only this exact child's exit releases the lease.
        try { await entry.helperExited; }
        catch { await new Promise<never>(() => {}); }
      }).finally(() => {
        this.active = undefined;
        for (const idle of this.idleListeners) idle();
        this.next();
      }).catch(() => {});
  }
}
export const windowsProcessScheduler = new WindowsProcessScheduler();
