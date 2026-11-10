import { Alert, Platform } from 'react-native';

import { DEVICE_ENERGY_MODE_NOTICE, enableDeviceEnergyMode } from './energy-mode';

/**
 * Call after a watch / health app was connected successfully: if the energy mode is still Static it becomes
 * Device-adjusted (once; a later manual choice of Static is respected) and the user is told. Never throws.
 */
export async function switchToDeviceEnergyMode(): Promise<void> {
  try {
    const result = await enableDeviceEnergyMode();
    if (result === 'switched' && Platform.OS !== 'web') Alert.alert('Energy mode updated', DEVICE_ENERGY_MODE_NOTICE);
  } catch {
    // offline or signed out: the mode can still be changed by hand in Profile & targets
  }
}
