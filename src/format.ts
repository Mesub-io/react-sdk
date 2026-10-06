import type { SolanaChain } from './wallet';

/** `2000000` at 6 decimals is `2`, `2500000` is `2.5`: exact, no float. */
export function formatAmount(amount: string, decimals: number): string {
    const units = BigInt(amount);
    const scale = 10n ** BigInt(decimals);
    const whole = (units / scale).toString();
    const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

const NAMED: Record<number, string> = { 24: 'day', 168: 'week', 720: 'month', 8760: 'year' };

/** `every month`, `every 3 days`, `every 6 hours`: the dashboard's own names. */
export function cadence(hours: number): string {
    const named = NAMED[hours];
    if (named) return `every ${named}`;
    if (hours % 24 === 0) return `every ${hours / 24} days`;
    return hours === 1 ? 'every hour' : `every ${hours} hours`;
}

/** Lamports as SOL: `2039280` is `0.00203928 SOL`. */
export function formatSol(lamports: string): string {
    return `${formatAmount(lamports, 9)} SOL`;
}

/** `Oct 4, 2026`, in the subscriber's own locale. */
export function formatDate(date: Date): string {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** `Oct 4`: a date in a list of them, where the year is not in doubt. Null when there is none. */
export function shortDay(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? null
        : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** An ISO date as `formatDate` writes it, or null when there is none to show. */
export function day(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : formatDate(date);
}

/** Within two days either way, the hour matters: an hourly plan's dates all fall on one day. */
const CLOSE_MS = 48 * 3_600_000;

function written(
    iso: string | null | undefined,
    far: Intl.DateTimeFormatOptions,
    now: number,
): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    if (Math.abs(date.getTime() - now) >= CLOSE_MS) return date.toLocaleDateString(undefined, far);

    return date.toLocaleString(undefined, {
        ...far,
        hour: 'numeric',
        minute: '2-digit',
        // The subscriber's own zone, named: an hour alone could be anyone's.
        timeZoneName: 'short',
    });
}

/** A charge or an end as `day` writes it, with its hour when it is close: `Oct 5, 2026, 3:00 PM GMT+2`. */
export function moment(iso: string | null | undefined, now = Date.now()): string | null {
    return written(iso, { month: 'short', day: 'numeric', year: 'numeric' }, now);
}

/** `shortDay` with the hour when it is close: `Oct 5, 3:00 PM GMT+2`. */
export function shortMoment(iso: string | null | undefined, now = Date.now()): string | null {
    return written(iso, { month: 'short', day: 'numeric' }, now);
}

export function shortAddress(address: string): string {
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** The transaction on Solana Explorer, on the network it was sent to. */
export function explorerUrl(signature: string, chain: SolanaChain): string {
    const cluster = chain === 'solana:mainnet' ? '' : `?cluster=${chain.slice('solana:'.length)}`;
    return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

/** One line of the terms the wallet signs: a fact with its name, or a plain sentence. */
export interface TermsLine {
    label: string | null;
    value: string;
}

/**
 * The terms message, line by line, for a list rather than a block of text.
 * Nothing is dropped nor reworded: it is what the wallet is about to sign. The
 * first line is its heading, and a line with no `Name: value` shape stays a
 * sentence.
 */
export function termsLines(message: string): TermsLine[] {
    return message
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line, index) => {
            const named = index === 0 ? null : /^([A-Za-z][A-Za-z ]{0,30}): (.+)$/.exec(line);

            return named ? { label: named[1]!, value: named[2]! } : { label: null, value: line };
        });
}

/** The line that says where a subscription is stopped: a link, not a fact to read. */
const CANCEL_LABEL = 'Cancel any time';

/** Where the terms say the subscription can be cancelled, when it is a web address. */
export function termsCancelUrl(message: string): string | null {
    const line = termsLines(message).find((each) => each.label === CANCEL_LABEL);

    return line && /^https?:\/\/\S+$/.test(line.value) ? line.value : null;
}

/**
 * Whether the terms say the first charge is the only one, as Mesub writes it:
 * `Amount: 2 USDC, a single charge`. Null when they name no amount at all.
 */
export function termsSingleCharge(message: string): boolean | null {
    const lines = termsLines(message);
    const amount = lines.find((each) => each.label === 'Amount');
    if (amount) return amount.value.endsWith(', a single charge');

    return lines.some((each) => each.label === 'Single charge') ? true : null;
}

/** Mesub runs no charge this close to a plan's end: the margin its clock keeps against the chain's. */
const END_MARGIN_MS = 120_000;

/** Whether a plan ending at `endsAt` rules out a charge due at `dueMs`. Never on a plan with no end. */
export function noChargeAt(dueMs: number, endsAt: string | null | undefined): boolean {
    const end = endsAt ? Date.parse(endsAt) : NaN;

    return !Number.isNaN(end) && dueMs + END_MARGIN_MS > end;
}

/**
 * Whether subscribing now leaves one charge only: the period paid starts when
 * the transaction lands, the margin before now at the earliest, and no charge
 * runs at its end once the plan's is that close.
 */
export function chargedOnce(
    plan: { period_hours: number; ends_at: string | null },
    now = Date.now(),
): boolean {
    return noChargeAt(now - END_MARGIN_MS + plan.period_hours * 3_600_000, plan.ends_at);
}

/** Where "Cancel any time" leads, and whether it leaves the site. */
export interface ManageLink {
    href: string;
    external: boolean;
}

/**
 * Where a subscriber goes to stop: your own page when you named one, a path
 * on your site or a full address; Mesub's, as the terms give it, otherwise.
 * `null` shows no button at all. An address that is neither falls back to
 * Mesub's rather than become a link to anything.
 */
export function manageLink(
    yours: string | null | undefined,
    fromTerms: string | null,
): ManageLink | null {
    if (yours === null) return null;
    if (typeof yours === 'string') {
        if (/^\/(?!\/)\S*$/.test(yours)) return { href: yours, external: false };
        if (/^https?:\/\/\S+$/.test(yours)) return { href: yours, external: true };
    }

    return fromTerms ? { href: fromTerms, external: true } : null;
}

/** Lines of the terms a person does not read: said elsewhere on the screen, or for machines. */
const NOT_SHOWN = new Set([
    // Also on a single charge: its own line says it, in full.
    'Amount',
    'Plan',
    'Plan details',
    'Wallet',
    'Nonce',
    'Expires',
    // The merchant may change where it is paid: not a term a subscriber holds them to.
    'Paid to',
    // Shown as a button under the list.
    CANCEL_LABEL,
]);

const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

/** One fact of the terms, as the review lists it. `full` is the whole value when it was shortened. */
export interface TermsFact {
    label: string;
    value: string;
    full?: string;
    /** Where the value leads, when it is worth a click: the token's page on Jupiter. */
    href?: string;
}

/** The token's page on Jupiter, where it is bought or swapped. */
export function jupiterUrl(mint: string): string {
    return `https://jup.ag/tokens/${mint}`;
}

/**
 * The terms as a short list a person reads: the first charge, what follows
 * or that nothing does, when access stops on a plan that ends, which
 * subscription and in which token. The price, the wallet and the
 * lines meant for machines (the plan's address, the nonce, the expiry) are
 * left out, and addresses are shortened: the wallet shows the full text when
 * it asks to sign.
 */
export function termsFacts(message: string): TermsFact[] {
    return termsLines(message)
        .filter((line): line is { label: string; value: string } => line.label !== null)
        .filter((line) => !NOT_SHOWN.has(line.label))
        .map(({ label, value }) => {
            // "USDC, mint 4zMM..." is the token's name; a mint alone stays, shortened.
            const named = /^(.+), mint ([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(value);
            if (named) {
                return { label, value: named[1]!, full: value, href: jupiterUrl(named[2]!) };
            }

            const address = ADDRESS.exec(value)?.[0];
            if (address) {
                return {
                    label,
                    value: value.replace(address, shortAddress(address)),
                    full: value,
                    // A mint with no name is still a token to get.
                    ...(label === 'Token' && { href: jupiterUrl(address) }),
                };
            }

            // The transaction comes right after: the screen's own button says so.
            const trimmed = value
                .replace(/, in the transaction you sign next$/, '')
                .replace(/^https?:\/\//, '');

            return trimmed === value ? { label, value } : { label, value: trimmed, full: value };
        });
}
