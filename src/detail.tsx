import { useEffect, useId, useState } from 'react';
import { useMesubInternal } from './context';
import { paidIn, paymentSaid, pickSubscription, retryOf } from './detail-logic';
import { MesubDialog } from './dialog';
import {
    cadence,
    day,
    explorerUrl,
    formatAmount,
    moment,
    shortAddress,
    shortMoment,
} from './format';
import {
    fact,
    noteOf,
    PayNow,
    STATUS,
    useSubscriptions,
    type MesubHeldSubscription,
} from './subscriptions';
import type { MesubAction, MesubPlan, MesubSubscriptionDetail } from './types';

const ACTION: Record<MesubAction, string> = {
    cancel: 'Cancel subscription',
    resume: 'Resume subscription',
    close: 'Close and get the deposit back',
};

const UPCOMING: Record<string, string> = { charge: 'Next charge', retry: 'Next try' };

/** The plan a row names, read best effort: its slug stands in until then. */
function usePlan(slug: string | null | undefined): MesubPlan | undefined {
    const { plan } = useMesubInternal();
    const [read, setRead] = useState<MesubPlan | undefined>(undefined);

    useEffect(() => {
        if (!slug) return;
        let live = true;
        plan(slug).then(
            (served) => live && setRead(served),
            () => undefined,
        );
        return () => {
            live = false;
        };
    }, [plan, slug]);

    return slug && read?.slug === slug ? read : undefined;
}

/** What comes next and what was charged, read once the row is known. Null while unknown. */
function useDetail(row: MesubHeldSubscription | null): MesubSubscriptionDetail | null {
    const { api, revision } = useMesubInternal();
    const [detail, setDetail] = useState<MesubSubscriptionDetail | null>(null);
    const id = row?.id;

    useEffect(() => {
        if (!id) return;
        let live = true;
        api.subscription(id).then(
            (served) => live && setDetail(served),
            // An older server has no such route: the view stands without its payments.
            () => undefined,
        );
        return () => {
            live = false;
        };
    }, [api, id, revision]);

    return detail?.subscription.id === id ? detail : null;
}

/**
 * The customer's subscription to a plan, in the Mesub window: what it is, how
 * it stands, what comes next, what was charged, and the one thing it allows.
 * One subscription, never a list: what the Manage button opens.
 */
/** Past payments listed at first, and how many more each request adds. */
const PAST_SHOWN = 5;
const PAST_STEP = 10;

export function SubscriptionDialog({
    plan: slug,
    onClose,
}: {
    plan: string | undefined;
    onClose(): void;
}) {
    // How many past payments are listed: a few, then more on request, never a list that scrolls.
    const [shown, setShown] = useState(PAST_SHOWN);
    const titleId = useId();
    const { chain } = useMesubInternal();
    const { state, subscriptions, error, reload, payNow, manage } = useSubscriptions();
    const row = (pickSubscription(subscriptions, slug) as MesubHeldSubscription | null) ?? null;
    const plan = usePlan(row?.plan);
    const detail = useDetail(row);

    let body;
    if (state === 'loading') {
        body = (
            <>
                <h2 id={titleId}>Your subscription</h2>
                <p data-mesub-notice="" role="status" aria-busy="true">
                    Reading your subscription
                </p>
            </>
        );
    } else if (state === 'signed-out') {
        body = (
            <>
                <h2 id={titleId}>Sign in first</h2>
                <p>Sign in on this site to see your subscription.</p>
            </>
        );
    } else if (state === 'error') {
        body = (
            <>
                <h2 id={titleId}>Your subscription</h2>
                <p role="alert" data-mesub-error="">
                    {error}
                </p>
                <button type="button" data-mesub-retry="" onClick={() => void reload()}>
                    Try again
                </button>
            </>
        );
    } else if (!row) {
        body = (
            <>
                <h2 id={titleId}>No subscription yet</h2>
                <p>You are not subscribed to this plan.</p>
            </>
        );
    } else {
        const name = plan?.name ?? row.plan ?? 'Subscription';
        const dated = fact(row);
        const since = day(row.confirmed_at);
        const note = noteOf(row);
        const upcoming = detail?.upcoming ?? [];
        const past = detail?.payments ?? [];
        // In the plan's token; left out while the plan or the total is unknown, never guessed.
        const total = detail?.paid?.amount ? paidIn(detail.paid.amount, plan, formatAmount) : null;
        // What comes next is told once: on its own line when the server serves it, as a fact otherwise.
        const facts = upcoming.length > 0 && dated?.term !== 'Access until' ? null : dated;

        body = (
            <>
                <div data-mesub-identity="">
                    {plan?.logo_url ? (
                        <img data-mesub-logo="" src={plan.logo_url} alt="" />
                    ) : (
                        <span data-mesub-logo="" aria-hidden="true">
                            {name.slice(0, 1).toUpperCase()}
                        </span>
                    )}
                    <div>
                        <h2 id={titleId}>{name}</h2>
                        {plan ? <span>by {plan.project_name}</span> : null}
                    </div>
                    <span data-mesub-status={row.paused ? 'paused' : row.status}>
                        {row.paused ? 'Parked' : (STATUS[row.status] ?? row.status)}
                    </span>
                </div>

                {plan ? (
                    <p data-mesub-rate="">
                        <strong>
                            {plan.amount_display} {plan.symbol ?? shortAddress(plan.mint)}
                        </strong>{' '}
                        {cadence(plan.period_hours)}
                    </p>
                ) : null}

                {note ? <p data-mesub-state-note="">{note}</p> : null}

                <dl data-mesub-summary="">
                    {facts ? (
                        <div data-mesub-row="">
                            <dt>{facts.term}</dt>
                            <dd>{facts.date}</dd>
                        </div>
                    ) : null}
                    {since ? (
                        <div data-mesub-row="">
                            <dt>Since</dt>
                            <dd>{since}</dd>
                        </div>
                    ) : null}
                    {total ? (
                        <div data-mesub-row="">
                            <dt>Total paid</dt>
                            <dd>{total}</dd>
                        </div>
                    ) : null}
                    {moment(plan?.ends_at) ? (
                        <div data-mesub-row="">
                            <dt>Plan ends</dt>
                            <dd>{moment(plan?.ends_at)}</dd>
                        </div>
                    ) : null}
                    <div data-mesub-row="">
                        <dt>Pays from</dt>
                        <dd title={row.wallet}>{shortAddress(row.wallet)}</dd>
                    </div>
                </dl>

                {upcoming.length > 0 || past.length > 0 ? (
                    // Closed until asked for, as the terms are on the checkout: same toggle.
                    <details data-mesub-terms="" data-mesub-payments="">
                        <summary>Payments</summary>
                        {upcoming.length > 0 ? (
                            <section aria-label="Incoming payments">
                                <h3>Incoming</h3>
                                <ul>
                                    {upcoming.map((next) => (
                                        <li
                                            key={`next-${next.due_at}`}
                                            data-mesub-payment="upcoming"
                                        >
                                            <span>{shortMoment(next.due_at)}</span>
                                            <span>
                                                {UPCOMING[next.kind] ?? next.kind}
                                                {retryOf(next) ? (
                                                    <small title="Retry">{retryOf(next)}</small>
                                                ) : null}
                                            </span>
                                            <span>
                                                {next.amount_display
                                                    ? `${next.amount_display}${plan?.symbol ? ` ${plan.symbol}` : ''}`
                                                    : ''}
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ) : null}
                        {past.length > 0 ? (
                            <section aria-label="Past payments">
                                <h3>Past</h3>
                                <ul>
                                    {past.slice(0, shown).map((payment) => {
                                        const said = paymentSaid(payment);
                                        const amount = paidIn(payment.amount, plan, formatAmount);
                                        return (
                                            <li
                                                key={`${payment.attempted_at}-${payment.signature ?? ''}`}
                                                data-mesub-payment={said.tone}
                                            >
                                                <span>{shortMoment(payment.attempted_at)}</span>
                                                <span>
                                                    {said.label}
                                                    {retryOf(payment) ? (
                                                        <small title="Retry">
                                                            {retryOf(payment)}
                                                        </small>
                                                    ) : null}
                                                </span>
                                                <span>
                                                    {payment.signature &&
                                                    payment.outcome === 'paid' ? (
                                                        <a
                                                            href={explorerUrl(
                                                                payment.signature,
                                                                chain,
                                                            )}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            title="See the transaction"
                                                        >
                                                            {amount ?? 'Receipt'}
                                                        </a>
                                                    ) : (
                                                        amount
                                                    )}
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                                {past.length > shown ? (
                                    <button
                                        type="button"
                                        data-mesub-more=""
                                        onClick={() => setShown(shown + PAST_STEP)}
                                    >
                                        Show more
                                    </button>
                                ) : null}
                            </section>
                        ) : null}
                    </details>
                ) : null}

                {row.payable ? <PayNow pay={() => payNow(row.id)} /> : null}
                {row.action ? (
                    <button
                        type="button"
                        data-mesub-action={row.action}
                        onClick={() => void manage(row.id)}
                    >
                        {ACTION[row.action]}
                    </button>
                ) : null}
            </>
        );
    }

    return (
        <MesubDialog
            titleId={titleId}
            onClose={onClose}
            screen={{
                step: 'subscription',
                view: `subscription-${state}-${row?.id ?? 'none'}`,
                body: (
                    <>
                        {body}
                        <button type="button" data-mesub-cancel="" onClick={onClose}>
                            Done
                        </button>
                    </>
                ),
            }}
        />
    );
}
