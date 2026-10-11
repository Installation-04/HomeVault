import { useCallback, useEffect, useRef, useState } from 'react';

// Runs an async loader and tracks { data, error, loading }. Re-runs when
// `deps` change; a slow earlier request can never overwrite a newer one.
// Pages use this instead of bare `.then(setX)` so an API failure shows an
// error (with a retry) rather than leaving a blank screen.
export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const latest = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    const id = ++latest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    return Promise.resolve()
      .then(loader)
      .then(
        (data) => {
          if (id === latest.current) setState({ data, error: null, loading: false });
          return data;
        },
        (error) => {
          if (id === latest.current) setState((s) => ({ data: s.data, error, loading: false }));
          return undefined;
        }
      );
  }, deps);

  useEffect(() => {
    run();
    return () => {
      latest.current += 1;
    };
  }, [run]);

  const setData = useCallback((updater) => {
    setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater }));
  }, []);

  return { ...state, reload: run, setData };
}
