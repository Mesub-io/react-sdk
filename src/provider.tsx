import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApiClient, type FetchLike } from './api';
import { SessionKeeper } from './keeper';
import {
    MesubContext,
    MesubInternalContext,
    type MesubInternal,
    type MesubState,
    type MesubTheme,
} from './context';
import { MesubSignInCancelledError } from './errors';
import { SignInModal } from './sign-in-modal';
import type { MesubSession, MesubUser } from './types';

export interface MesubProviderProps {
    publishableKey: string;
    // Defaults to https://api.mesub.io.
    apiUrl?: string | undefined;
    // For tests. Defaults to globalThis.fetch.
    fetch?: FetchLike | undefined;
    // data-mesub-theme on the widget. Leave it out to inherit it from an ancestor.
    theme?: MesubTheme | undefined;
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

/** Keeps the session alive, exposes it through `useMesub()`, and renders the sign-in. */
export function MesubProvider({
    publishableKey,
    apiUrl,
    fetch,
    theme,
    children,
}: MesubProviderProps) {
    const api = useMemo(
        () => createApiClient({ publishableKey, apiUrl, fetch }),
        [publishableKey, apiUrl, fetch],
    );

    const [session, setSessionState] = useState<MesubSession | null>(null);
    const [signingIn, setSigningIn] = useState(false);
    const [ready, setReady] = useState(false);
    const pendingRef = useRef<PendingSignIn | null>(null);
    // Holds the session outside React, so two calls in one tick see each other.
    const keeper = useMemo(
        () => new SessionKeeper(api, publishableKey, setSessionState),
        [api, publishableKey],
    );

    // Ready once the stored session, if any, is restored or refused.
    useEffect(() => {
        let live = true;
        const stop = keeper.start();
        setSessionState(keeper.session);
        void keeper.restore().finally(() => {
            if (live) setReady(true);
        });
        return () => {
            live = false;
            stop();
        };
    }, [keeper]);

    const setSession = useCallback((next: MesubSession | null) => keeper.set(next), [keeper]);

    const login = useCallback((): Promise<MesubUser> => {
        const current = keeper.session;
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
    }, [keeper]);

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

    const logout = useCallback(() => keeper.logout(), [keeper]);

    const getAccessToken = useCallback(() => keeper.getAccessToken(), [keeper]);

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
        () => ({
            api,
            session,
            signingIn,
            completeSignIn,
            cancelSignIn,
            setSession,
            theme,
        }),
        [api, session, signingIn, completeSignIn, cancelSignIn, setSession, theme],
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
