import { vi } from 'vitest';

/**
 * A fake Wallet Standard wallet, registered the way a real extension does it:
 * through the window events `@wallet-standard/app` listens to. No module mock,
 * so the modal's own `useWallets()` finds it.
 */

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+';

export interface FakeAccount {
    address: string;
    publicKey: Uint8Array;
    chains: readonly string[];
    features: readonly string[];
}

export interface FakeWalletOptions {
    name?: string;
    chains?: string[];
    // Feature names to leave out, to fake a wallet that cannot sign.
    without?: string[];
    address?: string;
    // Already authorised on this site.
    connected?: boolean;
    signature?: Uint8Array;
}

type Register = (wallet: object) => () => void;
type RegisterCallback = (api: { register: Register }) => void;

const unregisters: (() => void)[] = [];

export function registerWallet(options: FakeWalletOptions = {}) {
    const chains = options.chains ?? ['solana:mainnet', 'solana:devnet'];
    const names = [
        'standard:connect',
        'standard:disconnect',
        'solana:signMessage',
        'solana:signAndSendTransaction',
    ].filter((name) => !options.without?.includes(name));
    const account: FakeAccount = {
        address: options.address ?? 'Wa11et1111111111111111111111111111111111111',
        publicKey: new Uint8Array(32),
        chains,
        features: names.filter((name) => name.startsWith('solana:')),
    };
    const signature = options.signature ?? new Uint8Array(64).fill(7);

    const wallet = {
        version: '1.0.0' as const,
        name: options.name ?? 'Fake Wallet',
        icon: ICON,
        chains,
        accounts: options.connected ? [account] : ([] as FakeAccount[]),
        features: {} as Record<string, object>,
    };
    const connect = vi.fn(async () => {
        wallet.accounts = [account];
        return { accounts: wallet.accounts };
    });
    const disconnect = vi.fn(async () => {
        wallet.accounts = [];
    });
    const signMessage = vi.fn(async (...inputs: { account: FakeAccount; message: Uint8Array }[]) =>
        inputs.map((input) => ({ signedMessage: input.message, signature })),
    );

    const signAndSendTransaction = vi.fn(
        async (
            ...inputs: { account: FakeAccount; chain: string; transaction: Uint8Array }[]
        ): Promise<{ signature: Uint8Array }[]> => inputs.map(() => ({ signature })),
    );

    const all: Record<string, object> = {
        'standard:connect': { version: '1.0.0', connect },
        'standard:disconnect': { version: '1.0.0', disconnect },
        'solana:signMessage': { version: '1.0.0', signMessage },
        'solana:signAndSendTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signAndSendTransaction,
        },
    };
    for (const name of names) wallet.features[name] = all[name]!;

    // Both halves of the handshake: the app may or may not be listening yet.
    let unregister: (() => void) | undefined;
    const callback: RegisterCallback = ({ register }) => {
        unregister ??= register(wallet);
    };
    const onAppReady = (event: Event) => callback((event as CustomEvent).detail);
    window.addEventListener('wallet-standard:app-ready', onAppReady);
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: callback }));

    unregisters.push(() => {
        window.removeEventListener('wallet-standard:app-ready', onAppReady);
        unregister?.();
    });
    return { wallet, account, signature, connect, disconnect, signMessage, signAndSendTransaction };
}

/** Removes every wallet registered by the test. */
export function unregisterWallets() {
    while (unregisters.length > 0) unregisters.pop()!();
}
