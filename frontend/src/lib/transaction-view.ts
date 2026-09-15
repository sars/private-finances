/** Browsing starts with recent payments; review is an explicit narrower view. */
export function transactionView(search: string) {
  const query = new URLSearchParams(search);
  const direct = Boolean(query.get('id'));
  return {
    all: direct || query.get('all') !== '0',
    window: direct ? 'all' : (query.get('window') ?? 'current_month'),
  };
}
