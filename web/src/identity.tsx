import { createContext, useContext } from 'react';
import type { AuthState } from './api';

/**
 * Who is signed in, for pages that show a different amount to different
 * people. The shell already holds this to draw the header; pages read it
 * here rather than asking /auth/me again.
 */
const IdentityContext = createContext<AuthState | null>(null);

export const IdentityProvider = IdentityContext.Provider;

export function useAuthState(): AuthState | null {
  return useContext(IdentityContext);
}

/** True for the administrator, and for everyone before the first account
 *  exists -- the same rule the backend's RequireOwner applies. */
export function useIsOwner(): boolean {
  const auth = useAuthState();
  if (!auth) return false;
  return !auth.enforcement || auth.identity?.role === 'admin';
}
