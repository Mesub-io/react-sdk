/** The pauses the design asks for. Mutable so the tests can set them to zero. */
export const TIMING = {
    // The slots stay teal this long before the next step.
    verifiedMs: 600,
    // A bare sign-in shows "Signed in" this long, then closes.
    doneMs: 900,
    // A new code can be asked for after this.
    resendS: 30,
};
