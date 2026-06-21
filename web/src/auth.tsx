// Supabase Auth wired into a tiny React context.
//
// Why @supabase/auth-js directly instead of @supabase/supabase-js: the full
// SDK pulls in realtime, which needs `ws` on Node < 22 and bloats the
// browser bundle. We only need email magic-link auth.

import { createContext, useContext, useEffect, useState } from 'react';
import { AuthClient, Session } from '@supabase/auth-js';

const SUPABASE_URL = (import.meta as any).env?.VITE_SUPABASE_URL
  ?? 'https://juypvyxapierfykgncsf.supabase.co';
const SUPABASE_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY
  ?? 'sb_publishable_oHh3nEiUOcjd9rhg7ogm3Q_sEWj-YPC';

// Single client instance — talks to /auth/v1 on the Supabase project.
export const auth = new AuthClient({
  url: `${SUPABASE_URL}/auth/v1`,
  storageKey: 'earshot.auth',
  autoRefreshToken: true,
  persistSession: true,
  detectSessionInUrl: true, // picks up the magic-link tokens from the URL hash
  headers: { apikey: SUPABASE_KEY },
});

type AuthState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'signed-in'; session: Session };

const AuthContext = createContext<AuthState>({ kind: 'loading' });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });

  useEffect(() => {
    auth.getSession().then(({ data }) => {
      setState(data.session
        ? { kind: 'signed-in', session: data.session }
        : { kind: 'signed-out' });
    });
    const { data: sub } = auth.onAuthStateChange((_event, session) => {
      setState(session
        ? { kind: 'signed-in', session }
        : { kind: 'signed-out' });
    });
    return () => { sub.subscription.unsubscribe(); };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth() { return useContext(AuthContext); }

// Always-current access token for the API client.
export async function getAccessToken(): Promise<string | null> {
  const { data } = await auth.getSession();
  return data.session?.access_token ?? null;
}

export async function signInWithMagicLink(email: string) {
  return auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
}

export async function signOut() {
  return auth.signOut();
}
