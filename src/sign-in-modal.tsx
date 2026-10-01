import { useEffect, useId, useRef, useState } from 'react';
import { useMesubInternal } from './context';
import { MesubDialog } from './dialog';
import { useSignIn } from './sign-in';
import { TIMING } from './timing';
import type { MesubSession } from './types';

/** Rendered by the provider while a login() waits. Unmounting drops its state. */
export function SignInModal() {
    const { signingIn } = useMesubInternal();
    return signingIn ? <SignIn /> : null;
}

function SignIn() {
    const { completeSignIn, cancelSignIn } = useMesubInternal();
    const titleId = useId();
    // Signed in, shown "Signed in" for a moment before login() resolves.
    const [done, setDone] = useState<MesubSession | null>(null);
    const doneRef = useRef<MesubSession | null>(null);

    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const signIn = useSignIn({
        titleId,
        onSignedIn: (session) => {
            doneRef.current = session;
            setDone(session);
            // A close meanwhile has already completed it.
            void new Promise((resolve) => setTimeout(resolve, TIMING.doneMs)).then(
                () => alive.current && completeSignIn(session),
            );
        },
    });

    // Closing on "Signed in" keeps the session: it is already proved.
    const close = () => (doneRef.current ? completeSignIn(doneRef.current) : cancelSignIn());

    const screen = done
        ? {
              step: 'done',
              view: 'done',
              body: (
                  <>
                      <div data-mesub-hero="check" aria-hidden="true" />
                      <h2 id={titleId}>Signed in</h2>
                  </>
              ),
          }
        : signIn;

    return <MesubDialog screen={screen} titleId={titleId} onClose={close} />;
}
