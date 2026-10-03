import { createContext, useContext } from 'react';
import type { MesubApi } from './api';
import type { MesubAction, MesubPlan, MesubSubscription } from './types';
import type { SolanaChain } from './wallet';

export type MesubTheme = 'light' | 'dark' | 'auto';

/** Where a subscribe stands: `open` is the dialog up with nothing being signed. */
export type SubscribeState = 'idle' | 'open' | 'signing' | 'confirming' | 'subscribed';

export interface SubscribeRequest {
    plan: string;
    onState(state: SubscribeState): void;
    // `signature` is the transaction's id, when the wallet is its first signer.
    onSubscribed(subscription: MesubSubscription, signature: string | null): void;
}

export interface ManageRequest {
    subscription: MesubSubscription;
    action: MesubAction;
}

/** What the provider hands to the hooks and the dialogs. Not part of the public API. */
export interface MesubInternal {
    api: MesubApi;
    chain: SolanaChain;
    // Set on the widget as data-mesub-theme; undefined leaves it to an ancestor.
    theme: MesubTheme | undefined;
    // Where "Cancel any time" leads: the merchant's own page, null for no button, undefined for Mesub's.
    manageUrl: string | null | undefined;
    // One read per slug, shared: a failed one is asked again next time.
    plan(slug: string): Promise<MesubPlan>;
    // Bumped when a subscription was made or changed: the lists read again.
    revision: number;
    // Opens the checkout. Resolves on close, with the subscription if it went through.
    subscribe(request: SubscribeRequest): Promise<MesubSubscription | null>;
    // Opens the cancel, resume or close dialog. Resolves on close.
    manage(request: ManageRequest): Promise<MesubSubscription | null>;
}

export const MesubContext = createContext<MesubInternal | null>(null);

export function useMesubInternal(): MesubInternal {
    const value = useContext(MesubContext);
    if (!value) throw new Error('@mesub/react must be used inside <MesubProvider>');
    return value;
}
