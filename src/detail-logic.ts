import type { MesubPayment, MesubPlan, MesubSubscription } from './types';

/** Statuses of a subscription worth opening first: something is still running or owed. */
const LIVE = ['active', 'unpaid', 'cancelled', 'stopped'];

/** Nothing to manage: checkouts nobody signed, and rows a newer one replaced. */
const NOT_ONE = ['pending', 'expired', 'failed', 'superseded'];

/**
 * The one subscription the Manage window is about: the customer's to that
 * plan, or to any when none is named. A live one before an ended one, the
 * newest first within each. Null when there is none.
 */
export function pickSubscription(
    rows: readonly MesubSubscription[],
    plan?: string | undefined,
): MesubSubscription | null {
    const theirs = rows
        .filter((row) => !NOT_ONE.includes(row.status))
        .filter((row) => plan === undefined || row.plan === plan)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    return theirs.find((row) => LIVE.includes(row.status)) ?? theirs[0] ?? null;
}

/** How one charge reads: a word, and whether it went well, badly, or neither. */
export interface PaymentSaid {
    label: string;
    tone: 'good' | 'bad' | 'none';
}

const REASONS: Record<string, string> = {
    'insufficient-balance': 'low balance',
    'approval-revoked': 'approval was removed',
};

/** A charge in words. An outcome this version does not know is shown as Mesub named it. */
export function paymentSaid(payment: Pick<MesubPayment, 'outcome' | 'reason'>): PaymentSaid {
    const why = payment.reason ? REASONS[payment.reason] : undefined;

    switch (payment.outcome) {
        case 'paid':
            return { label: 'Paid', tone: 'good' };
        case 'rejected':
            return { label: why ? `Missed, ${why}` : 'Missed', tone: 'bad' };
        case 'skipped':
            return { label: 'Skipped', tone: 'none' };
        case 'blocked':
            return { label: 'Not charged', tone: 'none' };
        default:
            return { label: payment.outcome.toLowerCase().replace(/_/g, ' '), tone: 'none' };
    }
}

/** An amount in the plan's token, or null when the plan could not be read: never a guess. */
export function paidIn(
    amount: string,
    plan: Pick<MesubPlan, 'decimals' | 'symbol'> | undefined,
    format: (amount: string, decimals: number) => string,
): string | null {
    if (!plan || !/^\d+$/.test(amount)) return null;

    return `${format(amount, plan.decimals)}${plan.symbol ? ` ${plan.symbol}` : ''}`;
}

/** `2 / 3`: which retry, out of how many the plan allows. Null when it is not one, or not said. */
export function retryOf(of: {
    retry_number?: number | null | undefined;
    retries_allowed?: number | null | undefined;
}): string | null {
    const { retry_number: number, retries_allowed: allowed } = of;
    if (!Number.isInteger(number) || !Number.isInteger(allowed)) return null;
    return number! > 0 && allowed! > 0 ? `${number} / ${allowed}` : null;
}
