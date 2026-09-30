import { getBase58Decoder } from '@solana/kit';
import { getWalletFeature, type UiWallet } from '@wallet-standard/react';

// The few Wallet Standard shapes used here, read off the wallet itself.
interface WalletAccount {
    readonly address: string;
    readonly chains: readonly string[];
}

interface ConnectFeature {
    connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}

interface SignMessageFeature {
    signMessage(
        ...inputs: { account: WalletAccount; message: Uint8Array }[]
    ): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
}

const isSolana = (chain: string) => chain.startsWith('solana:');

/** A wallet that can hand over a Solana account and sign the proof. */
export function canSignIn(wallet: UiWallet): boolean {
    return (
        wallet.chains.some(isSolana) &&
        wallet.features.includes('standard:connect') &&
        wallet.features.includes('solana:signMessage')
    );
}

/** Asks the wallet for its Solana account. Null when it shares none. */
export async function connectAccount(wallet: UiWallet): Promise<WalletAccount | null> {
    // Never `standard:disconnect` first: on a dApp it would also sign the
    // subscriber out of the merchant's own wallet connection, which shares
    // this origin. An authorised wallet hands back its authorised account.
    // Called as methods: a wallet may rely on `this`.
    const feature = getWalletFeature(wallet, 'standard:connect') as ConnectFeature;
    const { accounts } = await feature.connect();
    return accounts.find((account) => account.chains.some(isSolana)) ?? null;
}

/** Signs the text's UTF-8 bytes and returns the signature in base58. */
export async function signText(
    wallet: UiWallet,
    account: WalletAccount,
    text: string,
): Promise<string> {
    const feature = getWalletFeature(wallet, 'solana:signMessage') as SignMessageFeature;
    const [output] = await feature.signMessage({
        account,
        message: new TextEncoder().encode(text),
    });
    if (!output) throw new Error('The wallet returned no signature');
    return getBase58Decoder().decode(output.signature);
}
