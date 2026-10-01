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
import { MesubClientError, MesubSignInCancelledError } from './errors';
import { sessionWallet } from './session';
import { SignInModal } from './sign-in-modal';
import type { MesubSession, MesubUser, WalletProof } from './types';
import type { MesubWallet } from './wallets-api';

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
    // Kept with its account: another sign-in never shows the last one's wallets.
    const [walletList, setWalletList] = useState<{ userId: string; wallets: MesubWallet[] } | null>(
        null,
    );
    const loadingWallets = useRef<Promise<MesubWallet[]> | null>(null);
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

    const signedInToken = useCallback(async (): Promise<string> => {
        const token = await keeper.getAccessToken();
        if (!token) throw new MesubClientError('You are signed out. Sign in again.', 401);
        return token;
    }, [keeper]);

    const loadWallets = useCallback((): Promise<MesubWallet[]> => {
        loadingWallets.current ??= (async () => {
            const token = await signedInToken();
            const userId = keeper.session?.user.id;
            const wallets = await api.wallets.list(token);
            if (userId && keeper.session?.user.id === userId) setWalletList({ userId, wallets });
            return wallets;
        })().finally(() => {
            loadingWallets.current = null;
        });
        return loadingWallets.current;
    }, [api, keeper, signedInToken]);

    const selectWallet = useCallback(
        async (address: string): Promise<void> => {
            const token = await signedInToken();
            const proof = await api.wallets.select(token, address);
            const next = await keeper.switchAccess(proof.user, proof.accessToken);
            if (!next) return;
            setWalletList((list) =>
                list && list.userId === next.user.id
                    ? {
                          ...list,
                          wallets: list.wallets.map((wallet) => ({
                              ...wallet,
                              selected: wallet.address === address,
                          })),
                      }
                    : list,
            );
        },
        [api, keeper, signedInToken],
    );

    const adoptWallet = useCallback(
        async (proof: WalletProof): Promise<void> => {
            if (!(await keeper.switchAccess(proof.user, proof.accessToken))) return;
            // Its label and plans come from the API: list them again, after any older read.
            await loadingWallets.current?.catch(() => undefined);
            await loadWallets().catch(() => undefined);
        },
        [keeper, loadWallets],
    );

    const state = useMemo<MesubState>(
        () => ({
            ready,
            user: session?.user ?? null,
            wallet: sessionWallet(session),
            wallets: session && walletList?.userId === session.user.id ? walletList.wallets : null,
            login,
            logout,
            getAccessToken,
            loadWallets,
            selectWallet,
        }),
        [ready, session, walletList, login, logout, getAccessToken, loadWallets, selectWallet],
    );

    const internal = useMemo<MesubInternal>(
        () => ({
            api,
            session,
            signingIn,
            completeSignIn,
            cancelSignIn,
            setSession,
            adoptWallet,
            theme,
        }),
        [api, session, signingIn, completeSignIn, cancelSignIn, setSession, adoptWallet, theme],
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
