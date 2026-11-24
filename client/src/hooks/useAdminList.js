import { useCallback, useEffect, useRef, useState } from 'react';

// Loads a paged admin list. `fetcher(params)` must return { pagination, ... }. Ignores stale responses, debounces nothing
// (the page debounces its own search box), and exposes reload() so a successful write can refresh from the server.
export function useAdminList(fetcher, params) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const seq = useRef(0);
  const key = JSON.stringify(params);
  const load = useCallback(async () => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try { const data = await fetcher(JSON.parse(key)); if (n === seq.current) setState({ loading: false, error: null, data }); }
    catch (error) { if (n === seq.current) setState((s) => ({ ...s, loading: false, error })); }
  }, [fetcher, key]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}
