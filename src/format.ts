import type { SolanaChain } from './send-transaction';

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

/** `Oct 4, 2026`, in the subscriber's own locale. */
export function formatDate(date: Date): string {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function shortAddress(address: string): string {
    return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** The transaction on Solana Explorer, on the network it was sent to. */
export function explorerUrl(signature: string, chain: SolanaChain): string {
    const cluster = chain === 'solana:mainnet' ? '' : `?cluster=${chain.slice('solana:'.length)}`;
    return `https://explorer.solana.com/tx/${signature}${cluster}`;
}
