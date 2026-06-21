// Tiny API client. In dev, Vite serves the PWA at :5173 and we hit the
// backend at :8787 directly. In prod, both will live behind the same host
// and we'll switch to relative URLs.

import { getAccessToken } from './auth';

// In production the PWA is served from the same origin as the API, so we
// use relative URLs. Override with VITE_API_BASE for split-host dev.
const BASE = (import.meta as any).env?.VITE_API_BASE ?? '';

async function authHeaders(): Promise<Record<string, string>> {
  const t = await getAccessToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export type ApiProject = {
  projectId: string;
  project: string;
  takes: number;
  latestCreatedAt: number;
};

export type ApiTake = {
  id: string;
  project: string;
  projectId: string;
  durationSec: number;
  bytes: number;
  note?: string | null;
  createdAt: number;
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { headers: await authHeaders() });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function del(path: string): Promise<void> {
  const r = await fetch(BASE + path, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!r.ok && r.status !== 404) throw new Error(`${path} → ${r.status}`);
}

export const api = {
  base: BASE,
  projects:  () => get<ApiProject[]>('/projects'),
  takes:     (projectId: string) => get<ApiTake[]>(`/projects/${projectId}/takes`),
  audioUrl:  (takeId: string) => `${BASE}/takes/${takeId}/audio`,
  setNote:   (takeId: string, note: string) =>
    patch<{ ok: true }>(`/takes/${takeId}`, { note }),
  remove:    (takeId: string) => del(`/takes/${takeId}`),
};
