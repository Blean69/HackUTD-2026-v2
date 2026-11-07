// Job intake: dedupe, claim (another worker may win the race), run with bounded concurrency.
import type { JobInfo } from './workflows/types.js';

export interface JobQueueDeps {
  claim(jobId: bigint): Promise<void>;
  run(job: JobInfo): Promise<void>;
  /** Only claim workflows this worker knows how to run. */
  supports(workflow: string): boolean;
  concurrency?: number;
  log?: (msg: string) => void;
}

export class JobQueue {
  private seen = new Set<string>();
  private waiting: JobInfo[] = [];
  private active = 0;
  private idleWaiters: (() => void)[] = [];
  private max: number;
  private log: (msg: string) => void;
  private warned = new Set<string>();

  constructor(private d: JobQueueDeps) {
    this.max = d.concurrency ?? 2;
    this.log = d.log ?? ((m) => console.log(m));
  }

  offer(job: JobInfo): void {
    const key = job.id.toString();
    if (this.seen.has(key)) return;
    if (!this.d.supports(job.workflow)) {
      if (!this.warned.has(job.workflow)) {
        this.warned.add(job.workflow);
        this.log(`[jobs] no workflow "${job.workflow}" registered here; leaving job ${key} queued for another worker`);
      }
      return;
    }
    this.seen.add(key);
    this.waiting.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.max && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.active++;
      void this.process(job).finally(() => {
        this.active--;
        this.pump();
        if (!this.active && !this.waiting.length) this.idleWaiters.splice(0).forEach((r) => r());
      });
    }
  }

  private async process(job: JobInfo): Promise<void> {
    try {
      await this.d.claim(job.id);
    } catch (e) {
      this.log(`[jobs] job ${job.id} not claimed (${e instanceof Error ? e.message : String(e)}); another worker has it`);
      return;
    }
    this.log(`[jobs] claimed job ${job.id} (${job.workflow} / ${job.subjectId})`);
    try {
      await this.d.run(job);
    } catch (e) {
      this.log(`[jobs] job ${job.id} crashed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Resolves when nothing is running or waiting (tests, shutdown). */
  idle(): Promise<void> {
    return this.active || this.waiting.length ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve();
  }
}

export function parseJobInput(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
