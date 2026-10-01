import { useWallets } from '@wallet-standard/react';
import { useEffect, useId, useRef, useState } from 'react';
import { useMesub, useMesubInternal } from './context';
import { MesubClientError } from './errors';
import { cadence, explorerUrl, formatAmount, formatDate, shortAddress } from './format';
import type { MesubPlan } from './plan-api';
import { WalletError, type Signer, type SolanaChain } from './send-transaction';
import { MesubDialog, SignInSteps, type SignInStepName } from './sign-in-modal';
import type { MesubSubscription } from './subscribe-api';
import { NotSettledError, subscribeOnce, unreachable } from './subscribe-flow';

export type CheckoutStage = 'signin' | 'review' | 'approve' | 'confirming' | 'subscribed';

export interface CheckoutProps {
    plan: string;
    chain: SolanaChain;
    onClose(): void;
    // Each stage reached, for the button underneath.
    onStage?(stage: CheckoutStage): void;
    onSubscribed?(subscription: MesubSubscription): void;
}

type PlanState =
    { name: 'loading' } | { name: 'loaded'; plan: MesubPlan } | { name: 'failed'; message: string };

const NOTHING_CHARGED = 'Nothing was charged.';

/** What a failure says, and whether money moved: before the wallet sent, it did not. */
function failureMessage(error: unknown, sent: boolean): string {
    const refused =
        error instanceof NotSettledError ||
        error instanceof WalletError ||
        (error instanceof MesubClientError && !unreachable(error));
    if (sent && !refused) {
        return 'Solana did not confirm in time. If your wallet shows the transaction as sent, wait a minute: your subscription will appear on its own.';
    }
    const message =
        refused || error instanceof MesubClientError
            ? (error as Error).message
            : 'Something went wrong. Try again.';
    return sent ? message : `${message} ${NOTHING_CHARGED}`;
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
    const [signInStep, setSignInStep] = useState<SignInStepName>('email');
    const [loaded, setLoaded] = useState<PlanState>({ name: 'loading' });
    const [error, setError] = useState('');
    const [signer, setSigner] = useState<Signer | null>(null);
    const [signature, setSignature] = useState<string | null>(null);
    const [subscription, setSubscription] = useState<MesubSubscription | null>(null);

    const alive = useRef(true);
    const latest = useRef({ wallets, onStage, onSubscribed });
    latest.current = { wallets, onStage, onSubscribed };

    function setStage(next: CheckoutStage) {
        setStageState(next);
        latest.current.onStage?.(next);
    }

    useEffect(() => {
        alive.current = true;
        latest.current.onStage?.(user ? 'review' : 'signin');
        // Read while the subscriber signs in: the summary is ready when they are.
        api.plans.get(plan).then(
            (served) => alive.current && setLoaded({ name: 'loaded', plan: served }),
            (failure: unknown) =>
                alive.current &&
                setLoaded({
                    name: 'failed',
                    message:
                        failure instanceof MesubClientError
                            ? failure.message
                            : 'Could not read this plan.',
                }),
        );
        return () => {
            alive.current = false;
        };
        // Once per opening: the button keys a new Checkout on another plan.
    }, []);

    async function pay() {
        const address = user?.walletAddress;
        const token = await getAccessToken();
        if (!address || !token) {
            setError('');
            setStage('signin');
            return;
        }
        setError('');
        setSignature(null);
        setStage('approve');
        let sent = false;
        let prompted = false;
        try {
            const done = await subscribeOnce({
                api,
                accessToken: token,
                plan,
                wallets: latest.current.wallets,
                address,
                chain,
                onSigner: (found) => {
                    prompted = true;
                    if (alive.current) setSigner(found);
                },
                onSent: (sig) => {
                    sent = true;
                    if (!alive.current) return;
                    setSignature(sig);
                    setStage('confirming');
                },
            });
            latest.current.onSubscribed?.(done.subscription);
            if (!alive.current) return;
            setSubscription(done.subscription);
            setStage('subscribed');
        } catch (failure) {
            if (!alive.current) return;
            setError(failureMessage(failure, sent));
            // Refused before the wallet showed anything: the review is where to decide.
            if (!prompted) setStage('review');
        }
    }

    const step = stage === 'signin' ? signInStep : stage;

    return (
        <MesubDialog step={step} titleId={titleId} onClose={onClose}>
            {stage === 'signin' ? (
                <SignInSteps
                    titleId={titleId}
                    onStep={setSignInStep}
                    onSignedIn={(session) => {
                        // Not through login(): nothing waits on it, the checkout carries on.
                        completeSignIn(session);
                        setStage('review');
                    }}
                />
            ) : null}

            {stage !== 'signin' && loaded.name === 'loading' ? (
                <>
                    <h2 id={titleId}>Subscribe</h2>
                    <p role="status" data-mesub-notice="">
                        Loading the plan.
                    </p>
                </>
            ) : null}

            {stage !== 'signin' && loaded.name === 'failed' ? (
                <>
                    <h2 id={titleId}>Subscribe</h2>
                    <p role="alert" data-mesub-error="">
                        {loaded.message}
                    </p>
                </>
            ) : null}

            {stage !== 'signin' && loaded.name === 'loaded' ? (
                <Stage
                    stage={stage}
                    plan={loaded.plan}
                    chain={chain}
                    titleId={titleId}
                    wallet={user?.walletAddress ?? null}
                    signer={signer}
                    signature={signature}
                    subscription={subscription}
                    error={error}
                    onPay={() => void pay()}
                    onBack={() => {
                        setError('');
                        setStage('review');
                    }}
                    onClose={onClose}
                />
            ) : null}
        </MesubDialog>
    );
}

function Stage({
    stage,
    plan,
    chain,
    titleId,
    wallet,
    signer,
    signature,
    subscription,
    error,
    onPay,
    onBack,
    onClose,
}: {
    stage: Exclude<CheckoutStage, 'signin'>;
    plan: MesubPlan;
    chain: SolanaChain;
    titleId: string;
    wallet: string | null;
    signer: Signer | null;
    signature: string | null;
    subscription: MesubSubscription | null;
    error: string;
    onPay(): void;
    onBack(): void;
    onClose(): void;
}) {
    const price = `${formatAmount(plan.amount, plan.decimals)} ${plan.symbol ?? shortAddress(plan.mint)}`;
    const every = cadence(plan.periodHours);
    const walletName = signer?.wallet.name ?? 'your wallet';
    const testNetwork = chain !== 'solana:mainnet';
    const explorer = signature ? (
        <a
            href={explorerUrl(signature, chain)}
            target="_blank"
            rel="noreferrer"
            data-mesub-explorer=""
        >
            View transaction
        </a>
    ) : null;
    const failed = error ? (
        <p role="alert" data-mesub-error="">
            {error}
        </p>
    ) : null;

    if (stage === 'review') {
        const nextCharge = new Date(Date.now() + plan.periodHours * 3_600_000);
        return (
            <div data-mesub-form="review">
                <div data-mesub-merchant="">
                    {plan.merchant.logoUrl ? (
                        <img src={plan.merchant.logoUrl} alt="" width={40} height={40} />
                    ) : null}
                    <span>{plan.merchant.name}</span>
                </div>
                <h2 id={titleId}>{plan.name}</h2>
                {plan.description ? <p>{plan.description}</p> : null}
                <p data-mesub-price="">
                    <strong>{price}</strong> <span>{every}</span>
                </p>
                <dl data-mesub-summary="">
                    <div data-mesub-row="due">
                        <dt>Due today</dt>
                        <dd>{price}</dd>
                    </div>
                    <div data-mesub-row="next">
                        <dt>Next charge</dt>
                        <dd>{formatDate(nextCharge)}</dd>
                    </div>
                    {wallet ? (
                        <div data-mesub-row="wallet">
                            <dt>Pays from</dt>
                            <dd>{shortAddress(wallet)}</dd>
                        </div>
                    ) : null}
                    <div data-mesub-row="fee">
                        <dt>Network fee</dt>
                        <dd>Paid once in SOL, to open the subscription on Solana</dd>
                    </div>
                </dl>
                <ul data-mesub-terms="">
                    <li>Charged automatically {every}. No signature needed after today.</li>
                    <li>
                        Cancel anytime. You keep access until the end of the period you paid for.
                    </li>
                </ul>
                {testNetwork ? (
                    <p data-mesub-network="devnet">Test network: no real money moves.</p>
                ) : null}
                {plan.available ? null : (
                    <p role="alert" data-mesub-warning="">
                        This plan is not taking new subscribers right now.
                    </p>
                )}
                {failed}
                <button
                    type="button"
                    disabled={!plan.available}
                    onClick={onPay}
                    data-mesub-submit=""
                >
                    Subscribe and pay {price}
                </button>
                <button type="button" onClick={onClose} data-mesub-cancel="">
                    Cancel
                </button>
            </div>
        );
    }

    if (stage === 'approve') {
        return (
            <div data-mesub-form="approve">
                {signer ? <img src={signer.wallet.icon} alt="" width={40} height={40} /> : null}
                <h2 id={titleId}>Approve in {walletName}</h2>
                <p>
                    {walletName === 'your wallet' ? 'Your wallet' : walletName} shows one
                    transaction: {price} now, and permission for Mesub to charge {price} {every}.
                </p>
                {failed ? (
                    <>
                        {failed}
                        <button type="button" onClick={onPay} data-mesub-submit="">
                            Try again
                        </button>
                        <button type="button" onClick={onBack} data-mesub-back="">
                            Back
                        </button>
                    </>
                ) : (
                    <p role="status" aria-busy="true" data-mesub-notice="">
                        Waiting for {walletName}.
                    </p>
                )}
            </div>
        );
    }

    if (stage === 'confirming') {
        return (
            <div data-mesub-form="confirming">
                <h2 id={titleId}>Confirming on Solana</h2>
                {failed ? (
                    <>
                        {failed}
                        <button type="button" onClick={onBack} data-mesub-back="">
                            Back
                        </button>
                    </>
                ) : (
                    <p role="status" aria-busy="true" data-mesub-notice="">
                        This takes a few seconds.
                    </p>
                )}
                {explorer}
            </div>
        );
    }

    const due = subscription?.dueAt ? new Date(subscription.dueAt) : null;
    return (
        <div data-mesub-form="subscribed">
            <h2 id={titleId}>You are subscribed</h2>
            <p>
                {plan.name}, {price} {every}
            </p>
            <dl data-mesub-summary="">
                <div data-mesub-row="paid">
                    <dt>Paid today</dt>
                    <dd>{price}</dd>
                </div>
                {due ? (
                    <div data-mesub-row="next">
                        <dt>Next charge</dt>
                        <dd>{formatDate(due)}</dd>
                    </div>
                ) : null}
                {explorer ? (
                    <div data-mesub-row="receipt">
                        <dt>Receipt</dt>
                        <dd>{explorer}</dd>
                    </div>
                ) : null}
            </dl>
            <button type="button" onClick={onClose} data-mesub-done="">
                Done
            </button>
        </div>
    );
}
