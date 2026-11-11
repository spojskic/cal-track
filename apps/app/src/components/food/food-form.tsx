import { useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import {
  NUTRIENT_BY_CODE,
  NUTRIENT_GROUPS,
  NUTRIENTS,
  parseNumber,
  type CarbBasis,
  type NutrientCode,
  type NutrientMap,
} from '@ration/core';

import { Glyph } from '@/components/Glyph';
import type { FoodInput } from '@/data/foods';
import { validateBarcode } from '@/data/foods';
import { MAX_CONTENT_WIDTH, spacing, useTheme } from '@/theme';

import { NumberField, Segmented, SwitchRow, TextField, WarningHint } from '../forms';
import { AppText, Button, Card } from '../ui';
import { UNIT_LABEL, formatAmount, trimNumber } from './format';

export interface FoodFormInitial {
  name?: string;
  brand?: string | null;
  gtin?: string | null;
  /** Per 100 g, or per serving when `basis` is 'perServing'. */
  nutrients?: NutrientMap;
  /** What `nutrients` are per. Default per 100 g. 'perServing' = per the first serving (`servings[0]`). */
  basis?: Basis;
  carbBasis?: CarbBasis;
  densityGPerMl?: number | null;
  /** Grams of ONE unit named `name`. `null` grams = not known yet (the form asks for it). */
  servings?: { name: string; grams: number | null }[];
  /**
   * Review mode for values that were filled in by a machine (a nutrition label scan): nutrients to mark "check this
   * value" until the user edits them, and the same for fields other than nutrients.
   */
  unclear?: readonly NutrientCode[];
  unclearFields?: readonly CheckField[];
  /** Open "More nutrients" when it holds filled values, so none of them is hidden from the review. */
  expandFilled?: boolean;
}

type Basis = 'per100g' | 'perServing';

/** Fields other than nutrients that can carry a "check this" marker. */
export type CheckField = 'name' | 'brand' | 'serving' | 'basis' | 'carbBasis';

const CHECK_VALUE = 'Check this value against the label.';
const NO_FLAGS: ReadonlySet<string> = new Set();

/** Marker keys: a nutrient code, or `field:<name>`. */
function initialFlags(initial: FoodFormInitial | undefined): ReadonlySet<string> {
  if (!initial || (!initial.unclear?.length && !initial.unclearFields?.length)) return NO_FLAGS;
  return new Set<string>([...(initial.unclear ?? []), ...(initial.unclearFields ?? []).map((f) => `field:${f}`)]);
}

const MAIN_FIELDS: NutrientCode[] = ['ENERGY_KCAL', 'PROTEIN_G', 'CARBS_G', 'FAT_G'];
const LABEL_FIELDS: NutrientCode[] = [
  'FIBER_G',
  'SUGARS_G',
  'ADDED_SUGARS_G',
  'SATURATED_FAT_G',
  'TRANS_FAT_G',
  'CHOLESTEROL_MG',
  'SODIUM_MG',
  'POTASSIUM_MG',
  'CALCIUM_MG',
  'IRON_MG',
  'VITAMIN_D_UG',
];
const PRIORITY = new Set<NutrientCode>([...MAIN_FIELDS, ...LABEL_FIELDS]);

const MORE_GROUPS = NUTRIENT_GROUPS.map((g) => ({
  ...g,
  fields: NUTRIENTS.filter((n) => n.group === g.code && !n.computed && !PRIORITY.has(n.code)).map((n) => n.code),
})).filter((g) => g.fields.length > 0);

interface ServingRow {
  name: string;
  grams: string;
}

interface FormErrors {
  summary?: string;
  name?: string;
  gtin?: string;
  density?: string;
  basis?: string;
  nutrition?: string;
  servings: Record<number, { name?: string; grams?: string }>;
  fields: Partial<Record<NutrientCode, string>>;
}

const NO_ERRORS: FormErrors = { servings: {}, fields: {} };

function initialValues(nutrients: NutrientMap | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!nutrients) return out;
  for (const [code, value] of Object.entries(nutrients)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[code] = trimNumber(value, 4);
  }
  return out;
}

function anyFilled(values: Record<string, string>, codes: readonly NutrientCode[]): boolean {
  return codes.some((c) => (values[c] ?? '').trim() !== '');
}

/**
 * Create / edit form for custom foods: name, brand, barcode, servings, nutrients (per 100 g or per
 * serving) with grouped collapsible sections, carb basis and optional density.
 */
export function FoodForm({
  initial,
  submitLabel,
  submitting,
  submitError,
  onSubmit,
  onCancel,
  header,
}: {
  initial?: FoodFormInitial;
  submitLabel: string;
  submitting: boolean;
  submitError?: string | null;
  onSubmit: (input: FoodInput) => void;
  onCancel?: () => void;
  header?: ReactNode;
}) {
  const { colors, radius } = useTheme();
  const scrollRef = useRef<ScrollViewInstance>(null);

  const [name, setName] = useState(initial?.name ?? '');
  const [brand, setBrand] = useState(initial?.brand ?? '');
  const [gtin, setGtin] = useState(initial?.gtin ?? '');
  const [servings, setServings] = useState<ServingRow[]>(() =>
    initial?.servings && initial.servings.length > 0
      ? initial.servings.map((s) => ({ name: s.name, grams: s.grams === null ? '' : trimNumber(s.grams, 3) }))
      : [{ name: '', grams: '' }],
  );
  const [basis, setBasis] = useState<Basis>(initial?.basis ?? 'per100g');
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(initial?.nutrients));
  const [includesFiber, setIncludesFiber] = useState((initial?.carbBasis ?? 'includes_fiber') === 'includes_fiber');
  const [density, setDensity] = useState(
    initial?.densityGPerMl ? trimNumber(initial.densityGPerMl, 4) : '',
  );
  const [openLabel, setOpenLabel] = useState(() => anyFilled(initialValues(initial?.nutrients), LABEL_FIELDS));
  const [openMore, setOpenMore] = useState(
    () => initial?.expandFilled === true && MORE_GROUPS.some((g) => anyFilled(initialValues(initial.nutrients), g.fields)),
  );
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const v = initialValues(initial?.nutrients);
    return Object.fromEntries(MORE_GROUPS.map((g) => [g.code, anyFilled(v, g.fields)]));
  });
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  // "Check this" markers; each one goes away as soon as the user touches that field.
  const [flags, setFlags] = useState<ReadonlySet<string>>(() => initialFlags(initial));

  function clearFlag(key: string) {
    setFlags((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }

  const primaryServingGrams = parseNumber(servings[0]?.grams ?? '');
  const primaryServingName = servings[0]?.name.trim() ?? '';

  function setValue(code: NutrientCode, text: string) {
    clearFlag(code);
    setValues((v) => ({ ...v, [code]: text }));
    if (errors.fields[code]) setErrors((e) => ({ ...e, fields: { ...e.fields, [code]: undefined } }));
  }

  function changeBasis(next: Basis) {
    if (next === basis) return;
    clearFlag('field:basis');
    if (primaryServingGrams === null || primaryServingGrams <= 0) {
      setErrors((e) => ({ ...e, basis: 'Enter the serving size in grams first (Serving size section).' }));
      return;
    }
    // Keep the same food: rescale what was typed.
    const factor = next === 'perServing' ? primaryServingGrams / 100 : 100 / primaryServingGrams;
    setValues((prev) => {
      const out: Record<string, string> = {};
      for (const [code, text] of Object.entries(prev)) {
        const n = parseNumber(text);
        out[code] = n === null ? text : String(Number((n * factor).toPrecision(5)));
      }
      return out;
    });
    setBasis(next);
    setErrors((e) => ({ ...e, basis: undefined }));
  }

  function validate(): { input: FoodInput | null; errors: FormErrors } {
    const errs: FormErrors = { servings: {}, fields: {} };

    const trimmedName = name.trim();
    if (trimmedName === '') errs.name = 'Name is required.';

    let gtinValue: string | null = null;
    if (gtin.trim() !== '') {
      const check = validateBarcode(gtin);
      if (check.ok) gtinValue = check.gtin14;
      else errs.gtin = check.message;
    }

    const validServings: { name: string; grams: number }[] = [];
    servings.forEach((row, i) => {
      const n = row.name.trim();
      const g = row.grams.trim();
      if (n === '' && g === '') return;
      const parsed = parseNumber(row.grams);
      const rowErr: { name?: string; grams?: string } = {};
      if (n === '') rowErr.name = 'Name this serving, e.g. slice.';
      if (g === '' || parsed === null || parsed <= 0) rowErr.grams = 'Enter grams greater than 0.';
      if (rowErr.name || rowErr.grams) errs.servings[i] = rowErr;
      else if (parsed !== null) validServings.push({ name: n, grams: parsed });
    });

    let densityValue: number | null = null;
    if (density.trim() !== '') {
      const d = parseNumber(density);
      if (d === null || d <= 0) errs.density = 'Enter a density greater than 0 (g per ml), or leave it empty.';
      else densityValue = d;
    }

    let factor = 1;
    if (basis === 'perServing') {
      const g = primaryServingGrams;
      if (g === null || g <= 0) errs.basis = 'Enter the serving size in grams to use per-serving values.';
      else factor = 100 / g;
    }

    const nutrients: NutrientMap = {};
    for (const [code, text] of Object.entries(values)) {
      if (text.trim() === '') continue;
      const def = NUTRIENT_BY_CODE[code as NutrientCode];
      if (!def) continue;
      const parsed = parseNumber(text);
      if (parsed === null) {
        errs.fields[def.code] = 'Enter a number, 0 or more.';
        continue;
      }
      const per100 = parsed * factor;
      if (def.unit === 'g' && per100 > 100.0001) {
        errs.fields[def.code] = 'More than 100 g per 100 g is not possible.';
        continue;
      }
      if (def.unit === 'kcal' && per100 > 1000) {
        errs.fields[def.code] = 'More than 1000 kcal per 100 g is not possible.';
        continue;
      }
      nutrients[def.code] = per100;
    }

    const hasEnergyOrMacro = MAIN_FIELDS.some((c) => nutrients[c] !== undefined);
    const hasBadMain = MAIN_FIELDS.some((c) => errs.fields[c]);
    if (!hasEnergyOrMacro && !hasBadMain) {
      errs.nutrition = 'Enter energy or at least one of protein, carbs and fat.';
    }
    const macroSum = (nutrients.PROTEIN_G ?? 0) + (nutrients.CARBS_G ?? 0) + (nutrients.FAT_G ?? 0);
    if (macroSum > 105) errs.nutrition = 'Protein + carbs + fat cannot add up to more than 100 g per 100 g.';

    const failed =
      errs.name ||
      errs.gtin ||
      errs.density ||
      errs.basis ||
      errs.nutrition ||
      Object.keys(errs.servings).length > 0 ||
      Object.keys(errs.fields).length > 0;
    if (failed) {
      errs.summary = 'Some fields need attention. They are marked below.';
      return { input: null, errors: errs };
    }

    return {
      input: {
        name: trimmedName,
        brand: brand.trim() === '' ? null : brand.trim(),
        gtin: gtinValue,
        nutrients,
        carbBasis: includesFiber ? 'includes_fiber' : 'excludes_fiber',
        densityGPerMl: densityValue,
        servings: validServings,
      },
      errors: errs,
    };
  }

  function submit() {
    const result = validate();
    setErrors(result.errors);
    if (!result.input) {
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    onSubmit(result.input);
  }

  const kcalPer100 = (() => {
    const t = values.ENERGY_KCAL;
    const n = t ? parseNumber(t) : null;
    if (n === null) return null;
    if (basis === 'per100g') return n;
    return primaryServingGrams && primaryServingGrams > 0 ? (n * 100) / primaryServingGrams : null;
  })();

  const referenceText =
    basis === 'per100g'
      ? 'Values are for 100 g of the food.'
      : `Values are for 1 ${primaryServingName || 'serving'}${primaryServingGrams ? ` (${trimNumber(primaryServingGrams, 1)} g)` : ''}.`;

  const field = (code: NutrientCode) => {
    const def = NUTRIENT_BY_CODE[code];
    return (
      <View key={code} style={styles.cell}>
        <NumberField
          label={def.name}
          unit={UNIT_LABEL[def.unit]}
          value={values[code] ?? ''}
          onChange={(t) => setValue(code, t)}
          error={errors.fields[code] ?? null}
          warning={flags.has(code) ? CHECK_VALUE : null}
          selectTextOnFocus
        />
      </View>
    );
  };

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets>
      <View style={styles.content}>
        {header}
        {errors.summary || submitError ? (
          <Card style={{ borderColor: colors.danger }}>
            {errors.summary ? (
              <AppText accessibilityLiveRegion="polite" style={{ color: colors.danger, fontWeight: '600' }}>
                {errors.summary}
              </AppText>
            ) : null}
            {submitError ? (
              <AppText accessibilityLiveRegion="polite" style={{ color: colors.danger }}>
                {submitError}
              </AppText>
            ) : null}
          </Card>
        ) : null}

        <Card>
          <AppText variant="heading">Food</AppText>
          <TextField
            label="Name"
            value={name}
            onChangeText={(t) => {
              setName(t);
              clearFlag('field:name');
              if (errors.name) setErrors((e) => ({ ...e, name: undefined }));
            }}
            placeholder="e.g. Homemade bread"
            autoCapitalize="sentences"
            maxLength={120}
            error={errors.name ?? null}
            warning={flags.has('field:name') ? 'Check the name against the package.' : null}
            accessibilityLabel="Food name"
          />
          <TextField
            label="Brand (optional)"
            value={brand}
            onChangeText={(t) => {
              setBrand(t);
              clearFlag('field:brand');
            }}
            placeholder="e.g. Sunny Farms"
            autoCapitalize="words"
            maxLength={80}
            warning={flags.has('field:brand') ? 'Check the brand against the package.' : null}
          />
          <TextField
            label="Barcode (optional)"
            value={gtin}
            onChangeText={(t) => {
              setGtin(t);
              if (errors.gtin) setErrors((e) => ({ ...e, gtin: undefined }));
            }}
            placeholder="Digits under the barcode"
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={20}
            error={errors.gtin ?? null}
            hint="Lets you find this food by scanning it."
          />
        </Card>

        <Card>
          <AppText variant="heading">Serving size</AppText>
          <AppText variant="small" muted>
            Every food can be logged in grams. Add a serving, such as 1 slice = 30 g, to log it by the piece.
          </AppText>
          {servings.map((row, i) => (
            <View key={i} style={styles.servingRow}>
              <View style={styles.servingName}>
                <TextField
                  label={i === 0 ? 'Serving name' : `Serving ${i + 1} name`}
                  value={row.name}
                  onChangeText={(t) => {
                    if (i === 0) clearFlag('field:serving');
                    setServings((s) => s.map((r, j) => (j === i ? { ...r, name: t } : r)));
                  }}
                  placeholder="slice, cup, bar..."
                  maxLength={40}
                  error={errors.servings[i]?.name ?? null}
                />
              </View>
              <View style={styles.servingGrams}>
                <NumberField
                  label="Grams"
                  unit="g"
                  value={row.grams}
                  onChange={(t) => {
                    if (i === 0) clearFlag('field:serving');
                    setServings((s) => s.map((r, j) => (j === i ? { ...r, grams: t } : r)));
                  }}
                  placeholder="30"
                  error={errors.servings[i]?.grams ?? null}
                  warning={i === 0 && flags.has('field:serving') ? 'Check the serving size against the label.' : null}
                />
              </View>
              {servings.length > 1 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove serving ${i + 1}`}
                  onPress={() => setServings((s) => s.filter((_, j) => j !== i))}
                  style={[styles.remove, { borderColor: colors.border, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill }]}>
                  <Glyph name="close" size={18} color={colors.text} />
                </Pressable>
              ) : null}
            </View>
          ))}
          {servings.length < 6 ? (
            <Button
              label="Add another serving"
              variant="ghost"
              onPress={() => setServings((s) => [...s, { name: '', grams: '' }])}
            />
          ) : null}
        </Card>

        <Card>
          <AppText variant="heading">Nutrition</AppText>
          <Segmented<Basis>
            label="Nutrients entered per"
            options={[
              { value: 'per100g', label: 'Per 100 g' },
              { value: 'perServing', label: 'Per serving' },
            ]}
            value={basis}
            onChange={changeBasis}
          />
          {errors.basis ? (
            <AppText variant="small" style={{ color: colors.danger }}>{errors.basis}</AppText>
          ) : flags.has('field:basis') ? (
            <WarningHint>{'Check whether the label\u2019s values are per 100 g or per serving.'}</WarningHint>
          ) : (
            <AppText variant="small" muted>
              {referenceText}
              {basis === 'perServing' && kcalPer100 !== null
                ? ` That is ${formatAmount(kcalPer100, 'kcal')} kcal per 100 g.`
                : ''}
            </AppText>
          )}
          <SwitchRow
            label="Total carbs include fiber"
            description="On for US-style labels. Turn off if the label's carbohydrates already exclude fiber."
            warning={flags.has('field:carbBasis') ? 'Not sure which one this label is. Check it.' : null}
            value={includesFiber}
            onChange={(v) => {
              clearFlag('field:carbBasis');
              setIncludesFiber(v);
            }}
          />
          {errors.nutrition ? (
            <AppText accessibilityLiveRegion="polite" style={{ color: colors.danger, fontWeight: '600' }}>
              {errors.nutrition}
            </AppText>
          ) : null}
          <View style={styles.grid}>{MAIN_FIELDS.map(field)}</View>
          <Collapsible
            title="Label nutrients"
            subtitle="Fiber, sugars, fats, sodium, a few minerals"
            open={openLabel}
            onToggle={() => setOpenLabel((o) => !o)}>
            <View style={styles.grid}>{LABEL_FIELDS.map(field)}</View>
          </Collapsible>
          <Collapsible
            title="More nutrients"
            subtitle="Vitamins, minerals, fatty acids, amino acids"
            open={openMore}
            onToggle={() => setOpenMore((o) => !o)}>
            {MORE_GROUPS.map((g) => (
              <Collapsible
                key={g.code}
                nested
                title={g.label}
                open={openGroups[g.code] === true}
                onToggle={() => setOpenGroups((o) => ({ ...o, [g.code]: !o[g.code] }))}>
                <View style={styles.grid}>{g.fields.map(field)}</View>
              </Collapsible>
            ))}
          </Collapsible>
          <AppText variant="small" muted>
            Leave a field empty when you do not know the value. Empty means unknown, 0 means none.
          </AppText>
        </Card>

        <Card>
          <AppText variant="heading">Optional</AppText>
          <NumberField
            label="Density"
            unit="g/ml"
            value={density}
            onChange={(t) => {
              setDensity(t);
              if (errors.density) setErrors((e) => ({ ...e, density: undefined }));
            }}
            placeholder="e.g. 1.03 for milk"
            hint="Needed to log liquids by cup, tbsp, tsp, ml or fl oz."
            error={errors.density ?? null}
          />
        </Card>

        <View style={styles.actions}>
          <Button label={submitLabel} onPress={submit} loading={submitting} />
          {onCancel ? <Button label="Cancel" variant="ghost" onPress={onCancel} disabled={submitting} /> : null}
        </View>
      </View>
    </ScrollView>
  );
}

function Collapsible({
  title,
  subtitle,
  open,
  onToggle,
  nested = false,
  children,
}: {
  title: string;
  subtitle?: string;
  open: boolean;
  onToggle: () => void;
  nested?: boolean;
  children: ReactNode;
}) {
  const { colors, radius } = useTheme();
  return (
    <View style={[styles.collapsible, { borderColor: colors.border, borderRadius: nested ? radius.sm : radius.md }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${open ? 'Collapse' : 'Expand'}`}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.collapsibleHeader}>
        <View style={{ flex: 1 }}>
          <AppText variant="body" style={{ fontWeight: '700' }}>{title}</AppText>
          {subtitle ? <AppText variant="small" muted>{subtitle}</AppText> : null}
        </View>
        <AppText muted>{open ? '\u25BE' : '\u25B8'}</AppText>
      </Pressable>
      {open ? <View style={styles.collapsibleBody}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1 },
  content: {
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  cell: { flexGrow: 1, flexBasis: 150, minWidth: 140 },
  servingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  servingName: { flex: 2 },
  servingGrams: { flex: 1, minWidth: 90 },
  remove: {
    width: 40,
    height: 40,
    marginTop: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsible: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  collapsibleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    minHeight: 48,
  },
  collapsibleBody: { padding: spacing.md, paddingTop: 0, gap: spacing.md },
  actions: { gap: spacing.sm },
});
