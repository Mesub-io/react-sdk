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
import { useMesub, useMesubInternal } from './context';
import { MesubClientError, MesubSignInCancelledError } from './errors';
import { findSigner, signAndSend, WalletError, type SolanaChain } from './send-transaction';
import type { MesubSubscription } from './subscribe-api';

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
    // Signs in first if needed. Resolves with the subscription, or null when it did not go through.
    subscribe(): Promise<MesubSubscription | null>;
}

function messageOf(error: unknown): string {
    if (error instanceof MesubClientError || error instanceof WalletError) return error.message;
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

            const address = signedIn.walletAddress;
            const token = await getAccessToken();
            if (!address || !token) {
                fail('You are signed out. Sign in again.');
                return null;
            }

            const reserved = await api.subscriptions.reserve(token, plan);
            const { transaction } = await api.subscriptions.transaction(token, reserved.id);
            const signer = await findSigner(latest.current.wallets, address);
            const chain = latest.current.options.chain ?? 'solana:devnet';
            const signature = await signAndSend(signer, chain, transaction);

            if (!alive.current) return null;
            setState('confirming');
            const confirmed = await api.subscriptions.confirm(token, reserved.id, signature);
            if (confirmed.reason) {
                fail(confirmed.reason);
                return null;
            }
            if (alive.current) {
                setSubscription(confirmed.subscription);
                setState('subscribed');
            }
            latest.current.options.onSubscribed?.(confirmed.subscription);
            return confirmed.subscription;
        } catch (failure) {
            fail(messageOf(failure));
            return null;
        } finally {
            running.current = false;
        }
    }, [api, plan, login, getAccessToken]);

    return { state, error, subscription, subscribe };
}

export interface SubscribeButtonProps
    extends UseSubscribeOptions, ButtonHTMLAttributes<HTMLButtonElement> {
    // The plan's slug, as set in the dashboard.
    plan: string;
}

const LABELS: Record<Exclude<SubscribeState, 'idle'>, string> = {
    signing: 'Approve in your wallet',
    confirming: 'Confirming',
    subscribed: 'Subscribed',
    error: 'Try again',
};

/** One signature for the whole subscription. Unstyled: style it by its data-mesub-* attributes. */
export const SubscribeButton = forwardRef<HTMLButtonElement, SubscribeButtonProps>(
    function SubscribeButton(
        { plan, chain, onSubscribed, children, onClick, disabled, type, ...rest },
        ref,
    ) {
        const { state, error, subscribe } = useSubscribe(plan, { chain, onSubscribed });
        const busy = state === 'signing' || state === 'confirming';

        function click(event: MouseEvent<HTMLButtonElement>) {
            onClick?.(event);
            if (!event.defaultPrevented) void subscribe();
        }

        return (
            <>
                <button
                    {...rest}
                    ref={ref}
                    type={type ?? 'button'}
                    disabled={Boolean(disabled) || busy || state === 'subscribed'}
                    aria-busy={busy || undefined}
                    onClick={click}
                    data-mesub-subscribe=""
                    data-mesub-state={state}
                >
                    {state === 'idle' ? (children ?? 'Subscribe') : LABELS[state]}
                </button>
                {error ? (
                    <span role="alert" data-mesub-error="">
                        {error}
                    </span>
                ) : null}
            </>
        );
    },
);
