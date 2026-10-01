import { createContext, useContext } from 'react';
import type { MesubApi } from './api';
import type { MesubSession, MesubUser, WalletProof } from './types';
import type { MesubWallet } from './wallets-api';

/** What `useMesub()` returns. */
export interface MesubState {
    // True once the provider knows whether someone is signed in.
    ready: boolean;
    user: MesubUser | null;
    // The wallet that pays on this site: the access token's.
    wallet: string | null;
    // The account's proved wallets, null until loadWallets() first answers.
    wallets: MesubWallet[] | null;
    login(): Promise<MesubUser>;
    logout(): Promise<void>;
    getAccessToken(): Promise<string | null>;
    loadWallets(): Promise<MesubWallet[]>;
    // Pays from another of the account's wallets on this site. Signs nothing.
    selectWallet(address: string): Promise<void>;
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
    // Replaces and persists the session, without touching a sign-in in progress.
    setSession(session: MesubSession | null): void;
    // A wallet just linked: its access token, then the list again.
    adoptWallet(proof: WalletProof): Promise<void>;
    // Set on the dialog as data-mesub-theme; undefined leaves it to an ancestor.
    theme: MesubTheme | undefined;
}

export type MesubTheme = 'light' | 'dark' | 'auto';

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
