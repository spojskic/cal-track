/** Types shared by scenarios (src/scenarios.ts) and the runner (src/runner.ts). */
import type { Page } from 'playwright-core';

import type { FixtureSet, FixtureVariant } from './fixtures';
import type { MockBackend, MutationRecord } from './mock-backend';

export interface ViewportDef {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  /** prefers-color-scheme (default light). */
  colorScheme?: 'light' | 'dark';
}

export type ViewportName = 'phone' | 'desktop' | 'phone-dark' | 'desktop-dark';

export const VIEWPORTS: Readonly<Record<ViewportName, ViewportDef>> = {
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  'phone-dark': { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' },
  'desktop-dark': { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, colorScheme: 'dark' },
};

/** What a run covers unless `--viewports` says otherwise (the dark variants are opt-in). */
export const DEFAULT_VIEWPORTS: readonly ViewportName[] = ['phone', 'desktop'];

export interface TextOptions {
  timeout?: number;
  /** Exact (whole string, case-sensitive) match instead of case-insensitive substring. */
  exact?: boolean;
}

/** What `setup` / `after` get next to the Playwright page. */
export interface ScenarioContext {
  readonly page: Page;
  /** The scenario's private backend: inspect `backend.mutations`, `backend.rows(...)`, `backend.calls`. */
  readonly backend: MockBackend;
  readonly fixtures: FixtureSet;
  readonly viewport: ViewportName;
  readonly isPhone: boolean;
  /** Interaction that may fail without invalidating the scenario: a failure is recorded as WARN. Returns success. */
  step(label: string, fn: () => Promise<unknown>): Promise<boolean>;
  /** Assertion: a failure is recorded as FAIL. */
  check(label: string, fn: () => unknown | Promise<unknown>): Promise<boolean>;
  /** FAIL unless the text becomes visible. */
  expectText(text: string | RegExp, options?: TextOptions): Promise<boolean>;
  /** FAIL when the text is (still) visible after `timeout` ms. */
  expectNoText(text: string | RegExp, options?: TextOptions): Promise<boolean>;
  /** FAIL unless the page URL matches. */
  expectUrl(pattern: RegExp, timeout?: number): Promise<boolean>;
  /** FAIL unless a committed mutation matching the predicate was recorded (polls briefly: writes are async). */
  expectMutation(table: string, op: MutationRecord['op'], predicate?: (m: MutationRecord) => boolean, timeout?: number): Promise<boolean>;
  /** Network idle + short settle. */
  settle(extraMs?: number): Promise<void>;
  /** Additional screenshot `<index>-<name>-<label>.png`. */
  snapshot(label: string, options?: { tall?: boolean }): Promise<void>;
  warn(message: string): void;
  fail(message: string): void;
}

export interface Scenario {
  /** Unique, human readable. Used for the file name and `--only`. */
  name: string;
  /** The expo-router pattern this scenario exercises, e.g. `/food/[id]` (compared with the file tree). */
  route: string;
  /** Concrete URL path (+ query) to open. */
  path: string | ((fixtures: FixtureSet) => string);
  auth: 'signed-in' | 'signed-out';
  /** Fixture variant (default: 'default'). */
  fixtures?: FixtureVariant;
  /** Limit to some viewports (default: all). */
  viewports?: ViewportName[];
  /** Texts that must be visible after the page settled (case-insensitive substrings or regexes). */
  expect?: (string | RegExp)[];
  /** Console messages matching one of these are ignored for this scenario. */
  allowConsole?: RegExp[];
  /** Backend errors (`METHOD /path ... code: message`) matching one of these are expected here. */
  allowBackendErrors?: (string | RegExp)[];
  /** Page text that would normally look like an error but is expected here ("Food not found"). */
  allowText?: RegExp[];
  /** Runs before navigation (extra routes, init scripts, backend tweaks). */
  setup?: (page: Page, ctx: ScenarioContext) => Promise<void>;
  /** Runs after the page loaded and settled: interactions and assertions. */
  after?: (page: Page, ctx: ScenarioContext) => Promise<void>;
}

export const resolvePath = (s: Scenario, fixtures: FixtureSet): string => (typeof s.path === 'function' ? s.path(fixtures) : s.path);
