import type { Post } from './api';

export type MesubSubscriptionStatus =
    'PENDING' | 'ACTIVE' | 'CANCELLED' | 'UNPAID' | 'STOPPED' | 'ENDED' | 'FAILED';

/** A subscription, as the API returns it. Dates are ISO strings, chain numbers strings. */
export interface MesubSubscription {
    id: string;
    planId: string;
    // The wallet that signed, base58.
    subscriber: string;
    status: MesubSubscriptionStatus;
    currentPeriodStartTs: string | null;
    dueAt: string | null;
    // Unix seconds from which pulls are refused, "0" while not cancelled.
    expiresAtTs: string;
    createTxSignature: string | null;
    confirmedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/** What POST /:id/transaction returns. */
export interface SubscribeTransaction {
    // Base64 wire format, already signed by the puller.
    transaction: string;
    lastValidBlockHeight: string;
}

/** What POST /:id/confirm returns. `reason` is set when nothing settled. */
export interface ConfirmedSubscription {
    subscription: MesubSubscription;
    reason?: string | null;
}

export interface SubscriptionsApi {
    reserve(accessToken: string, plan: string): Promise<MesubSubscription>;
    transaction(accessToken: string, id: string): Promise<SubscribeTransaction>;
    confirm(accessToken: string, id: string, signature: string): Promise<ConfirmedSubscription>;
}

export function createSubscriptionsApi(post: Post): SubscriptionsApi {
    const at = (id: string) => `/${encodeURIComponent(id)}`;
    return {
        reserve: (accessToken, plan) => post('', { plan }, accessToken),
        transaction: (accessToken, id) => post(`${at(id)}/transaction`, {}, accessToken),
        confirm: (accessToken, id, signature) =>
            post(`${at(id)}/confirm`, { signature }, accessToken),
    };
}
