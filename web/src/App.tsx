import { Routes, Route, Link } from 'react-router-dom';
import { Library } from './screens/Library';
import { Project } from './screens/Project';
import { SignIn } from './screens/SignIn';

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="wordmark">EARSHOT</Link>
        <span className="chip">mazhar</span>
      </header>

      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/p/:id" element={<Project />} />
        <Route path="/signin" element={<SignIn />} />
      </Routes>
    </div>
  );
}
