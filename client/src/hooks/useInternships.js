import { useCallback, useEffect, useState } from 'react';
import { listInternships, getInternship } from '../services/internshipService';

// status: 'loading' | 'ready' | 'error'
function useAsync(fn, deps, enabled = true) {
  const [state, setState] = useState({ status: enabled ? 'loading' : 'idle', data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Stage 08A: nothing to look up (e.g. no internship id yet) means no request, instead of a guaranteed 404.
    if (!enabled) { setState({ status: 'idle', data: null, error: null }); return undefined; }
    let cancelled = false;
    setState((s) => ({ ...s, status: 'loading' }));
    fn().then((data) => !cancelled && setState({ status: 'ready', data, error: null }))
      .catch((error) => !cancelled && setState({ status: 'error', data: null, error }));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export const useInternships = () => useAsync(listInternships, []);
export const useInternship = (id) => useAsync(() => getInternship(id), [id], Boolean(id));
