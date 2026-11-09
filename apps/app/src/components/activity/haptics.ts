import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/** Fire-and-forget haptics. No-ops on web and never throws (unsupported devices, low-power mode). */
function run(fn: () => Promise<void>) {
  if (Platform.OS === 'web') return;
  try {
    fn().catch(() => {});
  } catch {
    // ignore
  }
}

export const hapticSuccess = () =>
  run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));

export const hapticError = () =>
  run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));

export const hapticLight = () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
