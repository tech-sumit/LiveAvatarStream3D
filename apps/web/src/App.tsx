import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { AvatarsPage } from './pages/AvatarsPage.js';
import { VoicesPage } from './pages/VoicesPage.js';
import { StudioPage } from './pages/StudioPage.js';
import { RealtimePage } from './pages/RealtimePage.js';

export function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <header className="topbar">
          <div className="brand">LiveAvatarStream</div>
          <nav>
            <NavLink to="/avatars">Avatars</NavLink>
            <NavLink to="/voices">Voices</NavLink>
            <NavLink to="/studio">Studio</NavLink>
            <NavLink to="/live">Live</NavLink>
          </nav>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<Navigate to="/avatars" replace />} />
            <Route path="/avatars" element={<AvatarsPage />} />
            <Route path="/voices" element={<VoicesPage />} />
            <Route path="/studio" element={<StudioPage />} />
            <Route path="/live" element={<RealtimePage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
