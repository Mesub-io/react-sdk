import {
    cadence,
    day,
    explorerUrl,
    formatAmount,
    formatSol,
    shortAddress,
    termsCancelUrl,
    termsFacts,
    termsLines,
} from '../src/format';

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

describe('termsLines', () => {
    const MESSAGE = [
        'Mesub: the terms of the subscription you are about to sign.',
        'Amount: 2 USDC every 3 days',
        'Paid to: 69NhtEhTjxGq1pGRgwZjqVoGyr5nNY7w7By6vTh1E7WB',
        'Cancel any time: https://mesub.io/subscriptions',
        'Signing this message moves nothing by itself.',
        'Expires: 2026-10-03T21:00:00.000Z',
    ].join('\n');

    it('keeps the first line as the heading, whatever its shape', () => {
        expect(termsLines(MESSAGE)[0]).toEqual({
            label: null,
            value: 'Mesub: the terms of the subscription you are about to sign.',
        });
    });

    it('splits a named fact on its first colon only: a url and a date keep theirs', () => {
        const lines = termsLines(MESSAGE);

        expect(lines[1]).toEqual({ label: 'Amount', value: '2 USDC every 3 days' });
        expect(lines[3]).toEqual({
            label: 'Cancel any time',
            value: 'https://mesub.io/subscriptions',
        });
        expect(lines[5]).toEqual({ label: 'Expires', value: '2026-10-03T21:00:00.000Z' });
    });

    it('leaves a sentence a sentence', () => {
        expect(termsLines(MESSAGE)[4]).toEqual({
            label: null,
            value: 'Signing this message moves nothing by itself.',
        });
    });

    it('drops nothing and rewords nothing: the lines rebuild the message', () => {
        const rebuilt = termsLines(MESSAGE)
            .map((line) => (line.label ? `${line.label}: ${line.value}` : line.value))
            .join('\n');

        expect(rebuilt).toBe(MESSAGE);
    });

    it('skips blank lines, and answers nothing for an empty message', () => {
        expect(termsLines('a\n\nB: c\n')).toEqual([
            { label: null, value: 'a' },
            { label: 'B', value: 'c' },
        ]);
        expect(termsLines('')).toEqual([]);
    });
});

describe('termsFacts', () => {
    const MESSAGE = [
        'Mesub: the terms of the subscription you are about to sign.',
        'Amount: 2 USDC every 3 days',
        'First charge: 2 USDC now, in the transaction you sign next',
        'Then: 2 USDC every 3 days, until you cancel',
        'Paid to: 69NhtEhTjxGq1pGRgwZjqVoGyr5nNY7w7By6vTh1E7WB',
        'Subscription: Pro, from Acme',
        'Token: USDC, mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        'Cancel any time: https://mesub.io/subscriptions',
        'Plan: EZcr6mpXS48uMccxQWn7UhUW9b8WBwYTYyyLzGwWH6En',
        'Plan details: https://api.mesub.io/m/EZcr6mpXS48uMccxQWn7UhUW9b8WBwYTYyyLzGwWH6En',
        'Wallet: 2YwUMbyZPC42iEXx2peDe5V46LGLrZgdU6rd89fbRaJr',
        'Signing this message moves nothing by itself.',
        'Nonce: 9f2c1e7ab04d',
        'Expires: 2026-10-03T21:30:00.000Z',
    ].join('\n');

    it('lists what a person reads, in the order of the message', () => {
        expect(termsFacts(MESSAGE).map((fact) => [fact.label, fact.value])).toEqual([
            ['First charge', '2 USDC now'],
            ['Then', '2 USDC every 3 days, until you cancel'],
            ['Paid to', '69Nh…E7WB'],
            ['Subscription', 'Pro, from Acme'],
            ['Token', 'USDC'],
        ]);
        // Where to cancel is a button, not a row.
        expect(termsCancelUrl(MESSAGE)).toBe('https://mesub.io/subscriptions');
    });

    it('keeps the whole value of what it shortened, for a tooltip', () => {
        const facts = Object.fromEntries(termsFacts(MESSAGE).map((fact) => [fact.label, fact]));

        expect(facts['Paid to']?.full).toBe('69NhtEhTjxGq1pGRgwZjqVoGyr5nNY7w7By6vTh1E7WB');
        expect(facts['Token']?.full).toBe(
            'USDC, mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        );
        expect(facts['Then']?.full).toBeUndefined();
    });

    it('leaves out the heading, the sentences and the lines for machines', () => {
        const labels = termsFacts(MESSAGE).map((fact) => fact.label);

        for (const hidden of ['Amount', 'Plan', 'Plan details', 'Wallet', 'Nonce', 'Expires']) {
            expect(labels).not.toContain(hidden);
        }
        expect(labels).not.toContain('Mesub');
    });

    it('shows a token with no symbol by its mint, shortened', () => {
        const facts = termsFacts(
            'Mesub: terms\nToken: mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        );

        expect(facts).toEqual([
            {
                label: 'Token',
                value: 'mint 4zMM…ncDU',
                full: 'mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
            },
        ]);
    });

    it('shows a line it does not know as it is, and nothing for an empty message', () => {
        expect(termsFacts('Mesub: terms\nGrace: 3 days')).toEqual([
            { label: 'Grace', value: '3 days' },
        ]);
        expect(termsFacts('')).toEqual([]);
    });
});

describe('termsCancelUrl', () => {
    it('answers the address only when it is one a browser can open', () => {
        expect(
            termsCancelUrl('Mesub: terms\nCancel any time: http://localhost:3000/subscriptions'),
        ).toBe('http://localhost:3000/subscriptions');
        for (const value of [
            'from your wallet',
            'javascript:alert(1)',
            'https://a.co then b',
            '',
        ]) {
            expect(termsCancelUrl(`Mesub: terms\nCancel any time: ${value}`)).toBeNull();
        }
        expect(termsCancelUrl('Mesub: terms')).toBeNull();
    });
});
