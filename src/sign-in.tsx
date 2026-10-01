import { useWallets, type UiWallet } from '@wallet-standard/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { INSTALL_ICONS } from './brand';
import { useMesubInternal } from './context';
import type { DialogScreen } from './dialog';
import { MesubClientError } from './errors';
import { TIMING } from './timing';
import type { MesubSession, WalletProof } from './types';
import { canSignIn, connectAccount, signText } from './wallet';

const CODE_LENGTH = 6;
const LAST_WALLET_KEY = 'mesub:last-wallet';

/** Who the subscriber is signing in for, shown above the email field. */
export interface SignInMerchant {
    name: string;
    logoUrl: string | null;
}

export type WalletView =
    | { name: 'list' }
    | { name: 'waiting'; wallet: UiWallet }
    | { name: 'rejected'; wallet: UiWallet; message: string }
    // The API refused: a wallet held by another account, or anything else.
    | { name: 'taken'; wallet: UiWallet; message: string }
    | { name: 'failed'; wallet: UiWallet; message: string };

type Step =
    | { name: 'email' }
    | { name: 'code' }
    | { name: 'wallet'; sessionToken: string; refreshToken: string; view: WalletView };

/** What a failed step says: the API's own words, or a fallback. */
function messageOf(error: unknown): string {
    if (error instanceof MesubClientError) return error.message;
    return 'Something went wrong. Try again.';
}

// The API's words for a code that can no longer be used: only a new one helps.
const SPENT_CODE = /expired|new code|too many/i;

function lastWallet(): string | null {
    try {
        return localStorage.getItem(LAST_WALLET_KEY);
    } catch {
        return null;
    }
}

function rememberWallet(name: string) {
    try {
        localStorage.setItem(LAST_WALLET_KEY, name);
    } catch {
        // Storage refused: the badge is a nicety.
    }
}

/**
 * Email, code, wallet: the sign-in, as the screen to show in whichever dialog
 * hosts it. `onSignedIn` gets a session with a proved wallet and an access token.
 */
export function useSignIn({
    titleId,
    merchant,
    onSignedIn,
}: {
    titleId: string;
    merchant?: SignInMerchant | null | undefined;
    onSignedIn(session: MesubSession): void;
}): DialogScreen {
    const { api } = useMesubInternal();
    const wallets = useWallets().filter(canSignIn);
    // Closed mid-request: a late answer must not sign anyone in.
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const [step, setStep] = useState<Step>({ name: 'email' });
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [verified, setVerified] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [focused, setFocused] = useState(false);
    const [resendIn, setResendIn] = useState(0);

    // One tick a second while a resend is held back.
    useEffect(() => {
        if (resendIn <= 0) return;
        const timer = setTimeout(() => setResendIn((left) => left - 1), 1000);
        return () => clearTimeout(timer);
    }, [resendIn]);

    function go(next: Step) {
        setError('');
        setNotice('');
        setStep(next);
    }

    // Runs one request with the busy flag and the step's error.
    async function run(task: () => Promise<void>) {
        setBusy(true);
        setError('');
        setNotice('');
        try {
            await task();
        } catch (failure) {
            if (alive.current) setError(messageOf(failure));
        } finally {
            if (alive.current) setBusy(false);
        }
    }

    function sendCode(event: FormEvent) {
        event.preventDefault();
        void run(async () => {
            await api.sendCode(email.trim());
            if (!alive.current) return;
            setCode('');
            setResendIn(TIMING.resendS);
            go({ name: 'code' });
        });
    }

    function resendCode() {
        void run(async () => {
            await api.sendCode(email.trim());
            if (!alive.current) return;
            setCode('');
            setResendIn(TIMING.resendS);
            setNotice('We sent a new code.');
        });
    }

    function checkCode(value: string) {
        void run(async () => {
            const session = await api.createSession(email.trim(), value);
            if (!alive.current) return;
            setVerified(true);
            await new Promise((resolve) => setTimeout(resolve, TIMING.verifiedMs));
            if (!alive.current) return;
            setVerified(false);
            const { user, refreshToken, accessToken } = session;
            // A returning subscriber: the wallet is already proved.
            if (accessToken && user.walletAddress) {
                onSignedIn({ user, refreshToken, accessToken });
                return;
            }
            go({
                name: 'wallet',
                sessionToken: session.sessionToken,
                refreshToken,
                view: { name: 'list' },
            });
        });
    }

    function typeCode(raw: string) {
        const value = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
        setCode(value);
        setError('');
        setNotice('');
        // No Continue button: the sixth digit sends it.
        if (value.length === CODE_LENGTH && !busy) checkCode(value);
    }

    if (step.name === 'wallet') {
        return walletScreen({
            titleId,
            view: step.view,
            wallets,
            setView: (view) => setStep({ ...step, view }),
            pick: (wallet) => void pickWallet(wallet, step),
            // The code is spent: back to the email, where a new one is sent.
            onBack: () => {
                setCode('');
                go({ name: 'email' });
            },
        });
    }

    async function pickWallet(wallet: UiWallet, current: Extract<Step, { name: 'wallet' }>) {
        const proof = await proveOwnership(
            wallet,
            {
                challenge: (address) => api.walletChallenge(current.sessionToken, address),
                prove: (signed) => api.proveWallet(current.sessionToken, signed),
            },
            (next) => alive.current && setStep({ ...current, view: next }),
        );
        if (!proof || !alive.current) return;
        onSignedIn({
            user: proof.user,
            refreshToken: current.refreshToken,
            accessToken: proof.accessToken,
        });
    }

    if (step.name === 'code') {
        const spent = SPENT_CODE.test(error);
        const slots = Array.from({ length: CODE_LENGTH }, (_, index) => {
            const digit = code[index];
            if (verified) return { state: 'ok', digit };
            if (digit !== undefined) return { state: 'filled', digit };
            return { state: focused && index === code.length ? 'active' : 'empty', digit };
        });
        const resend = (
            <p>
                Didn’t get it?{' '}
                <button
                    type="button"
                    data-mesub-resend=""
                    disabled={busy || resendIn > 0}
                    onClick={resendCode}
                >
                    {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
                </button>
            </p>
        );
        return {
            step: 'code',
            view: 'code',
            onBack: () => {
                setCode('');
                go({ name: 'email' });
            },
            body: (
                <>
                    <div data-mesub-hero="mail" aria-hidden="true" />
                    <h2 id={titleId}>Enter the code</h2>
                    <p>
                        Sent to <strong>{email.trim()}</strong>
                    </p>
                    <form
                        data-mesub-form=""
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (code.length === CODE_LENGTH) checkCode(code);
                        }}
                    >
                        <div data-mesub-otp="" aria-busy={(busy && !notice) || undefined}>
                            <input
                                type="text"
                                name="code"
                                aria-label="6-digit code"
                                data-mesub-input="code"
                                autoComplete="one-time-code"
                                inputMode="numeric"
                                maxLength={CODE_LENGTH}
                                value={code}
                                aria-invalid={error ? true : undefined}
                                onChange={(event) => typeCode(event.target.value)}
                                onFocus={() => setFocused(true)}
                                onBlur={() => setFocused(false)}
                            />
                            <div data-mesub-slots="" aria-hidden="true">
                                {slots.map((slot, index) => (
                                    <span key={index} data-mesub-slot={slot.state}>
                                        {slot.digit}
                                    </span>
                                ))}
                            </div>
                        </div>
                        {verified ? (
                            <p data-mesub-notice="" role="status">
                                Verified
                            </p>
                        ) : busy && code.length === CODE_LENGTH ? (
                            <p data-mesub-notice="" role="status" aria-busy="true">
                                Checking
                            </p>
                        ) : notice ? (
                            <p data-mesub-notice="" role="status">
                                {notice}
                            </p>
                        ) : error ? (
                            <>
                                <span role="alert" data-mesub-error="">
                                    {error}
                                </span>
                                {spent ? (
                                    <button
                                        type="button"
                                        data-mesub-submit=""
                                        disabled={busy}
                                        onClick={resendCode}
                                    >
                                        Send a new code
                                    </button>
                                ) : (
                                    resend
                                )}
                            </>
                        ) : (
                            resend
                        )}
                    </form>
                </>
            ),
        };
    }

    return {
        step: 'email',
        view: 'email',
        body: (
            <>
                {merchant ? <Merchant merchant={merchant} /> : null}
                <h2 id={titleId}>{merchant ? 'Sign in to subscribe' : 'Sign in'}</h2>
                <p>We email you a 6-digit code.</p>
                <form data-mesub-form="" onSubmit={sendCode}>
                    <input
                        type="email"
                        name="email"
                        aria-label="Email"
                        data-mesub-input="email"
                        placeholder="you@example.com"
                        autoComplete="email"
                        required
                        value={email}
                        aria-invalid={error ? true : undefined}
                        onChange={(event) => setEmail(event.target.value)}
                    />
                    {error ? (
                        <span role="alert" data-mesub-error="">
                            {error}
                        </span>
                    ) : null}
                    <button
                        type="submit"
                        data-mesub-submit=""
                        disabled={busy}
                        aria-busy={busy || undefined}
                    >
                        {busy ? 'Sending' : 'Send me a code'}
                    </button>
                </form>
            </>
        ),
    };
}

export function Merchant({
    merchant,
    testNetwork = false,
}: {
    merchant: SignInMerchant;
    testNetwork?: boolean;
}) {
    return (
        <div data-mesub-merchant="">
            {merchant.logoUrl ? <img src={merchant.logoUrl} alt="" width={56} height={56} /> : null}
            <strong>{merchant.name}</strong>
            {testNetwork ? <span data-mesub-network="devnet">Test network</span> : null}
        </div>
    );
}

/**
 * Connects the wallet, signs the challenge and proves it, showing each step
 * through `view`. Null when the wallet refused or the API did, as shown.
 */
export async function proveOwnership(
    wallet: UiWallet,
    api: {
        challenge(address: string): Promise<{ message: string }>;
        prove(proof: { address: string; signature: string }): Promise<WalletProof>;
    },
    view: (next: WalletView) => void,
): Promise<WalletProof | null> {
    const refused = (message: string) => view({ name: 'rejected', wallet, message });
    view({ name: 'waiting', wallet });

    // The wallet's part fails as a refusal, in its own words.
    let account;
    try {
        account = await connectAccount(wallet);
    } catch (refusal) {
        refused(
            `${wallet.name} said: ${refusal instanceof Error ? refusal.message : 'it did not connect.'}`,
        );
        return null;
    }
    if (!account) {
        refused(`${wallet.name} shared no Solana account.`);
        return null;
    }
    try {
        const { message } = await api.challenge(account.address);
        let signature;
        try {
            signature = await signText(wallet, account, message);
        } catch (refusal) {
            refused(
                `${wallet.name} said: ${refusal instanceof Error ? refusal.message : String(refusal)}`,
            );
            return null;
        }
        const proof = await api.prove({ address: account.address, signature });
        rememberWallet(wallet.name);
        return proof;
    } catch (failure) {
        const message = messageOf(failure);
        const taken = failure instanceof MesubClientError && failure.status === 409;
        view({ name: taken ? 'taken' : 'failed', wallet, message });
        return null;
    }
}

/** The wallet step: the installed wallets, then waiting on one, or its refusal. */
export function walletScreen({
    titleId,
    view,
    wallets,
    setView,
    pick,
    onBack,
    title = 'Connect a wallet',
    step = 'wallet',
}: {
    titleId: string;
    view: WalletView;
    wallets: UiWallet[];
    setView(view: WalletView): void;
    pick(wallet: UiWallet): void;
    // From the list, or with no wallet installed.
    onBack(): void;
    title?: string;
    // The checkout keeps its own step, so the progress line stays put.
    step?: string;
}): DialogScreen {
    const toList = () => setView({ name: 'list' });

    if (view.name === 'waiting') {
        return {
            step,
            view: 'wallet-waiting',
            onBack: toList,
            body: (
                <>
                    <div data-mesub-hero="wait" aria-hidden="true">
                        <img src={view.wallet.icon} alt="" width={56} height={56} />
                    </div>
                    <h2 id={titleId}>Approve in {view.wallet.name}</h2>
                    <p>Check the {view.wallet.name} window.</p>
                    <button type="button" data-mesub-back="" onClick={toList}>
                        Use another wallet
                    </button>
                </>
            ),
        };
    }

    if (view.name === 'rejected' || view.name === 'taken' || view.name === 'failed') {
        const taken = view.name === 'taken';
        const title = taken
            ? 'Wallet already in use'
            : view.name === 'failed'
              ? 'Could not connect'
              : 'Request rejected';
        return {
            step,
            view: `wallet-${view.name}`,
            onBack: toList,
            body: (
                <>
                    <div data-mesub-hero="error" aria-hidden="true">
                        <img src={view.wallet.icon} alt="" width={56} height={56} />
                    </div>
                    <h2 id={titleId}>{title}</h2>
                    <p role="alert" data-mesub-error="">
                        {view.message}
                    </p>
                    {taken ? (
                        <button type="button" data-mesub-submit="" onClick={toList}>
                            Use another wallet
                        </button>
                    ) : (
                        <>
                            <button
                                type="button"
                                data-mesub-submit=""
                                onClick={() => pick(view.wallet)}
                            >
                                Try again
                            </button>
                            <button type="button" data-mesub-back="" onClick={toList}>
                                Use another wallet
                            </button>
                        </>
                    )}
                </>
            ),
        };
    }

    if (wallets.length === 0) {
        return {
            step,
            view: 'wallet-none',
            onBack,
            body: (
                <>
                    <div data-mesub-hero="empty" aria-hidden="true" />
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
                    <button
                        type="button"
                        data-mesub-reload=""
                        onClick={() => window.location.reload()}
                    >
                        Reload
                    </button>
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
                <h2 id={titleId}>{title}</h2>
                <p>Sign a message to prove it is yours. It is free.</p>
                <ul data-mesub-wallets="" aria-label="Wallets in this browser">
                    {wallets.map((wallet) => (
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
            </>
        ),
    };
}
