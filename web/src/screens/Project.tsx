import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { api, ApiTake } from '../api';
import { fmtDuration, fmtRelative, fmtBytes } from '../data';
import { coverGradient } from '../cover';

export function Project() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const sharedTakeId = search.get('t');
  const [takes, setTakes] = useState<ApiTake[] | null>(null);
  const [selected, setSelected] = useState<ApiTake | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const t = await api.takes(id);
        if (cancelled) return;
        setTakes(t);
        setError(null);
        // Priority for initial selection:
        //   1. ?t=<takeId> from a share link
        //   2. whatever's already selected
        //   3. newest take
        setSelected(s => {
          if (s) return s;
          if (sharedTakeId) {
            const shared = t.find(x => x.id === sharedTakeId);
            if (shared) return shared;
          }
          return t[0] ?? null;
        });
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'failed to load');
      }
    };
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [id, sharedTakeId]);

  const shareCurrent = async () => {
    if (!selected || !id) return;
    const url = `${window.location.origin}/p/${id}?t=${selected.id}`;
    try {
      // Web Share API (mobile native sheet) preferred; clipboard otherwise.
      if (navigator.share) {
        await navigator.share({ title: selected.project, url });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }
    } catch { /* user cancelled / share unsupported */ }
  };

  if (error) return <p className="empty">{error}</p>;
  if (!takes) return <p className="empty">loading…</p>;

  const projectName = takes[0]?.project ?? id ?? 'project';

  return (
    <>
      <h2 className="section-label">
        <Link to="/" style={{ color: 'var(--text-muted)' }}>← library</Link>
      </h2>

      <div className="player">
        <div className="cover" style={{ background: coverGradient(projectName) }} />

        <h3 className="title" style={{ textAlign: 'center', marginTop: 0 }}>
          {projectName}
        </h3>

        {selected ? (
          <>
            <audio
              ref={audioRef}
              src={api.audioUrl(selected.id)}
              controls
              autoPlay={!!sharedTakeId} // share-link recipients hear it immediately
              style={{ width: '100%', marginTop: 12, accentColor: 'var(--accent)' }}
              preload="metadata"
            />
            <p className="meta" style={{ textAlign: 'center', marginTop: 10 }}>
              {fmtDuration(selected.durationSec)} · {fmtBytes(selected.bytes)} · {fmtRelative(selected.createdAt)}
            </p>
            <button
              onClick={shareCurrent}
              style={{
                display: 'block',
                margin: '12px auto 0',
                padding: '10px 16px',
                background: 'transparent',
                border: '1px solid var(--stroke)',
                color: copied ? 'var(--accent)' : 'var(--text)',
                borderRadius: 8,
                fontFamily: 'var(--mono)',
                fontSize: 12,
              }}
            >
              {copied ? 'link copied' : 'share this take'}
            </button>
          </>
        ) : (
          <p className="meta" style={{ textAlign: 'center' }}>
            no takes yet
          </p>
        )}
      </div>

      <h2 className="section-label" style={{ marginTop: 28 }}>
        takes ({takes.length})
      </h2>

      {takes.length === 0 ? (
        <p className="empty">no takes yet — record one in ableton.</p>
      ) : (
        <ul className="take-list">
          {takes.map(t => {
            const isSelected = selected?.id === t.id;
            return (
              <li
                key={t.id}
                onClick={() => setSelected(t)}
                style={{
                  cursor: 'pointer',
                  color: isSelected ? 'var(--accent)' : undefined,
                }}
              >
                <span>{new Date(t.createdAt).toLocaleString()}</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {fmtDuration(t.durationSec)} · {fmtRelative(t.createdAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
