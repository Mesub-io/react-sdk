import { useWallets } from '@wallet-standard/react';
import {
    forwardRef,
    useCallback,
    useEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type MouseEvent,
} from 'react';
import { Checkout, type CheckoutStage } from './checkout';
import { useMesub, useMesubInternal } from './context';
import { MesubClientError, MesubSignInCancelledError } from './errors';
import { explorerUrl, formatDate } from './format';
import { WalletError, type SolanaChain } from './send-transaction';
import { tokenWallet } from './session';
import type { MesubSubscription } from './subscribe-api';
import { NotSettledError, subscribeOnce } from './subscribe-flow';

export type SubscribeState = 'idle' | 'signing' | 'confirming' | 'subscribed' | 'error';

export interface UseSubscribeOptions {
    // The network the wallet sends on. Defaults to solana:devnet while Mesub runs there.
    chain?: SolanaChain | undefined;
    onSubscribed?: ((subscription: MesubSubscription) => void) | undefined;
}

/** What `useSubscribe()` returns. */
export interface UseSubscribeResult {
    state: SubscribeState;
    // The API's or the wallet's message, in the error state.
    error: string | null;
    subscription: MesubSubscription | null;
    // The transaction that paid the first period, base58, once subscribed.
    signature: string | null;
    // Signs in first if needed. Resolves with the subscription, or null when it did not go through.
    subscribe(): Promise<MesubSubscription | null>;
}

function messageOf(error: unknown): string {
    if (
        error instanceof MesubClientError ||
        error instanceof WalletError ||
        error instanceof NotSettledError
    ) {
        return error.message;
    }
    return 'Something went wrong. Try again.';
}

/** The Subscribe flow, for a button of your own: sign in, reserve, sign once, confirm. */
export function useSubscribe(plan: string, options: UseSubscribeOptions = {}): UseSubscribeResult {
    const { user, login, getAccessToken } = useMesub();
    const { api } = useMesubInternal();
    const wallets = useWallets();

    const [state, setState] = useState<SubscribeState>('idle');
    const [error, setError] = useState<string | null>(null);
    const [subscription, setSubscription] = useState<MesubSubscription | null>(null);
    const [signature, setSignature] = useState<string | null>(null);

    // Read at call time: the latest render's values, without new callbacks.
    const latest = useRef({ user, wallets, options });
    latest.current = { user, wallets, options };
    const running = useRef(false);
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const subscribe = useCallback(async (): Promise<MesubSubscription | null> => {
        if (running.current) return null;
        running.current = true;
        const fail = (message: string) => {
            if (!alive.current) return;
            setError(message);
            setState('error');
        };
        try {
            let signedIn = latest.current.user;
            if (!signedIn) {
                try {
                    signedIn = await login();
                } catch (cancelled) {
                    // Closing the sign-in is not an error: back to where it was.
                    if (cancelled instanceof MesubSignInCancelledError) return null;
                    throw cancelled;
                }
            }
            if (!alive.current) return null;
            setError(null);
            setState('signing');

            const token = await getAccessToken();
            // The wallet this site pays from: the token's, which a switch may have changed.
            const address = tokenWallet(token) ?? signedIn.walletAddress;
            if (!address || !token) {
                fail('You are signed out. Sign in again.');
                return null;
            }

            const { subscription: confirmed, signature: paid } = await subscribeOnce({
                api,
                accessToken: token,
                plan,
                wallets: latest.current.wallets,
                address,
                chain: latest.current.options.chain ?? 'solana:devnet',
                onSent: () => {
                    if (alive.current) setState('confirming');
                },
            });
            if (alive.current) {
                setSubscription(confirmed);
                setSignature(paid);
                setState('subscribed');
            }
            latest.current.options.onSubscribed?.(confirmed);
            return confirmed;
        } catch (failure) {
            fail(messageOf(failure));
            return null;
        } finally {
            running.current = false;
        }
    }, [api, plan, login, getAccessToken]);

    return { state, error, subscription, signature, subscribe };
}

export interface SubscribeButtonProps
    extends UseSubscribeOptions, ButtonHTMLAttributes<HTMLButtonElement> {
    // The plan's slug, as set in the dashboard.
    plan: string;
    // Opens the Mesub checkout (default). False: signs at once, the button alone shows progress.
    checkout?: boolean | undefined;
}

const LABELS: Record<Exclude<SubscribeState, 'idle'>, string> = {
    signing: 'Approve in your wallet',
    confirming: 'Confirming',
    subscribed: 'Subscribed',
    error: 'Try again',
};

// The button underneath the checkout follows it, so it reads right once closed.
const FROM_STAGE: Partial<Record<CheckoutStage, SubscribeState>> = {
    approve: 'signing',
    confirming: 'confirming',
    subscribed: 'subscribed',
};

/** One signature for the whole subscription. Unstyled: style it by its data-mesub-* attributes. */
export const SubscribeButton = forwardRef<HTMLButtonElement, SubscribeButtonProps>(
    function SubscribeButton({ checkout = true, ...props }, ref) {
        return checkout ? (
            <CheckoutButton {...props} ref={ref} />
        ) : (
            <InlineButton {...props} ref={ref} />
        );
    },
);

type ButtonProps = Omit<SubscribeButtonProps, 'checkout'>;

interface FaceProps extends Omit<ButtonProps, 'plan' | 'chain' | 'onSubscribed'> {
    state: SubscribeState;
    error: string | null;
    subscription: MesubSubscription | null;
    signature: string | null;
    chain: SolanaChain;
    onStart(): void;
}

/**
 * The button and the spans that follow it. Busy is aria-disabled, not
 * disabled, so the keyboard focus stays on it; only subscribed disables it.
 */
const Face = forwardRef<HTMLButtonElement, FaceProps>(function Face(
    {
        state,
        error,
        subscription,
        signature,
        chain,
        onStart,
        children,
        onClick,
        disabled,
        type,
        ...rest
    },
    ref,
) {
    const busy = state === 'signing' || state === 'confirming';
    const due = subscription?.dueAt ? new Date(subscription.dueAt) : null;

    function click(event: MouseEvent<HTMLButtonElement>) {
        if (busy) return;
        onClick?.(event);
        if (!event.defaultPrevented) onStart();
    }

    return (
        <>
            <button
                {...rest}
                ref={ref}
                type={type ?? 'button'}
                disabled={Boolean(disabled) || state === 'subscribed'}
                aria-busy={busy || undefined}
                aria-disabled={busy || undefined}
                onClick={click}
                data-mesub-subscribe=""
                data-mesub-state={state}
            >
                {state === 'idle' ? (children ?? 'Subscribe') : LABELS[state]}
            </button>
            {state === 'error' && error ? (
                <span role="alert" data-mesub-error="">
                    {error}
                </span>
            ) : null}
            {state === 'subscribed' && (due || signature) ? (
                <span data-mesub-receipt="">
                    {due ? `Next charge ${formatDate(due)}` : null}
                    {due && signature ? ' · ' : null}
                    {signature ? (
                        <a href={explorerUrl(signature, chain)} target="_blank" rel="noopener">
                            Receipt
                        </a>
                    ) : null}
                </span>
            ) : null}
        </>
    );
});

const CheckoutButton = forwardRef<HTMLButtonElement, ButtonProps>(function CheckoutButton(
    { plan, chain = 'solana:devnet', onSubscribed, ...rest },
    ref,
) {
    const [open, setOpen] = useState(false);
    const [state, setState] = useState<SubscribeState>('idle');
    const [paid, setPaid] = useState<{ subscription: MesubSubscription; signature: string } | null>(
        null,
    );

    return (
        <>
            <Face
                {...rest}
                ref={ref}
                state={state}
                error={null}
                subscription={paid?.subscription ?? null}
                signature={paid?.signature ?? null}
                chain={chain}
                onStart={() => setOpen(true)}
            />
            {open ? (
                <Checkout
                    plan={plan}
                    chain={chain}
                    onStage={(stage) => setState(FROM_STAGE[stage] ?? 'idle')}
                    onSubscribed={(subscription, signature) => {
                        setPaid({ subscription, signature });
                        onSubscribed?.(subscription);
                    }}
                    onClose={() => {
                        setOpen(false);
                        // Closed before the end: back to where it was.
                        setState((current) => (current === 'subscribed' ? current : 'idle'));
                    }}
                />
            ) : null}
        </>
    );
});

const InlineButton = forwardRef<HTMLButtonElement, ButtonProps>(function InlineButton(
    { plan, chain = 'solana:devnet', onSubscribed, ...rest },
    ref,
) {
    const { state, error, subscription, signature, subscribe } = useSubscribe(plan, {
        chain,
        onSubscribed,
    });

    return (
        <Face
            {...rest}
            ref={ref}
            state={state}
            error={error}
            subscription={subscription}
            signature={signature}
            chain={chain}
            onStart={() => void subscribe()}
        />
    );
});
