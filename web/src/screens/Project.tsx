import { useParams, Link } from 'react-router-dom';
import { findProject, fmtDuration, fmtRelative } from '../data';
import { coverGradient } from '../cover';

export function Project() {
  const { id } = useParams();
  const project = id ? findProject(id) : undefined;

  if (!project) {
    return (
      <>
        <p className="empty">project not found.</p>
        <p className="empty"><Link to="/">back to library</Link></p>
      </>
    );
  }

  return (
    <>
      <h2 className="section-label">
        <Link to="/" style={{ color: 'var(--text-muted)' }}>← library</Link>
      </h2>

      <div className="player">
        <div className="cover" style={{ background: coverGradient(project.name) }} />
        <button className="play-btn" aria-label="play">▶</button>
        <h3 className="title" style={{ textAlign: 'center', marginTop: 0 }}>
          {project.name}
        </h3>
        <p className="meta" style={{ textAlign: 'center' }}>
          {project.live ? 'live now' : `${project.takes.length} takes`}
        </p>
      </div>

      <h2 className="section-label" style={{ marginTop: 28 }}>takes</h2>

      {project.takes.length === 0 ? (
        <p className="empty">no takes yet — hit play in ableton and snapshot.</p>
      ) : (
        <ul className="take-list">
          {project.takes.map(t => (
            <li key={t.id}>
              <span>{t.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>
                {fmtDuration(t.durationSec)} · {fmtRelative(t.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
