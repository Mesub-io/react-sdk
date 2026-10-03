import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { MesubMark } from './brand';
import { useMesubInternal } from './context';

// The first control of a screen: its first choice, or its primary button.
const FIRST_CONTROL =
    '[data-mesub-wallets] button:not(:disabled), [data-mesub-submit], [data-mesub-done], [data-mesub-install], [data-mesub-reload], [data-mesub-cancel]';

export interface DialogScreen {
    // data-mesub-step: what the CSS keys the progress line and layout on.
    step: string;
    // One per screen: a new one remounts the body, which replays its enter animation.
    view: string;
    // Draws the icon back, top left.
    onBack?: (() => void) | undefined;
    body: ReactNode;
}

/**
 * The native dialog every Mesub window is. Stays mounted across steps, so the
 * progress line animates between them; only the body is remounted.
 */
export function MesubDialog({
    screen,
    titleId,
    onClose,
}: {
    screen: DialogScreen;
    titleId: string;
    onClose(): void;
}) {
    const { theme } = useMesubInternal();
    const dialog = useRef<HTMLDialogElement>(null);

    // Layout effect: runs before the focus effect below, so showModal() does
    // not take the focus back from the first control.
    useLayoutEffect(() => {
        const node = dialog.current;
        if (node && !node.open) {
            if (typeof node.showModal === 'function') node.showModal();
            else node.setAttribute('open', '');
        }
    }, []);

    useEffect(() => {
        const node = dialog.current;
        const control = node?.querySelector<HTMLElement>(FIRST_CONTROL);
        (control ?? node?.querySelector<HTMLElement>('[data-mesub-close]'))?.focus();
    }, [screen.view]);

    return (
        <dialog
            ref={dialog}
            aria-labelledby={titleId}
            aria-modal="true"
            data-mesub-dialog=""
            data-mesub-step={screen.step}
            data-mesub-theme={theme}
            onCancel={(event) => {
                // Escape: the owner unmounts the dialog, not the browser.
                event.preventDefault();
                onClose();
            }}
            onClick={(event) => {
                // The backdrop is the dialog itself: a click outside its box landed on it.
                if (event.target !== event.currentTarget) return;
                const box = event.currentTarget.getBoundingClientRect();
                const inside =
                    event.clientX >= box.left &&
                    event.clientX <= box.right &&
                    event.clientY >= box.top &&
                    event.clientY <= box.bottom;
                if (!inside) onClose();
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    onClose();
                }
            }}
        >
            {/* Empty on purpose: the CSS draws both icons with :empty. */}
            {screen.onBack ? (
                <button
                    type="button"
                    data-mesub-back=""
                    aria-label="Back"
                    onClick={screen.onBack}
                />
            ) : null}
            <button type="button" data-mesub-close="" aria-label="Close" onClick={onClose} />
            <div data-mesub-brand="">
                <MesubMark width={27} height={18} />
                mesub.io
            </div>
            <Fragment key={screen.view}>{screen.body}</Fragment>
        </dialog>
    );
}
