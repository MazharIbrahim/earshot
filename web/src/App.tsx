import { Routes, Route, Link } from 'react-router-dom';
import { Library } from './screens/Library';
import { Project } from './screens/Project';
import { SignIn } from './screens/SignIn';
import { AuthProvider, useAuth, signOut } from './auth';

function Shell() {
  const auth = useAuth();

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
