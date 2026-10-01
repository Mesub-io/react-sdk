import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MesubProvider, SubscribeButton, useMesub, type MesubPlan, type MesubState } from '../src';
import { json, user } from './helpers';
import { registerWallet, unregisterWallets } from './wallets';

/**
 * The handoff's DOM is the contract: the CSS keys on element order, attribute
 * values and :empty. This compares what we render with test/fixtures/v5, as a
 * skeleton: tags, data-mesub-*, roles, aria and types, in order. Text, ids,
 * urls and icons are the plan's and the session's, so they are left out.
 */

const KEPT =
    /^(data-mesub-(?!theme)|aria-(?!labelledby|label$|modal)|role$|type$|disabled$|open$|target$)/;

function skeleton(element: Element, depth = 0): string {
    const attributes = Array.from(element.attributes)
        .filter((attribute) => KEPT.test(attribute.name))
        // Values the plan or the wallet set.
        .map((attribute) =>
            /^data-mesub-(wallet|step)$/.test(attribute.name) || attribute.name === 'open'
                ? attribute.name
                : `${attribute.name}="${attribute.value}"`,
        )
        .sort();
    const own = `${'  '.repeat(depth)}<${element.tagName.toLowerCase()}${attributes.length ? ' ' + attributes.join(' ') : ''}>`;
    // An svg mark stands where the handoff has a placeholder img.
    if (element.tagName.toLowerCase() === 'svg') return `${'  '.repeat(depth)}<img>`;
    const children = Array.from(element.children)
        // The handoff's <strong> inside a sentence, our <code> inside the error: prose, not layout.
        .filter(
            (child) =>
                !['strong', 'code'].includes(child.tagName.toLowerCase()) ||
                element.tagName === 'DIV',
        )
        .map((child) => skeleton(child, depth + 1));
    return [own, ...children].join('\n');
}

function fixture(name: string): string {
    const html = // happy-dom's import.meta.url is not a file url: read from the package root.
        readFileSync(join(process.cwd(), 'test/fixtures/v5', `${name}.html`), 'utf8');
    const holder = document.createElement('div');
    holder.innerHTML = html;
    return skeleton(holder.querySelector('dialog')!);
}

function rendered(): string {
    return skeleton(screen.getByRole('dialog'));
}

const plan: MesubPlan = {
    slug: 'pro',
    name: 'Pro',
    description: null,
    amount: '2000000',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6,
    periodHours: 72,
    network: 'mainnet-beta',
    merchant: { name: 'Atlas', logoUrl: 'https://cdn.test/atlas.svg', websiteUrl: null },
    available: true,
};
const subscription = {
    id: 'sub_1',
    planId: 'pln_1',
    subscriber: user.walletAddress!,
    status: 'ACTIVE',
    currentPeriodStartTs: '1',
    dueAt: '2026-10-04T12:00:00.000Z',
    expiresAtTs: '0',
    createTxSignature: null,
    confirmedAt: null,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
};
const newcomer = { ...user, walletAddress: null, walletVerifiedAt: null };

type Handler = () => Response | Promise<Response>;

function routes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
    return {
        'GET /plans/pro': () => json(200, plan),
        'POST /auth/code': () => json(204),
        'POST /auth/session': () =>
            json(201, { user, sessionToken: 'st_1', refreshToken: 'rt_1', accessToken: 'at_1' }),
        'POST /subscriptions': () => json(201, { ...subscription, status: 'PENDING', dueAt: null }),
        'POST /subscriptions/sub_1/transaction': () =>
            json(201, { transaction: btoa('tx'), lastValidBlockHeight: '1' }),
        'POST /subscriptions/sub_1/confirm': () => json(201, { subscription }),
        ...overrides,
    };
}

function mount(handlers: Record<string, Handler>, chain: `solana:${string}` = 'solana:mainnet') {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        const key = `${init.method} ${url.slice('http://api.test/v1/client'.length)}`;
        const handler = handlers[key];
        if (!handler) throw new Error(`unexpected ${key}`);
        return handler();
    });
    let state!: MesubState;
    function Probe() {
        state = useMesub();
        return null;
    }
    render(
        <MesubProvider publishableKey="PUB_1" apiUrl="http://api.test" fetch={fetch}>
            <Probe />
            <SubscribeButton plan="pro" chain={chain} />
        </MesubProvider>,
    );
    return () => state;
}

const dialog = () => screen.getByRole('dialog');
const button = (name: string | RegExp) => within(dialog()).getByRole('button', { name });

async function toCode() {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'thomas@example.com' } });
    fireEvent.click(button('Send me a code'));
    await screen.findByLabelText('6-digit code');
}

/** Signed in through login(), then the checkout opened on the review. */
async function review(handlers = routes(), chain?: `solana:${string}`) {
    const state = mount(handlers, chain);
    let login!: Promise<unknown>;
    act(() => {
        login = state().login();
    });
    await screen.findByRole('dialog');
    await toCode();
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    await act(async () => {
        await login;
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
    await waitFor(() =>
        expect(within(dialog()).queryByRole('heading')?.textContent).not.toBe('Subscribe'),
    );
}

afterEach(() => unregisterWallets());

describe('the sign-in matches the handoff', () => {
    it('01 email', async () => {
        mount(routes());
        fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
        await waitFor(() => expect(dialog().querySelector('[data-mesub-merchant]')).not.toBeNull());

        expect(rendered()).toBe(fixture('01-email'));
    });

    it('03 email error', async () => {
        mount(routes({ 'POST /auth/code': () => json(503, { message: 'Nope' }) }));
        fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
        await waitFor(() => expect(dialog().querySelector('[data-mesub-merchant]')).not.toBeNull());
        fireEvent.change(screen.getByLabelText('Email'), {
            target: { value: 'thomas@example.com' },
        });
        fireEvent.click(button('Send me a code'));
        await within(dialog()).findByRole('alert');

        expect(rendered()).toBe(fixture('03-email-error'));
    });

    it('07 code wrong', async () => {
        mount(
            routes({
                'POST /auth/session': () =>
                    json(401, { message: 'Wrong code. Enter the one we emailed you.' }),
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
        await screen.findByLabelText('Email');
        await toCode();
        fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '481207' } });
        await within(dialog()).findByRole('alert');

        expect(rendered()).toBe(fixture('07-code-wrong'));
    });

    it('08 code expired', async () => {
        mount(
            routes({
                'POST /auth/session': () =>
                    json(401, { message: 'That code expired. Ask for a new one.' }),
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
        await screen.findByLabelText('Email');
        await toCode();
        fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '481027' } });
        await within(dialog()).findByRole('alert');

        expect(rendered()).toBe(fixture('08-code-expired'));
    });

    it('10 wallet list', async () => {
        registerWallet({ name: 'Phantom' });
        registerWallet({ name: 'Solflare' });
        registerWallet({ name: 'Backpack' });
        localStorage.setItem('mesub:last-wallet', 'Phantom');
        mount(
            routes({
                'POST /auth/session': () =>
                    json(201, {
                        user: newcomer,
                        sessionToken: 'st_1',
                        refreshToken: 'rt_1',
                        accessToken: null,
                    }),
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
        await screen.findByLabelText('Email');
        await toCode();
        fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
        await waitFor(() => expect(dialog().getAttribute('data-mesub-step')).toBe('wallet'));

        expect(rendered()).toBe(fixture('10-wallet-list'));
    });

    it('14 wallet none installed', async () => {
        mount(
            routes({
                'POST /auth/session': () =>
                    json(201, {
                        user: newcomer,
                        sessionToken: 'st_1',
                        refreshToken: 'rt_1',
                        accessToken: null,
                    }),
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
        await screen.findByLabelText('Email');
        await toCode();
        fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
        await waitFor(() => expect(dialog().getAttribute('data-mesub-step')).toBe('wallet'));

        expect(rendered()).toBe(fixture('14-wallet-none-installed'));
    });
});

describe('the checkout matches the handoff', () => {
    it('16 review', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review();

        expect(rendered()).toBe(fixture('16-review-details-and-terms-closed-default'));
    });

    it('20 approve', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockImplementation(() => new Promise(() => undefined));
        await review();
        fireEvent.click(button(/Subscribe and pay/));
        await waitFor(() => expect(fake.signAndSendTransaction).toHaveBeenCalled());

        expect(rendered()).toBe(fixture('20-approve'));
    });

    it('21 confirming', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review(
            routes({ 'POST /subscriptions/sub_1/confirm': () => new Promise(() => undefined) }),
        );
        fireEvent.click(button(/Subscribe and pay/));
        await waitFor(() => expect(dialog().getAttribute('data-mesub-step')).toBe('confirming'));

        expect(rendered()).toBe(fixture('21-confirming'));
    });

    it('22 subscribed', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review();
        fireEvent.click(button(/Subscribe and pay/));
        await waitFor(() => expect(dialog().getAttribute('data-mesub-step')).toBe('subscribed'));

        expect(rendered()).toBe(fixture('22-subscribed'));
    });

    it('23 error closed wallet', async () => {
        const fake = registerWallet({ name: 'Phantom', connected: true });
        fake.signAndSendTransaction.mockRejectedValueOnce(new Error('User rejected the request.'));
        await review();
        fireEvent.click(button(/Subscribe and pay/));
        await within(dialog()).findByRole('alert');

        expect(rendered()).toBe(fixture('23-error-closed-wallet'));
    });

    it('26 error already subscribed', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review(
            routes({
                'POST /subscriptions': () =>
                    json(409, { message: 'You are already subscribed to this plan.' }),
            }),
        );
        fireEvent.click(button(/Subscribe and pay/));
        await within(dialog()).findByRole('alert');

        expect(rendered()).toBe(fixture('26-error-already-subscribed'));
    });

    it('27 error plan closed', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review(routes({ 'GET /plans/pro': () => json(200, { ...plan, available: false }) }));

        expect(rendered()).toBe(fixture('27-error-plan-closed'));
    });

    it('28 error slow confirmation', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review(
            routes({
                'POST /subscriptions/sub_1/confirm': () => {
                    throw new TypeError('Failed to fetch');
                },
            }),
        );
        fireEvent.click(button(/Subscribe and pay/));
        await within(dialog()).findByRole('alert');

        expect(rendered()).toBe(fixture('28-error-slow-confirmation'));
    });

    it('29 error Mesub timeout', async () => {
        registerWallet({ name: 'Phantom', connected: true });
        await review(
            routes({
                'POST /subscriptions': () => {
                    throw new TypeError('Failed to fetch');
                },
            }),
        );
        fireEvent.click(button(/Subscribe and pay/));
        await within(dialog()).findByRole('alert');

        expect(rendered()).toBe(fixture('29-error-mesub-timeout'));
    });
});
