import { useWallets, type UiWallet } from '@wallet-standard/react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useMesubInternal } from './context';
import { MesubClientError } from './errors';
import type { WalletProof } from './types';
import { canSignIn, connectAccount, signText } from './wallet';

type Step =
    | { name: 'email' }
    | { name: 'code' }
    | { name: 'wallet'; sessionToken: string; refreshToken: string };

/** What a failed step says: the API's own words, or a fallback. */
function messageOf(error: unknown): string {
    if (error instanceof MesubClientError) return error.message;
    return 'Something went wrong. Try again.';
}

/** Rendered by the provider while a login() waits. Unmounting drops its state. */
export function SignInModal() {
    const { signingIn } = useMesubInternal();
    return signingIn ? <SignIn /> : null;
}

function SignIn() {
    const { api, completeSignIn, cancelSignIn } = useMesubInternal();
    const dialog = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    // Closed mid-request: a late answer must not sign anyone in.
    const alive = useRef(true);

    const [step, setStep] = useState<Step>({ name: 'email' });
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    // Layout effect: runs before the focus effect below, so showModal() does
    // not take the focus back from the first field.
    useLayoutEffect(() => {
        const node = dialog.current;
        if (node && !node.open) {
            if (typeof node.showModal === 'function') node.showModal();
            else node.setAttribute('open', '');
        }
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    // The first field of each step, or its first wallet: the Close button is last.
    useEffect(() => {
        dialog.current?.querySelector<HTMLElement>('input, button')?.focus();
    }, [step.name]);

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
            go({ name: 'code' });
        });
    }

    function resendCode() {
        void run(async () => {
            await api.sendCode(email.trim());
            if (alive.current) setNotice('We sent a new code.');
        });
    }

    function checkCode(event: FormEvent) {
        event.preventDefault();
        void run(async () => {
            const session = await api.createSession(email.trim(), code.trim());
            if (!alive.current) return;
            const { user, refreshToken, accessToken } = session;
            // A returning subscriber: the wallet is already proved.
            if (accessToken && user.walletAddress) {
                completeSignIn({ user, refreshToken, accessToken });
                return;
            }
            go({ name: 'wallet', sessionToken: session.sessionToken, refreshToken });
        });
    }

    return (
        <dialog
            ref={dialog}
            aria-labelledby={titleId}
            aria-modal="true"
            data-mesub-dialog=""
            data-mesub-step={step.name}
            onCancel={(event) => {
                // Escape: the provider unmounts the dialog, not the browser.
                event.preventDefault();
                cancelSignIn();
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelSignIn();
                }
            }}
        >
            {step.name === 'email' ? (
                <form onSubmit={sendCode} data-mesub-form="email">
                    <h2 id={titleId}>Sign in</h2>
                    <p>Enter your email: we will send you a 6-digit code.</p>
                    <label>
                        Email
                        <input
                            type="email"
                            name="email"
                            autoComplete="email"
                            required
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            data-mesub-input="email"
                        />
                    </label>
                    <Feedback error={error} notice={notice} />
                    <button type="submit" disabled={busy} data-mesub-submit="">
                        Send the code
                    </button>
                </form>
            ) : null}

            {step.name === 'code' ? (
                <form onSubmit={checkCode} data-mesub-form="code">
                    <h2 id={titleId}>Check your email</h2>
                    <p>We sent a 6-digit code to {email.trim()}.</p>
                    <label>
                        Code
                        <input
                            type="text"
                            name="code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            required
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            data-mesub-input="code"
                        />
                    </label>
                    <Feedback error={error} notice={notice} />
                    <button type="submit" disabled={busy} data-mesub-submit="">
                        Continue
                    </button>
                    <button type="button" disabled={busy} onClick={resendCode} data-mesub-resend="">
                        Send the code again
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => go({ name: 'email' })}
                        data-mesub-back=""
                    >
                        Back
                    </button>
                </form>
            ) : null}

            {step.name === 'wallet' ? (
                <WalletStep
                    titleId={titleId}
                    onBack={() => {
                        // The code is spent: going back means another email, or a new code.
                        setCode('');
                        go({ name: 'email' });
                    }}
                    onSigned={(proof) => {
                        if (!alive.current) return;
                        completeSignIn({
                            user: proof.user,
                            refreshToken: step.refreshToken,
                            accessToken: proof.accessToken,
                        });
                    }}
                    prove={async (address, sign) => {
                        const { message } = await api.walletChallenge(step.sessionToken, address);
                        const signature = await sign(message);
                        return api.proveWallet(step.sessionToken, { address, signature });
                    }}
                />
            ) : null}

            <button type="button" onClick={cancelSignIn} data-mesub-close="">
                Close
            </button>
        </dialog>
    );
}

function Feedback({ error, notice }: { error: string; notice: string }) {
    return (
        <>
            {error ? (
                <p role="alert" data-mesub-error="">
                    {error}
                </p>
            ) : null}
            {notice ? (
                <p role="status" data-mesub-notice="">
                    {notice}
                </p>
            ) : null}
        </>
    );
}

// The signature step's own marker: a wallet error, not the API's.
class WalletRefusal extends Error {}

function WalletStep({
    titleId,
    onBack,
    onSigned,
    prove,
}: {
    titleId: string;
    onBack(): void;
    onSigned(proof: WalletProof): void;
    // Challenge, sign, prove: `sign` is the wallet's part.
    prove(address: string, sign: (message: string) => Promise<string>): Promise<WalletProof>;
}) {
    const wallets = useWallets().filter(canSignIn);
    const [busy, setBusy] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [error, setError] = useState('');

    // Back is disabled meanwhile: only a close unmounts this mid-flow, and the
    // parent drops a late proof then.
    async function pick(wallet: UiWallet) {
        setBusy(true);
        setError('');
        try {
            let account;
            try {
                account = await connectAccount(wallet);
            } catch {
                throw new WalletRefusal(`${wallet.name} did not connect.`);
            }
            if (!account) throw new WalletRefusal(`${wallet.name} shared no Solana account.`);

            const proof = await prove(account.address, async (message) => {
                setWaiting(true);
                try {
                    return await signText(wallet, account, message);
                } catch (refusal) {
                    const detail = refusal instanceof Error ? refusal.message : String(refusal);
                    throw new WalletRefusal(`${wallet.name} did not sign. It said: ${detail}`);
                } finally {
                    setWaiting(false);
                }
            });
            onSigned(proof);
        } catch (failure) {
            setError(failure instanceof WalletRefusal ? failure.message : messageOf(failure));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div data-mesub-form="wallet">
            <h2 id={titleId}>Connect your wallet</h2>
            <p>Sign a message to prove the wallet is yours. It costs nothing and moves nothing.</p>
            {wallets.length === 0 ? (
                <p data-mesub-no-wallet="">
                    No Solana wallet found in this browser. Install one, such as Phantom or
                    Solflare, then reload this page.
                </p>
            ) : (
                <ul data-mesub-wallets="">
                    {wallets.map((wallet) => (
                        <li key={wallet.name}>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => void pick(wallet)}
                                data-mesub-wallet={wallet.name}
                            >
                                <img src={wallet.icon} alt="" width={24} height={24} />
                                {wallet.name}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {waiting ? (
                <p role="status" data-mesub-notice="">
                    Waiting for the signature in your wallet.
                </p>
            ) : null}
            <Feedback error={error} notice="" />
            <button type="button" disabled={busy} onClick={onBack} data-mesub-back="">
                Back
            </button>
        </div>
    );
}
