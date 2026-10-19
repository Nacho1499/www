import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Footer from '../components/Footer';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Footer status badge', () => {
  it('renders a live status badge that links to the status page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'UP', message: 'All systems operational' }),
      }),
    );

    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/all systems normal/i)).toBeInTheDocument();
    // The status host is not provisioned yet, so the badge opens the on-site page.
    const badge = screen.getByRole('link', { name: /open wraith protocol status page/i });
    expect(badge).toHaveAttribute('href', '/status');
    expect(badge).not.toHaveAttribute('target');
  });
});
