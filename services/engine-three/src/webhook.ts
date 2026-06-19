import type { Config } from './config.js';

export class ProgressReporter {
  constructor(
    private readonly jobId: string,
    private readonly cfg: Config,
  ) {}

  async report(opts: {
    status: string;
    progress?: number;
    message?: string;
    outputKey?: string;
    error?: string;
  }): Promise<void> {
    const body: Record<string, unknown> = { jobId: this.jobId, status: opts.status };
    if (opts.progress !== undefined) body.progress = opts.progress;
    if (opts.message) body.message = opts.message;
    if (opts.outputKey) body.outputKey = opts.outputKey;
    if (opts.error) body.error = opts.error;

    try {
      await fetch(`${this.cfg.controlApiUrl}/api/internal/jobs/progress`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.internalToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      // Best-effort — never fail the render on webhook errors.
    }
  }
}
