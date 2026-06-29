import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiProject } from '../api';
import { fmtRelative } from '../data';
import { coverGradient } from '../cover';

export function Library() {
  const [projects, setProjects] = useState<ApiProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const p = await api.projects();
        if (!cancelled) { setProjects(p); setError(null); }
      } catch (e: any) {
        if (!cancelled) setError(e.message || 'failed to load');
      }
    };
    load();
    const t = setInterval(load, 10000); // poll for new takes
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (error) return <p className="empty">backend offline · {error}</p>;
  if (!projects) return <p className="empty">loading…</p>;

  if (projects.length === 0) {
    return (
      <p className="empty">
        no takes yet — record one in your DAW and it'll appear here.
      </p>
    );
  }

  return (
    <>
      <h2 className="section-label">projects</h2>

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
    </>
  );
}
