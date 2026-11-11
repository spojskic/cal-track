import {
  MACRO_PRESET_MODES,
  MacroModeSchema,
  parseNumber,
  type MacroMode,
  type MacroPresetId,
  type MacroTargets,
} from '@ration/core';

/** The three editor tabs (the core `protein_per_kg` mode is not editable here). */
export type MacroEditorMode = 'ratios' | 'fixed' | 'keto';

/** Everything typed in the macro editor; all three tabs keep their own values. */
export interface MacroDraft {
  mode: MacroEditorMode;
  proteinPct: string;
  carbsPct: string;
  fatPct: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  netCarbsG: string;
  /** Protein in g per kg of lean mass (keto). */
  proteinPerKgLean: string;
}

const text = (n: number, decimals = 1) => String(Number(n.toFixed(decimals)));

function gramsFrom(computed: MacroTargets | null): Pick<MacroDraft, 'proteinG' | 'carbsG' | 'fatG'> {
  if (!computed) return { proteinG: '', carbsG: '', fatG: '' };
  return {
    proteinG: text(computed.protein.grams, 0),
    carbsG: text(computed.carbs.grams, 0),
    fatG: text(computed.fat.grams, 0),
  };
}

function percentsFrom(computed: MacroTargets): Pick<MacroDraft, 'proteinPct' | 'carbsPct' | 'fatPct'> {
  const protein = Math.round(computed.protein.pct);
  const carbs = Math.round(computed.carbs.pct);
  return { proteinPct: String(protein), carbsPct: String(carbs), fatPct: String(100 - protein - carbs) };
}

/** Builds the editor state from a macro mode; `computed` supplies grams for fixed values and unsupported modes. */
export function draftFromMode(mode: MacroMode, computed: MacroTargets | null): MacroDraft {
  const balanced = MACRO_PRESET_MODES.balanced;
  const keto = MACRO_PRESET_MODES.keto;
  const base: MacroDraft = {
    mode: 'ratios',
    proteinPct: String(balanced.proteinPct),
    carbsPct: String(balanced.carbsPct),
    fatPct: String(balanced.fatPct),
    ...gramsFrom(computed),
    netCarbsG: String(keto.netCarbsG),
    proteinPerKgLean: String(keto.proteinGPerKgLean),
  };
  switch (mode.mode) {
    case 'ratios':
      return {
        ...base,
        mode: 'ratios',
        proteinPct: text(mode.proteinPct),
        carbsPct: text(mode.carbsPct),
        fatPct: text(mode.fatPct),
      };
    case 'fixed':
      return {
        ...base,
        mode: 'fixed',
        proteinG: text(mode.proteinG),
        carbsG: text(mode.carbsG),
        fatG: text(mode.fatG),
      };
    case 'keto':
      return {
        ...base,
        mode: 'keto',
        netCarbsG: text(mode.netCarbsG),
        proteinPerKgLean: text(mode.proteinGPerKgLean, 2),
      };
    case 'protein_per_kg':
      // Not editable here: show what it currently resolves to as fixed grams.
      return computed ? { ...base, mode: 'fixed', ...gramsFrom(computed) } : base;
  }
}

export const draftFromPreset = (id: MacroPresetId): MacroDraft => draftFromMode(MACRO_PRESET_MODES[id], null);

/** Result of {@link draftToMode}. */
export interface DraftParse {
  mode: MacroMode | null;
  /** Message to show under the editor when `mode` is null. */
  error: string | null;
  /** Sum of the three percentages when in ratios mode and all are numbers. */
  ratioSum: number | null;
}

export function draftToMode(draft: MacroDraft): DraftParse {
  switch (draft.mode) {
    case 'ratios': {
      const p = parseNumber(draft.proteinPct);
      const c = parseNumber(draft.carbsPct);
      const f = parseNumber(draft.fatPct);
      if (p === null || c === null || f === null) {
        return { mode: null, error: 'Enter a percentage for every macro.', ratioSum: null };
      }
      const sum = p + c + f;
      if (Math.abs(sum - 100) > 0.01) {
        return {
          mode: null,
          error: `The ratios add up to ${text(sum, 2)}%. They must total exactly 100%.`,
          ratioSum: sum,
        };
      }
      const parsed = MacroModeSchema.safeParse({ mode: 'ratios', proteinPct: p, carbsPct: c, fatPct: f });
      return parsed.success
        ? { mode: parsed.data, error: null, ratioSum: sum }
        : { mode: null, error: 'Each percentage must be between 0 and 100.', ratioSum: sum };
    }
    case 'fixed': {
      const p = parseNumber(draft.proteinG);
      const c = parseNumber(draft.carbsG);
      const f = parseNumber(draft.fatG);
      if (p === null || c === null || f === null) {
        return { mode: null, error: 'Enter grams for every macro.', ratioSum: null };
      }
      return { mode: { mode: 'fixed', proteinG: p, carbsG: c, fatG: f }, error: null, ratioSum: null };
    }
    case 'keto': {
      const carbs = parseNumber(draft.netCarbsG);
      const protein = parseNumber(draft.proteinPerKgLean);
      if (carbs === null || protein === null) {
        return { mode: null, error: 'Enter net carbs and protein per kg of lean mass.', ratioSum: null };
      }
      return {
        mode: { mode: 'keto', netCarbsG: carbs, proteinGPerKgLean: protein },
        error: null,
        ratioSum: null,
      };
    }
  }
}

/** Switches tab, carrying the current computed values over (percentages <-> grams) where it makes sense. */
export function switchDraftMode(draft: MacroDraft, to: MacroEditorMode, computed: MacroTargets | null): MacroDraft {
  if (to === draft.mode) return draft;
  if (to === 'fixed' && computed) return { ...draft, mode: to, ...gramsFrom(computed) };
  if (to === 'ratios' && computed) return { ...draft, mode: to, ...percentsFrom(computed) };
  return { ...draft, mode: to };
}

/** Which preset the draft currently equals, or null for a custom setup. */
export function matchingPreset(draft: MacroDraft): MacroPresetId | null {
  const parsed = draftToMode(draft).mode;
  if (!parsed) return null;
  for (const id of Object.keys(MACRO_PRESET_MODES) as MacroPresetId[]) {
    const preset = MACRO_PRESET_MODES[id];
    if (preset.mode !== parsed.mode) continue;
    if (
      parsed.mode === 'ratios' &&
      preset.mode === 'ratios' &&
      parsed.proteinPct === preset.proteinPct &&
      parsed.carbsPct === preset.carbsPct &&
      parsed.fatPct === preset.fatPct
    ) {
      return id;
    }
    if (
      parsed.mode === 'keto' &&
      preset.mode === 'keto' &&
      parsed.netCarbsG === preset.netCarbsG &&
      parsed.proteinGPerKgLean === preset.proteinGPerKgLean
    ) {
      return id;
    }
  }
  return null;
}
