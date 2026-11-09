import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform } from 'react-native';

export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/credits';

/** Opens a link: the in-app browser on native, a new tab on web. Silent on failure (the URL is also shown in text). */
export async function openUrl(url: string): Promise<void> {
  try {
    if (Platform.OS === 'web') await Linking.openURL(url);
    else await WebBrowser.openBrowserAsync(url);
  } catch {
    // nothing sensible to do
  }
}
