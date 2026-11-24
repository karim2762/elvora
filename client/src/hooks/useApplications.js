import { useCallback, useEffect, useState } from 'react';
import { listMyApplications, getApplication, getApplicationDetails } from '../services/applicationService';

// status: 'loading' | 'ready' | 'error'. `enabled=false` keeps it idle (e.g. before sign-in is confirmed).
export function useRemote(fn, deps, enabled = true) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    setState((s) => ({ ...s, status: 'loading' }));
    fn().then((data) => alive && setState({ status: 'ready', data, error: null }))
      .catch((error) => alive && setState({ status: 'error', data: null, error }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export const useMyApplications = ({ status = 'All', page = 1, pageSize = 10 } = {}, enabled = true) =>
  useRemote(() => listMyApplications({ status, page, pageSize }), [status, page, pageSize], enabled);
export const useApplication = (id) => useRemote(() => getApplication(id), [id]);
export const useApplicationDetails = (id) => useRemote(() => getApplicationDetails(id), [id]);

// Every application of the signed-in student as a plain array (used to spot a duplicate before applying).
// Stays idle until `enabled` is true, so signed-out visitors never trigger a 401 request.
export const useAllMyApplications = (enabled = true) =>
  useRemote(() => listMyApplications({ status: 'All', page: 1, pageSize: 50 }).then((r) => r.applications), [], enabled);
