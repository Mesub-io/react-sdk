import type { UiWallet } from '@wallet-standard/react';
import type { MesubApi } from './api';
import { MesubClientError } from './errors';
import { findSigner, signAndSend, type Signer, type SolanaChain } from './send-transaction';
import type { MesubSubscription } from './subscribe-api';

/** Confirm answered, but nothing settled: the API's reason, and what was sent. */
export class NotSettledError extends Error {
    constructor(
        message: string,
        readonly signature: string,
    ) {
        super(message);
        this.name = 'NotSettledError';
    }
}

export interface SubscribeInput {
    api: MesubApi;
    accessToken: string;
    plan: string;
    wallets: readonly UiWallet[];
    // The wallet the session proved: the only one allowed to sign.
    address: string;
    chain: SolanaChain;
    // The wallet is about to prompt.
    onSigner?(signer: Signer): void;
    // The wallet sent it: money may move from here on.
    onSent?(signature: string): void;
}

/** Reserve, one signature, confirm. Throws MesubClientError, WalletError or NotSettledError. */
export async function subscribeOnce(
    input: SubscribeInput,
): Promise<{ subscription: MesubSubscription; signature: string }> {
    const { api, accessToken, plan } = input;
    const reserved = await api.subscriptions.reserve(accessToken, plan);
    const { transaction } = await api.subscriptions.transaction(accessToken, reserved.id);
    const signer = await findSigner(input.wallets, input.address);
    input.onSigner?.(signer);
    const signature = await signAndSend(signer, input.chain, transaction);
    input.onSent?.(signature);

    const confirmed = await api.subscriptions.confirm(accessToken, reserved.id, signature);
    if (confirmed.reason) throw new NotSettledError(confirmed.reason, signature);
    return { subscription: confirmed.subscription, signature };
}

/** Network trouble or a timeout, as opposed to the API refusing. */
export function unreachable(error: unknown): boolean {
    return error instanceof MesubClientError && error.status === null;
}
