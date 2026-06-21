import { useState } from 'react';
import { signInWithMagicLink } from '../auth';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setState('sending');
    setError(null);
    const { error } = await signInWithMagicLink(email.trim());
    if (error) {
      setError(error.message);
      setState('error');
    } else {
      setState('sent');
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 'calc(100vh - 120px)',
      maxWidth: 360,
      margin: '0 auto',
      padding: 20,
    }}>
      <h1 style={{
        fontFamily: 'var(--mono)',
        fontWeight: 700,
        fontSize: 26,
        letterSpacing: '0.06em',
        marginBottom: 8,
      }}>EARSHOT</h1>
      <p style={{
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: 'var(--text-muted)',
        marginTop: 0,
        marginBottom: 40,
        textAlign: 'center',
      }}>
        your studio, in your pocket
      </p>

      {state === 'sent' ? (
        <div style={{
          textAlign: 'center',
          fontFamily: 'var(--mono)',
          fontSize: 13,
          lineHeight: 1.6,
        }}>
          <p style={{ color: 'var(--accent)', marginBottom: 12 }}>
            check your inbox.
          </p>
          <p style={{ color: 'var(--text-muted)' }}>
            We sent a sign-in link to<br />
            <strong style={{ color: 'var(--text)' }}>{email}</strong>
          </p>
          <p style={{ color: 'var(--text-muted)', marginTop: 24, fontSize: 11 }}>
            Click the link to sign in. You can close this tab — the link
            will open you back here signed in.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} style={{ width: '100%' }}>
          <p className="section-label" style={{ marginBottom: 12 }}>
            sign in or sign up
          </p>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@studio.fm"
            required
            autoFocus
            inputMode="email"
            autoComplete="email"
            style={{
              width: '100%',
              padding: '14px 16px',
              background: 'var(--bg)',
              border: '1px solid var(--stroke)',
              color: 'var(--text)',
              borderRadius: 10,
              fontFamily: 'var(--mono)',
              fontSize: 14,
              marginBottom: 12,
            }}
          />
          <button
            type="submit"
            disabled={state === 'sending'}
            style={{
              width: '100%',
              padding: '14px 16px',
              background: 'var(--accent)',
              color: 'var(--bg)',
              border: 0,
              borderRadius: 10,
              fontFamily: 'var(--mono)',
              fontSize: 14,
              fontWeight: 700,
              cursor: state === 'sending' ? 'wait' : 'pointer',
              opacity: state === 'sending' ? 0.7 : 1,
            }}
          >
            {state === 'sending' ? 'sending…' : 'send magic link'}
          </button>

          {error && (
            <p style={{
              color: '#ff5a3c',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              marginTop: 12,
              textAlign: 'center',
            }}>{error}</p>
          )}

          <p style={{
            color: 'var(--text-muted)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            marginTop: 20,
            textAlign: 'center',
            lineHeight: 1.5,
          }}>
            We'll email you a one-time link.<br />
            No password to remember.
          </p>
        </form>
      )}
    </div>
  );
}
