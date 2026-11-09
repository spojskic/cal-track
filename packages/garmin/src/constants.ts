// Constants of the Garmin Connect Personal API (read-only, pull-only, one person's OWN data).
// Everything here is taken from Garmin's official docs/client (Nov 2026). Response SHAPES are unverified, see mappers.ts.

/** Global Personal API host. */
export const GARMIN_BASE_URL = 'https://personal.connectapi.garmin.com';
/** China host. */
export const GARMIN_BASE_URL_CN = 'https://personal.connectapi.garmin.cn';

/** `POST` here with `Authorization: ApiKey <key>` -> bare JWT (text/plain). The only place the key is ever sent. */
export const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';

/** Personal API keys start with this prefix. */
export const API_KEY_PREFIX = 'GCDC_';

/** Page where the user creates the key. */
export const API_KEY_CREATE_URL = 'https://connect.garmin.com/app/settings/personalApiToken';

/** Validity periods offered when a key is created. */
export const KEY_EXPIRY_OPTIONS_DAYS = [30, 90, 180, 365] as const;
export type KeyExpiryDays = (typeof KEY_EXPIRY_OPTIONS_DAYS)[number];

/** Scopes a key can carry. */
export const GARMIN_SCOPES = [
  'CONNECT_READ',
  'PERSONAL_API_FITNESS_READ',
  'PERSONAL_API_WELLNESS_READ',
  'PERSONAL_API_USER_READ',
  'PERSONAL_API_NUTRITION_READ',
] as const;
export type GarminScope = (typeof GARMIN_SCOPES)[number];

/** JWT lifetime (also bounded by the key's own expiry). There are no refresh tokens. */
export const TOKEN_LIFETIME_SEC = 24 * 60 * 60;
/** Fetch a new token when less than this much validity remains. */
export const TOKEN_REFRESH_MARGIN_SEC = 60 * 60;

export const RATE_LIMIT = {
  /** Garmin's documented limit. */
  garminPerMinute: 100,
  /** What this client allows itself per rolling window, to stay clear of the limit. */
  clientBudgetPerWindow: 90,
  windowMs: 60_000,
  /** HTTP 429: wait `retryInSeconds` (capped) and retry at most this many times. */
  maxRetries: 2,
  maxWaitSec: 60,
  /** Used when a 429 carries no `retryInSeconds` / `Retry-After`. */
  defaultWaitSec: 10,
} as const;

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum number of calendar days (inclusive) a single ranged request may cover. */
export const MAX_DAYS = {
  /** Garmin: "max 1 year"; 365 keeps clear of leap-year edge cases. */
  dailySummaries: 365,
  sleep: 31,
  bodyBattery: 31,
  steps: 28,
  stress: 28,
  hydration: 31,
  /** Unverified: conservative guesses. */
  hrv: 28,
  weightAll: 31,
  weightRange: 31,
  wellnessActivities: 31,
} as const;

/** Page size of the activity search (100 is accepted by Garmin). */
export const ACTIVITY_PAGE_SIZE = 100;
/** Safety stop for paginated activity downloads (pages). */
export const ACTIVITY_MAX_PAGES = 100;

export const PATHS = {
  userSettings: '/userprofile-service/userprofile/settings',
  dailySummaries: '/usersummary-service/v2/dailysummaries',
  dailySummaryDay: '/usersummary-service/usersummary/daily',
  sleepRange: '/sleep-service/sleep/dailySleepSummariesByDate',
  sleepDay: '/sleep-service/sleep/dailySleep',
  hrvRange: (from: string, to: string) => `/hrv-service/hrv/daily/${from}/${to}`,
  hrvDay: (date: string) => `/hrv-service/hrv/${date}`,
  weightAll: (from: string, to: string) => `/weight-service/weight/all/${from}/${to}`,
  weightRange: (from: string, to: string) => `/weight-service/weight/range/${from}/${to}`,
  bodyBattery: '/wellness-service/wellness/bodyBattery/reports/daily',
  heartRateDay: '/wellness-service/wellness/dailyHeartRate',
  spo2Day: (date: string) => `/wellness-service/wellness/daily/spo2acclimation/${date}`,
  stepsDaily: (from: string, to: string) => `/usersummary-service/stats/steps/daily/${from}/${to}`,
  stressDaily: (from: string, to: string) => `/usersummary-service/stats/stress/daily/${from}/${to}`,
  hydrationDaily: (from: string, to: string) => `/usersummary-service/stats/hydration/daily/${from}/${to}`,
  activities: '/activitylist-service/activities/search/activities',
  wellnessActivities: (from: string, until: string) =>
    `/wellnessactivity-service/activity/summary/range/${from}/${until}`,
} as const;
