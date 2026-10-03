import type { UiWallet } from '@wallet-standard/react';
import type { ReactNode } from 'react';
import { INSTALL_ICONS } from './brand';
import type { DialogScreen } from './dialog';
import { explorerUrl } from './format';
import { isSolanaWallet, lacking, usable, type Purpose, type SolanaChain } from './wallet';

const LAST_WALLET_KEY = 'mesub:last-wallet';

function lastWallet(): string | null {
    try {
        return localStorage.getItem(LAST_WALLET_KEY);
    } catch {
        return null;
    }
}

export function rememberWallet(name: string) {
    try {
        localStorage.setItem(LAST_WALLET_KEY, name);
    } catch {
        // Storage refused: the badge is a nicety.
    }
}

export function Hero({ kind, icon }: { kind: string; icon?: string | null | undefined }) {
    return (
        <div data-mesub-hero={kind} aria-hidden="true">
            {icon ? <img src={icon} alt="" width={56} height={56} /> : null}
        </div>
    );
}

export function Explorer({
    signature,
    chain,
    label,
}: {
    signature: string;
    chain: SolanaChain;
    label: string;
}) {
    return (
        <a
            data-mesub-explorer=""
            href={explorerUrl(signature, chain)}
            target="_blank"
            rel="noopener"
        >
            {label}
        </a>
    );
}

/** Whose plan it is, above its name. */
export function Merchant({
    name,
    logoUrl,
    testNetwork,
}: {
    name: string;
    logoUrl: string | null;
    testNetwork: boolean;
}) {
    return (
        <div data-mesub-merchant="">
            {logoUrl ? <img src={logoUrl} alt="" width={56} height={56} /> : null}
            <strong>{name}</strong>
            {testNetwork ? <span data-mesub-network="devnet">Test network</span> : null}
        </div>
    );
}

export type WalletView =
    | { name: 'list' }
    | { name: 'waiting'; wallet: UiWallet }
    | { name: 'rejected'; wallet: UiWallet; message: string };

/** The wallet step: the installed wallets, then waiting on one, or its refusal. */
export function walletScreen({
    titleId,
    view,
    wallets,
    purpose,
    lead,
    step = 'wallet',
    setView,
    pick,
    onBack,
}: {
    titleId: string;
    view: WalletView;
    // Every installed wallet: the ones that cannot do it are named, not hidden.
    wallets: readonly UiWallet[];
    purpose: Purpose;
    lead: string;
    step?: string;
    setView(view: WalletView): void;
    pick(wallet: UiWallet): void;
    onBack(): void;
}): DialogScreen {
    const toList = () => setView({ name: 'list' });

    if (view.name === 'waiting') {
        return {
            step,
            view: 'wallet-waiting',
            onBack: toList,
            body: (
                <>
                    <Hero kind="wait" icon={view.wallet.icon} />
                    <h2 id={titleId}>Approve in {view.wallet.name}</h2>
                    <p>Check the {view.wallet.name} window.</p>
                    <button type="button" data-mesub-back="" onClick={toList}>
                        Use another wallet
                    </button>
                </>
            ),
        };
    }

    if (view.name === 'rejected') {
        return {
            step,
            view: 'wallet-rejected',
            onBack: toList,
            body: (
                <>
                    <Hero kind="error" icon={view.wallet.icon} />
                    <h2 id={titleId}>Request rejected</h2>
                    <p role="alert" data-mesub-error="">
                        {view.message}
                    </p>
                    <button type="button" data-mesub-submit="" onClick={() => pick(view.wallet)}>
                        Try again
                    </button>
                    <button type="button" data-mesub-back="" onClick={toList}>
                        Use another wallet
                    </button>
                </>
            ),
        };
    }

    const solana = wallets.filter(isSolanaWallet);
    const capable = solana.filter((wallet) => usable(wallet, purpose));
    const unable = solana.filter((wallet) => !usable(wallet, purpose));
    const reload = (
        <button type="button" data-mesub-reload="" onClick={() => window.location.reload()}>
            Reload
        </button>
    );

    if (solana.length === 0) {
        return {
            step,
            view: 'wallet-none',
            onBack,
            body: (
                <>
                    <Hero kind="empty" />
                    <h2 id={titleId}>No Solana wallet found</h2>
                    <p>Install one, then reload this page.</p>
                    <div data-mesub-no-wallet="">
                        <a
                            data-mesub-install=""
                            href="https://phantom.com"
                            target="_blank"
                            rel="noopener"
                        >
                            <img src={INSTALL_ICONS.Phantom} alt="" width={28} height={28} />
                            Phantom<span>Install</span>
                        </a>
                        <a
                            data-mesub-install=""
                            href="https://solflare.com"
                            target="_blank"
                            rel="noopener"
                        >
                            <img src={INSTALL_ICONS.Solflare} alt="" width={28} height={28} />
                            Solflare<span>Install</span>
                        </a>
                    </div>
                    {reload}
                </>
            ),
        };
    }

    // Installed, but missing what this takes: say which, and what it lacks.
    const cannot = unable.map(
        (wallet) => `${wallet.name} cannot ${lacking(wallet, purpose).join(' or ')}.`,
    );

    if (capable.length === 0) {
        return {
            step,
            view: 'wallet-unable',
            onBack,
            body: (
                <>
                    <Hero kind="empty" />
                    <h2 id={titleId}>This wallet cannot do it</h2>
                    <p>Use a wallet that can, such as Phantom or Solflare, then reload.</p>
                    <p role="alert" data-mesub-error="">
                        {cannot.join(' ')}
                    </p>
                    {reload}
                </>
            ),
        };
    }

    const last = lastWallet();
    return {
        step,
        view: 'wallet-list',
        onBack,
        body: (
            <>
                <h2 id={titleId}>Connect a wallet</h2>
                <p>{lead}</p>
                <ul data-mesub-wallets="" aria-label="Wallets in this browser">
                    {capable.map((wallet) => (
                        <li key={wallet.name}>
                            <button
                                type="button"
                                data-mesub-wallet={wallet.name}
                                onClick={() => pick(wallet)}
                            >
                                <img src={wallet.icon} alt="" width={28} height={28} />
                                {wallet.name}
                                {wallet.name === last ? (
                                    <span data-mesub-badge="">Last used</span>
                                ) : null}
                            </button>
                        </li>
                    ))}
                </ul>
                {cannot.length > 0 ? (
                    <p data-mesub-notice="" role="note">
                        {cannot.join(' ')}
                    </p>
                ) : null}
            </>
        ),
    };
}

/**
 * What went wrong, on the step it happened on. `moved` is the line that says
 * whether anything left the wallet: `safe` only when nothing can have landed.
 */
export interface Failure {
    step: string;
    title: string;
    message: ReactNode;
    moved: 'safe' | 'pending' | null;
    // The one primary action.
    action: 'retry' | 'check' | 'close' | 'wallet';
    // The wallet's icon where the wallet failed, the merchant's elsewhere.
    icon: 'wallet' | 'merchant';
}

const PRIMARY: Record<Exclude<Failure['action'], 'close'>, string> = {
    retry: 'Try again',
    check: 'Check again',
    wallet: 'Use another wallet',
};

export function failureScreen({
    failure,
    titleId,
    icon,
    safe,
    pending,
    signature,
    chain,
    busy,
    onAct,
    onBack,
    backLabel,
}: {
    failure: Failure;
    titleId: string;
    icon: string | null | undefined;
    // The two money lines, in the flow's own words.
    safe: string;
    pending: string;
    signature: string | null;
    chain: SolanaChain;
    busy: boolean;
    onAct(action: Failure['action']): void;
    // Leaves the failure for the screen before it. None while something may still land.
    onBack?: (() => void) | undefined;
    backLabel: string;
}): DialogScreen {
    const back = failure.moved === 'pending' ? undefined : onBack;
    return {
        step: failure.step,
        view: `${failure.step}-failed-${failure.title}`,
        onBack: back,
        body: (
            <>
                <Hero kind={failure.moved === 'pending' ? 'pending' : 'error'} icon={icon} />
                <h2 id={titleId}>{failure.title}</h2>
                <p role="alert" data-mesub-error="">
                    {failure.message}
                </p>
                {failure.moved === 'safe' ? (
                    <p data-mesub-funds="safe">{safe}</p>
                ) : failure.moved === 'pending' ? (
                    <p data-mesub-funds="pending">{pending}</p>
                ) : null}
                {failure.moved === 'pending' && signature ? (
                    <Explorer signature={signature} chain={chain} label="View transaction" />
                ) : null}
                {failure.action === 'close' ? (
                    <button type="button" data-mesub-done="" onClick={() => onAct('close')}>
                        Close
                    </button>
                ) : (
                    <button
                        type="button"
                        data-mesub-submit=""
                        disabled={busy}
                        aria-busy={busy || undefined}
                        onClick={() => onAct(failure.action)}
                    >
                        {PRIMARY[failure.action]}
                    </button>
                )}
                {back && failure.action === 'retry' ? (
                    <button type="button" data-mesub-back="" onClick={back}>
                        {backLabel}
                    </button>
                ) : null}
            </>
        ),
    };
}

/** A 401: nobody is signed in on the merchant's site, so there is nothing to sign. */
export function signedOutScreen({
    titleId,
    step,
    message,
    safe,
    onClose,
}: {
    titleId: string;
    step: string;
    message: string;
    safe: string;
    onClose(): void;
}): DialogScreen {
    return {
        step,
        view: 'signed-out',
        body: (
            <>
                <Hero kind="error" />
                <h2 id={titleId}>Sign in first</h2>
                <p role="alert" data-mesub-error="">
                    {message}
                </p>
                <p data-mesub-funds="safe">{safe}</p>
                <button type="button" data-mesub-done="" onClick={onClose}>
                    Close
                </button>
            </>
        ),
    };
}
