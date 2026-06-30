import { Routes, Route, Link } from 'react-router-dom';
import { Library } from './screens/Library';
import { Project } from './screens/Project';
import { SignIn } from './screens/SignIn';
import { Link as LinkPlugin } from './screens/Link';
import { Shared } from './screens/Shared';
import { AuthProvider, useAuth, signOut } from './auth';

// Pages that must remain accessible without sign-in.
function PublicShell() {
  return (
    <Routes>
      <Route path="/s/:token" element={<Shared />} />
    </Routes>
  );
}

function Shell() {
  const auth = useAuth();

  // Always evaluate public routes first so share links work for
  // anyone — signed in or not.
  if (window.location.pathname.startsWith('/s/')) {
    return <PublicShell />;
  }

  if (auth.kind === 'loading') {
    return <div className="app"><p className="empty">loading…</p></div>;
  }

  if (auth.kind === 'signed-out') {
    return <SignIn />;
  }

  const email = auth.session.user.email ?? '';
  const handle = email.split('@')[0];

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="wordmark">EARSHOT</Link>
        <button
          onClick={() => { signOut(); }}
          className="chip"
          title={`signed in as ${email} · click to sign out`}
          style={{ cursor: 'pointer' }}
        >
          {handle}
        </button>
      </header>

      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/p/:id" element={<Project />} />
        <Route path="/link" element={<LinkPlugin />} />
      </Routes>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
