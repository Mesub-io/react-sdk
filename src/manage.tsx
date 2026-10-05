import { useWallets, type UiWallet } from '@wallet-standard/react';
import { useEffect, useId, useRef, useState } from 'react';
import { signedOut } from './api';
import { useMesubInternal } from './context';
import { MesubDialog, type DialogScreen } from './dialog';
import { MesubClientError } from './errors';
import { moment, shortAddress } from './format';
import {
    Explorer,
    failureScreen,
    Hero,
    rememberWallet,
    signedOutScreen,
    walletScreen,
    type Failure,
    type WalletView,
} from './screens';
import type { MesubAction, MesubSubscription } from './types';
import { connectAccounts, findConnected, signAndSend, WalletError, type Signer } from './wallet';

export interface ManageProps {
    subscription: MesubSubscription;
    action: MesubAction;
    onClose(): void;
    // Something was sent or settled: the lists read again. Null when only the outcome is unknown.
    onChanged(subscription: MesubSubscription | null): void;
}

type View =
    | { name: 'confirm' }
    | { name: 'finding' }
    | { name: 'wallet'; pick: WalletView }
    | { name: 'building'; signer: Signer }
    | { name: 'approve'; signer: Signer }
    | { name: 'confirming'; signer: Signer; signature: string }
    | { name: 'done'; subscription: MesubSubscription; signature: string }
    | {
          name: 'failed';
          failure: Failure;
          signer: Signer | null;
          signature: string | null;
          icon: string | undefined;
      }
    | { name: 'signed-out' };

const FIND_TIMEOUT_MS = 4_000;
const SAFE = 'Nothing changed.';
const PENDING = 'The transaction may still land.';

const WORDS: Record<MesubAction, { ask: string; go: string; keep: string; done: string }> = {
    cancel: {
        ask: 'Cancel',
        go: 'Cancel subscription',
        keep: 'Keep it',
        done: 'Subscription cancelled',
    },
    resume: {
        ask: 'Resume',
        go: 'Resume subscription',
        keep: 'Not now',
        done: 'Subscription resumed',
    },
    close: { ask: 'Close', go: 'Close subscription', keep: 'Not now', done: 'Subscription closed' },
};

const messageOf = (error: unknown) =>
    error instanceof MesubClientError ? error.message : 'Something went wrong.';

/** What the action does, before anything is signed. */
function consequence(action: MesubAction, subscription: MesubSubscription): string {
    const until = moment(subscription.access_until ?? subscription.current_period_end);
    if (action === 'cancel') {
        return subscription.access && until
            ? `You keep access until ${until}. Nothing more is charged.`
            : 'It stops now. Nothing more is charged.';
    }
    if (action === 'resume') {
        return until
            ? `Charges start again on ${until}, as before.`
            : 'Charges start again, as before.';
    }
    return 'It is over. Closing it returns its deposit to your wallet.';
}

/** What it became, once Mesub confirmed. */
function outcome(action: MesubAction, subscription: MesubSubscription): string {
    const until = moment(subscription.access_until ?? subscription.current_period_end);
    if (action === 'cancel') {
        return subscription.access && until
            ? `You keep access until ${until}.`
            : 'Nothing more is charged.';
    }
    if (action === 'resume') {
        const next = moment(subscription.next_charge_at);
        return next ? `Next charge ${next}.` : 'It runs again.';
    }
    return 'Its deposit is back in your wallet.';
}

/**
 * The window that cancels, resumes or closes one subscription: the wallet that
 * pays it signs and sends one transaction, then the server confirms it.
 */
export function Manage({ subscription, action, onClose, onChanged }: ManageProps) {
    const { api, chain, plan: readPlan } = useMesubInternal();
    const wallets = useWallets();
    const titleId = useId();
    const words = WORDS[action];
    const payer = subscription.wallet;

    const [view, setViewState] = useState<View>({ name: 'confirm' });
    const [checking, setChecking] = useState(false);
    // The plan's name, when it can be read: its slug stands in until then.
    const [planName, setPlanName] = useState(subscription.plan ?? 'this subscription');

    const alive = useRef(true);
    const attempt = useRef(0);
    const shown = useRef<View>(view);
    const checkingNow = useRef(false);
    const latest = useRef({ wallets, onChanged });
    latest.current = { wallets, onChanged };

    function setView(next: View) {
        shown.current = next;
        setViewState(next);
    }

    function begin() {
        const id = ++attempt.current;
        return () => alive.current && id === attempt.current;
    }

    useEffect(() => {
        alive.current = true;
        if (subscription.plan) {
            readPlan(subscription.plan).then(
                (served) => alive.current && setPlanName(served.name),
                () => undefined,
            );
        }
        return () => {
            alive.current = false;
        };
        // Once per opening.
    }, []);

    function fail(
        failure: Failure,
        signer: Signer | null,
        signature: string | null = null,
        icon = signer?.wallet.icon,
    ) {
        setView({ name: 'failed', failure, signer, signature, icon });
    }

    // The wallet already showing the paying account signs; else the subscriber picks one.
    async function start() {
        if (shown.current.name !== 'confirm') return;
        const current = begin();
        setView({ name: 'finding' });
        // A wallet that never answers a silent connect must not hold the dialog.
        const signer = await Promise.race([
            findConnected(latest.current.wallets, payer, 'manage'),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), FIND_TIMEOUT_MS)),
        ]);
        if (!current()) return;
        if (signer) await run(signer);
        else setView({ name: 'wallet', pick: { name: 'list' } });
    }

    async function pick(wallet: UiWallet) {
        if (shown.current.name !== 'wallet' || shown.current.pick.name === 'waiting') return;
        const current = begin();
        setView({ name: 'wallet', pick: { name: 'waiting', wallet } });

        let accounts;
        try {
            accounts = await connectAccounts(wallet);
        } catch (refusal) {
            if (!current()) return;
            const message = `${wallet.name} said: ${refusal instanceof Error ? refusal.message : 'it did not connect.'}`;
            setView({ name: 'wallet', pick: { name: 'rejected', wallet, message } });
            return;
        }
        if (!current()) return;
        const account = accounts.find((entry) => entry.address === payer);
        if (!account) {
            // Not the wallet that pays this one: nothing is built, nothing is signed.
            const on = accounts[0]
                ? `${wallet.name} is on ${shortAddress(accounts[0].address)}`
                : `${wallet.name} shared no Solana account`;
            fail(
                {
                    step: 'wallet',
                    title: 'Wrong wallet',
                    message: `${on}, and this subscription is paid from ${shortAddress(payer)}. Switch to that account in your wallet, then try again.`,
                    moved: 'safe',
                    action: 'wallet',
                    icon: 'wallet',
                },
                null,
                null,
                wallet.icon,
            );
            return;
        }
        rememberWallet(wallet.name);
        await run({ wallet, account });
    }

    async function run(signer: Signer) {
        const current = begin();
        setView({ name: 'building', signer });
        let transaction;
        try {
            ({ transaction } = await api.build(action, subscription.id));
        } catch (error) {
            if (!current()) return;
            if (signedOut(error)) {
                setView({ name: 'signed-out' });
                return;
            }
            const refused = error instanceof MesubClientError && error.status !== null;
            fail(
                {
                    step: 'approve',
                    title: refused ? `Cannot ${action} it` : 'No answer',
                    message: messageOf(error),
                    moved: 'safe',
                    // Mesub's refusal is final for now; a silence is worth another try.
                    action: refused && error.status !== 429 ? 'close' : 'retry',
                    icon: 'wallet',
                },
                signer,
            );
            return;
        }
        if (!current()) return;

        setView({ name: 'approve', signer });
        let signature;
        try {
            // The wallet signs AND sends this one: Mesub signs nothing of it.
            signature = await signAndSend(signer, chain, transaction);
        } catch (error) {
            if (!current()) return;
            fail(
                {
                    step: 'approve',
                    title: 'Not approved',
                    message:
                        error instanceof WalletError
                            ? error.message
                            : `${signer.wallet.name} did not send it.`,
                    moved: 'safe',
                    action: 'retry',
                    icon: 'wallet',
                },
                signer,
            );
            return;
        }
        // Sent: whatever the dialog does next, the lists are out of date.
        latest.current.onChanged(null);
        if (!current()) return;
        await confirm(signer, signature);
    }

    // Also "Check again": the same confirm is answered the same, and sends nothing.
    async function confirm(signer: Signer, signature: string) {
        const current = begin();
        setView({ name: 'confirming', signer, signature });
        try {
            const settled = await api.confirm(action, subscription.id, signature);
            latest.current.onChanged(settled.reason ? null : settled.subscription);
            if (!current()) return;
            if (settled.reason) {
                fail(
                    {
                        step: 'confirming',
                        title: 'It did not go through',
                        message: settled.reason,
                        moved: 'safe',
                        action: 'retry',
                        icon: 'wallet',
                    },
                    signer,
                );
                return;
            }
            setView({ name: 'done', subscription: settled.subscription, signature });
        } catch (error) {
            if (!current()) return;
            if (signedOut(error)) {
                setView({ name: 'signed-out' });
                return;
            }
            const status = error instanceof MesubClientError ? error.status : null;
            const refused = status !== null && status < 500;
            fail(
                refused
                    ? {
                          step: 'confirming',
                          title: `Cannot ${action} it`,
                          message: messageOf(error),
                          moved: null,
                          action: 'close',
                          icon: 'wallet',
                      }
                    : {
                          step: 'confirming',
                          title: 'Still confirming',
                          message: `If ${signer.wallet.name} shows the transaction as sent, wait a minute, then check again.`,
                          moved: 'pending',
                          action: 'check',
                          icon: 'wallet',
                      },
                signer,
                signature,
            );
        }
    }

    async function checkAgain(signer: Signer, signature: string) {
        if (checkingNow.current) return;
        checkingNow.current = true;
        setChecking(true);
        try {
            await confirm(signer, signature);
        } finally {
            checkingNow.current = false;
            if (alive.current) setChecking(false);
        }
    }

    function toWallets() {
        attempt.current++;
        setView({ name: 'wallet', pick: { name: 'list' } });
    }

    function toConfirm() {
        attempt.current++;
        setView({ name: 'confirm' });
    }

    let screen: DialogScreen;
    if (view.name === 'signed-out') {
        screen = signedOutScreen({
            titleId,
            step: 'confirm',
            message: 'You are not signed in on this site. Sign in here first, then try again.',
            safe: SAFE,
            onClose,
        });
    } else if (view.name === 'wallet') {
        screen = walletScreen({
            titleId,
            view: view.pick,
            wallets,
            purpose: 'manage',
            lead: `The one that pays this subscription: ${shortAddress(payer)}.`,
            setView: (pickView) => {
                attempt.current++;
                setView({ name: 'wallet', pick: pickView });
            },
            pick: (wallet) => void pick(wallet),
            onBack: toConfirm,
        });
    } else if (view.name === 'failed') {
        const { failure, signer, signature } = view;
        screen = failureScreen({
            failure,
            titleId,
            icon: view.icon,
            safe: SAFE,
            pending: PENDING,
            signature,
            chain,
            busy: checking,
            onAct: (next) => {
                if (next === 'close') onClose();
                else if (next === 'check' && signer && signature) {
                    void checkAgain(signer, signature);
                } else if (next === 'wallet' || !signer) toWallets();
                else void run(signer);
            },
            onBack: toConfirm,
            backLabel: 'Back',
        });
    } else if (view.name === 'confirm') {
        screen = {
            step: 'confirm',
            view: 'confirm',
            body: (
                <>
                    <h2 id={titleId}>
                        {words.ask} {planName}?
                    </h2>
                    <p>{consequence(action, subscription)}</p>
                    <dl data-mesub-summary="">
                        <div data-mesub-row="">
                            <dt>Signed by</dt>
                            <dd title={payer}>{shortAddress(payer)}</dd>
                        </div>
                    </dl>
                    <button type="button" data-mesub-submit="" onClick={() => void start()}>
                        {words.go}
                    </button>
                    <button type="button" data-mesub-cancel="" onClick={onClose}>
                        {words.keep}
                    </button>
                </>
            ),
        };
    } else if (view.name === 'finding' || view.name === 'building') {
        screen = {
            step: 'wallet',
            view: view.name,
            onBack: toConfirm,
            body: (
                <>
                    <Hero
                        kind="wait"
                        icon={view.name === 'building' ? view.signer.wallet.icon : null}
                    />
                    <h2 id={titleId}>
                        {view.name === 'finding' ? 'Looking for your wallet' : 'Preparing'}
                    </h2>
                    <p data-mesub-notice="" role="status" aria-busy="true">
                        Nothing to sign yet
                    </p>
                </>
            ),
        };
    } else if (view.name === 'approve') {
        screen = {
            step: 'approve',
            view: 'approve',
            onBack: toConfirm,
            body: (
                <>
                    <Hero kind="wait" icon={view.signer.wallet.icon} />
                    <h2 id={titleId}>Approve in {view.signer.wallet.name}</h2>
                    <p>
                        One transaction, sent by your wallet. It pays nothing but the network fee.
                    </p>
                    <button type="button" data-mesub-cancel="" onClick={onClose}>
                        Cancel
                    </button>
                </>
            ),
        };
    } else if (view.name === 'confirming') {
        screen = {
            step: 'confirming',
            view: 'confirming',
            body: (
                <>
                    <Hero kind="wait" icon={view.signer.wallet.icon} />
                    <h2 id={titleId}>Confirming on Solana</h2>
                    <p>This can take up to a minute.</p>
                    <Explorer signature={view.signature} chain={chain} label="View transaction" />
                </>
            ),
        };
    } else {
        screen = {
            step: 'done',
            view: 'done',
            body: (
                <>
                    <Hero kind="check" />
                    <h2 id={titleId}>{words.done}</h2>
                    <p>{outcome(action, view.subscription)}</p>
                    <Explorer signature={view.signature} chain={chain} label="View transaction" />
                    <button type="button" data-mesub-done="" onClick={onClose}>
                        Done
                    </button>
                </>
            ),
        };
    }

    return <MesubDialog screen={screen} titleId={titleId} onClose={onClose} />;
}
