/** Catalogue + conversions for the "Add biometric" flow. Stored units follow the shared convention:
 * weight kg, body_fat percent, bp_systolic/bp_diastolic mmHg, heart_rate bpm, glucose mmol/L,
 * ketones mmol/L, waist cm. Custom types are free text, slugified. */

export type BiometricKind =
  | 'weight'
  | 'body_fat'
  | 'blood_pressure'
  | 'heart_rate'
  | 'glucose'
  | 'ketones'
  | 'waist'
  | 'custom';

export const BIOMETRIC_KINDS: { kind: BiometricKind; label: string }[] = [
  { kind: 'weight', label: 'Weight' },
  { kind: 'body_fat', label: 'Body fat %' },
  { kind: 'blood_pressure', label: 'Blood pressure' },
  { kind: 'heart_rate', label: 'Heart rate' },
  { kind: 'glucose', label: 'Blood glucose' },
  { kind: 'ketones', label: 'Ketones' },
  { kind: 'waist', label: 'Waist' },
  { kind: 'custom', label: 'Custom' },
];

/** DB `type` + stored unit for every non-custom kind (blood pressure is two rows). */
export const BIOMETRIC_STORAGE: Record<Exclude<BiometricKind, 'custom' | 'blood_pressure'>, { type: string; unit: string }> = {
  weight: { type: 'weight', unit: 'kg' },
  body_fat: { type: 'body_fat', unit: 'percent' },
  heart_rate: { type: 'heart_rate', unit: 'bpm' },
  glucose: { type: 'glucose', unit: 'mmol/L' },
  ketones: { type: 'ketones', unit: 'mmol/L' },
  waist: { type: 'waist', unit: 'cm' },
};

export const BP_TYPES = { systolic: 'bp_systolic', diastolic: 'bp_diastolic', unit: 'mmHg' } as const;

/** Plausibility bounds in STORED units; values outside are rejected as likely typos. */
export const BIOMETRIC_RANGES: Record<string, { min: number; max: number }> = {
  weight: { min: 10, max: 500 },
  body_fat: { min: 1, max: 80 },
  bp_systolic: { min: 50, max: 300 },
  bp_diastolic: { min: 20, max: 200 },
  heart_rate: { min: 20, max: 250 },
  glucose: { min: 0.5, max: 60 },
  ketones: { min: 0, max: 20 },
  waist: { min: 20, max: 300 },
};

/** mg/dL per mmol/L of glucose (molar mass 180.16 g/mol). */
export const GLUCOSE_MGDL_PER_MMOLL = 18.016;

export type GlucoseUnit = 'mmol/L' | 'mg/dL';

export const mgdlToMmol = (mgdl: number): number => mgdl / GLUCOSE_MGDL_PER_MMOLL;
export const mmolToMgdl = (mmol: number): number => mmol * GLUCOSE_MGDL_PER_MMOLL;

/** "Resting HR!" -> "resting_hr". Empty string when nothing usable remains. */
export function slugifyBiometricType(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}
