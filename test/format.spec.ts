import { cadence, day, explorerUrl, formatAmount, formatSol, shortAddress } from '../src/format';

describe('formatAmount', () => {
    it.each([
        ['2000000', 6, '2'],
        ['2500000', 6, '2.5'],
        ['1', 6, '0.000001'],
        ['0', 6, '0'],
        ['18446744073709551615', 6, '18446744073709.551615'],
        ['42', 0, '42'],
    ])('%s at %i decimals is %s', (amount, decimals, expected) => {
        expect(formatAmount(amount, decimals)).toBe(expected);
    });
});

describe('formatSol', () => {
    it.each([
        ['2039280', '0.00203928 SOL'],
        ['10000', '0.00001 SOL'],
        ['1000000000', '1 SOL'],
        ['0', '0 SOL'],
    ])('%s lamports is %s', (lamports, expected) => {
        expect(formatSol(lamports)).toBe(expected);
    });
});

describe('day', () => {
    it('writes an ISO date as a day', () => {
        expect(day('2026-10-04T12:00:00.000Z')).toMatch(/2026/);
    });

    it.each([null, undefined, '', 'soon'])('is null for %s', (value) => {
        expect(day(value)).toBeNull();
    });
});

describe('cadence', () => {
    it.each([
        [24, 'every day'],
        [168, 'every week'],
        [720, 'every month'],
        [8760, 'every year'],
        [72, 'every 3 days'],
        [1, 'every hour'],
        [6, 'every 6 hours'],
    ])('%i hours is %s', (hours, expected) => {
        expect(cadence(hours)).toBe(expected);
    });
});

describe('explorerUrl', () => {
    it('names the cluster off mainnet', () => {
        expect(explorerUrl('sig', 'solana:devnet')).toBe(
            'https://explorer.solana.com/tx/sig?cluster=devnet',
        );
    });

    it('names none on mainnet', () => {
        expect(explorerUrl('sig', 'solana:mainnet')).toBe('https://explorer.solana.com/tx/sig');
    });
});

it('shortens an address to its ends', () => {
    expect(shortAddress('Ffy3EvkCabcdefgbEz')).toBe('Ffy3…gbEz');
});
