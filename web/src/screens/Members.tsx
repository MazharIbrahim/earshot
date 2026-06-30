import { useEffect, useState } from 'react';
import { api } from '../api';
import { fmtRelative } from '../data';

type Member = { email: string; userId: string | null; role: string; invitedAt: number };

export function Members({ projectId, projectName, ownerOnly }: {
  projectId: string; projectName?: string; ownerOnly?: boolean;
}) {
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const m = await api.listMembers(projectId);
      setMembers(m);
    } catch { setMembers([]); }
  };

  useEffect(() => {
    // Owner status: PWA hides the whole invite UI for collaborators.
    api.project(projectId)
      .then(p => setIsOwner(p.isOwner))
      .catch(() => setIsOwner(false));
    load();
    /* eslint-disable-next-line */
  }, [projectId]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.includes('@') || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.addMember(projectId, email.trim().toLowerCase(), 'viewer', projectName);
      setEmail('');
      load();
    } catch (e: any) {
      setErr(e.message?.includes('400') ? 'invalid email' : 'failed to add');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (em: string) => {
    if (!confirm(`Remove ${em}?`)) return;
    try {
      await api.removeMember(projectId, em);
      load();
    } catch {/* ignore */}
  };

  const memberCount = members?.length ?? 0;

  // Hide the whole panel for non-owners so collaborators don't see
  // (or attempt) an invite UI they're not allowed to use.
  if (ownerOnly && isOwner === false) return null;
  if (ownerOnly && isOwner === null) return null; // wait for owner check

  return (
    <section style={{ marginTop: 22 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px',
          background: 'var(--surface)',
          border: '1px solid var(--stroke)',
          borderRadius: 8,
          fontFamily: 'var(--mono)', fontSize: 12,
          color: 'var(--text-muted)',
          cursor: 'pointer',
        }}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>collaborators ({memberCount})</span>
      </button>

      {open && (
        <div style={{
          marginTop: 10, padding: 14,
          background: 'var(--surface)',
          border: '1px solid var(--stroke)',
          borderRadius: 10,
        }}>
          <p style={{
            fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--text-muted)', margin: '0 0 12px',
          }}>
            anyone you add sees every take in this project
          </p>

          {members && members.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px' }}>
              {members.map(m => (
                <li key={m.email} style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '8px 0',
                  borderBottom: '1px solid var(--stroke)',
                  fontFamily: 'var(--mono)', fontSize: 12,
                }}>
                  <div>
                    <strong style={{ color: 'var(--text)' }}>{m.email}</strong>
                    <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                      {m.userId ? 'joined' : 'pending'} · {fmtRelative(m.invitedAt)}
                    </span>
                  </div>
                  <button
                    onClick={() => remove(m.email)}
                    style={{
                      padding: 0, background: 'none',
                      color: 'var(--text-muted)', fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >remove</button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={add} style={{ display: 'flex', gap: 8 }}>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="invite by email…"
              style={{
                flex: 1, padding: '8px 10px',
                background: 'var(--bg)', color: 'var(--text)',
                border: '1px solid var(--stroke)', borderRadius: 8,
                fontFamily: 'var(--mono)', fontSize: 12,
              }}
            />
            <button
              type="submit"
              disabled={busy || !email.includes('@')}
              style={{
                padding: '8px 14px',
                background: email.includes('@') ? 'var(--accent)' : 'var(--surface)',
                color: email.includes('@') ? 'var(--bg)' : 'var(--text-muted)',
                border: 0, borderRadius: 8,
                fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700,
                cursor: email.includes('@') ? 'pointer' : 'not-allowed',
              }}
            >{busy ? '…' : 'invite'}</button>
          </form>
          {err && (
            <p style={{ color: '#ff5a3c', fontFamily: 'var(--mono)',
                        fontSize: 11, marginTop: 6 }}>{err}</p>
          )}
        </div>
      )}
    </section>
  );
}
