import type { EngineRenderSpec, Job, JobEvent, VoiceProfile } from '@las/protocol';

export const API_BASE = import.meta.env.VITE_API_URL ?? '/api';
const BASE = API_BASE;
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

  listVoices(): Promise<VoiceProfile[]> {
    return req(`/voices?userId=${USER_ID}`);
  },

  createEngineJob(spec: EngineRenderSpec): Promise<Job> {
    return req('/engine-jobs', {
      method: 'POST',
      body: JSON.stringify({ userId: USER_ID, spec }),
    });
  },

  getEngineJob(id: string): Promise<{ job: Job; events: JobEvent[] }> {
    return req(`/jobs/${id}`);
  },

  engineJobDownloadUrl(id: string): string {
    return `${BASE}/jobs/${id}/download`;
  },

  engineJobManifestUrl(id: string): string {
    return `${BASE}/engine-jobs/${id}/manifest`;
  },

  async uploadGlb(file: File): Promise<{ key: string }> {
    const { key, url } = await req<{ key: string; url: string }>('/uploads', {
      method: 'POST',
      body: JSON.stringify({ userId: USER_ID, kind: 'scene-asset', contentType: 'model/gltf-binary' }),
    });
    const res = await fetch(url, { method: 'PUT', body: file });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return { key };
  },

  createUpload(kind: string, contentType: string): Promise<{ key: string; url: string }> {
    return req('/uploads', {
      method: 'POST',
      body: JSON.stringify({ userId: USER_ID, kind, contentType }),
    });
  },

  async putToSignedUrl(url: string, blob: Blob): Promise<void> {
    const res = await fetch(url, { method: 'PUT', body: blob });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  },

  cloneVoice(body: {
    sampleKey: string;
    label?: string;
    engine?: string;
    language?: string;
  }): Promise<VoiceProfile> {
    return req('/voices', {
      method: 'POST',
      body: JSON.stringify({ userId: USER_ID, ...body }),
    });
  },

  retryVoice(id: string): Promise<VoiceProfile> {
    return req(`/voices/${id}/retry?userId=${USER_ID}`, { method: 'POST' });
  },
};
