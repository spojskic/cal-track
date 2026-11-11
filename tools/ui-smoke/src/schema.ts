/**
 * Schema metadata of the Ration Postgres database as the mock backend needs it, derived BY HAND from
 * supabase/migrations/*.sql: columns (type, nullability, defaults, check constraints), primary / unique keys,
 * foreign keys (used for PostgREST resource embedding and referential integrity) and the simplified RLS scope.
 *
 * Keep in sync with the migrations. `mock-backend.test.ts` and `grep-sync.test.ts` fail when the app uses a
 * table / RPC that is missing here.
 */

export type ColType = 'uuid' | 'text' | 'int' | 'numeric' | 'bool' | 'date' | 'timestamptz' | 'jsonb' | 'array';

export type DefaultSpec =
  | { fn: 'uuid' }
  | { fn: 'now' }
  | { fn: 'today' }
  | { fn: 'serial' }
  | { value: unknown };

export interface ColumnDef {
  type: ColType;
  notNull?: boolean;
  default?: DefaultSpec;
  /** CHECK (col in (...)). */
  oneOf?: readonly string[];
  /** CHECK (col >= min). */
  min?: number;
  /** CHECK (col > gt). */
  gt?: number;
  /** CHECK (col <= max). */
  max?: number;
  /** CHECK (char_length(btrim(col)) > 0). */
  nonBlank?: boolean;
  /** CHECK (col ~ regex). */
  pattern?: RegExp;
  /** Generated always (cannot be written). */
  generated?: boolean;
  /** Not part of `select=*` (large generated search columns). */
  hiddenFromStar?: boolean;
}

export interface FkDef {
  name: string;
  cols: string[];
  ref: string;
  refCols: string[];
  onDelete: 'cascade' | 'set null' | 'no action';
  /** For composite FKs `ON DELETE SET NULL (col)`: only these columns are nulled. */
  setNullCols?: string[];
}

/**
 * Simplified row level security.
 * - user:        rows have `column` = auth.uid() (read + write). `friendRead` adds READ access to the rows of the caller's accepted
 *                friends (public.my_friend_ids(), 20261110000109: recipes); writes stay owner-only
 * - owner:       `column` is NULL (global, read only) or auth.uid() (read + write, restricted to `writeKinds`). `friendKinds` adds READ
 *                access to the rows of those kinds that accepted friends own, `usedRead` to the rows the caller uses anywhere
 *                (public.my_used_food()); both are the foods_read policy of 20261110000109
 * - participant: rows where one of `columns` is auth.uid() (friendships); what a client may do with them is limited by `writeGrants`
 * - parent:      visible when the parent row is visible; writable when the parent row is writable
 * - reference:   readable by every signed-in user, never writable by clients
 */
export type Scope =
  | { kind: 'user'; column: string; friendRead?: boolean }
  | { kind: 'owner'; column: string; writeKinds?: readonly string[]; friendKinds?: readonly string[]; usedRead?: boolean }
  | { kind: 'participant'; columns: readonly string[] }
  | { kind: 'parent'; fk: string }
  | { kind: 'reference' };

export interface TableDef {
  name: string;
  columns: Record<string, ColumnDef>;
  pk: string[];
  unique: string[][];
  fks: FkDef[];
  scope: Scope;
  /** Computed on read (daily_totals): never writable. */
  virtual?: boolean;
  /**
   * The writes the `authenticated` role has a table GRANT for (default: all three). A write without a grant fails with
   * `permission denied for table ...` (403) before any row level security is looked at, like a read-only reference table.
   */
  writeGrants?: readonly ('insert' | 'update' | 'delete')[];
  /**
   * Columns that hold a food id which the row policy requires the caller to be able to SEE:
   * `with check (exists (select 1 from public.foods f where f.id = <col>))` (diary_entries, favorites, recipe_ingredients,
   * saved_meal_items). The food is looked up through the foods policy, so a friend's food passes and a stranger's does not.
   */
  foodRefCols?: readonly string[];
  /** CHECK constraints over more than one column (the single column ones are on the ColumnDef). */
  checks?: readonly { name: string; ok: (row: Record<string, unknown>) => boolean }[];
  /** `create unique index ... (least(a, b), greatest(a, b))`: one row per unordered pair of two columns. */
  pairUnique?: { name: string; cols: readonly [string, string] };
}

// ----------------------------------------------------------------------------- column builders

const col = (type: ColType, o: Partial<ColumnDef> = {}): ColumnDef => ({ type, ...o });
const uuid = (o: Partial<ColumnDef> = {}) => col('uuid', o);
const idCol = () => uuid({ notNull: true, default: { fn: 'uuid' } });
const text = (o: Partial<ColumnDef> = {}) => col('text', o);
const int = (o: Partial<ColumnDef> = {}) => col('int', o);
const num = (o: Partial<ColumnDef> = {}) => col('numeric', o);
const bool = (o: Partial<ColumnDef> = {}) => col('bool', o);
const date = (o: Partial<ColumnDef> = {}) => col('date', o);
const ts = (o: Partial<ColumnDef> = {}) => col('timestamptz', o);
const jsonb = (o: Partial<ColumnDef> = {}) => col('jsonb', o);
const nowCol = () => ts({ notNull: true, default: { fn: 'now' } });
const userCol = () => uuid({ notNull: true });

export const FOOD_SOURCES = [
  'fdc_foundation',
  'fdc_sr_legacy',
  'fdc_fndds',
  'fdc_branded',
  'cnf',
  'cofid',
  'off',
  'custom',
  'recipe',
  'ai_estimate',
] as const;
export const FOOD_KINDS = ['generic', 'branded', 'custom', 'recipe', 'ai_estimate'] as const;
const DEVICE_SOURCES = ['manual', 'apple_health', 'health_connect', 'garmin'] as const;

const fk = (
  table: string,
  cols: string[],
  ref: string,
  refCols: string[],
  onDelete: FkDef['onDelete'] = 'no action',
  extra: Partial<FkDef> = {},
): FkDef => ({ name: `${table}_${cols.join('_')}_fkey`, cols, ref, refCols, onDelete, ...extra });

const userFk = (table: string, column = 'user_id'): FkDef => fk(table, [column], 'auth.users', ['id'], 'cascade');

function table(def: Omit<TableDef, 'unique'> & { unique?: string[][] }): TableDef {
  return { unique: [], ...def };
}

// ----------------------------------------------------------------------------- tables

const defs: TableDef[] = [
  table({
    name: 'nutrients',
    columns: {
      code: text({ notNull: true, pattern: /^[A-Z][A-Z0-9_]*$/ }),
      name: text({ notNull: true }),
      short_name: text(),
      unit: text({ notNull: true }),
      nutrient_group: text({ notNull: true }),
      fdc_id: int(),
      fdc_alt_ids: col('array', { default: { value: [] } }),
      off_key: text(),
      sort_order: int({ notNull: true, default: { value: 0 } }),
      computed: bool({ notNull: true, default: { value: false } }),
      limit_nutrient: bool({ notNull: true, default: { value: false } }),
      highlight: bool({ notNull: true, default: { value: false } }),
    },
    pk: ['code'],
    fks: [],
    scope: { kind: 'reference' },
  }),
  table({
    name: 'dri_values',
    columns: {
      id: int({ notNull: true, default: { fn: 'serial' } }),
      nutrient_code: text({ notNull: true }),
      sex: text({ notNull: true, default: { value: 'any' }, oneOf: ['male', 'female', 'any'] }),
      age_min: int({ min: 0 }),
      age_max: int({ min: 0 }),
      life_stage: text({ notNull: true, default: { value: 'normal' }, oneOf: ['normal', 'pregnant', 'lactating'] }),
      rda: num(),
      ai: num(),
      ul: num(),
      ul_scope: text(),
      cdrr: num(),
    },
    pk: ['id'],
    fks: [fk('dri_values', ['nutrient_code'], 'nutrients', ['code'], 'cascade')],
    scope: { kind: 'reference' },
  }),
  table({
    name: 'exercise_activities',
    columns: {
      code: text({ notNull: true }),
      name: text({ notNull: true }),
      met: num({ notNull: true, gt: 0 }),
      category: text(),
    },
    pk: ['code'],
    fks: [],
    scope: { kind: 'reference' },
  }),
  table({
    name: 'app_settings',
    columns: {
      key: text({ notNull: true }),
      value: jsonb({ notNull: true }),
      updated_at: nowCol(),
    },
    pk: ['key'],
    fks: [],
    scope: { kind: 'reference' },
  }),
  table({
    name: 'foods',
    columns: {
      id: idCol(),
      source: text({ notNull: true, oneOf: FOOD_SOURCES }),
      source_id: text(),
      kind: text({ notNull: true, oneOf: FOOD_KINDS }),
      owner_id: uuid(),
      name: text({ notNull: true, nonBlank: true }),
      brand: text(),
      gtin14: text({ pattern: /^[0-9]{14}$/ }),
      category: text(),
      nutrients: jsonb({ notNull: true, default: { value: {} } }),
      completeness: num({ min: 0, max: 1 }),
      carb_basis: text({ notNull: true, default: { value: 'includes_fiber' }, oneOf: ['includes_fiber', 'excludes_fiber'] }),
      density_g_per_ml: num({ gt: 0 }),
      popularity: int({ notNull: true, default: { value: 0 } }),
      version: int({ notNull: true, default: { value: 1 } }),
      supersedes: uuid(),
      archived: bool({ notNull: true, default: { value: false } }),
      search_text: text({ generated: true, hiddenFromStar: true }),
      search: text({ generated: true, hiddenFromStar: true }),
      created_at: nowCol(),
      updated_at: nowCol(),
    },
    pk: ['id'],
    fks: [userFk('foods', 'owner_id'), fk('foods', ['supersedes'], 'foods', ['id'], 'set null')],
    // 20261110000109 foods_read: global, own, a friend's custom foods / recipes, and any food the caller uses. Writes stay owner-only.
    scope: { kind: 'owner', column: 'owner_id', writeKinds: ['custom', 'recipe', 'ai_estimate'], friendKinds: ['custom', 'recipe'], usedRead: true },
  }),
  table({
    name: 'food_portions',
    columns: {
      id: idCol(),
      food_id: uuid({ notNull: true }),
      label: text({ notNull: true }),
      amount: num({ gt: 0 }),
      unit: text(),
      grams: num({ notNull: true, gt: 0 }),
      sort_order: int({ notNull: true, default: { value: 0 } }),
    },
    pk: ['id'],
    fks: [fk('food_portions', ['food_id'], 'foods', ['id'], 'cascade')],
    scope: { kind: 'parent', fk: 'food_portions_food_id_fkey' },
  }),
  table({
    name: 'profiles',
    columns: {
      user_id: userCol(),
      display_name: text(),
      sex: text({ oneOf: ['male', 'female'] }),
      birthdate: date(),
      height_cm: num({ gt: 0 }),
      unit_system: text({ notNull: true, default: { value: 'metric' }, oneOf: ['metric', 'imperial'] }),
      timezone: text({ notNull: true, default: { value: 'UTC' } }),
      activity_level: text({ oneOf: ['none', 'sedentary', 'light', 'moderate', 'very'] }),
      bmr_formula: text({
        notNull: true,
        default: { value: 'mifflin' },
        oneOf: ['mifflin', 'katch_mcardle', 'harris_benedict', 'cunningham', 'manual'],
      }),
      bmr_override: num({ gt: 0 }),
      tef_enabled: bool({ notNull: true, default: { value: true } }),
      energy_mode: text({
        notNull: true,
        default: { value: 'static' },
        oneOf: ['static', 'device_adjusted', 'device_total'],
      }),
      // 20261110000103: what the third circle of the energy summary shows, and when the app switched energy_mode itself.
      energy_summary_mode: text({ notNull: true, default: { value: 'target' }, oneOf: ['target', 'balance'] }),
      energy_mode_auto_switched_at: ts(),
      net_carbs: bool({ notNull: true, default: { value: true } }),
      pregnant: bool({ notNull: true, default: { value: false } }),
      lactating: bool({ notNull: true, default: { value: false } }),
      coach_auto_delete: bool({ notNull: true, default: { value: true } }),
      onboarded: bool({ notNull: true, default: { value: false } }),
      // 20261110000107: the super admin flag; only the SQL editor / service_role can change it (a client's write of it is refused).
      is_admin: bool({ notNull: true, default: { value: false } }),
      created_at: nowCol(),
      updated_at: nowCol(),
    },
    pk: ['user_id'],
    fks: [userFk('profiles')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'meal_groups',
    columns: {
      id: idCol(),
      user_id: userCol(),
      name: text({ notNull: true, nonBlank: true }),
      sort_order: int({ notNull: true, default: { value: 0 } }),
      hidden: bool({ notNull: true, default: { value: false } }),
    },
    pk: ['id'],
    unique: [['id', 'user_id']],
    fks: [userFk('meal_groups')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'weight_goals',
    columns: {
      id: idCol(),
      user_id: userCol(),
      start_weight_kg: num({ notNull: true, gt: 0 }),
      target_weight_kg: num({ notNull: true, gt: 0 }),
      rate_kg_per_week: num({ notNull: true, default: { value: 0 } }),
      start_date: date({ notNull: true, default: { fn: 'today' } }),
      active: bool({ notNull: true, default: { value: true } }),
    },
    pk: ['id'],
    fks: [userFk('weight_goals')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'macro_targets',
    columns: {
      id: idCol(),
      user_id: userCol(),
      mode: text({ notNull: true, default: { value: 'ratios' }, oneOf: ['ratios', 'fixed', 'keto', 'protein_per_kg'] }),
      protein_pct: num({ min: 0, max: 100 }),
      carbs_pct: num({ min: 0, max: 100 }),
      fat_pct: num({ min: 0, max: 100 }),
      protein_g: num({ min: 0 }),
      carbs_g: num({ min: 0 }),
      fat_g: num({ min: 0 }),
      protein_g_per_kg: num({ min: 0 }),
      net_carbs_g: num({ min: 0 }),
      weekday: int({ min: 0, max: 6 }),
      effective_from: date({ notNull: true, default: { fn: 'today' } }),
    },
    pk: ['id'],
    fks: [userFk('macro_targets')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'nutrient_targets',
    columns: {
      user_id: userCol(),
      nutrient_code: text({ notNull: true }),
      min_value: num(),
      max_value: num(),
    },
    pk: ['user_id', 'nutrient_code'],
    fks: [userFk('nutrient_targets'), fk('nutrient_targets', ['nutrient_code'], 'nutrients', ['code'], 'cascade')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'recipes',
    columns: {
      food_id: uuid({ notNull: true }),
      user_id: userCol(),
      servings: num({ notNull: true, gt: 0, default: { value: 1 } }),
      final_weight_g: num({ gt: 0 }),
      notes: text(),
    },
    pk: ['food_id'],
    fks: [fk('recipes', ['food_id'], 'foods', ['id'], 'cascade'), userFk('recipes')],
    // recipes_friend_read (20261110000109): a friend's recipe row is readable; recipes_owner keeps every write to the owner.
    scope: { kind: 'user', column: 'user_id', friendRead: true },
  }),
  table({
    name: 'recipe_ingredients',
    columns: {
      id: idCol(),
      recipe_food_id: uuid({ notNull: true }),
      ingredient_food_id: uuid({ notNull: true }),
      grams: num({ notNull: true, gt: 0 }),
      sort_order: int({ notNull: true, default: { value: 0 } }),
    },
    pk: ['id'],
    fks: [
      fk('recipe_ingredients', ['recipe_food_id'], 'recipes', ['food_id'], 'cascade'),
      fk('recipe_ingredients', ['ingredient_food_id'], 'foods', ['id'], 'no action'),
    ],
    // Follows the recipe row: readable for a friend's recipe too (recipe_ingredients_friend_read), writable only for the owner.
    scope: { kind: 'parent', fk: 'recipe_ingredients_recipe_food_id_fkey' },
    foodRefCols: ['ingredient_food_id'],
  }),
  table({
    name: 'saved_meals',
    columns: {
      id: idCol(),
      user_id: userCol(),
      name: text({ notNull: true, nonBlank: true }),
    },
    pk: ['id'],
    fks: [userFk('saved_meals')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'saved_meal_items',
    columns: {
      id: idCol(),
      saved_meal_id: uuid({ notNull: true }),
      food_id: uuid({ notNull: true }),
      grams: num({ notNull: true, gt: 0 }),
      sort_order: int({ notNull: true, default: { value: 0 } }),
    },
    pk: ['id'],
    fks: [
      fk('saved_meal_items', ['saved_meal_id'], 'saved_meals', ['id'], 'cascade'),
      fk('saved_meal_items', ['food_id'], 'foods', ['id'], 'no action'),
    ],
    scope: { kind: 'parent', fk: 'saved_meal_items_saved_meal_id_fkey' },
    foodRefCols: ['food_id'],
  }),
  table({
    name: 'favorites',
    columns: {
      user_id: userCol(),
      food_id: uuid({ notNull: true }),
      created_at: nowCol(),
    },
    pk: ['user_id', 'food_id'],
    fks: [userFk('favorites'), fk('favorites', ['food_id'], 'foods', ['id'], 'cascade')],
    scope: { kind: 'user', column: 'user_id' },
    foodRefCols: ['food_id'],
  }),
  table({
    name: 'food_usage',
    columns: {
      user_id: userCol(),
      food_id: uuid({ notNull: true }),
      use_count: int({ notNull: true, default: { value: 0 } }),
      last_used_at: nowCol(),
    },
    pk: ['user_id', 'food_id'],
    fks: [userFk('food_usage'), fk('food_usage', ['food_id'], 'foods', ['id'], 'cascade')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'diary_entries',
    columns: {
      id: idCol(),
      user_id: userCol(),
      entry_date: date({ notNull: true }),
      meal_group_id: uuid(),
      food_id: uuid({ notNull: true }),
      grams: num({ notNull: true, gt: 0 }),
      amount: num(),
      portion_label: text(),
      source: text({
        notNull: true,
        default: { value: 'manual' },
        oneOf: ['manual', 'barcode', 'ai_photo', 'ai_text', 'recipe', 'copy', 'quick_add'],
      }),
      ai_confidence: num({ min: 0, max: 1 }),
      note: text(),
      logged_at: nowCol(),
    },
    pk: ['id'],
    fks: [
      userFk('diary_entries'),
      fk('diary_entries', ['food_id'], 'foods', ['id'], 'no action'),
      {
        name: 'diary_entries_meal_group_fk',
        cols: ['meal_group_id', 'user_id'],
        ref: 'meal_groups',
        refCols: ['id', 'user_id'],
        onDelete: 'set null',
        setNullCols: ['meal_group_id'],
      },
    ],
    scope: { kind: 'user', column: 'user_id' },
    foodRefCols: ['food_id'],
  }),
  table({
    name: 'daily_totals',
    columns: {
      user_id: userCol(),
      entry_date: date({ notNull: true }),
      kcal: num({ notNull: true, default: { value: 0 } }),
      protein_g: num({ notNull: true, default: { value: 0 } }),
      carbs_g: num({ notNull: true, default: { value: 0 } }),
      fat_g: num({ notNull: true, default: { value: 0 } }),
      fiber_g: num({ notNull: true, default: { value: 0 } }),
      entry_count: int({ notNull: true, default: { value: 0 } }),
      nutrients: jsonb({ notNull: true, default: { value: {} } }),
      updated_at: nowCol(),
    },
    pk: ['user_id', 'entry_date'],
    fks: [userFk('daily_totals')],
    scope: { kind: 'user', column: 'user_id' },
    virtual: true,
  }),
  table({
    name: 'exercise_entries',
    columns: {
      id: idCol(),
      user_id: userCol(),
      entry_date: date({ notNull: true }),
      activity_code: text(),
      name: text({ notNull: true }),
      minutes: num({ min: 0 }),
      kcal: num({ notNull: true, min: 0 }),
      source: text({ notNull: true, default: { value: 'manual' }, oneOf: DEVICE_SOURCES }),
      external_id: text(),
      started_at: ts(),
      ended_at: ts(),
      counts_toward_energy: bool({ notNull: true, default: { value: true } }),
      // 20261110000105: what a device knows about the workout (heart rate, zones, sets, ...); jsonb object, null = not known.
      details: jsonb(),
    },
    pk: ['id'],
    fks: [userFk('exercise_entries'), fk('exercise_entries', ['activity_code'], 'exercise_activities', ['code'], 'set null')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'biometrics',
    columns: {
      id: idCol(),
      user_id: userCol(),
      entry_date: date({ notNull: true }),
      type: text({ notNull: true, nonBlank: true }),
      value: num({ notNull: true }),
      unit: text(),
      source: text({ notNull: true, default: { value: 'manual' }, oneOf: DEVICE_SOURCES }),
      external_id: text(),
      recorded_at: nowCol(),
      meta: jsonb({ notNull: true, default: { value: {} } }),
    },
    pk: ['id'],
    fks: [userFk('biometrics')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'daily_energy',
    columns: {
      user_id: userCol(),
      local_date: date({ notNull: true }),
      source: text({ notNull: true, oneOf: DEVICE_SOURCES }),
      active_kcal: num({ min: 0 }),
      resting_kcal: num({ min: 0 }),
      steps: int({ min: 0 }),
      updated_at: nowCol(),
    },
    pk: ['user_id', 'local_date', 'source'],
    fks: [userFk('daily_energy')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'notes',
    columns: {
      id: idCol(),
      user_id: userCol(),
      entry_date: date({ notNull: true }),
      body: text({ notNull: true }),
      created_at: nowCol(),
    },
    pk: ['id'],
    fks: [userFk('notes')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'water_entries',
    columns: {
      id: idCol(),
      user_id: userCol(),
      entry_date: date({ notNull: true }),
      ml: num({ notNull: true, gt: 0 }),
      logged_at: nowCol(),
    },
    pk: ['id'],
    fks: [userFk('water_entries')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'fasts',
    columns: {
      id: idCol(),
      user_id: userCol(),
      started_at: ts({ notNull: true }),
      ended_at: ts(),
      target_hours: num({ gt: 0 }),
    },
    pk: ['id'],
    fks: [userFk('fasts')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'integrations',
    columns: {
      id: idCol(),
      user_id: userCol(),
      provider: text({ notNull: true, oneOf: ['apple_health', 'health_connect', 'garmin'] }),
      enabled: bool({ notNull: true, default: { value: false } }),
      settings: jsonb({ notNull: true, default: { value: {} } }),
      backfill_date: date(),
      secret_ref: text(),
      last_sync_at: ts(),
    },
    pk: ['id'],
    unique: [['user_id', 'provider']],
    fks: [userFk('integrations')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'coach_threads',
    columns: {
      id: idCol(),
      user_id: userCol(),
      title: text(),
      created_at: nowCol(),
      updated_at: nowCol(),
      // migration 20261110000106: what the chat is about, {kind, id}; null = ordinary chat
      topic: jsonb(),
    },
    pk: ['id'],
    unique: [['id', 'user_id']],
    fks: [userFk('coach_threads')],
    scope: { kind: 'user', column: 'user_id' },
  }),
  table({
    name: 'coach_messages',
    columns: {
      id: idCol(),
      thread_id: uuid({ notNull: true }),
      user_id: userCol(),
      role: text({ notNull: true, oneOf: ['user', 'assistant'] }),
      content: text({ notNull: true }),
      created_at: nowCol(),
    },
    pk: ['id'],
    fks: [
      userFk('coach_messages'),
      {
        name: 'coach_messages_thread_fk',
        cols: ['thread_id', 'user_id'],
        ref: 'coach_threads',
        refCols: ['id', 'user_id'],
        onDelete: 'cascade',
      },
    ],
    scope: { kind: 'user', column: 'user_id' },
  }),
  // 20261110000109: one row per pair, written only by send_friend_request / respond_friend_request (SECURITY DEFINER). A client may
  // read its own rows and delete them (cancel a request, decline one, remove a friend); INSERT and UPDATE have no grant.
  table({
    name: 'friendships',
    columns: {
      id: idCol(),
      requester_id: userCol(),
      addressee_id: userCol(),
      status: text({ notNull: true, default: { value: 'pending' }, oneOf: ['pending', 'accepted'] }),
      created_at: nowCol(),
      responded_at: ts(),
    },
    pk: ['id'],
    fks: [userFk('friendships', 'requester_id'), userFk('friendships', 'addressee_id')],
    scope: { kind: 'participant', columns: ['requester_id', 'addressee_id'] },
    writeGrants: ['delete'],
    checks: [{ name: 'friendships_not_self', ok: (row) => row.requester_id !== row.addressee_id }],
    pairUnique: { name: 'friendships_pair_uk', cols: ['requester_id', 'addressee_id'] },
  }),
];

export const SCHEMA: Readonly<Record<string, TableDef>> = Object.fromEntries(defs.map((d) => [d.name, d]));

/** Every public table the mock knows. */
export const KNOWN_TABLES: readonly string[] = defs.map((d) => d.name);

/** Tables that `authenticated` can only read (grants). */
export const READ_ONLY_TABLES: readonly string[] = defs
  .filter((d) => d.scope.kind === 'reference' || d.virtual)
  .map((d) => d.name);

/** RPCs the `authenticated` role may call (20261110000010_grants.sql) with their argument names. */
export const CLIENT_RPCS: Readonly<Record<string, { args: readonly string[]; required: readonly string[] }>> = {
  search_foods: { args: ['q', 'max_results', 'kinds'], required: ['q'] },
  get_food_by_gtin: { args: ['gtin'], required: ['gtin'] },
  supersede_food: { args: ['p_food_id'], required: ['p_food_id'] },
  delete_all_my_coach_data: { args: [], required: [] },
  // 20261110000107: super admin only (the database raises 42501 for everybody else).
  admin_create_invite_code: { args: ['p_note', 'p_max_uses', 'p_valid_days'], required: [] },
  admin_list_invite_codes: { args: [], required: [] },
  admin_revoke_invite_code: { args: ['p_code'], required: ['p_code'] },
  // 20261110000108: codes made for an e-mail address, and the list with the e-mail (the app pages it with PostgREST limit / offset).
  admin_create_invite_code_for: { args: ['p_email', 'p_max_uses', 'p_valid_days'], required: ['p_email'] },
  admin_list_invites: { args: [], required: [] },
  // 20261110000109: friends. my_friend_ids / my_used_food run inside the row level security policies as the caller and are executable
  // by `authenticated` too (the migration grants them), so they are callable through the REST API.
  my_friend_ids: { args: [], required: [] },
  my_used_food: { args: ['p_food_id'], required: ['p_food_id'] },
  send_friend_request: { args: ['p_email'], required: ['p_email'] },
  respond_friend_request: { args: ['p_id', 'p_accept'], required: ['p_id', 'p_accept'] },
  list_friendships: { args: [], required: [] },
};

/** Functions that exist but are service_role only: a client call is a bug (permission denied). */
export const SERVICE_ONLY_RPCS: readonly string[] = [
  'consume_rate_limit',
  'purge_old_coach_messages',
  'upsert_branded_food',
  'recompute_daily_totals',
  'handle_new_user',
  // Invite codes (20261110000100_invite_codes.sql): the owner (SQL editor) and the Edge Function `sign-up` only.
  'create_invite_code',
  'list_invite_codes',
  'revoke_invite_code',
  'consume_invite_code',
  'release_invite_code',
  // 20261110000108: the owner's e-mail version of create_invite_code.
  'create_invite_code_for',
];

export const KNOWN_RPCS: readonly string[] = [...Object.keys(CLIENT_RPCS), ...SERVICE_ONLY_RPCS];

export function tableOf(name: string): TableDef | undefined {
  return SCHEMA[name];
}

/** Columns returned by `select=*`. */
export function starColumns(def: TableDef): string[] {
  return Object.entries(def.columns)
    .filter(([, c]) => !c.hiddenFromStar)
    .map(([name]) => name);
}
