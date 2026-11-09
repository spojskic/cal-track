// A provider for platforms without a health store (web, other targets). Pure: used by provider.web.ts / provider.ts.
import type { HealthProvider, HealthProviderId, ProviderAvailability } from './types';

export function createUnsupportedProvider(
  id: HealthProviderId,
  label: string,
  message: string,
  reason: ProviderAvailability['reason'] = 'unsupported_platform',
): HealthProvider {
  const unavailable = async (): Promise<ProviderAvailability> => ({ available: false, reason, message });
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    id,
    label,
    getAvailability: unavailable,
    isAvailable: async () => false,
    checkPermissions: async (types) => ({ granted: false, grantedTypes: [], missingTypes: [...types] }),
    requestPermissions: async (types) => ({ granted: false, grantedTypes: [], missingTypes: [...types], note: message }),
    readDailyEnergy: fail,
    readWorkouts: fail,
    readBiometrics: fail,
  };
}
