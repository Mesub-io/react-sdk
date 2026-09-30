import { render, screen } from '@testing-library/react';

// Proves the browser setup works before any component exists: #2 builds on it.
describe('the test browser', () => {
    it('renders React into happy-dom', () => {
        render(<p>mesub</p>);

        expect(screen.getByText('mesub').tagName).toBe('P');
    });
});
