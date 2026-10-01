import { getBase58Decoder } from '@solana/kit';
import { getWalletFeature, type UiWallet } from '@wallet-standard/react';

// The Wallet Standard shapes used here, read off the wallet itself.
interface WalletAccount {
    readonly address: string;
    readonly chains: readonly string[];
}

interface ConnectFeature {
    connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}

interface SignAndSendFeature {
    signAndSendTransaction(
        ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]
    ): Promise<readonly { signature: Uint8Array }[]>;
}

/** A Wallet Standard chain, such as `solana:mainnet` or `solana:devnet`. */
export type SolanaChain = `solana:${string}`;

export type WalletErrorKind =
    'none' | 'not-connected' | 'wrong-account' | 'rejected' | 'no-signature';

/** What the subscriber can fix in their wallet: shown as is. `kind` picks the screen. */
export class WalletError extends Error {
    constructor(
        message: string,
        readonly kind: WalletErrorKind,
        readonly wallet: string | null = null,
        // wrong-account: the account the wallet is on, and the one the session proved.
        readonly accounts: { shared: string; expected: string } | null = null,
    ) {
        super(message);
    }
}

const isSolana = (chain: string) => chain.startsWith('solana:');
const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

/** A wallet that can hand over a Solana account and send a transaction itself. */
export function canSubscribe(wallet: UiWallet): boolean {
    return (
        wallet.chains.some(isSolana) &&
        wallet.features.includes('standard:connect') &&
        wallet.features.includes('solana:signAndSendTransaction')
    );
}

export interface Signer {
    wallet: UiWallet;
    account: WalletAccount;
}

// Called as a method: a wallet may rely on `this`. Never `standard:disconnect`,
// see wallet.ts.
async function accountsOf(wallet: UiWallet, silent: boolean): Promise<readonly WalletAccount[]> {
    const feature = getWalletFeature(wallet, 'standard:connect') as ConnectFeature;
    const { accounts } = await feature.connect(silent ? { silent: true } : undefined);
    return accounts.filter((account) => account.chains.some(isSolana));
}

function mismatch(wallet: UiWallet, shared: WalletAccount, address: string): WalletError {
    return new WalletError(
        `${wallet.name} is on ${short(shared.address)}, but you signed in with ${short(address)}. Switch to that account in ${wallet.name}, then try again.`,
        'wrong-account',
        wallet.name,
        { shared: shared.address, expected: address },
    );
}

/**
 * The installed wallet holding `address`, the one the session proved. Asks
 * silently first, so a wallet that is not authorised on this site shows no prompt.
 */
export async function findSigner(wallets: readonly UiWallet[], address: string): Promise<Signer> {
    const shows = (wallet: UiWallet) => wallet.accounts.some((entry) => entry.address === address);
    // The one already showing that account first: it answers without a prompt.
    const capable = wallets
        .filter(canSubscribe)
        .sort((a, b) => Number(shows(b)) - Number(shows(a)));
    if (capable.length === 0) {
        throw new WalletError('No wallet in this browser can send a Solana transaction.', 'none');
    }

    let other: { wallet: UiWallet; account: WalletAccount } | null = null;
    for (const wallet of capable) {
        const accounts = await accountsOf(wallet, true).catch(() => []);
        const account = accounts.find((entry) => entry.address === address);
        if (account) return { wallet, account };
        if (!other && accounts[0]) other = { wallet, account: accounts[0] };
    }

    // One wallet, not authorised yet: it may prompt, and that is the one to ask.
    if (!other && capable.length === 1) {
        const wallet = capable[0]!;
        let accounts: readonly WalletAccount[];
        try {
            accounts = await accountsOf(wallet, false);
        } catch {
            throw new WalletError(`${wallet.name} did not connect.`, 'not-connected', wallet.name);
        }
        const account = accounts.find((entry) => entry.address === address);
        if (account) return { wallet, account };
        if (accounts[0]) other = { wallet, account: accounts[0] };
    }

    if (other) throw mismatch(other.wallet, other.account, address);
    throw new WalletError(
        `Connect the wallet holding ${short(address)} to this site, then try again.`,
        'not-connected',
    );
}

/** Hands the base64 wire transaction to the wallet, and returns its signature in base58. */
export async function signAndSend(
    { wallet, account }: Signer,
    chain: SolanaChain,
    transaction: string,
): Promise<string> {
    const bytes = Uint8Array.from(atob(transaction), (char) => char.charCodeAt(0));
    const feature = getWalletFeature(wallet, 'solana:signAndSendTransaction') as SignAndSendFeature;
    let output;
    try {
        [output] = await feature.signAndSendTransaction({ account, chain, transaction: bytes });
    } catch (refusal) {
        const detail = refusal instanceof Error ? refusal.message : String(refusal);
        throw new WalletError(
            `${wallet.name} did not send the transaction. It said: ${detail}`,
            'rejected',
            wallet.name,
        );
    }
    if (!output) {
        throw new WalletError(`${wallet.name} returned no signature.`, 'no-signature', wallet.name);
    }
    return getBase58Decoder().decode(output.signature);
}
