import { getBase58Decoder } from '@solana/kit';
import { getWalletFeature, type UiWallet } from '@wallet-standard/react';

// The few Wallet Standard shapes used here, read off the wallet itself.
export interface WalletAccount {
    readonly address: string;
    readonly chains: readonly string[];
}

interface ConnectFeature {
    connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}

interface SignMessageFeature {
    signMessage(
        ...inputs: { account: WalletAccount; message: Uint8Array }[]
    ): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
}

interface SignTransactionFeature {
    signTransaction(
        ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]
    ): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

interface SignAndSendFeature {
    signAndSendTransaction(
        ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]
    ): Promise<readonly { signature: Uint8Array }[]>;
}

/** A Wallet Standard chain, such as `solana:mainnet` or `solana:devnet`. */
export type SolanaChain = `solana:${string}`;

/** The wallet and the account of it that signs. */
export interface Signer {
    wallet: UiWallet;
    account: WalletAccount;
}

/**
 * Subscribing signs the terms, then the transaction without sending it: Mesub
 * co-signs and sends. Managing sends one transaction from the wallet itself.
 */
export type Purpose = 'subscribe' | 'manage';

const NEEDS: Record<Purpose, readonly string[]> = {
    subscribe: ['solana:signMessage', 'solana:signTransaction'],
    manage: ['solana:signAndSendTransaction'],
};

const IN_WORDS: Record<string, string> = {
    'solana:signMessage': 'sign a message',
    'solana:signTransaction': 'sign a transaction without sending it',
    'solana:signAndSendTransaction': 'send a transaction',
};

const isSolana = (chain: string) => chain.startsWith('solana:');

/** A wallet that can hand over a Solana account. */
export function isSolanaWallet(wallet: UiWallet): boolean {
    return wallet.chains.some(isSolana) && wallet.features.includes('standard:connect');
}

/** What the wallet cannot do for that purpose, in words. Empty when it can do it all. */
export function lacking(wallet: UiWallet, purpose: Purpose): string[] {
    return NEEDS[purpose]
        .filter((feature) => !(wallet.features as readonly string[]).includes(feature))
        .map((feature) => IN_WORDS[feature]!);
}

export function usable(wallet: UiWallet, purpose: Purpose): boolean {
    return isSolanaWallet(wallet) && lacking(wallet, purpose).length === 0;
}

/** The wallet said no, or answered nothing: shown in its own words. */
export class WalletError extends Error {
    constructor(
        message: string,
        readonly wallet: string,
    ) {
        super(message);
    }
}

const said = (wallet: UiWallet, refusal: unknown) =>
    `${wallet.name} said: ${refusal instanceof Error ? refusal.message : String(refusal)}`;

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/**
 * The wallet's Solana accounts. Never `standard:disconnect` first: on a dApp it
 * would also end the merchant's own wallet connection, which shares this origin.
 * Called as a method: a wallet may rely on `this`.
 */
export async function connectAccounts(
    wallet: UiWallet,
    silent = false,
): Promise<readonly WalletAccount[]> {
    const feature = getWalletFeature(wallet, 'standard:connect') as ConnectFeature;
    const { accounts } = await feature.connect(silent ? { silent: true } : undefined);
    return accounts.filter((account) => account.chains.some(isSolana));
}

/**
 * The installed wallet already showing `address` to this site, asked silently:
 * a wallet that is not authorised here shows no prompt. Null when none does.
 */
export async function findConnected(
    wallets: readonly UiWallet[],
    address: string,
    purpose: Purpose,
): Promise<Signer | null> {
    const shows = (wallet: UiWallet) => wallet.accounts.some((entry) => entry.address === address);
    const capable = wallets
        .filter((wallet) => usable(wallet, purpose))
        .sort((a, b) => Number(shows(b)) - Number(shows(a)));

    for (const wallet of capable) {
        const accounts = await connectAccounts(wallet, true).catch(() => []);
        const account = accounts.find((entry) => entry.address === address);
        if (account) return { wallet, account };
    }
    return null;
}

/** Signs the text's UTF-8 bytes and returns the signature in base58. */
export async function signText({ wallet, account }: Signer, text: string): Promise<string> {
    const feature = getWalletFeature(wallet, 'solana:signMessage') as SignMessageFeature;
    let output;
    try {
        [output] = await feature.signMessage({ account, message: new TextEncoder().encode(text) });
    } catch (refusal) {
        throw new WalletError(said(wallet, refusal), wallet.name);
    }
    if (!output) throw new WalletError(`${wallet.name} returned no signature.`, wallet.name);
    return getBase58Decoder().decode(output.signature);
}

/**
 * Has the wallet sign the base64 transaction WITHOUT sending it, and returns
 * it signed, in base64, with its id when the wallet is its first signer.
 */
export async function signOnly(
    { wallet, account }: Signer,
    chain: SolanaChain,
    transaction: string,
): Promise<{ transaction: string; signature: string | null }> {
    const feature = getWalletFeature(wallet, 'solana:signTransaction') as SignTransactionFeature;
    let output;
    try {
        [output] = await feature.signTransaction({
            account,
            chain,
            transaction: fromBase64(transaction),
        });
    } catch (refusal) {
        throw new WalletError(said(wallet, refusal), wallet.name);
    }
    if (!output) throw new WalletError(`${wallet.name} returned no transaction.`, wallet.name);
    return {
        transaction: toBase64(output.signedTransaction),
        signature: firstSignature(output.signedTransaction),
    };
}

/** Has the wallet sign AND send the base64 transaction, and returns its signature in base58. */
export async function signAndSend(
    { wallet, account }: Signer,
    chain: SolanaChain,
    transaction: string,
): Promise<string> {
    const feature = getWalletFeature(wallet, 'solana:signAndSendTransaction') as SignAndSendFeature;
    let output;
    try {
        [output] = await feature.signAndSendTransaction({
            account,
            chain,
            transaction: fromBase64(transaction),
        });
    } catch (refusal) {
        throw new WalletError(said(wallet, refusal), wallet.name);
    }
    if (!output) throw new WalletError(`${wallet.name} returned no signature.`, wallet.name);
    return getBase58Decoder().decode(output.signature);
}

/**
 * A transaction's id is its first signature: one count byte, then 64 bytes.
 * Null while that slot is empty, which is Mesub's to fill when it pays the fee.
 */
function firstSignature(wire: Uint8Array): string | null {
    const signature = wire.subarray(1, 65);
    if (signature.length < 64 || signature.every((byte) => byte === 0)) return null;
    return getBase58Decoder().decode(signature);
}
