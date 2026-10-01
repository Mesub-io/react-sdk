import { useWallets, type UiWallet } from '@wallet-standard/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MesubMark } from './brand';
import { useMesub, useMesubInternal } from './context';
import { MesubDialog, type DialogScreen } from './dialog';
import { MesubClientError } from './errors';
import { cadence, explorerUrl, formatAmount, formatDate, shortAddress } from './format';
import type { MesubPlan } from './plan-api';
import { canSubscribe, WalletError, type SolanaChain } from './send-transaction';
import { Merchant, useSignIn } from './sign-in';
import type { MesubSubscription } from './subscribe-api';
import { NotSettledError, subscribeOnce, unreachable } from './subscribe-flow';

// The subscriber's page on Mesub, whichever site the widget runs on.
const MANAGE_URL = 'https://mesub.io/subscriptions';

export type CheckoutStage = 'signin' | 'review' | 'approve' | 'confirming' | 'subscribed';

export interface CheckoutProps {
    plan: string;
    chain: SolanaChain;
    onClose(): void;
    // Each stage reached, for the button underneath.
    onStage?(stage: CheckoutStage): void;
    onSubscribed?(subscription: MesubSubscription, signature: string): void;
}

type PlanState =
    { name: 'loading' } | { name: 'loaded'; plan: MesubPlan } | { name: 'failed'; error: unknown };

/**
 * What went wrong, on the stage it happened on. `funds` is the money line:
 * `safe` only when no transaction can have landed.
 */
interface Failure {
    stage: 'review' | 'approve' | 'confirming';
    title: string;
    message: ReactNode;
    funds: 'safe' | 'pending' | null;
    // The one primary action.
    action: 'retry' | 'close' | 'check' | 'reload';
    // A text "Back to review" under it.
    back: boolean;
}

// The API's words for each refusal the design gives a screen of its own.
const ALREADY = /already subscribed|is cancelled, and runs/i;
const CLOSED =
    /not taking new subscribers|no longer takes new subscribers|has ended|no longer exists/i;
const TOO_LITTLE = /to pay the first period/i;

/** A failure before the wallet sent anything: nothing was charged. */
function beforeSending(error: unknown, walletName: string): Failure {
    if (error instanceof WalletError) {
        if (error.kind === 'wrong-account' && error.accounts) {
            const name = error.wallet ?? walletName;
            return {
                stage: 'approve',
                title: `Wrong account in ${name}`,
                message: (
                    <>
                        {name} is on <code>{shortAddress(error.accounts.shared)}</code>, you signed
                        in with <code>{shortAddress(error.accounts.expected)}</code>. Switch
                        account, then try again.
                    </>
                ),
                funds: 'safe',
                action: 'retry',
                back: true,
            };
        }
        const rejected = error.kind === 'rejected';
        return {
            stage: 'approve',
            title: rejected ? 'Not approved' : 'No wallet ready',
            message: rejected
                ? `You closed ${error.wallet ?? walletName} before approving.`
                : error.message,
            funds: 'safe',
            action: 'retry',
            back: true,
        };
    }
    if (unreachable(error)) {
        return {
            stage: 'review',
            title: 'Mesub did not answer',
            message: 'No reply within 15 seconds.',
            funds: 'safe',
            action: 'retry',
            back: false,
        };
    }
    const message = error instanceof MesubClientError ? error.message : 'Something went wrong.';
    if (ALREADY.test(message)) {
        return {
            stage: 'review',
            title: 'Already subscribed',
            message,
            funds: null,
            action: 'close',
            back: false,
        };
    }
    if (CLOSED.test(message)) {
        return {
            stage: 'review',
            title: 'Plan closed',
            message,
            funds: 'safe',
            action: 'close',
            back: false,
        };
    }
    if (TOO_LITTLE.test(message)) {
        return {
            stage: 'approve',
            title: 'Payment did not go through',
            message,
            funds: 'safe',
            action: 'retry',
            back: true,
        };
    }
    return {
        stage: 'review',
        title: 'Could not subscribe',
        message,
        funds: 'safe',
        action: 'retry',
        back: true,
    };
}

/** A failure once the wallet sent: unless the API said nothing settled, money may be moving. */
function afterSending(error: unknown, walletName: string): Failure {
    if (error instanceof NotSettledError) {
        return {
            stage: 'confirming',
            title: 'Payment did not go through',
            message: error.message,
            funds: 'safe',
            action: 'retry',
            back: true,
        };
    }
    return {
        stage: 'confirming',
        title: 'Still confirming',
        message: `If ${walletName} shows the transaction as sent, wait a minute: your subscription will appear on its own.`,
        funds: 'pending',
        action: 'check',
        back: false,
    };
}

/** The wallet that will sign, as best known before the flow finds it: for its icon and name. */
function likelySigner(wallets: readonly UiWallet[], address: string | null): UiWallet | null {
    const capable = wallets.filter(canSubscribe);
    return (
        capable.find((wallet) => wallet.accounts.some((account) => account.address === address)) ??
        capable[0] ??
        null
    );
}

/**
 * The window <SubscribeButton /> opens: sign in if needed, review the plan,
 * approve in the wallet, confirm. One dialog from the click to "Done".
 */
export function Checkout({ plan, chain, onClose, onStage, onSubscribed }: CheckoutProps) {
    const { user, getAccessToken } = useMesub();
    const { api, completeSignIn } = useMesubInternal();
    const wallets = useWallets();
    const titleId = useId();

    const [stage, setStageState] = useState<CheckoutStage>(user ? 'review' : 'signin');
    const [loaded, setLoaded] = useState<PlanState>({ name: 'loading' });
    const [failure, setFailure] = useState<Failure | null>(null);
    const [signer, setSigner] = useState<UiWallet | null>(null);
    const [sent, setSent] = useState<{ signature: string; id: string } | null>(null);
    const [subscription, setSubscription] = useState<MesubSubscription | null>(null);
    const [checking, setChecking] = useState(false);

    const alive = useRef(true);
    const latest = useRef({ wallets, onStage, onSubscribed });
    latest.current = { wallets, onStage, onSubscribed };

    function setStage(next: CheckoutStage) {
        setStageState(next);
        latest.current.onStage?.(next);
    }

    function loadPlan() {
        setLoaded({ name: 'loading' });
        // Read while the subscriber signs in: the summary is ready when they are.
        api.plans.get(plan).then(
            (served) => alive.current && setLoaded({ name: 'loaded', plan: served }),
            (error: unknown) => alive.current && setLoaded({ name: 'failed', error }),
        );
    }

    useEffect(() => {
        alive.current = true;
        latest.current.onStage?.(user ? 'review' : 'signin');
        loadPlan();
        return () => {
            alive.current = false;
        };
        // Once per opening: the button keys a new Checkout on another plan.
    }, []);

    const signIn = useSignIn({
        titleId,
        merchant: loaded.name === 'loaded' ? loaded.plan.merchant : null,
        onSignedIn: (session) => {
            // Not through login(): nothing waits on it, the checkout carries on.
            completeSignIn(session);
            setStage('review');
        },
    });

    const wallet = signer ?? likelySigner(wallets, user?.walletAddress ?? null);
    const walletName = wallet?.name ?? 'your wallet';

    function succeed(done: MesubSubscription, signature: string) {
        latest.current.onSubscribed?.(done, signature);
        if (!alive.current) return;
        setSubscription(done);
        setFailure(null);
        setStage('subscribed');
    }

    async function pay() {
        const address = user?.walletAddress;
        const token = await getAccessToken();
        if (!address || !token) {
            setFailure(null);
            setStage('signin');
            return;
        }
        setFailure(null);
        setSent(null);
        setStage('approve');
        let signature: string | null = null;
        try {
            const done = await subscribeOnce({
                api,
                accessToken: token,
                plan,
                wallets: latest.current.wallets,
                address,
                chain,
                onSigner: (found) => alive.current && setSigner(found.wallet),
                onSent: (sig, id) => {
                    signature = sig;
                    if (!alive.current) return;
                    setSent({ signature: sig, id });
                    setStage('confirming');
                },
            });
            succeed(done.subscription, done.signature);
        } catch (error) {
            if (!alive.current) return;
            const shown = signature
                ? afterSending(error, walletName)
                : beforeSending(error, walletName);
            setFailure(shown);
            setStage(shown.stage);
        }
    }

    // Asks for the same transaction again: never a second payment.
    async function checkAgain() {
        if (!sent) return;
        const token = await getAccessToken();
        if (!token) return;
        setChecking(true);
        try {
            const confirmed = await api.subscriptions.confirm(token, sent.id, sent.signature);
            if (confirmed.reason) throw new NotSettledError(confirmed.reason, sent.signature);
            succeed(confirmed.subscription, sent.signature);
        } catch (error) {
            if (alive.current) setFailure(afterSending(error, walletName));
        } finally {
            if (alive.current) setChecking(false);
        }
    }

    function act(action: Failure['action']) {
        if (action === 'close') onClose();
        else if (action === 'check') void checkAgain();
        else if (action === 'reload') loadPlan();
        else void pay();
    }

    function backToReview() {
        setFailure(null);
        setStage('review');
    }

    let screen: DialogScreen;
    if (stage === 'signin') {
        screen = signIn;
    } else if (loaded.name !== 'loaded') {
        screen = planScreen(loaded, titleId, () => act('reload'), onClose);
    } else {
        screen = stageScreen({
            stage,
            plan: loaded.plan,
            chain,
            titleId,
            wallet,
            walletName,
            address: user?.walletAddress ?? null,
            signature: sent?.signature ?? null,
            subscription,
            failure,
            checking,
            manageUrl: MANAGE_URL,
            onPay: () => void pay(),
            onAct: act,
            onBack: backToReview,
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
            step: 'review',
            view: 'plan-loading',
            body: (
                <>
                    <div data-mesub-hero="wait" aria-hidden="true" />
                    <h2 id={titleId}>Subscribe</h2>
                    <p data-mesub-notice="" role="status" aria-busy="true">
                        Loading the plan
                    </p>
                </>
            ),
        };
    }
    const timedOut = unreachable(loaded.error);
    return {
        step: 'review',
        view: 'plan-failed',
        body: (
            <>
                <div data-mesub-hero="error" aria-hidden="true" />
                <h2 id={titleId}>{timedOut ? 'Mesub did not answer' : 'Plan not found'}</h2>
                <p role="alert" data-mesub-error="">
                    {timedOut
                        ? 'No reply within 15 seconds.'
                        : loaded.error instanceof MesubClientError
                          ? loaded.error.message
                          : 'Could not read this plan.'}
                </p>
                <p data-mesub-funds="safe">Nothing was charged.</p>
                {timedOut ? (
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

function Hero({ kind, icon }: { kind: string; icon: string | null | undefined }) {
    return (
        <div data-mesub-hero={kind} aria-hidden="true">
            {icon ? <img src={icon} alt="" width={56} height={56} /> : null}
        </div>
    );
}

function Explorer({
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

function stageScreen(props: {
    stage: Exclude<CheckoutStage, 'signin'>;
    plan: MesubPlan;
    chain: SolanaChain;
    titleId: string;
    wallet: UiWallet | null;
    walletName: string;
    address: string | null;
    signature: string | null;
    subscription: MesubSubscription | null;
    failure: Failure | null;
    checking: boolean;
    manageUrl: string;
    onPay(): void;
    onAct(action: Failure['action']): void;
    onBack(): void;
    onClose(): void;
}): DialogScreen {
    const { stage, plan, chain, titleId, wallet, walletName, signature, failure } = props;
    const price = `${formatAmount(plan.amount, plan.decimals)} ${plan.symbol ?? shortAddress(plan.mint)}`;
    const every = cadence(plan.periodHours);
    const logo = plan.merchant.logoUrl;

    if (failure) {
        // The merchant's logo on the review, the wallet's where the wallet failed.
        const icon = failure.stage === 'approve' ? wallet?.icon : logo;
        const primary =
            failure.action === 'close' ? (
                <button type="button" data-mesub-done="" onClick={() => props.onAct('close')}>
                    Close
                </button>
            ) : (
                <button
                    type="button"
                    data-mesub-submit=""
                    disabled={props.checking}
                    aria-busy={props.checking || undefined}
                    onClick={() => props.onAct(failure.action)}
                >
                    {failure.action === 'check' ? 'Check again' : 'Try again'}
                </button>
            );
        return {
            step: failure.stage,
            view: `${failure.stage}-failed-${failure.title}`,
            // Back to the review, except while a payment may still land.
            onBack: failure.funds === 'pending' ? undefined : props.onBack,
            body: (
                <>
                    <Hero kind={failure.funds === 'pending' ? 'pending' : 'error'} icon={icon} />
                    <h2 id={titleId}>{failure.title}</h2>
                    <p role="alert" data-mesub-error="">
                        {failure.message}
                    </p>
                    {failure.funds === 'safe' ? (
                        <p data-mesub-funds="safe">Nothing was charged.</p>
                    ) : failure.funds === 'pending' ? (
                        <p data-mesub-funds="pending">Payment may be pending.</p>
                    ) : null}
                    {failure.funds === 'pending' && signature ? (
                        <Explorer signature={signature} chain={chain} label="View transaction" />
                    ) : null}
                    {primary}
                    {failure.back ? (
                        <button type="button" data-mesub-back="" onClick={props.onBack}>
                            Back to review
                        </button>
                    ) : null}
                </>
            ),
        };
    }

    if (stage === 'review') {
        if (!plan.available) {
            return {
                step: 'review',
                view: 'review-closed',
                body: (
                    <>
                        <Hero kind="error" icon={logo} />
                        <h2 id={titleId}>Plan closed</h2>
                        <p role="alert" data-mesub-error="">
                            This plan is not taking new subscribers right now.
                        </p>
                        <p data-mesub-funds="safe">Nothing was charged.</p>
                        <button type="button" data-mesub-done="" onClick={props.onClose}>
                            Close
                        </button>
                    </>
                ),
            };
        }
        const nextCharge = new Date(Date.now() + plan.periodHours * 3_600_000);
        return {
            step: 'review',
            view: 'review',
            body: (
                <>
                    <Merchant merchant={plan.merchant} testNetwork={chain !== 'solana:mainnet'} />
                    <h2 id={titleId}>{plan.name}</h2>
                    <p data-mesub-price="">
                        <strong>{price}</strong>
                        <span>{every}</span>
                    </p>
                    <details data-mesub-terms="">
                        <summary>Payment details and terms</summary>
                        <dl data-mesub-summary="">
                            <div data-mesub-row="">
                                <dt>Due today</dt>
                                <dd>{price}</dd>
                            </div>
                            <div data-mesub-row="">
                                <dt>Next charge</dt>
                                <dd>{formatDate(nextCharge)}</dd>
                            </div>
                            {props.address ? (
                                <div data-mesub-row="">
                                    <dt>Pays from</dt>
                                    <dd>
                                        {wallet ? (
                                            <img src={wallet.icon} alt="" width={16} height={16} />
                                        ) : null}
                                        {shortAddress(props.address)}
                                    </dd>
                                </div>
                            ) : null}
                            <div data-mesub-row="">
                                <dt>Network fee</dt>
                                <dd>≈ 0.002 SOL</dd>
                            </div>
                        </dl>
                        <p>Charged automatically, no new signature. Cancel anytime.</p>
                    </details>
                    <button type="button" data-mesub-submit="" onClick={props.onPay}>
                        Subscribe and pay {price}
                    </button>
                    <button type="button" data-mesub-cancel="" onClick={props.onClose}>
                        Cancel
                    </button>
                </>
            ),
        };
    }

    if (stage === 'approve') {
        return {
            step: 'approve',
            view: 'approve',
            onBack: props.onBack,
            body: (
                <>
                    <Hero kind="wait" icon={wallet?.icon} />
                    <h2 id={titleId}>Approve in {walletName}</h2>
                    <p>
                        One transaction: {price} now, then {price} {every}.
                    </p>
                    <button type="button" data-mesub-cancel="" onClick={props.onClose}>
                        Cancel
                    </button>
                </>
            ),
        };
    }

    if (stage === 'confirming') {
        return {
            step: 'confirming',
            view: 'confirming',
            body: (
                <>
                    <Hero kind="wait" icon={logo} />
                    <h2 id={titleId}>Confirming on Solana</h2>
                    <p>This takes a few seconds.</p>
                    {signature ? (
                        <Explorer signature={signature} chain={chain} label="View transaction" />
                    ) : null}
                </>
            ),
        };
    }

    const due = props.subscription?.dueAt ? new Date(props.subscription.dueAt) : null;
    return {
        step: 'subscribed',
        view: 'subscribed',
        body: (
            <>
                <div data-mesub-hero="check" aria-hidden="true" />
                <h2 id={titleId}>You are subscribed</h2>
                <p>
                    {plan.name}, {price} {every}
                </p>
                <dl data-mesub-summary="">
                    <div data-mesub-row="">
                        <dt>Paid today</dt>
                        <dd>{price}</dd>
                    </div>
                    {due ? (
                        <div data-mesub-row="">
                            <dt>Next charge</dt>
                            <dd>{formatDate(due)}</dd>
                        </div>
                    ) : null}
                    {signature ? (
                        <div data-mesub-row="">
                            <dt>Receipt</dt>
                            <dd>
                                <Explorer signature={signature} chain={chain} label="View" />
                            </dd>
                        </div>
                    ) : null}
                </dl>
                <button type="button" data-mesub-done="" onClick={props.onClose}>
                    Done
                </button>
                <a data-mesub-manage="" href={props.manageUrl} target="_blank" rel="noopener">
                    <MesubMark width={17} height={11} />
                    See details on mesub.io
                </a>
            </>
        ),
    };
}
