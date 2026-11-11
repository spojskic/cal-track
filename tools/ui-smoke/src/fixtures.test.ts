import { describe, expect, it } from 'vitest';

import { NUTRIENT_CODES, deriveNutrients, isNutrientCode, resolveTargets, scaleNutrients, sumNutrients } from '../../../packages/core/src';

import { FIXED_NOW, FIXED_NOW_MS, TIMEZONE, TODAY } from './constants';
import {
  BARCODES,
  FIXTURE_VARIANTS,
  FOOD_KEYS,
  IDS,
  USER,
  addDays,
  buildFixtures,
  foodName,
  foodNutrients,
  localIso,
} from './fixtures';
import { createMockBackend } from './mock-backend';
import { KNOWN_TABLES, SCHEMA } from './schema';
import { foldText } from './search';

const fx = buildFixtures();
const rows = (name: string) => (fx.seed.tables[name] ?? []) as Record<string, any>[];

describe('clock', () => {
  it('FIXED_NOW is local noon on TODAY and maps to the expected epoch', () => {
    expect(FIXED_NOW).toBe('2026-11-10T12:00:00');
    expect(TODAY).toBe('2026-11-10');
    expect(FIXED_NOW_MS).toBe(Date.UTC(2026, 10, 10, 11, 0, 0));
    expect(TIMEZONE).toBe('Europe/Sarajevo');
    expect(localIso(TODAY, '12:00')).toBe('2026-11-10T12:00:00+01:00');
    expect(addDays(TODAY, -1)).toBe('2026-11-09');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('fixture integrity', () => {
  it('builds a consistent database for every variant (schema, constraints, every FK resolves)', () => {
    for (const variant of FIXTURE_VARIANTS) {
      const backend = createMockBackend(buildFixtures(variant).seed);
      expect(backend.integrityErrors(), variant).toEqual([]);
    }
  });

  it('only seeds known tables, and every table is present', () => {
    expect(Object.keys(fx.seed.tables).filter((t) => !KNOWN_TABLES.includes(t))).toEqual([]);
    const missing = KNOWN_TABLES.filter((t) => !(t in fx.seed.tables) && !SCHEMA[t]?.virtual);
    expect(missing).toEqual([]);
  });

  it('uses only valid core NutrientCode keys with finite non-negative numbers', () => {
    for (const food of rows('foods')) {
      for (const [code, value] of Object.entries(food.nutrients as Record<string, unknown>)) {
        expect(isNutrientCode(code), `${food.name}: ${code}`).toBe(true);
        expect(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${food.name}.${code}=${String(value)}`).toBe(true);
      }
    }
    expect(rows('nutrients').map((n) => n.code)).toEqual([...NUTRIENT_CODES]);
    for (const t of rows('nutrient_targets')) expect(isNutrientCode(t.nutrient_code)).toBe(true);
  });

  it('every diary entry references an existing food and meal group of the user', () => {
    const foodIds = new Set(rows('foods').map((f) => f.id));
    const groupIds = new Set(rows('meal_groups').map((g) => g.id));
    for (const e of rows('diary_entries')) {
      expect(foodIds.has(e.food_id), e.id).toBe(true);
      expect(groupIds.has(e.meal_group_id), e.id).toBe(true);
      expect(e.user_id).toBe(USER.id);
    }
  });

  it('all foods, portions, favourites, usage, saved meals and recipes reference existing rows', () => {
    const foodIds = new Set(rows('foods').map((f) => f.id));
    for (const p of rows('food_portions')) expect(foodIds.has(p.food_id)).toBe(true);
    for (const f of rows('favorites')) expect(foodIds.has(f.food_id)).toBe(true);
    for (const u of rows('food_usage')) expect(foodIds.has(u.food_id)).toBe(true);
    for (const i of rows('saved_meal_items')) expect(foodIds.has(i.food_id)).toBe(true);
    for (const i of rows('recipe_ingredients')) {
      expect(foodIds.has(i.ingredient_food_id)).toBe(true);
      expect(foodIds.has(i.recipe_food_id)).toBe(true);
    }
    for (const a of rows('exercise_entries').filter((e) => e.activity_code)) {
      expect(rows('exercise_activities').some((x) => x.code === a.activity_code)).toBe(true);
    }
    expect(FOOD_KEYS.length).toBe(rows('foods').length);
    expect(new Set(Object.values(IDS.food)).size).toBe(FOOD_KEYS.length);
  });
});

describe('fixture content', () => {
  it('has ~30 foods of every kind, with rich, label-only, Bosnian, recipe and AI examples', () => {
    const foods = rows('foods');
    expect(foods.length).toBeGreaterThanOrEqual(30);
    const rich = foods.filter((f) => Object.keys(f.nutrients).length >= 40);
    expect(rich.length).toBeGreaterThanOrEqual(10);
    const branded = foods.find((f) => f.kind === 'branded');
    expect(branded).toBeDefined();
    expect(Object.keys(branded?.nutrients ?? {}).length).toBeLessThan(10);
    expect(branded?.gtin14).toBe(`0${BARCODES.nutella}`);
    expect(foods.some((f) => f.kind === 'ai_estimate' && f.source === 'ai_estimate')).toBe(true);
    expect(foods.some((f) => f.kind === 'recipe')).toBe(true);
    expect(new Set(foods.map((f) => f.kind))).toEqual(new Set(['generic', 'branded', 'custom', 'recipe', 'ai_estimate']));
    expect(new Set(foods.map((f) => f.carb_basis))).toEqual(new Set(['includes_fiber', 'excludes_fiber']));
  });

  it('has Bosnian names with diacritics that the search folds', () => {
    const names = rows('foods').map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Ćevapi', 'Vrhnje za kuhanje', 'Piletina s rižom']));
    expect(foodName('cevapi')).toBe('Ćevapi');
    expect(foldText('Ćevapi')).toBe('cevapi');
    expect(foldText('Đuveč s rižom, čaj, šljive, žlica')).toBe('duvec s rizom, caj, sljive, zlica');
    const units = rows('food_portions').map((p) => p.unit).filter(Boolean);
    expect(units).toEqual(expect.arrayContaining(['ćevap', 'žlica']));
  });

  it('follows the portion convention: grams is the mass of `amount` units, per-unit mass is plausible', () => {
    for (const p of rows('food_portions')) {
      expect(p.grams).toBeGreaterThan(0);
      expect(p.amount === null || p.amount > 0).toBe(true);
      const perUnit = p.grams / (p.amount ?? 1);
      expect(perUnit, `${p.label}`).toBeGreaterThan(0.5);
      expect(perUnit, `${p.label}`).toBeLessThan(1000);
    }
    const half = rows('food_portions').find((p) => p.label === '1/2 cup');
    expect(half).toMatchObject({ amount: 0.5, unit: 'cup', grams: 40 });
    const tbsp2 = rows('food_portions').find((p) => p.label === '2 tbsp');
    expect(tbsp2?.grams / tbsp2?.amount).toBe(16);
  });

  it('the recipe is computed from its ingredients and has serving portions', () => {
    const recipe = rows('foods').find((f) => f.id === IDS.food.recipeChickenRice);
    expect(recipe?.owner_id).toBe(USER.id);
    expect(recipe?.nutrients.ENERGY_KCAL).toBeGreaterThan(80);
    expect(recipe?.nutrients.ENERGY_KCAL).toBeLessThan(250);
    expect(rows('recipes')[0]).toMatchObject({ food_id: recipe?.id, servings: 2, final_weight_g: 900 });
    expect(rows('recipe_ingredients')).toHaveLength(5);
    const portions = rows('food_portions').filter((p) => p.food_id === recipe?.id).map((p) => p.label);
    expect(portions).toEqual(['1 serving', 'Full recipe', '100 g']);
  });

  it('puts the food nutrient data in believable ranges (per 100 g)', () => {
    for (const key of FOOD_KEYS) {
      const n = foodNutrients(key);
      const kcal = n.ENERGY_KCAL ?? 0;
      expect(kcal, key).toBeGreaterThan(0);
      expect(kcal, key).toBeLessThanOrEqual(900);
      const macroMass = (n.PROTEIN_G ?? 0) + (n.CARBS_G ?? 0) + (n.FAT_G ?? 0);
      expect(macroMass, key).toBeLessThanOrEqual(101);
      if (n.SATURATED_FAT_G !== undefined && n.FAT_G !== undefined) expect(n.SATURATED_FAT_G, key).toBeLessThanOrEqual(n.FAT_G + 0.001);
      if (n.SUGARS_G !== undefined && n.CARBS_G !== undefined && key !== 'breadWholemeal') expect(n.SUGARS_G, key).toBeLessThanOrEqual(n.CARBS_G + 0.5);
      // Atwater sanity: stated energy within 30% of 4/4/9 (alcohol and fibre excluded) - generous for rounding
      if (!['coffee', 'oliveOil'].includes(key)) {
        const atwater = (n.PROTEIN_G ?? 0) * 4 + (n.CARBS_G ?? 0) * 4 + (n.FAT_G ?? 0) * 9;
        expect(Math.abs(kcal - atwater) / Math.max(kcal, 1), key).toBeLessThan(0.3);
      }
    }
  });
});

describe('dates are relative to FIXED_NOW', () => {
  it('has diary entries for today, yesterday and the 6 days before (an 8 day streak)', () => {
    const byDate = new Map<string, number>();
    for (const e of rows('diary_entries')) byDate.set(e.entry_date, (byDate.get(e.entry_date) ?? 0) + 1);
    for (let back = 0; back <= 7; back += 1) expect(byDate.get(addDays(TODAY, -back)), `day -${back}`).toBeGreaterThan(5);
    const dates = [...byDate.keys()].sort();
    expect(dates[0]).toBe(addDays(TODAY, -7));
    expect(dates.at(-1)).toBe(TODAY);
    expect(byDate.get(TODAY)).toBeGreaterThanOrEqual(12);
  });

  it('today covers breakfast, lunch, dinner and snacks', () => {
    const groupOf = new Map(rows('meal_groups').map((g) => [g.id, g.name]));
    const today = rows('diary_entries').filter((e) => e.entry_date === TODAY);
    expect(new Set(today.map((e) => groupOf.get(e.meal_group_id)))).toEqual(new Set(['Breakfast', 'Lunch', 'Dinner', 'Snacks']));
    expect(rows('meal_groups').map((g) => g.name)).toEqual(['Breakfast', 'Lunch', 'Dinner', 'Snacks']);
  });

  it('has ~30 days of weight going from 82 to 80 kg and body fat readings', () => {
    const weights = rows('biometrics').filter((b) => b.type === 'weight').sort((a, b) => (a.entry_date < b.entry_date ? -1 : 1));
    expect(weights.length).toBeGreaterThanOrEqual(22);
    expect(weights[0]?.entry_date).toBe(addDays(TODAY, -29));
    expect(weights.at(-1)?.entry_date).toBe(TODAY);
    expect(weights[0]?.value).toBeGreaterThan(81.5);
    expect(weights.at(-1)?.value).toBe(80);
    expect(rows('biometrics').filter((b) => b.type === 'body_fat').length).toBeGreaterThanOrEqual(4);
    expect(new Set(weights.map((w) => w.entry_date)).size).toBe(weights.length);
  });

  it('has the active goal, macro ratios 30/40/30 and activity data', () => {
    expect(rows('weight_goals')).toHaveLength(1);
    expect(rows('weight_goals')[0]).toMatchObject({ active: true, rate_kg_per_week: -0.5, start_date: addDays(TODAY, -29) });
    expect(rows('macro_targets')[0]).toMatchObject({ mode: 'ratios', protein_pct: 30, carbs_pct: 40, fat_pct: 30, weekday: null });
    expect(rows('macro_targets')[0]?.effective_from <= TODAY).toBe(true);
    const exercise = rows('exercise_entries').filter((e) => e.entry_date === TODAY);
    expect(exercise.map((e) => e.source).sort()).toEqual(['apple_health', 'manual']);
    expect(rows('daily_energy')).toHaveLength(1);
    expect(rows('daily_energy')[0]).toMatchObject({ local_date: TODAY, source: 'apple_health' });
    expect(rows('water_entries').filter((w) => w.entry_date === TODAY)).toHaveLength(3);
    expect(rows('notes').length).toBeGreaterThanOrEqual(1);
    expect(rows('coach_threads').length).toBe(3);
    expect(rows('favorites').length).toBeGreaterThanOrEqual(5);
    expect(rows('saved_meals').length).toBeGreaterThanOrEqual(1);
  });

  it('daily totals (the view the dashboard reads) cover the last 8 days with plausible energy', () => {
    const backend = createMockBackend(fx.seed);
    const totals = backend.rows('daily_totals');
    expect(totals).toHaveLength(8);
    for (const t of totals) {
      expect(t.kcal as number, String(t.entry_date)).toBeGreaterThan(1200);
      expect(t.kcal as number, String(t.entry_date)).toBeLessThan(3600);
      expect(t.protein_g as number).toBeGreaterThan(40);
    }
  });
});

describe('the fixtures drive the real calculations of @ration/core (the same ones useTargets / useDayNutrients run)', () => {
  it('resolve to sensible daily targets for the default user', () => {
    const profile = rows('profiles')[0]!;
    const result = resolveTargets({
      sex: profile.sex,
      birthdate: profile.birthdate,
      heightCm: profile.height_cm,
      weightKg: 80,
      bodyFatPct: 18.9,
      activityLevel: profile.activity_level,
      bmrFormula: profile.bmr_formula,
      bmrOverride: null,
      rateKgPerWeek: -0.5,
      macroMode: { mode: 'ratios', proteinPct: 30, carbsPct: 40, fatPct: 30 },
      netCarbs: profile.net_carbs,
      pregnant: false,
      lactating: false,
      overrides: { FIBER_G: { min: 35 }, SODIUM_MG: { max: 2000 } },
      onDate: TODAY,
    });
    expect(result.age).toBe(34);
    expect(result.bmr).toBeGreaterThan(1700);
    expect(result.bmr).toBeLessThan(2000);
    expect(result.energy.target).toBeGreaterThan(1700);
    expect(result.energy.target).toBeLessThan(2300);
    expect(result.macros.protein.grams).toBeGreaterThan(120);
    expect(result.macros.energyKcal).toBe(result.energy.target);
    expect(result.nutrients.SODIUM_MG?.max).toBe(2000);
    expect(result.nutrients.FIBER_G?.min).toBe(35);
  });

  it("today's entries sum to a believable intake with the same maths as the diary screen", () => {
    const foods = new Map(rows('foods').map((f) => [f.id, f] as const));
    const kcalOf = (date: string) => {
      const entries = rows('diary_entries').filter((e) => e.entry_date === date);
      const total = sumNutrients(
        entries.map((e) => {
          const food = foods.get(e.food_id)!;
          return deriveNutrients(scaleNutrients(food.nutrients, e.grams), { carbBasis: food.carb_basis });
        }),
      );
      return total.ENERGY_KCAL ?? 0;
    };
    expect(kcalOf(TODAY)).toBeGreaterThan(1700);
    expect(kcalOf(TODAY)).toBeLessThan(2900);
    for (let back = 1; back <= 7; back += 1) {
      expect(kcalOf(addDays(TODAY, -back)), `day -${back}`).toBeGreaterThan(1400);
      expect(kcalOf(addDays(TODAY, -back)), `day -${back}`).toBeLessThan(3400);
    }
  });
});

describe('variants', () => {
  it('not-onboarded: signup state only', () => {
    const v = buildFixtures('not-onboarded').seed.tables;
    expect(v.profiles).toHaveLength(1);
    expect(v.profiles?.[0]).toMatchObject({ onboarded: false, sex: null, birthdate: null, height_cm: null });
    expect(v.meal_groups).toHaveLength(4);
    for (const t of ['biometrics', 'weight_goals', 'macro_targets', 'diary_entries', 'favorites', 'recipes', 'saved_meals']) {
      expect(v[t], t).toEqual([]);
    }
    expect((v.foods ?? []).every((f) => f.owner_id === null)).toBe(true);
  });

  it('imperial: same data with imperial units', () => {
    const v = buildFixtures('imperial').seed.tables;
    expect(v.profiles?.[0]).toMatchObject({ unit_system: 'imperial', onboarded: true });
    expect(v.diary_entries?.length).toBe(rows('diary_entries').length);
  });

  it('empty-diary: onboarded but nothing logged', () => {
    const v = buildFixtures('empty-diary').seed.tables;
    expect(v.profiles?.[0]).toMatchObject({ onboarded: true });
    expect(v.diary_entries).toEqual([]);
    expect(v.food_usage).toEqual([]);
    expect((v.biometrics ?? []).length).toBeGreaterThan(20);
  });

  it('fresh-account: onboarded with body data but no diary and no personal library', () => {
    const v = buildFixtures('fresh-account').seed.tables;
    expect(v.profiles?.[0]).toMatchObject({ onboarded: true });
    expect((v.biometrics ?? []).length).toBeGreaterThan(20);
    expect(v.weight_goals).toHaveLength(1);
    for (const t of ['diary_entries', 'food_usage', 'favorites', 'recipes', 'saved_meals', 'coach_threads', 'exercise_entries', 'water_entries']) {
      expect(v[t], t).toEqual([]);
    }
    expect((v.foods ?? []).every((f) => f.owner_id === null)).toBe(true);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildFixtures().seed)).toBe(JSON.stringify(buildFixtures().seed));
  });
});
