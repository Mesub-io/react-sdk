import {
    forwardRef,
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type HTMLAttributes,
} from 'react';
import { signedOut } from './api';
import { useMesubInternal } from './context';
import { MesubDialog } from './dialog';
import { MesubClientError } from './errors';
import { cadence, day, shortAddress } from './format';
import type { MesubAction, MesubPlan, MesubSubscription } from './types';

/** A subscription the customer holds, with what it allows now. */
export interface MesubHeldSubscription extends MesubSubscription {
    // Cancel a running one, resume a cancellation still running, close one that is over.
    action: MesubAction | null;
}

/** What `useSubscriptions()` returns. */
export interface UseSubscriptionsResult {
    // `signed-out`: the merchant's server answered 401, nobody is signed in on the site.
    state: 'loading' | 'ready' | 'signed-out' | 'error';
    // Newest first. Checkouts never signed are left out.
    subscriptions: MesubHeldSubscription[];
    // The server's message, in the error state.
    error: string | null;
    reload(): Promise<void>;
    // Opens the dialog for what that subscription allows. Resolves when it closes: the
    // subscription as it is now, or null if nothing changed.
    manage(id: string): Promise<MesubSubscription | null>;
}

// A checkout nobody signed, one that failed, one a newer row replaced: not held.
const HELD = new Set(['active', 'cancelled', 'unpaid', 'stopped', 'ended']);

function actionOf(subscription: MesubSubscription, now: number): MesubAction | null {
    const { status } = subscription;
    if (status === 'active' || status === 'unpaid' || status === 'stopped') return 'cancel';
    if (status === 'cancelled') {
        const end = Date.parse(subscription.access_until ?? subscription.current_period_end ?? '');
        // Past its end with the page still open: the server will say `ended` next read.
        return !Number.isNaN(end) && end <= now ? 'close' : 'resume';
    }
    if (status === 'ended') {
        const closed = ['closed', 'authority_closed'].includes(subscription.end_reason ?? '');
        return closed ? null : 'close';
    }
    return null;
}

/** The signed-in customer's subscriptions, read from the merchant's server, and what each allows. */
export function useSubscriptions(): UseSubscriptionsResult {
    const { api, revision, manage: open } = useMesubInternal();

    const [state, setState] = useState<UseSubscriptionsResult['state']>('loading');
    const [rows, setRows] = useState<MesubSubscription[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [now, setNow] = useState(() => Date.now());

    // The latest read wins: an older answer arriving late is dropped.
    const read = useRef(0);
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const reload = useCallback(async () => {
        const id = ++read.current;
        try {
            const served = await api.subscriptions();
            if (!alive.current || id !== read.current) return;
            setRows(served.filter((row) => HELD.has(row.status)));
            setNow(Date.now());
            setError(null);
            setState('ready');
        } catch (failure) {
            if (!alive.current || id !== read.current) return;
            if (signedOut(failure)) {
                setRows([]);
                setError(null);
                setState('signed-out');
                return;
            }
            setError(
                failure instanceof MesubClientError ? failure.message : 'Something went wrong.',
            );
            setState('error');
        }
    }, [api]);

    // On mount, and each time a subscription was made or changed through the widget.
    useEffect(() => {
        void reload();
    }, [reload, revision]);

    // A cancellation reaching its end turns closable: weigh the dates again then.
    useEffect(() => {
        const ends = rows
            .filter((row) => row.status === 'cancelled')
            .map((row) => Date.parse(row.access_until ?? row.current_period_end ?? ''))
            .filter((end) => !Number.isNaN(end) && end > now);
        if (ends.length === 0) return;
        // setTimeout overflows past 24 days: nobody keeps the page open that long.
        const wait = Math.min(Math.min(...ends) - now + 1000, 2_000_000_000);
        const timer = setTimeout(() => setNow(Date.now()), wait);
        return () => clearTimeout(timer);
    }, [rows, now]);

    const subscriptions = rows.map((row) => ({ ...row, action: actionOf(row, now) }));

    const latest = useRef(subscriptions);
    latest.current = subscriptions;
    const manage = useCallback(
        async (id: string): Promise<MesubSubscription | null> => {
            const held = latest.current.find((row) => row.id === id);
            if (!held?.action) return null;
            const { action, ...subscription } = held;
            return open({ subscription, action });
        },
        [open],
    );

    return { state, subscriptions, error, reload, manage };
}

const STATUS: Record<string, string> = {
    active: 'Active',
    unpaid: 'Payment late',
    cancelled: 'Cancelled',
    stopped: 'Stopped',
    ended: 'Ended',
};

const ACTION: Record<MesubAction, string> = { cancel: 'Cancel', resume: 'Resume', close: 'Close' };

/** The one date that matters now: the next charge, the next try, or when access ends. */
function fact(row: MesubHeldSubscription): { term: string; date: string } | null {
    const pick = (term: string, iso: string | null) => {
        const date = day(iso);
        return date ? { term, date } : null;
    };
    if (row.status === 'cancelled') {
        return pick('Access until', row.access_until ?? row.current_period_end);
    }
    if (row.status === 'unpaid') return pick('Next try', row.next_retry_at);
    if (row.status === 'active') return pick('Next charge', row.next_charge_at);
    return null;
}

/** What to do or expect, in a sentence, when the status alone does not say. Null on a healthy one. */
export function noteOf(row: MesubHeldSubscription): string | null {
    if (row.paused) return 'Parked: nothing is charged while it is.';
    if (row.status === 'unpaid') {
        return row.next_retry_at
            ? 'The last payment did not go through. Add funds to the wallet before the next try.'
            : 'The last payment did not go through. Add funds to the wallet.';
    }
    if (row.status === 'cancelled') return 'Cancelled. Resume before the end to keep it.';
    if (row.status === 'stopped') return 'Stopped after missed payments. Nothing more is charged.';
    if (row.status === 'ended') {
        return row.action === 'close'
            ? 'Ended. Close it to get its deposit back.'
            : 'Ended. Nothing more is charged.';
    }
    return null;
}

/** The plans named by the rows, read best effort: a slug stands in for one that cannot be read. */
function usePlans(slugs: string[]): Record<string, MesubPlan> {
    const { plan } = useMesubInternal();
    const [plans, setPlans] = useState<Record<string, MesubPlan>>({});
    const key = [...new Set(slugs)].sort().join(',');

    useEffect(() => {
        let live = true;
        for (const slug of key ? key.split(',') : []) {
            plan(slug).then(
                (served) => live && setPlans((known) => ({ ...known, [slug]: served })),
                () => undefined,
            );
        }
        return () => {
            live = false;
        };
    }, [key, plan]);

    return plans;
}

export interface ManageSubscriptionsProps extends HTMLAttributes<HTMLDivElement> {
    // Called when one was cancelled, resumed or closed.
    onChanged?: ((subscription: MesubSubscription) => void) | undefined;
}

/**
 * The signed-in customer's subscriptions, each with its status, its next date
 * and the one thing it allows now. Styled by its data-mesub-* attributes.
 */
export function ManageSubscriptions({ onChanged, ...rest }: ManageSubscriptionsProps) {
    const { theme } = useMesubInternal();
    const { state, subscriptions, error, reload, manage } = useSubscriptions();
    const plans = usePlans(subscriptions.flatMap((row) => (row.plan ? [row.plan] : [])));
    const [retrying, setRetrying] = useState(false);

    async function act(id: string) {
        const changed = await manage(id);
        if (changed) onChanged?.(changed);
    }

    async function retry() {
        setRetrying(true);
        try {
            await reload();
        } finally {
            setRetrying(false);
        }
    }

    let body;
    if (state === 'loading') {
        body = (
            <p data-mesub-notice="" role="status" aria-busy="true">
                Loading your subscriptions
            </p>
        );
    } else if (state === 'signed-out') {
        body = <p data-mesub-empty="signed-out">Sign in on this site to see your subscriptions.</p>;
    } else if (state === 'error') {
        body = (
            <>
                <p role="alert" data-mesub-error="">
                    {error}
                </p>
                <button
                    type="button"
                    data-mesub-retry=""
                    disabled={retrying}
                    aria-busy={retrying || undefined}
                    onClick={() => void retry()}
                >
                    Try again
                </button>
            </>
        );
    } else if (subscriptions.length === 0) {
        body = <p data-mesub-empty="none">You have no subscription yet.</p>;
    } else {
        body = (
            <ul data-mesub-subscription-list="" aria-label="Your subscriptions">
                {subscriptions.map((row) => {
                    const plan = row.plan ? plans[row.plan] : undefined;
                    const dated = fact(row);
                    const name = plan?.name ?? row.plan ?? 'Subscription';
                    const since = day(row.confirmed_at);
                    const note = noteOf(row);
                    return (
                        <li key={row.id} data-mesub-subscription={row.id}>
                            <div data-mesub-subscription-head="">
                                {plan?.logo_url ? (
                                    <img data-mesub-logo="" src={plan.logo_url} alt="" />
                                ) : (
                                    <span data-mesub-logo="" aria-hidden="true">
                                        {name.slice(0, 1).toUpperCase()}
                                    </span>
                                )}
                                <div data-mesub-subscription-name="">
                                    <strong>{name}</strong>
                                    {plan ? <span>by {plan.project_name}</span> : null}
                                </div>
                                <span data-mesub-status={row.paused ? 'paused' : row.status}>
                                    {row.paused ? 'Parked' : (STATUS[row.status] ?? row.status)}
                                </span>
                            </div>
                            {plan ? (
                                <p data-mesub-subscription-price="">
                                    <strong>
                                        {plan.amount_display}{' '}
                                        {plan.symbol ?? shortAddress(plan.mint)}
                                    </strong>{' '}
                                    {cadence(plan.period_hours)}
                                </p>
                            ) : null}
                            <dl data-mesub-summary="">
                                {dated ? (
                                    <div data-mesub-row="">
                                        <dt>{dated.term}</dt>
                                        <dd>{dated.date}</dd>
                                    </div>
                                ) : null}
                                {since ? (
                                    <div data-mesub-row="">
                                        <dt>Since</dt>
                                        <dd>{since}</dd>
                                    </div>
                                ) : null}
                                <div data-mesub-row="">
                                    <dt>Paid from</dt>
                                    <dd title={row.wallet}>{shortAddress(row.wallet)}</dd>
                                </div>
                            </dl>
                            {note ? <p data-mesub-subscription-note="">{note}</p> : null}
                            {row.action ? (
                                <button
                                    type="button"
                                    data-mesub-action={row.action}
                                    onClick={() => void act(row.id)}
                                >
                                    {ACTION[row.action]}
                                </button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
        );
    }

    return (
        <div
            {...rest}
            data-mesub-subscriptions=""
            data-mesub-state={state}
            data-mesub-theme={theme}
        >
            {body}
        </div>
    );
}

/** The customer's subscriptions in the Mesub dialog: what the Manage button opens. */
export function SubscriptionsDialog({ onClose }: { onClose(): void }) {
    const titleId = useId();

    return (
        <MesubDialog
            titleId={titleId}
            onClose={onClose}
            screen={{
                step: 'subscriptions',
                view: 'subscriptions',
                body: (
                    <>
                        <h2 id={titleId}>Your subscriptions</h2>
                        <ManageSubscriptions data-mesub-in-dialog="" />
                        {/* "Done", not "Close": a row may offer to close a subscription. */}
                        <button type="button" data-mesub-cancel="" onClick={onClose}>
                            Done
                        </button>
                    </>
                ),
            }}
        />
    );
}

export type ManageButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * Opens the customer's subscriptions in a dialog, each with what it allows
 * now: cancel, resume or close. Put it wherever your account menu is.
 */
export const ManageButton = forwardRef<HTMLButtonElement, ManageButtonProps>(function ManageButton(
    { children, onClick, ...rest },
    ref,
) {
    const { openSubscriptions, theme } = useMesubInternal();

    return (
        <button
            type="button"
            {...rest}
            ref={ref}
            data-mesub-manage-button=""
            data-mesub-theme={theme}
            onClick={(event) => {
                onClick?.(event);
                if (!event.defaultPrevented) openSubscriptions();
            }}
        >
            {children ?? 'Manage subscription'}
        </button>
    );
});
