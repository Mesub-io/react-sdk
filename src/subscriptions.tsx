import {
    forwardRef,
    useCallback,
    useEffect,
    useRef,
    useState,
    type ButtonHTMLAttributes,
    type HTMLAttributes,
} from 'react';
import { signedOut } from './api';
import { useMesubInternal } from './context';
import { MesubClientError } from './errors';
import { cadence, day, moment, shortAddress } from './format';
import type { MesubAction, MesubPlan, MesubSubscription } from './types';

/** A subscription the customer holds, with what it allows now. */
export interface MesubHeldSubscription extends MesubSubscription {
    // Cancel a running one, resume a cancellation still running, close one that is over.
    action: MesubAction | null;
    // A late payment the customer can pay now (Mesub-io/backend#354), see `payNow`.
    payable: boolean;
}

/** What a "Pay now" came to, in the words the widget shows. */
export interface PayNowResult {
    // Sent: the outcome comes with the pull, and the list reads again.
    ok: boolean;
    message: string;
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
    // Pays that late payment now: nothing to sign. Never throws: a refusal is its `message`.
    payNow(id: string): Promise<PayNowResult>;
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

/**
 * Whether paying a late payment now can succeed (Mesub-io/backend#354): late,
 * not paused, still approved by the wallet, and before `retry_deadline` when
 * there is one. Mesub refuses the rest anyway; the button is not offered.
 */
export function payableOf(row: MesubSubscription, now: number): boolean {
    if (row.status !== 'unpaid' || row.paused) return false;
    if (row.late_reason === 'approval_revoked' || row.late_reason === 'authority_closed') {
        return false;
    }
    const deadline = Date.parse(row.retry_deadline ?? '');
    return Number.isNaN(deadline) || deadline > now;
}

export const PAY_NOW_SENT = 'Payment sent. It shows here once the network confirms it.';

/** Why paying now was refused, as the canonical table words it; Mesub's own message otherwise. */
export function payNowRefusal(failure: unknown): string {
    if (!(failure instanceof MesubClientError)) return 'Something went wrong.';
    switch (failure.code) {
        case 'insufficient_balance':
            return `${failure.message} Add funds, then pay again: no retry was spent.`;
        case 'retry_too_soon': {
            const minutes = failure.retryAfter === null ? null : Math.ceil(failure.retryAfter / 60);
            return minutes === null
                ? failure.message
                : `You can pay again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
        }
        case 'retries_spent':
            return 'No retries are left for this period.';
        case 'retry_deadline_passed':
            return 'It is too late to pay this period: the subscription stops at its end.';
        default:
            return failure.message;
    }
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

    const subscriptions = rows.map((row) => ({
        ...row,
        action: actionOf(row, now),
        payable: payableOf(row, now),
    }));

    const latest = useRef(subscriptions);
    latest.current = subscriptions;
    const manage = useCallback(
        async (id: string): Promise<MesubSubscription | null> => {
            const held = latest.current.find((row) => row.id === id);
            if (!held?.action) return null;
            const { action, payable: _, ...subscription } = held;
            return open({ subscription, action });
        },
        [open],
    );

    const payNow = useCallback(
        async (id: string): Promise<PayNowResult> => {
            try {
                await api.payNow(id);
            } catch (failure) {
                return { ok: false, message: payNowRefusal(failure) };
            }
            // Still late until the pull lands: read again for what it says now.
            void reload();
            return { ok: true, message: PAY_NOW_SENT };
        },
        [api, reload],
    );

    return { state, subscriptions, error, reload, payNow, manage };
}

export const STATUS: Record<string, string> = {
    active: 'Active',
    unpaid: 'Payment late',
    cancelled: 'Cancelled',
    stopped: 'Stopped',
    ended: 'Ended',
};

const ACTION: Record<MesubAction, string> = { cancel: 'Cancel', resume: 'Resume', close: 'Close' };

/** The one date that matters now: the next charge, the next try, or when access ends. */
export function fact(row: MesubHeldSubscription): { term: string; date: string } | null {
    const pick = (term: string, iso: string | null) => {
        const date = moment(iso);
        return date ? { term, date } : null;
    };
    if (row.status === 'cancelled') {
        return pick('Access until', row.access_until ?? row.current_period_end);
    }
    // On Free no try of Mesub's comes: what is left is the date to pay by.
    if (row.status === 'unpaid') {
        return pick('Next try', row.next_retry_at) ?? pick('Pay by', row.retry_deadline);
    }
    if (row.status === 'active') {
        // No charge to come, in the last period of a plan that ends: what is left is its access.
        return pick('Next charge', row.next_charge_at) ?? pick('Access until', row.access_until);
    }
    return null;
}

/** What to do or expect, in a sentence, when the status alone does not say. Null on a healthy one. */
export function noteOf(row: MesubHeldSubscription): string | null {
    if (row.paused) return 'Parked: nothing is charged while it is.';
    if (row.status === 'unpaid') {
        // Adding funds only fixes a low balance: said for that, and when Mesub names no reason.
        if (row.late_reason === 'approval_revoked') {
            return 'The last payment did not go through. This wallet no longer lets Mesub charge it: adding funds will not fix it.';
        }
        if (row.late_reason === 'authority_closed') {
            return 'The last payment did not go through. This wallet closed its authorisation: it can no longer be charged.';
        }
        if (row.next_retry_at) {
            return 'The last payment did not go through. Add funds to the wallet, then pay now, with nothing to sign; otherwise Mesub tries again at the next try.';
        }
        return row.retry_deadline
            ? 'The last payment did not go through, so access is off. Add funds to the wallet, then pay now, with nothing to sign, before the date to pay by.'
            : 'The last payment did not go through. Add funds to the wallet, then pay now.';
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

/** "Pay now", and what came of it, read out where it was clicked. */
export function PayNow({ pay }: { pay(): Promise<PayNowResult> }) {
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<PayNowResult | null>(null);

    async function click() {
        setBusy(true);
        try {
            setSaid(await pay());
        } finally {
            setBusy(false);
        }
    }

    return (
        <div data-mesub-pay-now="">
            <button
                type="button"
                data-mesub-action="pay-now"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void click()}
            >
                Pay now
            </button>
            {said ? (
                <p
                    role={said.ok ? 'status' : 'alert'}
                    data-mesub-pay-now-said={said.ok ? 'sent' : 'refused'}
                >
                    {said.message}
                </p>
            ) : null}
        </div>
    );
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
    const { state, subscriptions, error, reload, payNow, manage } = useSubscriptions();
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
                            {row.payable ? <PayNow pay={() => payNow(row.id)} /> : null}
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

export interface ManageButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    // The plan whose subscription it opens. Left out: the customer's live one, whatever the plan.
    plan?: string | undefined;
}

/**
 * Opens the customer's subscription to a plan in the Mesub window: how it
 * stands, what comes next, what was charged, and cancel, resume or close.
 */
export const ManageButton = forwardRef<HTMLButtonElement, ManageButtonProps>(function ManageButton(
    { plan, children, onClick, ...rest },
    ref,
) {
    const { openSubscription, theme } = useMesubInternal();

    return (
        <button
            type="button"
            {...rest}
            ref={ref}
            data-mesub-manage-button=""
            data-mesub-theme={theme}
            onClick={(event) => {
                onClick?.(event);
                if (!event.defaultPrevented) openSubscription(plan);
            }}
        >
            {children ?? 'Manage subscription'}
        </button>
    );
});
