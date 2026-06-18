import type { JobEvent, JobStatus } from '@las/protocol';

interface JobState {
  status: JobStatus;
  outputKey?: string;
  error?: string;
  events: JobEvent[];
}

/**
 * Per-job coordinator. D1 holds the canonical job row; this DO owns the live
 * event log + latest progress and fans updates out to any connected websockets
 * (the web app can subscribe instead of polling).
 */
export class JobDO {
  private sockets = new Set<WebSocket>();

  constructor(private ctx: DurableObjectState) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/subscribe') {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      this.sockets.add(server);
      server.addEventListener('close', () => this.sockets.delete(server));
      const state = await this.state();
      server.send(JSON.stringify({ type: 'snapshot', state }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/append' && req.method === 'POST') {
      const event = (await req.json()) as JobEvent;
      await this.append(event);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/state') {
      return Response.json(await this.state());
    }

    return new Response('not found', { status: 404 });
  }

  private async state(): Promise<JobState> {
    return (await this.ctx.storage.get<JobState>('state')) ?? { status: 'queued', events: [] };
  }

  private async append(event: JobEvent): Promise<void> {
    const state = await this.state();
    state.events.push(event);
    if (event.status) state.status = event.status;
    if (event.kind === 'result' && event.data?.outputKey) {
      state.outputKey = String(event.data.outputKey);
    }
    if (event.kind === 'error') state.error = event.message;
    await this.ctx.storage.put('state', state);

    const msg = JSON.stringify({ type: 'event', event });
    for (const ws of this.sockets) {
      try {
        ws.send(msg);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }
}
