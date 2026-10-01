import type { Get, Post } from './api';
import type { WalletProof } from './types';

/** One of the account's proved wallets, as GET /v1/client/auth/wallets lists it. */
export interface MesubWallet {
    address: string;
    label: string | null;
    // The one this project's access tokens carry.
    selected: boolean;
    // This project's plans the wallet holds a live subscription to, by name.
    plans: string[];
}

/** The account's wallets on this project, under /v1/client/auth, with the access token. */
export interface WalletsApi {
    list(accessToken: string): Promise<MesubWallet[]>;
    // A linked wallet: no signature, it is already proved.
    select(accessToken: string, address: string): Promise<WalletProof>;
    challenge(accessToken: string, address: string): Promise<{ message: string }>;
    // Links a new wallet with the signed challenge, and selects it.
    link(
        accessToken: string,
        proof: { address: string; signature: string; label?: string },
    ): Promise<WalletProof>;
}

export function createWalletsApi(get: Get, post: Post): WalletsApi {
    return {
        list: async (accessToken) =>
            (await get<{ wallets: MesubWallet[] }>('/wallets', accessToken)).wallets,
        select: (accessToken, address) => post('/wallet/select', { address }, accessToken),
        challenge: (accessToken, address) => post('/wallets/challenge', { address }, accessToken),
        link: (accessToken, proof) => post('/wallets', proof, accessToken),
    };
}
