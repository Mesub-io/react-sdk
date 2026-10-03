import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MesubProvider, SubscribeButton } from '../src';
import {
    ENDPOINT,
    json,
    never,
    plan,
    prepared,
    server,
    subscription,
    type Handler,
} from './helpers';
import { registerWallet } from './wallets';

/**
 * The handoff's DOM is the contract for the screens it drew: the CSS keys on
 * element order, attribute values and :empty. This compares what we render
 * with test/fixtures/v5, as a skeleton: tags, data-mesub-*, roles, aria and
 * types, in order. Text, ids, urls and icons are the plan's and the wallet's.
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
    const children = Array.from(element.children).map((child) => skeleton(child, depth + 1));
    return [own, ...children].join('\n');
}

function fixture(name: string): string {
    // happy-dom's import.meta.url is not a file url: read from the package root.
    const html = readFileSync(join(process.cwd(), 'test/fixtures/v5', `${name}.html`), 'utf8');
    const holder = document.createElement('div');
    holder.innerHTML = html;
    return skeleton(holder.querySelector('dialog')!);
}

const rendered = () => skeleton(screen.getByRole('dialog'));

const routes: Record<string, Handler> = {
    'GET /plans/pro': () => json(200, plan),
    'POST /subscriptions': () => json(201, prepared()),
    'POST /subscriptions/sub_1/submit': () => json(201, { subscription: subscription() }),
};

function open(overrides: Record<string, Handler> = {}) {
    render(
        <MesubProvider endpoint={ENDPOINT} fetch={server({ ...routes, ...overrides })}>
            <SubscribeButton plan="pro" />
        </MesubProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Subscribe' }));
}

const press = async (name: string | RegExp) =>
    fireEvent.click(await screen.findByRole('button', { name }));

async function toReview() {
    await press('Continue with a wallet');
    await press(/Fake Wallet/);
    await screen.findByRole('button', { name: 'Sign and pay 2 USDC' });
}

describe('the screens the v5 handoff drew, as it drew them', () => {
    it('10: the wallet list, with the one used last', async () => {
        localStorage.setItem('mesub:last-wallet', 'Phantom');
        for (const name of ['Phantom', 'Solflare', 'Backpack']) registerWallet({ name });
        open();

        await press('Continue with a wallet');
        await screen.findByRole('button', { name: 'Backpack' });

        expect(rendered()).toBe(fixture('10-wallet-list'));
    });

    it('11: waiting on the wallet', async () => {
        const wallet = registerWallet();
        wallet.connect.mockReturnValueOnce(new Promise(() => undefined));
        open();

        await press('Continue with a wallet');
        await press('Fake Wallet');
        await screen.findByRole('heading', { name: 'Approve in Fake Wallet' });

        expect(rendered()).toBe(fixture('11-wallet-waiting'));
    });

    it('12: the wallet refused to connect', async () => {
        const wallet = registerWallet();
        wallet.connect.mockRejectedValueOnce(new Error('User rejected the request.'));
        open();

        await press('Continue with a wallet');
        await press('Fake Wallet');
        await screen.findByRole('heading', { name: 'Request rejected' });

        expect(rendered()).toBe(fixture('12-wallet-rejected'));
    });

    it('14: no wallet installed', async () => {
        open();

        await press('Continue with a wallet');
        await screen.findByRole('heading', { name: 'No Solana wallet found' });

        expect(rendered()).toBe(fixture('14-wallet-none-installed'));
    });

    it('20: approving in the wallet', async () => {
        const wallet = registerWallet();
        wallet.signMessage.mockReturnValueOnce(new Promise(() => undefined));
        open();

        await toReview();
        await press('Sign and pay 2 USDC');
        await screen.findByRole('heading', { name: 'Sign the terms in Fake Wallet' });

        expect(rendered()).toBe(fixture('20-approve'));
    });

    it('21: confirming', async () => {
        registerWallet();
        open({ 'POST /subscriptions/sub_1/submit': never });

        await toReview();
        await press('Sign and pay 2 USDC');
        await screen.findByRole('heading', { name: 'Confirming on Solana' });

        expect(rendered()).toBe(fixture('21-confirming'));
    });

    it('23: the wallet refused to sign', async () => {
        const wallet = registerWallet();
        wallet.signMessage.mockRejectedValueOnce(new Error('User rejected the request.'));
        open();

        await toReview();
        await press('Sign and pay 2 USDC');
        await screen.findByRole('heading', { name: 'Terms not signed' });

        expect(rendered()).toBe(fixture('23-error-closed-wallet'));
    });

    it('27: the plan takes no new subscribers', async () => {
        open({ 'GET /plans/pro': () => json(200, { ...plan, available: false }) });

        await screen.findByRole('heading', { name: 'Plan closed' });

        expect(rendered()).toBe(fixture('27-error-plan-closed'));
    });

    it('28: no word on what became of the transaction', async () => {
        registerWallet();
        open({ 'POST /subscriptions/sub_1/submit': never });

        await toReview();
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole('button', { name: 'Sign and pay 2 USDC' }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(90_000);
        });
        vi.useRealTimers();
        const dialog = await screen.findByRole('dialog');
        await within(dialog).findByRole('heading', { name: 'Still confirming' });

        expect(rendered()).toBe(fixture('28-error-slow-confirmation'));
    });
});
