/**
 * Console messages that are expected / harmless and must not turn a scenario red. Extend this list when a first
 * real run shows noise that is not a bug. Every rule needs a `reason`; ignored messages are only counted.
 */
export interface NoiseRule {
  /** Console message type: 'error' | 'warning' | 'log' | 'info' | 'debug'. Any when omitted. */
  type?: string;
  /** Matched against the message text. */
  text?: RegExp;
  /** Matched against the URL of the message location (e.g. the resource of "Failed to load resource"). */
  url?: RegExp;
  reason: string;
}

export const KNOWN_NOISE: readonly NoiseRule[] = [
  {
    text: /Failed to load resource/,
    url: /mock\.supabase\.test/,
    reason: 'HTTP errors of the mock backend are analysed from the backend call log instead (see report "Problems")',
  },
  {
    text: /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
    reason: 'external request blocked by the harness (listed under "External requests that were blocked")',
  },
  { text: /Download the React DevTools/i, reason: 'React dev-tools hint' },
  { text: /"shadow\*" style props are deprecated|"textShadow\*" style props are deprecated/i, reason: 'react-native-web deprecation notice' },
  { text: /props\.pointerEvents is deprecated/i, reason: 'react-native-web deprecation notice' },
  { text: /Animated: `useNativeDriver` is not supported/i, reason: 'React Native Animated falls back to JS on web' },
  { text: /\[expo-notifications\]|expo-notifications/i, reason: 'push notifications do not exist on web' },
  { type: 'warning', text: /Unable to activate keep awake/i, reason: 'expo-keep-awake on headless Chrome' },
];

export type ConsoleVerdict = { kind: 'ignore'; reason: string } | { kind: 'warn' } | { kind: 'fail' };

export interface ConsoleInfo {
  type: string;
  text: string;
  url?: string;
}

export function classifyConsole(
  msg: ConsoleInfo,
  opts: { extra?: readonly RegExp[]; errorSeverity?: 'fail' | 'warn' } = {},
): ConsoleVerdict {
  for (const rule of KNOWN_NOISE) {
    if (rule.type && rule.type !== msg.type) continue;
    if (rule.text && !rule.text.test(msg.text)) continue;
    if (rule.url && !(msg.url && rule.url.test(msg.url))) continue;
    return { kind: 'ignore', reason: rule.reason };
  }
  if (opts.extra?.some((re) => re.test(msg.text))) return { kind: 'ignore', reason: 'allowed by the scenario' };
  if (msg.type === 'error') return { kind: opts.errorSeverity ?? 'fail' };
  if (msg.type === 'warning' || msg.type === 'warn') return { kind: 'warn' };
  return { kind: 'ignore', reason: 'log level below warning' };
}
