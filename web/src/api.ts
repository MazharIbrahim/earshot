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

export type ApiComment = {
  id: string;
  userId: string | null;
  authorEmail: string | null;
  text: string;
  timestampSec: number | null;
  createdAt: number;
};

export type ApiShare = { token: string; url: string };

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
async function getNoAuth<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export const api = {
  base: BASE,
  projects:  () => get<ApiProject[]>('/projects'),
  takes:     (projectId: string) => get<ApiTake[]>(`/projects/${projectId}/takes`),
  audioUrl:  (takeId: string) => `${BASE}/takes/${takeId}/audio`,
  setNote:   (takeId: string, note: string) =>
    patch<{ ok: true }>(`/takes/${takeId}`, { note }),
  remove:    (takeId: string) => del(`/takes/${takeId}`),

  // Sharing
  createShare: (takeId: string) =>
    post<ApiShare>(`/takes/${takeId}/share`),
  getShare:    (token: string) =>
    getNoAuth<{ take: ApiTake & { opusFilename: string | null }; audioUrl: string }>(
      `/share/${token}`,
    ),

  // Comments
  listComments: (takeId: string) =>
    get<ApiComment[]>(`/takes/${takeId}/comments`),
  listShareComments: (token: string) =>
    getNoAuth<ApiComment[]>(`/share/${token}/comments`),
  addComment: (takeId: string, text: string, timestampSec: number | null) =>
    post<ApiComment>(`/takes/${takeId}/comments`, { text, timestampSec }),
  addShareComment: (token: string, text: string, timestampSec: number | null) =>
    post<ApiComment>(`/share/${token}/comments`, { text, timestampSec }),
  removeComment: (id: string) => del(`/comments/${id}`),

  // Share with optional recipient email — drops the take in their inbox.
  createShareWithRecipient: (takeId: string, recipientEmail?: string) =>
    post<ApiShare & { recipientEmail: string | null }>(
      `/takes/${takeId}/share`, { recipientEmail: recipientEmail || null }),

  // Profile + tier
  profile: () => get<{
    userId: string; email: string | null;
    tier: 'free' | 'pro' | 'studio';
    stripeCustomerId: string | null; proSince: number | null;
  }>('/profile'),

  // Collaborators
  listMembers: (projectId: string) =>
    get<{ email: string; userId: string | null; role: string; invitedAt: number }[]>
      (`/projects/${projectId}/members`),
  addMember: (projectId: string, email: string, role = 'viewer', projectName?: string) =>
    post(`/projects/${projectId}/members`, { email, role, projectName }),
  removeMember: (projectId: string, email: string) =>
    del(`/projects/${projectId}/members/${encodeURIComponent(email)}`),

  // Shared-with-me inbox
  inbox: () => get<{ token: string; take: ApiTake }[]>('/shared-with-me'),
};
