import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiProject, ApiTake } from '../api';
import { fmtRelative } from '../data';
import { coverGradient } from '../cover';

export function Library() {
  const [projects, setProjects] = useState<ApiProject[] | null>(null);
  const [inbox, setInbox] = useState<{ token: string; take: ApiTake }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [p, i] = await Promise.all([api.projects(), api.inbox().catch(() => [])]);
        if (cancelled) return;
        setProjects(p);
        setInbox(i);
        setError(null);
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'failed to load');
      }
    };
    load();
    const t = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (error) return <p className="empty">backend offline · {error}</p>;
  if (!projects) return <p className="empty">loading…</p>;

  const showInbox = (inbox || []).length > 0;
  const emptyLibrary = projects.length === 0 && !showInbox;

  if (emptyLibrary) {
    return (
      <p className="empty">
        no takes yet — record one in your DAW and it'll appear here.
      </p>
    );
  }

  return (
    <>
      {showInbox && (
        <>
          <h2 className="section-label">shared with you</h2>
          <div className="project-grid" style={{ marginBottom: 22 }}>
            {inbox!.map(({ token, take }) => (
              <Link
                to={`/s/${token}`}
                key={token}
                className="project-card"
                style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, var(--stroke))' }}
              >
                <div className="cover" style={{ background: coverGradient(take.project) }} />
                <h3 className="title">{take.project}</h3>
                <div className="meta">
                  {take.note || 'shared take'}
                  {take.createdAt && <> · {fmtRelative(take.createdAt)}</>}
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <h2 className="section-label">your projects</h2>

      {projects.length === 0 ? (
        <p className="empty">no projects yet — record a take in your DAW.</p>
      ) : (
        <div className="project-grid">
          {projects.map(p => (
            <Link to={`/p/${p.projectId}`} key={p.projectId} className="project-card">
              <div className="cover" style={{ background: coverGradient(p.project) }} />
              <h3 className="title">{p.project}</h3>
              <div className="meta">
                {p.takes} {p.takes === 1 ? 'take' : 'takes'}
                {p.latestCreatedAt && <> · {fmtRelative(p.latestCreatedAt)}</>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
