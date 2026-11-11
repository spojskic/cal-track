import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Moves a value stored under a key from before the app was renamed. Best effort: a failed move leaves the old value in place,
 * so the next call tries again. Does nothing when the new key already exists (the user's current choice wins).
 */
export async function migrateAsyncKey(oldKey: string, newKey: string): Promise<void> {
  try {
    if ((await AsyncStorage.getItem(newKey)) !== null) return;
    const value = await AsyncStorage.getItem(oldKey);
    if (value === null) return;
    await AsyncStorage.setItem(newKey, value);
    await AsyncStorage.removeItem(oldKey);
  } catch {
    // an unreadable store means the caller falls back to its defaults
  }
}
