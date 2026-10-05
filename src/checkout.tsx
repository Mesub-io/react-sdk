import { useWallets, type UiWallet } from '@wallet-standard/react';
import { useEffect, useId, useRef, useState } from 'react';
import { signedOut, unreachable } from './api';
import { useMesubInternal, type SubscribeState } from './context';
import { MesubDialog, type DialogScreen } from './dialog';
import { MesubClientError } from './errors';
import {
    cadence,
    moment,
    formatDate,
    manageLink,
    shortAddress,
    termsCancelUrl,
    termsFacts,
} from './format';
import {
    Explorer,
    failureScreen,
    Hero,
    Merchant,
    rememberWallet,
    signedOutScreen,
    walletScreen,
    type Failure,
    type WalletView,
} from './screens';
import type { MesubPlan, MesubSubscription, PreparedSubscription } from './types';
import {
    connectAccounts,
    signOnly,
    signText,
    WalletError,
    type Signer,
    type SolanaChain,
} from './wallet';

export interface CheckoutProps {
    plan: string;
    onClose(): void;
    // Each state reached, for the button underneath.
    onState(state: SubscribeState): void;
    onSubscribed(subscription: MesubSubscription, signature: string | null): void;
}

type PlanState =
    { name: 'loading' } | { name: 'loaded'; plan: MesubPlan } | { name: 'failed'; error: unknown };

/** Where the checkout is. Everything after the wallet carries who signs. */
type View =
    | { name: 'plan' }
    | { name: 'wallet'; pick: WalletView }
    | { name: 'preparing'; signer: Signer }
    | { name: 'review'; signer: Signer; prepared: PreparedSubscription; notice: string | null }
    | { name: 'signing'; signer: Signer; what: 'terms' | 'transaction' }
    | { name: 'submitting'; signer: Signer; signature: string | null }
    | {
          name: 'subscribed';
          signer: Signer;
          subscription: MesubSubscription;
          signature: string | null;
          cancelUrl: string | null;
      }
    | { name: 'failed'; failure: Failure; signer: Signer | null; signature: string | null }
    | { name: 'signed-out' };

const SAFE = 'Nothing was charged.';
const PENDING = 'Payment may be pending.';
const FRESH_TERMS = 'The terms had expired. These are fresh: check them again.';

const STATES: Partial<Record<View['name'], SubscribeState>> = {
    signing: 'signing',
    submitting: 'confirming',
    subscribed: 'subscribed',
};

/** Past `expires_at`, or within a few seconds of it: not worth asking the wallet. */
function expired(prepared: PreparedSubscription): boolean {
    const until = Date.parse(prepared.terms.expires_at);
    return !Number.isNaN(until) && until - Date.now() < 5_000;
}

const messageOf = (error: unknown) =>
    error instanceof MesubClientError ? error.message : 'Something went wrong.';

/** `POST /subscriptions` refused, or never answered: nothing was signed yet. */
function notPrepared(error: unknown): Failure {
    const base = { step: 'review', moved: 'safe', icon: 'merchant' } as const;
    if (unreachable(error)) {
        return { ...base, title: 'No answer', message: messageOf(error), action: 'retry' };
    }
    const status = error instanceof MesubClientError ? error.status : null;
    if (status === 403) {
        return { ...base, title: 'Wrong wallet', message: messageOf(error), action: 'wallet' };
    }
    if (status === 404) {
        return { ...base, title: 'Plan not found', message: messageOf(error), action: 'close' };
    }
    // A return asked while its billing period turns: a wait, not a no.
    if (error instanceof MesubClientError && error.code === 'comeback_period_rolling') {
        return {
            ...base,
            title: 'Almost there',
            message: error.retryAfter
                ? `Your billing period is turning over. Try again in ${error.retryAfter} seconds.`
                : messageOf(error),
            action: 'retry',
        };
    }
    // Mesub's own refusal (already subscribed, plan closed): its words, as written.
    if (status === 409) {
        return { ...base, title: 'Cannot subscribe', message: messageOf(error), action: 'close' };
    }
    if (status === 429) {
        const wait = error instanceof MesubClientError ? error.retryAfter : null;
        return {
            ...base,
            title: 'Too many requests',
            message: wait ? `Try again in ${wait} seconds.` : messageOf(error),
            action: 'retry',
        };
    }
    return { ...base, title: 'Could not subscribe', message: messageOf(error), action: 'retry' };
}

/**
 * The window `useSubscribe` opens: the plan, a wallet, what it costs, the two
 * signatures, then Mesub sends. One dialog from the click to "Done".
 */
export function Checkout({ plan: slug, onClose, onState, onSubscribed }: CheckoutProps) {
    const { api, chain, manageUrl } = useMesubInternal();
    const wallets = useWallets();
    const titleId = useId();

    const [loaded, setLoaded] = useState<PlanState>({ name: 'loading' });
    const [view, setViewState] = useState<View>({ name: 'plan' });
    const [checking, setChecking] = useState(false);

    const alive = useRef(true);
    // Bumped by each step taken: a late answer from the one before is dropped.
    const attempt = useRef(0);
    // The view as of now, not as of the last render: what a double click is checked against.
    const shown = useRef<View>(view);
    const checkingNow = useRef(false);
    // What was handed to submit: "Check again" sends exactly that, never a new payment.
    const sent = useRef<{
        id: string;
        signed: { transaction: string; terms_signature: string };
        signer: Signer;
        signature: string | null;
        // Where the terms said it can be stopped, for the done screen.
        cancelUrl: string | null;
    } | null>(null);
    const latest = useRef({ onState, onSubscribed });
    latest.current = { onState, onSubscribed };

    function setView(next: View) {
        shown.current = next;
        setViewState(next);
        latest.current.onState(STATES[next.name] ?? 'open');
    }

    function begin() {
        const id = ++attempt.current;
        return () => alive.current && id === attempt.current;
    }

    function loadPlan() {
        setLoaded({ name: 'loading' });
        api.plan(slug).then(
            (served) => alive.current && setLoaded({ name: 'loaded', plan: served }),
            (error: unknown) => alive.current && setLoaded({ name: 'failed', error }),
        );
    }

    useEffect(() => {
        alive.current = true;
        latest.current.onState('open');
        loadPlan();
        return () => {
            alive.current = false;
        };
        // Once per opening: the provider mounts a new Checkout each time.
    }, []);

    function fail(failure: Failure, signer: Signer | null, signature: string | null = null) {
        setView({ name: 'failed', failure, signer, signature });
    }

    async function prepare(signer: Signer, notice: string | null = null) {
        const current = begin();
        setView({ name: 'preparing', signer });
        try {
            const prepared = await api.prepare(slug, signer.account.address);
            if (current()) setView({ name: 'review', signer, prepared, notice });
        } catch (error) {
            if (!current()) return;
            if (signedOut(error)) setView({ name: 'signed-out' });
            else fail(notPrepared(error), signer);
        }
    }

    async function pick(wallet: UiWallet) {
        // A second click on the row: the first one is already asking the wallet.
        if (shown.current.name !== 'wallet' || shown.current.pick.name === 'waiting') return;
        const current = begin();
        const refused = (message: string) =>
            current() && setView({ name: 'wallet', pick: { name: 'rejected', wallet, message } });
        setView({ name: 'wallet', pick: { name: 'waiting', wallet } });

        let account;
        try {
            [account] = await connectAccounts(wallet);
        } catch (refusal) {
            refused(
                `${wallet.name} said: ${refusal instanceof Error ? refusal.message : 'it did not connect.'}`,
            );
            return;
        }
        if (!current()) return;
        if (!account) {
            refused(`${wallet.name} shared no Solana account.`);
            return;
        }
        rememberWallet(wallet.name);
        await prepare({ wallet, account });
    }

    async function sign(signer: Signer, prepared: PreparedSubscription) {
        // A second click finds the review gone: nothing is prepared or signed twice.
        if (shown.current.name !== 'review' || shown.current.prepared !== prepared) return;
        const current = begin();
        const notSigned = (title: string, error: unknown) =>
            fail(
                {
                    step: 'approve',
                    title,
                    message:
                        error instanceof WalletError
                            ? error.message
                            : `${signer.wallet.name} did not sign.`,
                    moved: 'safe',
                    action: 'retry',
                    icon: 'wallet',
                },
                signer,
            );
        // Never sign stale terms: ask the server again, and show what it answers.
        if (expired(prepared)) {
            await prepare(signer, FRESH_TERMS);
            return;
        }

        setView({ name: 'signing', signer, what: 'terms' });
        let termsSignature;
        try {
            termsSignature = await signText(signer, prepared.terms.message);
        } catch (error) {
            if (current()) notSigned('Terms not signed', error);
            return;
        }
        if (!current()) return;
        // The wallet's window stayed open past the terms' life.
        if (expired(prepared)) {
            await prepare(signer, FRESH_TERMS);
            return;
        }

        setView({ name: 'signing', signer, what: 'transaction' });
        let signed;
        try {
            // Signed, not sent: Mesub co-signs and sends it.
            signed = await signOnly(signer, chain, prepared.transaction);
        } catch (error) {
            if (current()) notSigned('Transaction not signed', error);
            return;
        }
        if (!current()) return;

        sent.current = {
            id: prepared.subscription.id,
            signed: { transaction: signed.transaction, terms_signature: termsSignature },
            signer,
            signature: signed.signature,
            cancelUrl: termsCancelUrl(prepared.terms.message),
        };
        await submit();
    }

    // Also "Check again": Mesub recognises what it already co-signed and answers from the chain.
    async function submit() {
        const handed = sent.current;
        if (!handed) return;
        const { id, signed, signer, signature, cancelUrl } = handed;
        const current = begin();
        setView({ name: 'submitting', signer, signature });
        try {
            const settled = await api.submit(id, signed);
            if (settled.reason) {
                if (!current()) return;
                fail(
                    {
                        step: 'confirming',
                        title: 'Payment did not go through',
                        message: settled.reason,
                        moved: 'safe',
                        action: 'retry',
                        icon: 'merchant',
                    },
                    signer,
                );
                return;
            }
            // Told even once closed: the subscription exists.
            latest.current.onSubscribed(settled.subscription, signature);
            if (current()) {
                setView({
                    name: 'subscribed',
                    signer,
                    subscription: settled.subscription,
                    signature,
                    cancelUrl,
                });
            }
        } catch (error) {
            if (!current()) return;
            if (signedOut(error)) {
                setView({ name: 'signed-out' });
                return;
            }
            const status = error instanceof MesubClientError ? error.status : null;
            // No word on what became of it: Mesub may have sent it.
            if (status === null || status >= 500 || !(error instanceof MesubClientError)) {
                fail(
                    {
                        step: 'confirming',
                        title: 'Still confirming',
                        message:
                            'No answer yet on what became of the transaction. Wait a minute, then check again: nothing is paid twice.',
                        moved: 'pending',
                        action: 'check',
                        icon: 'merchant',
                    },
                    signer,
                    signature,
                );
                return;
            }
            // A refusal: Mesub sent nothing.
            fail(
                {
                    step: 'confirming',
                    title: 'Could not subscribe',
                    message: error.message,
                    moved: 'safe',
                    action: 'retry',
                    icon: 'merchant',
                },
                signer,
            );
        }
    }

    async function checkAgain() {
        if (checkingNow.current) return;
        checkingNow.current = true;
        setChecking(true);
        try {
            await submit();
        } finally {
            checkingNow.current = false;
            if (alive.current) setChecking(false);
        }
    }

    function toWallets() {
        attempt.current++;
        setView({ name: 'wallet', pick: { name: 'list' } });
    }

    function toPlan() {
        attempt.current++;
        setView({ name: 'plan' });
    }

    function act(action: Failure['action'], signer: Signer | null) {
        if (action === 'close') onClose();
        else if (action === 'check') void checkAgain();
        else if (action === 'wallet' || !signer) toWallets();
        // Again from the server: a fresh transaction, and the review of what it costs.
        else void prepare(signer);
    }

    let screen: DialogScreen;
    if (view.name === 'signed-out') {
        screen = signedOutScreen({
            titleId,
            step: 'review',
            message:
                'You are not signed in on this site. Sign in here first, then subscribe again.',
            safe: SAFE,
            onClose,
        });
    } else if (loaded.name !== 'loaded') {
        screen = planScreen(loaded, titleId, loadPlan, onClose);
    } else if (view.name === 'wallet') {
        screen = walletScreen({
            titleId,
            view: view.pick,
            wallets,
            purpose: 'subscribe',
            lead: 'It pays the subscription. Nothing is signed yet.',
            setView: (pickView) => {
                attempt.current++;
                setView({ name: 'wallet', pick: pickView });
            },
            pick: (wallet) => void pick(wallet),
            onBack: toPlan,
        });
    } else {
        screen = stageScreen({
            view,
            plan: loaded.plan,
            chain,
            manageUrl,
            titleId,
            checking,
            onContinue: toWallets,
            onSign: (signer, prepared) => void sign(signer, prepared),
            onAct: act,
            onWallets: toWallets,
            onClose,
        });
    }

    return <MesubDialog screen={screen} titleId={titleId} onClose={onClose} />;
}

/** While the plan loads, or when it could not be read. */
function planScreen(
    loaded: Exclude<PlanState, { name: 'loaded' }>,
    titleId: string,
    reload: () => void,
    close: () => void,
): DialogScreen {
    if (loaded.name === 'loading') {
        return {
            step: 'plan',
            view: 'plan-loading',
            body: (
                <>
                    <Hero kind="wait" />
                    <h2 id={titleId}>Subscribe</h2>
                    <p data-mesub-notice="" role="status" aria-busy="true">
                        Loading the plan
                    </p>
                </>
            ),
        };
    }
    const silent = unreachable(loaded.error);
    return {
        step: 'plan',
        view: 'plan-failed',
        body: (
            <>
                <Hero kind="error" />
                <h2 id={titleId}>{silent ? 'No answer' : 'Plan not found'}</h2>
                <p role="alert" data-mesub-error="">
                    {loaded.error instanceof MesubClientError
                        ? loaded.error.message
                        : 'Could not read this plan.'}
                </p>
                <p data-mesub-funds="safe">{SAFE}</p>
                {silent ? (
                    <button type="button" data-mesub-submit="" onClick={reload}>
                        Try again
                    </button>
                ) : (
                    <button type="button" data-mesub-done="" onClick={close}>
                        Close
                    </button>
                )}
            </>
        ),
    };
}

function stageScreen(props: {
    view: Exclude<View, { name: 'wallet' } | { name: 'signed-out' }>;
    plan: MesubPlan;
    chain: SolanaChain;
    manageUrl: string | null | undefined;
    titleId: string;
    checking: boolean;
    onContinue(): void;
    onSign(signer: Signer, prepared: PreparedSubscription): void;
    onAct(action: Failure['action'], signer: Signer | null): void;
    onWallets(): void;
    onClose(): void;
}): DialogScreen {
    const { view, plan, chain, titleId } = props;
    const price = `${plan.amount_display} ${plan.symbol ?? shortAddress(plan.mint)}`;
    const every = cadence(plan.period_hours);
    const merchant = (
        <Merchant
            name={plan.project_name}
            logoUrl={plan.logo_url}
            testNetwork={plan.network !== 'mainnet-beta'}
        />
    );

    if (view.name === 'failed') {
        const { failure, signer } = view;
        return failureScreen({
            failure,
            titleId,
            icon: failure.icon === 'wallet' ? signer?.wallet.icon : plan.logo_url,
            safe: SAFE,
            pending: PENDING,
            signature: view.signature,
            chain,
            busy: props.checking,
            onAct: (action) => props.onAct(action, signer),
            onBack: props.onWallets,
            backLabel: 'Use another wallet',
        });
    }

    if (view.name === 'plan') {
        if (!plan.available) {
            return {
                step: 'plan',
                view: 'plan-closed',
                body: (
                    <>
                        <Hero kind="error" icon={plan.logo_url} />
                        <h2 id={titleId}>Plan closed</h2>
                        <p role="alert" data-mesub-error="">
                            This plan is not taking new subscribers right now.
                        </p>
                        <p data-mesub-funds="safe">{SAFE}</p>
                        <button type="button" data-mesub-done="" onClick={props.onClose}>
                            Close
                        </button>
                    </>
                ),
            };
        }
        return {
            step: 'plan',
            view: 'plan',
            body: (
                <>
                    {merchant}
                    <h2 id={titleId}>{plan.name}</h2>
                    <p data-mesub-price="">
                        <strong>{price}</strong>
                        <span>{every}</span>
                    </p>
                    {plan.description ? <p data-mesub-description="">{plan.description}</p> : null}
                    <button type="button" data-mesub-submit="" onClick={props.onContinue}>
                        Continue with a wallet
                    </button>
                    <button type="button" data-mesub-cancel="" onClick={props.onClose}>
                        Cancel
                    </button>
                </>
            ),
        };
    }

    const { wallet, account } = view.signer;

    if (view.name === 'preparing') {
        return {
            step: 'wallet',
            view: 'preparing',
            onBack: props.onWallets,
            body: (
                <>
                    <Hero kind="wait" icon={wallet.icon} />
                    <h2 id={titleId}>Preparing your subscription</h2>
                    <p data-mesub-notice="" role="status" aria-busy="true">
                        Nothing to sign yet
                    </p>
                </>
            ),
        };
    }

    if (view.name === 'review') {
        const { terms } = view.prepared;
        const nextCharge = new Date(Date.now() + plan.period_hours * 3_600_000);
        return {
            step: 'review',
            view: 'review',
            onBack: props.onWallets,
            body: (
                <>
                    {merchant}
                    <h2 id={titleId}>{plan.name}</h2>
                    <p data-mesub-price="">
                        <strong>{price}</strong>
                        <span>{every}</span>
                    </p>
                    {view.notice ? (
                        <p data-mesub-notice="" role="status">
                            {view.notice}
                        </p>
                    ) : null}
                    {/* Two facts only: the price is above, and the wallet shows the SOL it costs. */}
                    <dl data-mesub-summary="">
                        <div data-mesub-row="">
                            <dt>Pays from</dt>
                            <dd title={account.address}>
                                <img src={wallet.icon} alt="" width={16} height={16} />
                                {shortAddress(account.address)}
                            </dd>
                        </div>
                        <div data-mesub-row="">
                            <dt>Next charge</dt>
                            <dd>{formatDate(nextCharge)}</dd>
                        </div>
                    </dl>
                    <details data-mesub-terms="">
                        <summary>The terms you sign</summary>
                        {/* A plain list, the rows of the one above: what a person needs of the terms. */}
                        <dl data-mesub-summary="">
                            {termsFacts(terms.message).map((fact) => (
                                <div data-mesub-row="" key={fact.label}>
                                    <dt>{fact.label}</dt>
                                    <dd title={fact.full}>
                                        {fact.href ? (
                                            <a
                                                data-mesub-token=""
                                                href={fact.href}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            >
                                                {fact.value}
                                            </a>
                                        ) : (
                                            fact.value
                                        )}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </details>
                    {/* Last before the button: what clicking it starts. */}
                    <p data-mesub-footnote="">
                        Two approvals in {wallet.name}: the terms, then the payment. Cancel anytime.
                    </p>
                    <button
                        type="button"
                        data-mesub-submit=""
                        onClick={() => props.onSign(view.signer, view.prepared)}
                    >
                        Sign and pay {price}
                    </button>
                    <button type="button" data-mesub-cancel="" onClick={props.onClose}>
                        Cancel
                    </button>
                </>
            ),
        };
    }

    if (view.name === 'signing') {
        const terms = view.what === 'terms';
        return {
            step: 'approve',
            view: `approve-${view.what}`,
            onBack: props.onWallets,
            body: (
                <>
                    <Hero kind="wait" icon={wallet.icon} />
                    <h2 id={titleId}>
                        {terms ? 'Sign the terms' : 'Approve the payment'} in {wallet.name}
                    </h2>
                    <p>
                        {terms
                            ? 'Step 1 of 2: a message, it moves nothing.'
                            : `Step 2 of 2: ${price} now, then ${price} ${every}.`}
                    </p>
                    <button type="button" data-mesub-cancel="" onClick={props.onClose}>
                        Cancel
                    </button>
                </>
            ),
        };
    }

    if (view.name === 'submitting') {
        return {
            step: 'confirming',
            view: 'confirming',
            body: (
                <>
                    <Hero kind="wait" icon={plan.logo_url} />
                    <h2 id={titleId}>Confirming on Solana</h2>
                    <p>This can take up to a minute.</p>
                    {view.signature ? (
                        <Explorer
                            signature={view.signature}
                            chain={chain}
                            label="View transaction"
                        />
                    ) : null}
                </>
            ),
        };
    }

    const nextCharge = moment(view.subscription.next_charge_at);
    const manage = manageLink(props.manageUrl, view.cancelUrl);

    return {
        step: 'subscribed',
        view: 'subscribed',
        body: (
            <>
                <Hero kind="check" />
                <h2 id={titleId}>You are subscribed</h2>
                <p>
                    {plan.name}, {price} {every}
                </p>
                <dl data-mesub-summary="">
                    <div data-mesub-row="">
                        <dt>Paid today</dt>
                        <dd>{price}</dd>
                    </div>
                    {nextCharge ? (
                        <div data-mesub-row="">
                            <dt>Next charge</dt>
                            <dd>{nextCharge}</dd>
                        </div>
                    ) : null}
                    <div data-mesub-row="">
                        <dt>Pays from</dt>
                        <dd title={account.address}>
                            <img src={wallet.icon} alt="" width={16} height={16} />
                            {shortAddress(account.address)}
                        </dd>
                    </div>
                    {view.signature ? (
                        <div data-mesub-row="">
                            <dt>Receipt</dt>
                            <dd>
                                <Explorer signature={view.signature} chain={chain} label="View" />
                            </dd>
                        </div>
                    ) : null}
                </dl>
                <button type="button" data-mesub-done="" onClick={props.onClose}>
                    Done
                </button>
                {/* Only once it runs: where it is stopped is of no use before. */}
                {manage ? (
                    <a
                        data-mesub-manage=""
                        data-mesub-external={manage.external ? '' : undefined}
                        href={manage.href}
                        // The merchant's own page opens in place; Mesub's, in a tab of its own.
                        {...(manage.external && { target: '_blank', rel: 'noopener noreferrer' })}
                    >
                        Cancel any time
                    </a>
                ) : null}
            </>
        ),
    };
}
