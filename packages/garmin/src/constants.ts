// Constants of the Garmin Connect MOBILE-APP interface (undocumented; the same one Garmin's own mobile app uses).
// Mirrors the reference project (garmin-companion: crates/garmin-core/src/auth.rs, crates/garmin-api/src/session.rs).
// Garmin can change any of this without notice; nothing here is an official, supported API.

/** DI OAuth2 token endpoint: refresh (and the first ticket exchange). The ONLY place a POST is ever sent. */
export const DI_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';

/** Host of every data (GET) request. */
export const CONNECT_API_BASE = 'https://connectapi.garmin.com';

/** The Connect Mobile Android client the DI flow expects. Garmin rotates these per quarter. */
export const DEFAULT_CLIENT_ID = 'GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2';

/**
 * Client ids to try when redeeming a ticket, newest first. A retired id answers with a plain 4xx rather than saying it is
 * retired, so the list is walked. The id the token was actually issued for is stored with the tokens.
 */
export const DI_CLIENT_IDS: readonly string[] = [
  DEFAULT_CLIENT_ID,
  'GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4',
  'GARMIN_CONNECT_MOBILE_ANDROID_DI',
  'GARMIN_CONNECT_MOBILE_IOS_DI',
];

/** The custom grant Garmin's mobile clients use to turn a single-use SSO service ticket into a DI token pair. */
export const DI_GRANT_TYPE = 'https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket';

/** Garmin's own sign-in page (shown in a web view; its pages sit behind a Cloudflare browser check). */
export const SSO_SIGN_IN_URL = 'https://sso.garmin.com/portal/sso/en-US/sign-in';
/** CAS client and service of Garmin's own web portal. The service URL must be the same text in the page and the exchange. */
export const SSO_CLIENT_ID = 'GarminConnect';
export const SSO_SERVICE_URL = 'https://connect.garmin.com/app';

/** Headers the Connect Mobile Android app sends. Garmin's edge is picky about these on the auth host. */
export const NATIVE_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'GCM-Android-5.23',
  'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'X-Garmin-Paired-App-Version': '10861',
  'X-Garmin-Client-Platform': 'Android',
  'X-App-Ver': '10861',
  'X-Lang': 'en',
  'X-GCExperience': 'GC5',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Refresh a little early so a long sync cannot have the token expire out from under it. */
export const EXPIRY_SKEW_SEC = 120;

/**
 * This is an undocumented API and the user's real account: requests go out ONE AT A TIME, at least this far apart
 * (start to start). Never a parallel burst.
 */
export const REQUEST_SPACING_MS = 250;

/** Attempts per request (the first one included) for network errors, 429 and 5xx. */
export const MAX_ATTEMPTS = 3;
/** Pause before the 2nd and the 3rd attempt. */
export const BACKOFF_MS: readonly number[] = [1000, 3000];
/** A Retry-After header wins over the backoff, capped so one slow server cannot stall the app. */
export const RETRY_AFTER_CAP_SEC = 30;

export const REQUEST_TIMEOUT_MS = 45_000;

/** Paths of the GET endpoints used by the sync (all on {@link CONNECT_API_BASE}). */
export const PATHS = {
  /** Gives `displayName`, which several wellness endpoints need in their path. */
  profile: '/userprofile-service/socialProfile',
  /** Daily wellness rollup: ?calendarDate=YYYY-MM-DD */
  userSummary: (displayName: string): string => `/usersummary-service/usersummary/daily/${encodeURIComponent(displayName)}`,
  /** One night: ?date=YYYY-MM-DD&nonSleepBufferMinutes=60 */
  sleep: (displayName: string): string => `/wellness-service/wellness/dailySleepData/${encodeURIComponent(displayName)}`,
  hrv: (date: string): string => `/hrv-service/hrv/${date}`,
  /** Every weigh-in between two dates: ?startDate=&endDate= */
  weightRange: '/weight-service/weight/dateRange',
  /** Most recent activities, newest first: ?start=&limit= */
  activities: '/activitylist-service/activities/search/activities',
} as const;

/** Endpoint names used in the sync report. */
export type GarminEndpointName = 'profile' | 'userSummary' | 'sleep' | 'hrv' | 'weight' | 'activities';

/** Path templates (no real values) as printed in the sync report. */
export const ENDPOINT_TEMPLATES: Record<GarminEndpointName, string> = {
  profile: '/userprofile-service/socialProfile',
  userSummary: '/usersummary-service/usersummary/daily/{displayName}?calendarDate={date}',
  sleep: '/wellness-service/wellness/dailySleepData/{displayName}?date={date}&nonSleepBufferMinutes=60',
  hrv: '/hrv-service/hrv/{date}',
  weight: '/weight-service/weight/dateRange?startDate={from}&endDate={to}',
  activities: '/activitylist-service/activities/search/activities?start={n}&limit={n}',
};
