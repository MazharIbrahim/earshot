// Stub data until backend is wired up.

export type Take = {
  id: string;
  label: string;
  durationSec: number;
  createdAt: string; // ISO
};

export type Project = {
  id: string;
  name: string;
  live: boolean;
  takes: Take[];
};

export const PROJECTS: Project[] = [
  {
    id: 'midnight-bus',
    name: 'midnight bus',
    live: true,
    takes: [
      { id: 't3', label: 'v12', durationSec: 261, createdAt: '2026-06-04T16:42:00Z' },
      { id: 't2', label: 'v11', durationSec: 248, createdAt: '2026-06-04T14:18:00Z' },
      { id: 't1', label: 'v10 — first chorus', durationSec: 232, createdAt: '2026-06-03T22:05:00Z' },
    ],
  },
  {
    id: 'glass-corridor',
    name: 'glass corridor',
    live: false,
    takes: [
      { id: 't5', label: 'v04', durationSec: 198, createdAt: '2026-05-30T09:11:00Z' },
      { id: 't4', label: 'v03', durationSec: 191, createdAt: '2026-05-29T20:40:00Z' },
    ],
  },
  {
    id: 'untitled-3',
    name: 'untitled 3',
    live: false,
    takes: [],
  },
];

export function findProject(id: string) {
  return PROJECTS.find(p => p.id === id);
}

export function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function fmtRelative(iso: string) {
  const then = new Date(iso).getTime();
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.round(diffMin / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
