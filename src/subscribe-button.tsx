import {
    forwardRef,
    useCallback,
    useEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type MouseEvent,
} from 'react';
import { useMesubInternal, type SubscribeState } from './context';
import { day, explorerUrl } from './format';
import type { MesubSubscription } from './types';

export interface UseSubscribeOptions {
    // Called once Mesub confirmed it, even if the dialog was closed meanwhile.
    onSubscribed?: ((subscription: MesubSubscription) => void) | undefined;
}

/** What `useSubscribe()` returns. */
export interface UseSubscribeResult {
    // `open` while the dialog is up and nothing is being signed.
    state: SubscribeState;
    subscription: MesubSubscription | null;
    // The transaction that paid the first period, base58, when the wallet is its first signer.
    signature: string | null;
    // Opens the checkout. Resolves when it closes: the subscription, or null if it did not go through.
    subscribe(): Promise<MesubSubscription | null>;
}

/** The subscribe flow, for a button of your own: `subscribe()` opens the Mesub checkout. */
export function useSubscribe(plan: string, options: UseSubscribeOptions = {}): UseSubscribeResult {
    const { subscribe: open } = useMesubInternal();

    const [state, setState] = useState<SubscribeState>('idle');
    const [subscription, setSubscription] = useState<MesubSubscription | null>(null);
    const [signature, setSignature] = useState<string | null>(null);

    // Read at call time: the latest render's callback, without a new `subscribe`.
    const latest = useRef(options);
    latest.current = options;
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const subscribe = useCallback(async (): Promise<MesubSubscription | null> => {
        let done = false;
        const result = await open({
            plan,
            onState: (next) => alive.current && setState(next),
            onSubscribed: (confirmed, paid) => {
                done = true;
                if (alive.current) {
                    setSubscription(confirmed);
                    setSignature(paid);
                    // It may land after the dialog was closed: the button says so all the same.
                    setState('subscribed');
                }
                latest.current.onSubscribed?.(confirmed);
            },
        });
        // Closed before the end: back to where it was.
        if (alive.current) setState(done ? 'subscribed' : 'idle');
        return result;
    }, [open, plan]);

    return { state, subscription, signature, subscribe };
}

export interface SubscribeButtonProps
    extends UseSubscribeOptions, ButtonHTMLAttributes<HTMLButtonElement> {
    // The plan's slug, as set in the Mesub dashboard.
    plan: string;
}

const LABELS: Partial<Record<SubscribeState, string>> = {
    signing: 'Approve in your wallet',
    confirming: 'Confirming',
    subscribed: 'Subscribed',
};

/**
 * Opens the Mesub checkout for a plan. Busy is aria-disabled, not disabled, so
 * the keyboard focus stays on it; only subscribed disables it.
 */
export const SubscribeButton = forwardRef<HTMLButtonElement, SubscribeButtonProps>(
    function SubscribeButton(
        { plan, onSubscribed, children, onClick, disabled, type, ...rest },
        ref,
    ) {
        const { chain, theme } = useMesubInternal();
        const { state, subscription, signature, subscribe } = useSubscribe(plan, { onSubscribed });
        const busy = state === 'signing' || state === 'confirming';
        const due = day(subscription?.next_charge_at);

        function click(event: MouseEvent<HTMLButtonElement>) {
            if (busy) return;
            onClick?.(event);
            if (!event.defaultPrevented) void subscribe();
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
                    data-mesub-theme={theme}
                >
                    {LABELS[state] ?? children ?? 'Subscribe'}
                </button>
                {state === 'subscribed' && (due || signature) ? (
                    <span data-mesub-receipt="" data-mesub-theme={theme}>
                        {due ? `Next charge ${due}` : null}
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
    },
);
