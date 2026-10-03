import { cleanup } from '@testing-library/react';
import { unregisterWallets } from './wallets';

// Every test starts with a clean page: no remembered wallet, none installed.
beforeEach(() => {
    // Node environment specs have no browser.
    if (typeof document === 'undefined') return;
    localStorage.clear();
});

afterEach(() => {
    if (typeof document === 'undefined') return;
    cleanup();
    unregisterWallets();
    vi.useRealTimers();
});
