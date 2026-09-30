import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { MesubProvider, useMesub } from '@mesub/react';

const publishableKey = import.meta.env['VITE_MESUB_PUBLISHABLE_KEY'] ?? '';
const apiUrl = import.meta.env['VITE_MESUB_API_URL'] ?? 'http://localhost:3333';

/** Everything `useMesub()` answers, and a button per action. Plain on purpose. */
function Session() {
    const { ready, user, wallet, login, logout, getAccessToken } = useMesub();
    const [token, setToken] = useState<string | null>(null);
    const [error, setError] = useState('');

    async function run(action: () => Promise<unknown>) {
        setError('');
        try {
            await action();
        } catch (caught) {
            setError(
                caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught),
            );
        }
    }

    return (
        <main>
            <h1>@mesub/react playground</h1>
            <p>
                API <code>{apiUrl}</code>, key <code>{publishableKey || 'missing'}</code>
            </p>
            <h2>Session</h2>
            <dl>
                <dt>ready</dt>
                <dd>{String(ready)}</dd>
                <dt>user</dt>
                <dd>{user ? user.email : 'signed out'}</dd>
                <dt>wallet</dt>
                <dd>{wallet ?? 'none'}</dd>
            </dl>
            <button type="button" onClick={() => run(login)}>
                login()
            </button>{' '}
            <button type="button" onClick={() => run(logout)}>
                logout()
            </button>{' '}
            <button type="button" onClick={() => run(async () => setToken(await getAccessToken()))}>
                getAccessToken()
            </button>
            {error && <p role="alert">{error}</p>}
            {token !== null && (
                <>
                    <h2>Access token</h2>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{token}</pre>
                </>
            )}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {publishableKey ? (
            <MesubProvider publishableKey={publishableKey} apiUrl={apiUrl}>
                <Session />
            </MesubProvider>
        ) : (
            <p>
                Set VITE_MESUB_PUBLISHABLE_KEY in playground/.env.local, see playground/README.md.
            </p>
        )}
    </StrictMode>,
);
