import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, ApiTake } from '../api';
import { fmtDuration, fmtRelative, fmtBytes } from '../data';
import { coverGradient } from '../cover';
import { Comments } from './Comments';
import { useAuth } from '../auth';

export function Shared() {
  const { token } = useParams();
  const auth = useAuth();
  const [data, setData] = useState<{ take: ApiTake; audioUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const s = await api.getShare(token);
        setData(s);
      } catch (e: any) {
        setError(e?.message?.includes('404') ? 'link not found or revoked' : 'failed to load');
      }
    })();
  }, [token]);

  if (error) {
    return (
      <div className="app">
        <p className="empty">{error}</p>
        <p className="empty">
          <Link to="/" style={{ color: 'var(--accent)' }}>go to library →</Link>
        </p>
      </div>
    );
  }

  if (!data) {
    return <div className="app"><p className="empty">loading…</p></div>;
  }

  const { take } = data;
  const audioUrl = (api.base || '') + data.audioUrl;
  const canComment = auth.kind === 'signed-in';

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="wordmark">EARSHOT</Link>
        <span className="chip">shared with you</span>
      </header>

      <div className="player">
        <div className="cover" style={{ background: coverGradient(take.project) }} />
        <h3 className="title" style={{ textAlign: 'center', marginTop: 0 }}>
          {take.project}
        </h3>

        <audio
          ref={audioRef}
          src={audioUrl}
          controls
          autoPlay
          preload="metadata"
          style={{ width: '100%', marginTop: 12, accentColor: 'var(--accent)' }}
        />

        <p className="meta" style={{ textAlign: 'center', marginTop: 10 }}>
          {take.note
            ? <strong style={{ color: 'var(--text)' }}>{take.note}</strong>
            : <span>{new Date(take.createdAt).toLocaleString()}</span>}
          <br />
          {fmtDuration(take.durationSec)} · {fmtBytes(take.bytes)} · {fmtRelative(take.createdAt)}
        </p>
      </div>

      <Comments
        takeId={take.id}
        shareToken={token}
        getCurrentTime={() => audioRef.current?.currentTime ?? null}
        seekTo={(t) => { if (audioRef.current) audioRef.current.currentTime = t; }}
        readOnly={!canComment}
      />

      {!canComment && (
        <p style={{
          textAlign: 'center',
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text-muted)',
          marginTop: 18,
        }}>
          <Link to="/" style={{ color: 'var(--accent)' }}>sign in</Link> to leave a comment
        </p>
      )}
    </div>
  );
}
