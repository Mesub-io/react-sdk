import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApiClient, type FetchLike } from './api';
import { MesubContext, MesubInternalContext, type MesubInternal, type MesubState } from './context';
import { MesubSignInCancelledError } from './errors';
import { SignInModal } from './sign-in-modal';
import type { MesubSession, MesubUser } from './types';

export interface MesubProviderProps {
    publishableKey: string;
    // Defaults to https://api.mesub.io.
    apiUrl?: string | undefined;
    // For tests. Defaults to globalThis.fetch.
    fetch?: FetchLike | undefined;
    children?: ReactNode;
}

interface PendingSignIn {
    promise: Promise<MesubUser>;
    resolve(user: MesubUser): void;
    reject(error: Error): void;
}

function isSignedIn(session: MesubSession | null): session is MesubSession {
    return session !== null && session.accessToken !== null && session.user.walletAddress !== null;
}

/** Holds the session in memory, exposes it through `useMesub()`, and renders the sign-in. */
export function MesubProvider({ publishableKey, apiUrl, fetch, children }: MesubProviderProps) {
    const api = useMemo(
        () => createApiClient({ publishableKey, apiUrl, fetch }),
        [publishableKey, apiUrl, fetch],
    );

    const [session, setSessionState] = useState<MesubSession | null>(null);
    const [signingIn, setSigningIn] = useState(false);
    const [ready, setReady] = useState(false);
    // Callbacks read these, so two calls in one tick see each other.
    const sessionRef = useRef<MesubSession | null>(null);
    const pendingRef = useRef<PendingSignIn | null>(null);

    // Nothing to restore yet: #4 makes this wait for the stored session.
    useEffect(() => setReady(true), []);

    const setSession = useCallback((next: MesubSession | null) => {
        sessionRef.current = next;
        setSessionState(next);
    }, []);

    const login = useCallback((): Promise<MesubUser> => {
        const current = sessionRef.current;
        if (isSignedIn(current)) return Promise.resolve(current.user);
        if (pendingRef.current) return pendingRef.current.promise;

        let resolve!: (user: MesubUser) => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<MesubUser>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        pendingRef.current = { promise, resolve, reject };
        setSigningIn(true);
        return promise;
    }, []);

    const completeSignIn = useCallback(
        (next: MesubSession) => {
            if (!isSignedIn(next)) {
                throw new Error('completeSignIn() needs a session with a proved wallet');
            }
            setSession(next);
            pendingRef.current?.resolve(next.user);
            pendingRef.current = null;
            setSigningIn(false);
        },
        [setSession],
    );

    const cancelSignIn = useCallback(() => {
        pendingRef.current?.reject(new MesubSignInCancelledError());
        pendingRef.current = null;
        setSigningIn(false);
    }, []);

    const logout = useCallback(async () => {
        const current = sessionRef.current;
        setSession(null);
        if (!current) return;
        // Signed out locally whatever the API says: the token just expires.
        await api.logout(current.refreshToken).catch(() => undefined);
    }, [api, setSession]);

    const getAccessToken = useCallback(async () => sessionRef.current?.accessToken ?? null, []);

    const state = useMemo<MesubState>(
        () => ({
            ready,
            user: session?.user ?? null,
            wallet: session?.user.walletAddress ?? null,
            login,
            logout,
            getAccessToken,
        }),
        [ready, session, login, logout, getAccessToken],
    );

    const internal = useMemo<MesubInternal>(
        () => ({ api, session, signingIn, completeSignIn, cancelSignIn, setSession }),
        [api, session, signingIn, completeSignIn, cancelSignIn, setSession],
    );

    return (
        <MesubInternalContext.Provider value={internal}>
            <MesubContext.Provider value={state}>
                {children}
                {/* Opens on login(): nothing for the merchant to place. */}
                <SignInModal />
            </MesubContext.Provider>
        </MesubInternalContext.Provider>
    );
}
