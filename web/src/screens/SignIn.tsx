export function SignIn() {
  return (
    <>
      <h2 className="section-label">sign in</h2>
      <div className="player">
        <p className="meta" style={{ marginTop: 0 }}>
          enter your email — we'll send a magic link.
        </p>
        <input
          type="email"
          placeholder="you@studio.fm"
          style={{
            width: '100%',
            padding: '12px 14px',
            background: 'var(--bg)',
            border: '1px solid var(--stroke)',
            color: 'var(--text)',
            borderRadius: 8,
            fontFamily: 'var(--mono)',
            fontSize: 14,
            marginBottom: 12,
          }}
        />
        <button
          className="play-btn"
          style={{ width: '100%', height: 44, borderRadius: 8, fontSize: 14 }}
        >
          send link
        </button>
      </div>
    </>
  );
}
