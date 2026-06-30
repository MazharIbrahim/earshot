import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { api, ApiTake } from '../api';
import { fmtDuration, fmtRelative, fmtBytes } from '../data';
import { coverGradient } from '../cover';
import { Comments } from './Comments';

type Slot = 'A' | 'B';

export function Project() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const sharedTakeId = search.get('t');

  const [takes, setTakes] = useState<ApiTake[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A/B model: A is the always-loaded primary slot; B is optional. When
  // both are set, swapping carries playback position across.
  const [takeA, setTakeA] = useState<ApiTake | null>(null);
  const [takeB, setTakeB] = useState<ApiTake | null>(null);
  const [active, setActive] = useState<Slot>('A');
  const [copied, setCopied] = useState(false);

  const audioA = useRef<HTMLAudioElement>(null);
  const audioB = useRef<HTMLAudioElement>(null);

  // ---- data loading -------------------------------------------------------
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const t = await api.takes(id);
        if (cancelled) return;
        setTakes(t);
        setError(null);
        setTakeA(curr => {
          if (curr) {
            // Refresh in place — keep selection, but pick up new note text.
            const fresh = t.find(x => x.id === curr.id);
            return fresh ?? curr;
          }
          if (sharedTakeId) {
            const shared = t.find(x => x.id === sharedTakeId);
            if (shared) return shared;
          }
          return t[0] ?? null;
        });
        setTakeB(curr => curr ? (t.find(x => x.id === curr.id) ?? null) : null);
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'failed to load');
      }
    };
    load();
    const i = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(i); };
  }, [id, sharedTakeId]);

  // ---- A/B swap with playback continuity ----------------------------------
  const swap = useCallback(() => {
    if (!takeB) return;
    const from = active === 'A' ? audioA.current : audioB.current;
    const to   = active === 'A' ? audioB.current : audioA.current;
    if (!from || !to) return;

    const wasPlaying = !from.paused;
    // Sync position. Skip if seeking would be out of range.
    const pos = from.currentTime;
    if (Number.isFinite(pos) && pos > 0 && pos < (to.duration || Infinity)) {
      to.currentTime = pos;
    }
    from.pause();
    setActive(active === 'A' ? 'B' : 'A');
    if (wasPlaying) {
      to.play().catch(() => {/* autoplay may need a gesture; the click is one */});
    }
  }, [active, takeB]);

  // ---- share --------------------------------------------------------------
  const shareCurrent = async () => {
    const active_take = active === 'A' ? takeA : takeB;
    if (!active_take) return;
    try {
      // Mint a share token tied to just this take — recipient can play
      // it (and comment if signed in) without seeing the rest of the
      // project. Owner can revoke later by deleting the token.
      const { url } = await api.createShare(active_take.id);
      if (navigator.share) {
        await navigator.share({ title: active_take.project, url });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }
    } catch {/* user cancel or 401 */}
  };

  // ---- per-row interactions ----------------------------------------------
  const compareWith = (t: ApiTake) => {
    if (!takeA || takeA.id === t.id) { setTakeA(t); setTakeB(null); setActive('A'); return; }
    setTakeB(t);
    setActive('B'); // tap-to-compare jumps to B immediately
  };

  const setA = (t: ApiTake) => {
    if (takeB && takeB.id === t.id) {
      // Promoting B to A; clear B so the UI returns to single-take mode.
      setTakeA(t); setTakeB(null); setActive('A'); return;
    }
    setTakeA(t); setActive('A');
  };

  const saveNote = async (t: ApiTake, note: string) => {
    try {
      await api.setNote(t.id, note);
      // Optimistic local update.
      setTakes(prev => prev?.map(x => x.id === t.id ? { ...x, note } : x) ?? prev);
      if (takeA?.id === t.id) setTakeA({ ...takeA, note });
      if (takeB?.id === t.id) setTakeB({ ...takeB, note });
    } catch {/* swallow; UI will reflect on next poll */}
  };

  const deleteTake = async (t: ApiTake) => {
    const label = t.note || new Date(t.createdAt).toLocaleString();
    if (!window.confirm(`Delete "${label}"? This cannot be undone.`)) return;
    try {
      await api.remove(t.id);
      setTakes(prev => prev?.filter(x => x.id !== t.id) ?? prev);
      if (takeA?.id === t.id) setTakeA(null);
      if (takeB?.id === t.id) { setTakeB(null); setActive('A'); }
    } catch (e: any) {
      setError(e.message || 'delete failed');
    }
  };

  // ---- render -------------------------------------------------------------
  if (error) return <p className="empty">{error}</p>;
  if (!takes) return <p className="empty">loading…</p>;

  const projectName = takeA?.project ?? takes[0]?.project ?? id ?? 'project';
  const inAB = takeA && takeB;
  const activeTake = active === 'A' ? takeA : takeB;

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

        {takeA && (
          <>
            {/* Hidden duplicate <audio> element for B. Native controls follow
                the active slot below. */}
            <audio
              ref={audioA}
              src={api.audioUrl(takeA.id)}
              controls={active === 'A'}
              hidden={active !== 'A'}
              autoPlay={!!sharedTakeId && active === 'A'}
              preload="metadata"
              style={{ width: '100%', marginTop: 12, accentColor: 'var(--accent)' }}
            />
            {takeB && (
              <audio
                ref={audioB}
                src={api.audioUrl(takeB.id)}
                controls={active === 'B'}
                hidden={active !== 'B'}
                preload="metadata"
                style={{ width: '100%', marginTop: 12, accentColor: 'var(--accent)' }}
              />
            )}

            <p className="meta" style={{ textAlign: 'center', marginTop: 10 }}>
              {activeTake?.note
                ? <strong style={{ color: 'var(--text)' }}>{activeTake.note}</strong>
                : <span>{new Date(activeTake!.createdAt).toLocaleString()}</span>}
              <br />
              {fmtDuration(activeTake!.durationSec)} · {fmtBytes(activeTake!.bytes)} · {fmtRelative(activeTake!.createdAt)}
            </p>

            {inAB && (
              <div style={{
                marginTop: 14,
                padding: 12,
                background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
                border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--stroke))',
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}>
                <ABSlot label="A" take={takeA!} active={active === 'A'} />
                <button
                  onClick={swap}
                  aria-label="swap A/B"
                  style={{
                    width: 56, height: 56, flex: '0 0 auto',
                    background: 'var(--accent)', color: 'var(--bg)',
                    borderRadius: '50%',
                    fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700,
                  }}
                >⇄</button>
                <ABSlot label="B" take={takeB!} active={active === 'B'} />
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'center' }}>
              <button
                onClick={shareCurrent}
                style={{
                  padding: '10px 16px',
                  background: 'transparent',
                  border: '1px solid var(--stroke)',
                  color: copied ? 'var(--accent)' : 'var(--text)',
                  borderRadius: 8,
                  fontFamily: 'var(--mono)', fontSize: 12,
                }}
              >
                {copied ? 'link copied' : 'share this take'}
              </button>
              {inAB && (
                <button
                  onClick={() => { setTakeB(null); setActive('A'); }}
                  style={{
                    padding: '10px 16px',
                    background: 'transparent',
                    border: '1px solid var(--stroke)',
                    color: 'var(--text-muted)',
                    borderRadius: 8,
                    fontFamily: 'var(--mono)', fontSize: 12,
                  }}
                >exit A/B</button>
              )}
            </div>
          </>
        )}
      </div>

      {(takeA || takeB) && (
        <Comments
          takeId={(active === 'A' ? takeA : takeB)!.id}
          getCurrentTime={() => audioRef.current?.currentTime ?? null}
          seekTo={(t) => { if (audioRef.current) audioRef.current.currentTime = t; }}
        />
      )}

      <h2 className="section-label" style={{ marginTop: 28 }}>
        takes ({takes.length})
      </h2>

      {takes.length === 0 ? (
        <p className="empty">no takes yet — record one in your DAW.</p>
      ) : (
        <ul className="take-list">
          {takes.map(t => (
            <TakeRow
              key={t.id}
              take={t}
              isA={takeA?.id === t.id}
              isB={takeB?.id === t.id}
              onPlay={() => setA(t)}
              onCompare={() => compareWith(t)}
              onSaveNote={(note) => saveNote(t, note)}
              onDelete={() => deleteTake(t)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

// --------------------------------------------------------------------------
function ABSlot({ label, take, active }: { label: string; take: ApiTake; active: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11,
        color: active ? 'var(--accent)' : 'var(--text-muted)',
        marginBottom: 4, letterSpacing: '0.12em',
      }}>{label} {active && '· playing'}</div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 12,
        color: active ? 'var(--text)' : 'var(--text-muted)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {take.note || new Date(take.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
function TakeRow(props: {
  take: ApiTake;
  isA: boolean;
  isB: boolean;
  onPlay: () => void;
  onCompare: () => void;
  onSaveNote: (note: string) => void;
  onDelete: () => void;
}) {
  const { take, isA, isB, onPlay, onCompare, onSaveNote, onDelete } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(take.note ?? '');

  useEffect(() => { setDraft(take.note ?? ''); }, [take.note]);

  const commit = () => {
    const next = draft.trim();
    if (next !== (take.note ?? '')) onSaveNote(next);
    setEditing(false);
  };

  const display = take.note || new Date(take.createdAt).toLocaleString();
  const highlight = isA ? 'var(--accent)' : isB ? 'color-mix(in srgb, var(--accent) 60%, var(--text))' : undefined;

  return (
    <li style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '12px 0', borderTop: '1px solid var(--stroke)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { setDraft(take.note ?? ''); setEditing(false); }
            }}
            placeholder="add a label…"
            style={{
              width: '100%', padding: '4px 6px',
              background: 'var(--bg)', border: '1px solid var(--stroke)',
              color: 'var(--text)', borderRadius: 4,
              fontFamily: 'var(--mono)', fontSize: 13,
            }}
          />
        ) : (
          <div
            onClick={() => setEditing(true)}
            style={{
              fontFamily: 'var(--mono)', fontSize: 13,
              color: highlight ?? 'var(--text)',
              cursor: 'text',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}
            title="click to edit label"
          >
            {display}
          </div>
        )}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
          {fmtDuration(take.durationSec)} · {fmtRelative(take.createdAt)}
        </div>
      </div>

      <button
        onClick={onPlay}
        title="play"
        style={{
          width: 32, height: 32, flex: '0 0 auto',
          borderRadius: '50%', fontSize: 14,
          background: isA ? 'var(--accent)' : 'transparent',
          color: isA ? 'var(--bg)' : 'var(--text)',
          border: '1px solid var(--stroke)',
        }}
      >▶</button>
      <button
        onClick={onCompare}
        title="compare A/B"
        style={{
          width: 36, height: 32, flex: '0 0 auto',
          borderRadius: 6, fontSize: 11,
          background: isB ? 'color-mix(in srgb, var(--accent) 20%, transparent)' : 'transparent',
          color: isB ? 'var(--accent)' : 'var(--text-muted)',
          border: '1px solid ' + (isB ? 'var(--accent)' : 'var(--stroke)'),
          fontFamily: 'var(--mono)', fontWeight: 700,
        }}
      >{isB ? 'B✓' : 'A/B'}</button>
      <button
        onClick={onDelete}
        title="delete take"
        aria-label="delete"
        style={{
          width: 32, height: 32, flex: '0 0 auto',
          borderRadius: 6, fontSize: 14,
          background: 'transparent',
          color: 'var(--text-muted)',
          border: '1px solid var(--stroke)',
        }}
      >✕</button>
    </li>
  );
}
