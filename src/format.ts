import type { MesubPlan } from './types';
import type { SolanaChain } from './wallet';

/** `2000000` at 6 decimals is `2`, `2500000` is `2.5`: exact, no float. */
export function formatAmount(amount: string, decimals: number): string {
    const units = BigInt(amount);
    const scale = 10n ** BigInt(decimals);
    const whole = (units / scale).toString();
    const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
}

/** `30000` is `30,000`, `1234.5` is `1,234.5`: one grouping, whatever the browser's locale. */
export function grouped(display: string): string {
    const [whole = '', fraction] = display.split('.');
    if (!/^\d+$/.test(whole)) return display;
    const spaced = whole.replace(/\B(?=(\d{3})+$)/g, ',');
    return fraction === undefined ? spaced : `${spaced}.${fraction}`;
}

/** Decimal dollars as `$0.10` or `$1,234.50`; under a cent, `less than $0.01`. Null when unreadable. */
export function formatUsd(value: string | null | undefined): string | null {
    if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null;
    const dollars = Number(value);
    if (!Number.isFinite(dollars) || dollars >= 1e15) return null;
    if (dollars < 0.01) return 'less than $0.01';
    return `$${grouped(dollars.toFixed(2))}`;
}

/** An estimate says so: `about $0.10`. */
export function aboutUsd(value: string | null | undefined): string | null {
    const usd = formatUsd(value);
    if (!usd) return null;
    return usd.startsWith('less') ? usd : `about ${usd}`;
}

const SYMBOL_MAX = 12;
const NAME_MAX = 32;
/** The stablecoins Mesub vouches for: an unverified token never reads as one. */
const VOUCHED = new Set(['USDC', 'USDT', 'PYUSD']);

/** A token's own text, untrusted: no control or invisible character, one line, cut short. */
function clean(text: unknown, max: number): string | null {
    if (typeof text !== 'string') return null;
    const plain = text
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!plain) return null;
    const letters = Array.from(plain);
    return letters.length > max ? `${letters.slice(0, max).join('')}…` : plain;
}

/** How a plan's token reads on screen. */
export interface TokenText {
    // The symbol, or the short mint when it has none.
    unit: string;
    // Whether `unit` is a symbol.
    named: boolean;
    name: string | null;
    // An https image of a verified token, else null.
    logo: string | null;
    // Said by Mesub, not guessed: false against a server that predates `token`.
    unverified: boolean;
    // Its amount is its dollar value: no estimate beside it.
    vouched: boolean;
    shortMint: string;
}

type Priced = Pick<MesubPlan, 'symbol' | 'mint' | 'token'>;

function httpsUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        return new URL(value).protocol === 'https:' ? value : null;
    } catch {
        return null;
    }
}

/** The token of a plan: `token.symbol`, else the vouched `symbol`, else the short mint. */
export function tokenOf(plan: Priced): TokenText {
    const token = typeof plan.token === 'object' && plan.token !== null ? plan.token : null;
    const vouched = typeof plan.symbol === 'string' && plan.symbol !== '';
    const verified = vouched || token?.verified === true;
    const unverified = token !== null && !verified;
    const shortMint = shortAddress(plan.mint);

    let symbol =
        clean(token?.symbol, SYMBOL_MAX) ?? (vouched ? clean(plan.symbol, SYMBOL_MAX) : null);
    let name = clean(token?.name, NAME_MAX);
    // Mesub already drops these: said again here, the widget trusts no unverified text.
    if (unverified && symbol && VOUCHED.has(symbol.toUpperCase())) symbol = null;
    if (unverified && name && VOUCHED.has(name.toUpperCase())) name = null;

    return {
        unit: symbol ?? shortMint,
        named: symbol !== null,
        name,
        logo: verified ? httpsUrl(token?.logo_url) : null,
        unverified,
        vouched,
        shortMint,
    };
}

/** The one way an amount is written: `30,000 Bonk`, `1 USDC`, `30,000 DezX…B263`. */
export function priceOf(plan: Priced & Pick<MesubPlan, 'amount_display'>): string {
    return `${grouped(plan.amount_display)} ${tokenOf(plan).unit}`;
}

const UNITS = ['K', 'M', 'B', 'T'];

/**
 * `30000` is `30K`, `30500` is `30.5K`, `6000000000` is `6B`: from 10,000 up,
 * under 1e15, and only when nothing is lost at two decimals. Null when the
 * amount stays in full. On the digits as text: never rounded, never a float.
 */
export function short(display: string): string | null {
    if (!/^\d+$/.test(display)) return null;
    const digits = display.replace(/^0+(?=\d)/, '');
    if (digits.length < 5 || digits.length > 15) return null;

    // The largest unit it reaches: K for 5 or 6 digits, T for 13 to 15.
    const unit = Math.floor((digits.length - 1) / 3);
    const cut = digits.length - unit * 3;
    const rest = digits.slice(cut);
    if (/[1-9]/.test(rest.slice(2))) return null;

    const decimals = rest.slice(0, 2).replace(/0+$/, '');
    return `${digits.slice(0, cut)}${decimals ? `.${decimals}` : ''}${UNITS[unit - 1]}`;
}

/** An amount where it is read fast. `title` is the exact one, set only when `text` is short. */
export interface Brief {
    text: string;
    title: string | undefined;
}

/** Short when the rule allows and the token is no vouched stablecoin, in full otherwise. */
export function brief(display: string, vouched: boolean, unit = ''): Brief {
    const full = `${grouped(display)}${unit}`;
    const cut = vouched ? null : short(display);

    return cut ? { text: `${cut}${unit}`, title: full } : { text: full, title: undefined };
}

/** `priceOf` where it is read fast: `30K Bonk`, `1,500 USDC`, `30,512 Bonk`. */
export function briefPrice(plan: Priced & Pick<MesubPlan, 'amount_display'>): Brief {
    const token = tokenOf(plan);

    return brief(plan.amount_display, token.vouched, ` ${token.unit}`);
}

/** How far a long amount shrinks to stay in its box, for `data-mesub-fit`. None at ordinary lengths. */
export function fit(text: string): '2' | '3' | '4' | undefined {
    const length = Array.from(text).length;
    if (length > 30) return '4';
    if (length > 18) return '3';
    return length > 14 ? '2' : undefined;
}

/** The plan's dollar value as an estimate, or null: never beside a vouched stablecoin. */
export function planUsd(plan: Priced & Pick<MesubPlan, 'amount_usd'>): string | null {
    return tokenOf(plan).vouched ? null : aboutUsd(plan.amount_usd);
}

/** The one line an unverified token gets, with the mint to check it against. Null otherwise. */
export function unverifiedNote(plan: Priced): string | null {
    const token = tokenOf(plan);
    if (!token.unverified) return null;
    return token.name
        ? `Unverified token: ${token.name}, mint ${token.shortMint}`
        : `Unverified token, mint ${token.shortMint}`;
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/**
 * A plan's end, always with its time and in UTC: `Oct 20, 2026, 23:59 UTC`.
 * A plan ends on any second, not on a day, and the same words for everyone,
 * whatever their zone. Seconds are dropped: 23:59:59 reads 23:59.
 */
export function planEnd(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;

    return (
        `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ` +
        `${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`
    );
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
    /** A short line under the value: "Unverified token". */
    note?: string;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The plan's amount where a term states it (`30000 tokens`, `2 USDC`), as the screen writes it. */
function repriced(value: string, plan: TermsPlan): string {
    const units = ['tokens', ...(plan.symbol ? [escaped(plan.symbol)] : [])].join('|');
    const said = new RegExp(
        `(^|[^\\d.,])${escaped(plan.amount_display)} (?:${units})(?![\\w.])`,
        'g',
    );
    // A token with no symbol stays "tokens": its mint is on the Token line.
    const price = tokenOf(plan).named ? priceOf(plan) : `${grouped(plan.amount_display)} tokens`;

    return value.replace(said, (_, before: string) => `${before}${price}`);
}

type TermsPlan = Pick<MesubPlan, 'symbol' | 'mint' | 'token' | 'amount_display'>;

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
 * it asks to sign. With the plan, amounts and the token read as on the rest
 * of the screen; `full` stays the line as signed.
 */
export function termsFacts(message: string, plan?: TermsPlan): TermsFact[] {
    const token = plan ? tokenOf(plan) : null;
    const note = token?.unverified ? { note: 'Unverified token' } : {};

    return termsLines(message)
        .filter((line): line is { label: string; value: string } => line.label !== null)
        .filter((line) => !NOT_SHOWN.has(line.label))
        .map(({ label, value }) => {
            // "USDC, mint 4zMM..." is the token's name; a mint alone stays, shortened.
            const named = /^(.+), mint ([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(value);
            if (named) {
                return {
                    label,
                    value: named[1]!,
                    full: value,
                    href: jupiterUrl(named[2]!),
                    ...(label === 'Token' && note),
                };
            }

            const address = ADDRESS.exec(value)?.[0];
            if (address) {
                const short = value.replace(address, shortAddress(address));
                // The plan's own mint, unnamed in the terms: Mesub's symbol beside it.
                const known = label === 'Token' && token?.named && address === plan?.mint;
                return {
                    label,
                    value: known ? `${token.unit}, ${short}` : short,
                    full: value,
                    // A mint with no name is still a token to get.
                    ...(label === 'Token' && { href: jupiterUrl(address), ...note }),
                };
            }

            // The transaction comes right after: the screen's own button says so.
            const trimmed = value
                .replace(/, in the transaction you sign next$/, '')
                .replace(/^https?:\/\//, '');

            const shown = plan ? repriced(trimmed, plan) : trimmed;

            return shown === value ? { label, value } : { label, value: shown, full: value };
        });
}
