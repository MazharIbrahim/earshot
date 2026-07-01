import { useState, useRef } from 'react';
import { signInWithMagicLink } from '../auth';

// Landing page + inline sign-in. Signed-out visitors land here.
// The "get started" CTA scrolls to the email form.
export function SignIn() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const signInRef = useRef<HTMLDivElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setState('sending');
    setError(null);
    const { error } = await signInWithMagicLink(email.trim());
    if (error) { setError(error.message); setState('error'); }
    else setState('sent');
  };

  const scrollToSignIn = () => {
    signInRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 20px 80px' }}>
      {/* Top nav */}
      <nav style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 60,
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18,
          letterSpacing: '0.08em',
        }}>EARSHOT</span>
        <button
          onClick={scrollToSignIn}
          style={{
            padding: '8px 14px',
            background: 'transparent', color: 'var(--text)',
            border: '1px solid var(--stroke)', borderRadius: 8,
            fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer',
          }}
        >sign in</button>
      </nav>

      {/* Hero */}
      <section style={{ textAlign: 'center', marginBottom: 80 }}>
        <h1 style={{
          fontFamily: 'var(--mono)', fontWeight: 700,
          fontSize: 'clamp(32px, 6vw, 56px)',
          lineHeight: 1.05, letterSpacing: '-0.02em',
          margin: '0 0 20px',
        }}>
          hear your track
          <br />
          before you bounce it.
        </h1>
        <p style={{
          fontFamily: 'var(--mono)', fontSize: 15,
          color: 'var(--text-muted)', lineHeight: 1.6,
          maxWidth: 520, margin: '0 auto 36px',
        }}>
          Earshot streams your Ableton master straight to your phone.
          Every play-through is auto-saved as a versioned take. Listen anywhere,
          share by link, get real feedback.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={scrollToSignIn}
            style={{
              padding: '14px 24px',
              background: 'var(--accent)', color: 'var(--bg)',
              border: 0, borderRadius: 10,
              fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700,
              cursor: 'pointer',
            }}
          >get started — free</button>
          <a
            href="#how"
            style={{
              padding: '14px 24px',
              background: 'transparent', color: 'var(--text)',
              border: '1px solid var(--stroke)', borderRadius: 10,
              fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 500,
              textDecoration: 'none',
            }}
          >how it works</a>
        </div>
        <p style={{
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text-muted)', marginTop: 20,
        }}>
          VST3 · AU · Mac + Windows · Ableton, Logic, FL, Bitwig, Reaper
        </p>
      </section>

      {/* How it works */}
      <section id="how" style={{ marginBottom: 80 }}>
        <p className="section-label" style={{
          textAlign: 'center', marginBottom: 32,
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text-muted)', letterSpacing: '0.15em',
        }}>HOW IT WORKS</p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 24,
        }}>
          {[
            { n: '01', h: 'drop the plugin on your master',
              b: 'Add Earshot to Ableton’s master bus. It shows a 6-digit code — enter it on your phone to link.' },
            { n: '02', h: 'hit play',
              b: 'Every play-through auto-saves as a numbered take. No exporting, no dragging files, no AirDrop.' },
            { n: '03', h: 'listen on your phone',
              b: 'Open the PWA anywhere — subway, kitchen, bed. Compare takes, leave comments, share a link with your artist.' },
          ].map(({ n, h, b }) => (
            <div key={n} style={{
              padding: 20,
              background: 'var(--surface)',
              border: '1px solid var(--stroke)',
              borderRadius: 12,
            }}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11,
                color: 'var(--accent)', letterSpacing: '0.15em',
                marginBottom: 8,
              }}>{n}</div>
              <h3 style={{
                fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 15,
                margin: '0 0 8px', color: 'var(--text)',
              }}>{h}</h3>
              <p style={{
                fontFamily: 'var(--mono)', fontSize: 12,
                color: 'var(--text-muted)', margin: 0, lineHeight: 1.6,
              }}>{b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section style={{ marginBottom: 80 }}>
        <p className="section-label" style={{
          textAlign: 'center', marginBottom: 32,
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text-muted)', letterSpacing: '0.15em',
        }}>WHAT YOU GET</p>
        <ul style={{
          listStyle: 'none', padding: 0, margin: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 16,
        }}>
          {[
            ['automatic versioning', 'every take saved, numbered, dated — never lose the good pass'],
            ['side-by-side listening', 'swipe between v12 and v15 to A/B mixes on the go'],
            ['timestamped comments', 'drop notes at exact seconds — no more “0:47 kick is loud” screenshots'],
            ['share by link', 'send one URL. no install, no sign-up needed to listen'],
            ['collaborator invites', 'give your artist or producer access to a whole project'],
            ['works offline', 'recent takes cached — listen with no signal, phone in airplane mode'],
          ].map(([h, b]) => (
            <li key={h} style={{
              padding: 16,
              background: 'var(--surface)',
              border: '1px solid var(--stroke)',
              borderRadius: 10,
            }}>
              <strong style={{
                fontFamily: 'var(--mono)', fontSize: 13,
                color: 'var(--text)', display: 'block', marginBottom: 4,
              }}>{h}</strong>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 12,
                color: 'var(--text-muted)', lineHeight: 1.5,
              }}>{b}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Pricing */}
      <section style={{ marginBottom: 80 }}>
        <p className="section-label" style={{
          textAlign: 'center', marginBottom: 32,
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--text-muted)', letterSpacing: '0.15em',
        }}>PRICING</p>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 16, maxWidth: 640, margin: '0 auto',
        }}>
          {/* Free */}
          <div style={{
            padding: 24,
            background: 'var(--surface)',
            border: '1px solid var(--stroke)',
            borderRadius: 12,
          }}>
            <h3 style={{
              fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14,
              margin: '0 0 4px', letterSpacing: '0.08em',
            }}>FREE</h3>
            <p style={{
              fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 700,
              margin: '0 0 20px', color: 'var(--text)',
            }}>$0<span style={{
              fontSize: 12, fontWeight: 400, color: 'var(--text-muted)',
            }}> forever</span></p>
            <ul style={{
              listStyle: 'none', padding: 0, margin: 0,
              fontFamily: 'var(--mono)', fontSize: 12,
              color: 'var(--text-muted)', lineHeight: 1.9,
            }}>
              <li>3 active projects</li>
              <li>unlimited takes, unlimited comments</li>
              <li>128 kbps opus streaming</li>
              <li>public share links</li>
              <li>takes archived after 30 days idle</li>
            </ul>
          </div>

          {/* Pro */}
          <div style={{
            padding: 24,
            background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
            border: '1px solid var(--accent)',
            borderRadius: 12, position: 'relative',
          }}>
            <span style={{
              position: 'absolute', top: -10, right: 16,
              padding: '2px 8px',
              background: 'var(--accent)', color: 'var(--bg)',
              borderRadius: 6,
              fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
              letterSpacing: '0.1em',
            }}>PRO</span>
            <h3 style={{
              fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14,
              margin: '0 0 4px', letterSpacing: '0.08em', color: 'var(--accent)',
            }}>PRO</h3>
            <p style={{
              fontFamily: 'var(--mono)', fontSize: 24, fontWeight: 700,
              margin: '0 0 20px', color: 'var(--text)',
            }}>$5<span style={{
              fontSize: 12, fontWeight: 400, color: 'var(--text-muted)',
            }}> / month</span></p>
            <ul style={{
              listStyle: 'none', padding: 0, margin: 0,
              fontFamily: 'var(--mono)', fontSize: 12,
              color: 'var(--text)', lineHeight: 1.9,
            }}>
              <li>unlimited projects</li>
              <li>invite collaborators to any project</li>
              <li>256 kbps opus streaming (studio-grade)</li>
              <li>original WAV downloads</li>
              <li>takes never expire</li>
              <li>priority email support</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Sign-in */}
      <section ref={signInRef} style={{
        maxWidth: 400, margin: '0 auto',
        padding: 28,
        background: 'var(--surface)',
        border: '1px solid var(--stroke)',
        borderRadius: 12,
      }}>
        {state === 'sent' ? (
          <div style={{ textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.6 }}>
            <p style={{ color: 'var(--accent)', marginBottom: 12, fontWeight: 700 }}>
              check your inbox.
            </p>
            <p style={{ color: 'var(--text-muted)' }}>
              We sent a sign-in link to<br />
              <strong style={{ color: 'var(--text)' }}>{email}</strong>
            </p>
            <p style={{ color: 'var(--text-muted)', marginTop: 20, fontSize: 11 }}>
              Click the link to sign in. You can close this tab — the link opens
              you back here signed in.
            </p>
          </div>
        ) : (
          <form onSubmit={submit}>
            <p className="section-label" style={{
              marginBottom: 4, textAlign: 'center',
              fontFamily: 'var(--mono)', fontSize: 11,
              color: 'var(--text-muted)', letterSpacing: '0.15em',
            }}>SIGN IN OR SIGN UP</p>
            <p style={{
              fontFamily: 'var(--mono)', fontSize: 12,
              color: 'var(--text-muted)', textAlign: 'center',
              margin: '0 0 20px',
            }}>free — takes 10 seconds</p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@studio.fm"
              required
              inputMode="email"
              autoComplete="email"
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '14px 16px',
                background: 'var(--bg)', color: 'var(--text)',
                border: '1px solid var(--stroke)', borderRadius: 10,
                fontFamily: 'var(--mono)', fontSize: 14,
                marginBottom: 10,
              }}
            />
            <button
              type="submit"
              disabled={state === 'sending'}
              style={{
                width: '100%', padding: '14px 16px',
                background: 'var(--accent)', color: 'var(--bg)',
                border: 0, borderRadius: 10,
                fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700,
                cursor: state === 'sending' ? 'wait' : 'pointer',
                opacity: state === 'sending' ? 0.7 : 1,
              }}
            >
              {state === 'sending' ? 'sending…' : 'send magic link'}
            </button>
            {error && (
              <p style={{
                color: '#ff5a3c', fontFamily: 'var(--mono)',
                fontSize: 11, marginTop: 10, textAlign: 'center',
              }}>{error}</p>
            )}
            <p style={{
              color: 'var(--text-muted)', fontFamily: 'var(--mono)',
              fontSize: 11, marginTop: 16, textAlign: 'center', lineHeight: 1.5,
            }}>
              We'll email you a one-time link — no password to remember.
            </p>
          </form>
        )}
      </section>

      {/* Footer */}
      <footer style={{
        marginTop: 80, paddingTop: 24,
        borderTop: '1px solid var(--stroke)',
        display: 'flex', justifyContent: 'space-between',
        fontFamily: 'var(--mono)', fontSize: 11,
        color: 'var(--text-muted)', flexWrap: 'wrap', gap: 12,
      }}>
        <span>Earshot · made in Cairo</span>
        <span style={{ display: 'flex', gap: 16 }}>
          <a
            href="https://earshots.lemonsqueezy.com/affiliates"
            target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
          >affiliates</a>
          <a
            href="mailto:mazhar@earshot.cc"
            style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
          >contact</a>
        </span>
      </footer>
    </div>
  );
}
