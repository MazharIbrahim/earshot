import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { getAccessToken } from '../auth';

const BASE = (import.meta as any).env?.VITE_API_BASE ?? '';

export function Link() {
  const [search] = useSearchParams();
  const navigate = useNavigate();

  // 6-digit code typed by the user, or pre-filled from a QR scan.
  const [code, setCode] = useState((search.get('code') || '').replace(/\D/g, '').slice(0, 6));
  const [state, setState] = useState<'idle' | 'linking' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Auto-submit if code arrived via URL and looks valid.
    if (code.length === 6 && state === 'idle') submit();
  }, []);

  const submit = async () => {
    if (code.length !== 6) return;
    setState('linking');
    setError(null);
    const token = await getAccessToken();
    if (!token) {
      setError('please sign in first');
      setState('error');
      return;
    }
    const r = await fetch(BASE + '/auth/device-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code }),
    });
    if (r.ok) {
      setState('done');
      setTimeout(() => navigate('/'), 2000);
    } else {
      const body = await r.json().catch(() => ({}));
      setError(body.error || `error ${r.status}`);
      setState('error');
    }
  };

  return (
    <div style={{
      maxWidth: 360,
      margin: '60px auto',
      padding: 20,
      textAlign: 'center',
    }}>
      <h1 style={{
        fontFamily: 'var(--mono)',
        fontSize: 20,
        letterSpacing: '0.04em',
        marginBottom: 4,
      }}>link the plugin</h1>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-muted)' }}>
        type the 6-digit code shown in your DAW plugin.
      </p>

      {state === 'done' ? (
        <p style={{
          marginTop: 32, color: 'var(--accent)',
          fontFamily: 'var(--mono)', fontSize: 14,
        }}>plugin linked ✓ — back to library…</p>
      ) : (
        <>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            inputMode="numeric"
            autoFocus
            maxLength={6}
            style={{
              width: '100%',
              margin: '24px 0 12px',
              padding: '18px',
              fontSize: 28,
              fontFamily: 'var(--mono)',
              letterSpacing: '0.4em',
              textAlign: 'center',
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--stroke)',
              borderRadius: 12,
            }}
          />
          <button
            onClick={submit}
            disabled={code.length !== 6 || state === 'linking'}
            style={{
              width: '100%',
              padding: '14px',
              background: 'var(--accent)',
              color: 'var(--bg)',
              border: 0,
              borderRadius: 10,
              fontFamily: 'var(--mono)',
              fontSize: 14,
              fontWeight: 700,
              cursor: code.length === 6 ? 'pointer' : 'not-allowed',
              opacity: code.length === 6 ? 1 : 0.5,
            }}
          >
            {state === 'linking' ? 'linking…' : 'link plugin'}
          </button>

          {error && (
            <p style={{
              color: '#ff5a3c',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              marginTop: 16,
            }}>{error}</p>
          )}
        </>
      )}
    </div>
  );
}
