// Every test starts signed out: no stored refresh token, no token cookie.
beforeEach(() => {
    // Node environment specs have no browser.
    if (typeof document === 'undefined') return;
    localStorage.clear();
    document.cookie = 'mesub-token=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
});
