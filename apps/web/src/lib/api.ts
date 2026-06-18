import type {
  AvatarProfile,
  VoiceProfile,
  Job,
  JobEvent,
  OfflineRenderSpec,
  Script,
  StartSessionRequest,
  SessionMedia,
} from '@las/protocol';

export const API_BASE = import.meta.env.VITE_API_URL ?? '/api';
const BASE = API_BASE;

// No auth yet (internal tool). A stable demo user keeps R2/D1 keys namespaced.
const USER_ID = 'demo-user';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

export const api = {
  userId: USER_ID,

  // --- uploads ---
  async createUpload(kind: string, contentType: string): Promise<{ key: string; url: string }> {
    return req('/uploads', {
      method: 'POST',
      body: JSON.stringify({ userId: USER_ID, kind, contentType }),
    });
  },
  async putToSignedUrl(url: string, blob: Blob): Promise<void> {
    const res = await fetch(url, { method: 'PUT', body: blob });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  },

  // --- avatars ---
  listAvatars(): Promise<AvatarProfile[]> {
    return req(`/avatars?userId=${USER_ID}`);
  },
  buildAvatar(body: {
    sourceType: string;
    sourceKey: string;
    label?: string;
    prompt?: string;
    tier?: string;
    fineTune?: boolean;
  }): Promise<AvatarProfile> {
    return req('/avatars', {
      method: 'POST',
      body: JSON.stringify({ userId: USER_ID, ...body }),
    });
  },

  // --- voices ---
  listVoices(): Promise<VoiceProfile[]> {
    return req(`/voices?userId=${USER_ID}`);
  },
  cloneVoice(body: { sampleKey: string; label?: string; engine?: string }): Promise<VoiceProfile> {
    return req('/voices', {
      method: 'POST',
      body: JSON.stringify({ userId: USER_ID, ...body }),
    });
  },

  // --- jobs ---
  createRenderJob(spec: OfflineRenderSpec): Promise<Job> {
    return req('/jobs', { method: 'POST', body: JSON.stringify({ userId: USER_ID, spec }) });
  },
  getJob(id: string): Promise<{ job: Job; events: JobEvent[] }> {
    return req(`/jobs/${id}`);
  },
  jobDownloadUrl(id: string): string {
    return `${BASE}/jobs/${id}/download`;
  },

  // --- director LLM assist (offline draft) ---
  draftScript(prompt: string, persona = ''): Promise<Script> {
    return req('/director/draft', { method: 'POST', body: JSON.stringify({ prompt, persona }) });
  },

  // --- realtime ---
  startSession(body: Omit<StartSessionRequest, 'userId'>): Promise<SessionMedia> {
    return req('/sessions', { method: 'POST', body: JSON.stringify({ userId: USER_ID, ...body }) });
  },
  endSession(id: string): Promise<void> {
    return req(`/sessions/${id}`, { method: 'DELETE' });
  },
  // Typed user turn. `source:'text'` authorizes via the unguessable sessionId,
  // bypassing the GPU-only internal-token gate on the same /turn endpoint.
  sendTurn(sessionId: string, text: string): Promise<{ ok: boolean }> {
    return req(`/sessions/${sessionId}/turn`, {
      method: 'POST',
      body: JSON.stringify({ text, source: 'text' }),
    });
  },
};
