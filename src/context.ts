import { createContext, useContext } from 'react';
import type { MesubApi } from './api';
import type { MesubSession, MesubUser } from './types';

/** What `useMesub()` returns. */
export interface MesubState {
    // True once the provider knows whether someone is signed in.
    ready: boolean;
    user: MesubUser | null;
    wallet: string | null;
    login(): Promise<MesubUser>;
    logout(): Promise<void>;
    getAccessToken(): Promise<string | null>;
}

/** For the sign-in modal and the session restore: not part of the public API. */
export interface MesubInternal {
    api: MesubApi;
    session: MesubSession | null;
    // A login() is waiting for the modal.
    signingIn: boolean;
    // Needs a proved wallet and an access token: resolves every pending login().
    completeSignIn(session: MesubSession): void;
    // Rejects every pending login() with MesubSignInCancelledError.
    cancelSignIn(): void;
    // Replaces the session without touching a sign-in in progress (restore, refresh).
    setSession(session: MesubSession | null): void;
}

export const MesubContext = createContext<MesubState | null>(null);
export const MesubInternalContext = createContext<MesubInternal | null>(null);

export function useMesub(): MesubState {
    const value = useContext(MesubContext);
    if (!value) throw new Error('useMesub() must be called inside <MesubProvider>');
    return value;
}

export function useMesubInternal(): MesubInternal {
    const value = useContext(MesubInternalContext);
    if (!value) throw new Error('useMesubInternal() must be called inside <MesubProvider>');
    return value;
}
