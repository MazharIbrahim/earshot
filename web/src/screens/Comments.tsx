import { useEffect, useState, useRef } from 'react';
import { api, ApiComment } from '../api';
import { fmtDuration, fmtRelative } from '../data';

type Props = {
  takeId: string;
  // Owner-side: pull comments via /takes/:id/comments.
  // Shared view: pass shareToken to fetch via /share/:token/comments instead.
  shareToken?: string;
  getCurrentTime: () => number | null;
  seekTo: (sec: number) => void;
  readOnly?: boolean;
};

export function Comments({ takeId, shareToken, getCurrentTime, seekTo, readOnly }: Props) {
  const [comments, setComments] = useState<ApiComment[] | null>(null);
  const [text, setText] = useState('');
  const [pinTime, setPinTime] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = async () => {
    try {
      const list = shareToken
        ? await api.listShareComments(shareToken)
        : await api.listComments(takeId);
      setComments(list);
      setError(null);
    } catch (e: any) {
      // 401 / 403 on owner endpoint = not your take; show no comments.
      setComments([]);
    }
  };

  useEffect(() => {
    setComments(null);
    load();
    // Poll every 8s so co-listeners see each other's comments live.
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeId, shareToken]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || posting) return;
    setPosting(true);
    setError(null);
    const t = pinTime ? getCurrentTime() : null;
    try {
      const fn = shareToken ? api.addShareComment : api.addComment;
      const row = await fn(shareToken || takeId, text.trim(), t);
      setComments(prev => [...(prev ?? []), row]);
      setText('');
    } catch (err: any) {
      setError(err?.message?.includes('401') ? 'sign in to comment' : 'failed to post');
    } finally {
      setPosting(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.removeComment(id);
      setComments(prev => prev?.filter(c => c.id !== id) ?? prev);
    } catch {/* ignore */}
  };

  return (
    <section style={{ marginTop: 24 }}>
      <h2 className="section-label">comments ({comments?.length ?? 0})</h2>

      {comments && comments.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px' }}>
          {comments.map(c => (
            <li
              key={c.id}
              style={{
                padding: '10px 12px',
                marginBottom: 8,
                background: 'var(--surface)',
                border: '1px solid var(--stroke)',
                borderRadius: 10,
                fontFamily: 'var(--mono)', fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ color: 'var(--text-muted)' }}>
                  {c.authorEmail?.split('@')[0] || 'anonymous'}
                  {c.timestampSec != null && (
                    <button
                      onClick={() => seekTo(c.timestampSec!)}
                      style={{
                        marginLeft: 8, padding: '2px 8px',
                        background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
                        color: 'var(--accent)',
                        border: 0, borderRadius: 6,
                        fontFamily: 'var(--mono)', fontSize: 11,
                        cursor: 'pointer',
                      }}
                      title="jump to this time"
                    >
                      @{fmtDuration(c.timestampSec)}
                    </button>
                  )}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{fmtRelative(c.createdAt)}</span>
              </div>
              <div style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {c.text}
              </div>
              {!shareToken && (
                <button
                  onClick={() => remove(c.id)}
                  style={{
                    marginTop: 6, padding: 0, background: 'none',
                    color: 'var(--text-muted)', fontSize: 11,
                    fontFamily: 'var(--mono)', cursor: 'pointer',
                  }}
                >
                  delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!readOnly && (
        <form onSubmit={submit}>
          <textarea
            ref={inputRef}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="leave a comment…"
            rows={2}
            style={{
              width: '100%', resize: 'vertical',
              padding: '10px 12px',
              background: 'var(--bg)', color: 'var(--text)',
              border: '1px solid var(--stroke)', borderRadius: 8,
              fontFamily: 'var(--mono)', fontSize: 13,
            }}
          />
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 8,
          }}>
            <label style={{
              fontFamily: 'var(--mono)', fontSize: 11,
              color: 'var(--text-muted)', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={pinTime}
                onChange={e => setPinTime(e.target.checked)}
                style={{ marginRight: 6, verticalAlign: 'middle' }}
              />
              pin to current time
              {pinTime && getCurrentTime() != null && (
                <span style={{ color: 'var(--accent)', marginLeft: 6 }}>
                  ({fmtDuration(getCurrentTime() || 0)})
                </span>
              )}
            </label>
            <button
              type="submit"
              disabled={!text.trim() || posting}
              style={{
                padding: '8px 14px',
                background: text.trim() ? 'var(--accent)' : 'var(--surface)',
                color: text.trim() ? 'var(--bg)' : 'var(--text-muted)',
                border: 0, borderRadius: 8,
                fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
                cursor: text.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              {posting ? 'posting…' : 'post'}
            </button>
          </div>
          {error && (
            <p style={{ color: '#ff5a3c', fontFamily: 'var(--mono)', fontSize: 11, marginTop: 6 }}>
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
