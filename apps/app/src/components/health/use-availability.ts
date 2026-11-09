import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { getHealthProvider } from '@/health/provider';
import type { ProviderAvailability } from '@/health/types';

/**
 * Availability of the platform health store. Re-checked whenever the app returns to the foreground, so installing or
 * updating Health Connect from the Play Store is picked up without a restart. `null` while the first check runs.
 */
export function useProviderAvailability(): { availability: ProviderAvailability | null; refresh: () => void } {
  const [availability, setAvailability] = useState<ProviderAvailability | null>(null);

  const refresh = useCallback(() => {
    getHealthProvider()
      .getAvailability()
      .then(setAvailability)
      .catch(() =>
        setAvailability({ available: false, reason: 'unknown', message: 'Could not check the health data store.' }),
      );
  }, []);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  return { availability, refresh };
}
