/**
 * `@mesub/react`: `MesubProvider`, `useMesub`, the sign-in modal and the
 * Subscribe button. The button comes with #5.
 */
export { MesubProvider, type MesubProviderProps } from './provider';
export { useMesub, type MesubState } from './context';
export { MesubClientError, MesubSignInCancelledError } from './errors';
export type { MesubUser } from './types';
