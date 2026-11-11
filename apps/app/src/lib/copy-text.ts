import { Share } from 'react-native';

/**
 * Copies text to the clipboard. `expo-clipboard` is a native module: an app that was installed BEFORE it was added does not
 * contain it, and importing it at the top of a screen's code crashes the whole app. So it is loaded on demand, and when it is
 * missing the system share sheet is offered instead.
 */
export async function copyText(text: string): Promise<void> {
  try {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
  } catch {
    await Share.share({ message: text });
  }
}
