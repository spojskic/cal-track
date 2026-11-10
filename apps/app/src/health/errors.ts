/**
 * Turns the raw error of the platform health permission dialog into something a person can act on.
 * iOS answers `Error Domain=com.apple.healthkit Code=4 "Missing com.apple.developer.healthkit entitlement."` when the app was
 * installed without the HealthKit capability (typical for an unsigned .ipa re-signed by a sideloading tool that dropped it).
 */
export function friendlyPermissionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/entitlement/i.test(message)) {
    return new Error(
      'iOS refused Apple Health access because this installed copy of Cal Track does not carry the HealthKit permission ' +
        '(a signing issue, not something you did wrong). Install a build that is signed with HealthKit, for example from Xcode ' +
        'with your Personal Team - see docs/install-on-devices.md. Everything else in the app works without it.',
    );
  }
  return error instanceof Error ? error : new Error(message);
}
