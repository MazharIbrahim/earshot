import { Link } from 'react-router-dom';
import { PROJECTS, fmtRelative } from '../data';
import { coverGradient } from '../cover';

export function Library() {
  const live = PROJECTS.filter(p => p.live);
  return (
    <>
      {live.map(p => (
        <Link to={`/p/${p.id}`} key={p.id} className="live-banner">
          <span className="live-dot" />
          <span>live from <strong>{p.name}</strong> — tap to listen</span>
        </Link>
      ))}

      <h2 className="section-label">projects</h2>

      <div className="project-grid">
        {PROJECTS.map(p => {
          const last = p.takes[0];
          return (
            <Link to={`/p/${p.id}`} key={p.id} className="project-card">
              <div className="cover" style={{ background: coverGradient(p.name) }} />
              <h3 className="title">{p.name}</h3>
              <div className="meta">
                {p.takes.length} {p.takes.length === 1 ? 'take' : 'takes'}
                {last && <> · {fmtRelative(last.createdAt)}</>}
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
