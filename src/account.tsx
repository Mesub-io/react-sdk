import type { UiWallet } from '@wallet-standard/react';
import { useId, useRef, useState } from 'react';
import { useMesub } from './context';
import { MesubClientError } from './errors';
import { shortAddress } from './format';
import type { MesubWallet } from './wallets-api';

/** The installed wallet holding this address, for its icon. */
export function installedWith(wallets: readonly UiWallet[], address: string | null) {
    return wallets.find((wallet) => wallet.accounts.some((account) => account.address === address));
}

function nameOf(address: string, wallets: readonly MesubWallet[] | null): string {
    return wallets?.find((wallet) => wallet.address === address)?.label ?? shortAddress(address);
}

function messageOf(error: unknown): string {
    return error instanceof MesubClientError ? error.message : 'Something went wrong. Try again.';
}

/**
 * Signed in as, the wallet that pays here, and Change: the account's wallets,
 * to switch between without signing, or another one to connect. Each wallet
 * keeps its own subscriptions, so switching loses nothing: no warning.
 */
export function Account({
    email,
    address,
    installed,
    onConnect,
    onSwitched,
}: {
    email: string;
    address: string;
    installed: readonly UiWallet[];
    onConnect(): void;
    onSwitched(): void;
}) {
    const { wallets, loadWallets, selectWallet } = useMesub();
    const menuId = useId();
    const change = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');

    const icon = installedWith(installed, address)?.icon;

    // After a refused switch, the refusal stays up while the list is read again.
    function load(clear = true) {
        setLoading(true);
        if (clear) setError('');
        loadWallets()
            .catch((failure: unknown) => setError(messageOf(failure)))
            .finally(() => setLoading(false));
    }

    function close() {
        setOpen(false);
        setError('');
        change.current?.focus();
    }

    function toggle() {
        if (open) {
            close();
            return;
        }
        setOpen(true);
        // Read each time it opens: a plan may have been taken since.
        load();
    }

    async function select(next: string) {
        setError('');
        setBusy(next);
        try {
            await selectWallet(next);
            onSwitched();
            close();
        } catch (failure) {
            setError(messageOf(failure));
            // Not one of the account's wallets any more: show the list as it is.
            if (failure instanceof MesubClientError && failure.status === 404) load(false);
        } finally {
            setBusy(null);
        }
    }

    return (
        <>
            <div data-mesub-account="">
                <p>
                    Signed in as <strong>{email}</strong>
                </p>
                <span data-mesub-account-wallet="" title={address}>
                    {icon ? <img src={icon} alt="" width={16} height={16} /> : null}
                    {nameOf(address, wallets)}
                </span>
                <button
                    ref={change}
                    type="button"
                    data-mesub-change=""
                    aria-expanded={open}
                    aria-controls={open ? menuId : undefined}
                    onClick={toggle}
                >
                    Change
                </button>
            </div>
            {open ? (
                <div data-mesub-wallet-menu="" id={menuId}>
                    {wallets ? (
                        <ul data-mesub-linked-wallets="" aria-label="Your wallets">
                            {wallets.map((wallet) => {
                                const selected = wallet.address === address;
                                const walletIcon = installedWith(installed, wallet.address)?.icon;
                                return (
                                    <li key={wallet.address}>
                                        <button
                                            type="button"
                                            data-mesub-linked=""
                                            title={wallet.address}
                                            aria-current={selected || undefined}
                                            aria-busy={busy === wallet.address || undefined}
                                            disabled={busy !== null}
                                            onClick={() =>
                                                selected ? close() : void select(wallet.address)
                                            }
                                        >
                                            {walletIcon ? (
                                                <img
                                                    src={walletIcon}
                                                    alt=""
                                                    width={20}
                                                    height={20}
                                                />
                                            ) : null}
                                            <span>
                                                {wallet.label ?? shortAddress(wallet.address)}
                                                {wallet.plans.length > 0 ? (
                                                    <small>· {wallet.plans.join(', ')}</small>
                                                ) : null}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : loading ? (
                        <p data-mesub-notice="" role="status" aria-busy="true">
                            Loading your wallets
                        </p>
                    ) : null}
                    {error ? (
                        <p role="alert" data-mesub-error="">
                            {error}
                        </p>
                    ) : null}
                    <button
                        type="button"
                        data-mesub-connect=""
                        disabled={busy !== null}
                        onClick={onConnect}
                    >
                        Connect another wallet
                    </button>
                </div>
            ) : null}
        </>
    );
}
