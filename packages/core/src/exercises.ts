/**
 * MET values for common activities.
 *
 * APPROXIMATE values adapted from the 2011 Compendium of Physical Activities
 * (Ainsworth et al.). They are rounded / merged from memory and some entries
 * (HIIT, dancing, climbing gym, etc.) are estimates. CHECK AGAINST
 * https://pacompendium.com BEFORE RELEASE.
 *
 * 1 MET = resting energy expenditure (about 1 kcal per kg per hour). Use
 * `exerciseKcalNetMet(met, kg, minutes)` from energy.ts to convert to kcal.
 */

export interface MetActivity {
  /** Stable UPPER_SNAKE code (used as DB key). */
  code: string;
  name: string;
  /** Metabolic equivalent (multiples of resting energy expenditure). */
  met: number;
  category: string;
}

export const EXERCISE_CATEGORIES = [
  'Walking & hiking',
  'Running',
  'Cycling',
  'Water',
  'Gym & cardio machines',
  'Strength & conditioning',
  'Mind & body',
  'Dance',
  'Team sports',
  'Racket sports',
  'Combat sports',
  'Winter sports',
  'Outdoor & recreation',
  'Home & garden',
] as const;

export const MET_ACTIVITIES: readonly MetActivity[] = [
  // Walking & hiking
  { code: 'WALK_SLOW', name: 'Walking, slow (2.0 mph / 3.2 km/h)', met: 2.8, category: 'Walking & hiking' },
  { code: 'WALK_NORMAL', name: 'Walking, normal pace (3.0 mph / 4.8 km/h)', met: 3.5, category: 'Walking & hiking' },
  { code: 'WALK_BRISK', name: 'Walking, brisk (3.5 mph / 5.6 km/h)', met: 4.3, category: 'Walking & hiking' },
  { code: 'WALK_VERY_BRISK', name: 'Walking, very brisk (4.0 mph / 6.4 km/h)', met: 5.0, category: 'Walking & hiking' },
  { code: 'WALK_RACE', name: 'Walking, race pace (4.5 mph / 7.2 km/h)', met: 7.0, category: 'Walking & hiking' },
  { code: 'WALK_UPHILL', name: 'Walking, uphill (3.5 mph, 1-5% grade)', met: 5.3, category: 'Walking & hiking' },
  { code: 'WALK_DOG', name: 'Walking the dog', met: 3.0, category: 'Walking & hiking' },
  { code: 'HIKING', name: 'Hiking, cross country', met: 6.0, category: 'Walking & hiking' },
  { code: 'BACKPACKING', name: 'Backpacking, with load', met: 7.0, category: 'Walking & hiking' },
  { code: 'NORDIC_WALKING', name: 'Nordic walking', met: 4.8, category: 'Walking & hiking' },

  // Running
  { code: 'JOG_GENERAL', name: 'Jogging, general', met: 7.0, category: 'Running' },
  { code: 'RUN_5_MPH', name: 'Running, 5 mph (8 km/h, 12 min/mile)', met: 8.3, category: 'Running' },
  { code: 'RUN_6_MPH', name: 'Running, 6 mph (9.7 km/h, 10 min/mile)', met: 9.8, category: 'Running' },
  { code: 'RUN_7_5_MPH', name: 'Running, 7.5 mph (12 km/h, 8 min/mile)', met: 11.5, category: 'Running' },
  { code: 'RUN_9_MPH', name: 'Running, 9 mph (14.5 km/h, 6:40 min/mile)', met: 12.8, category: 'Running' },
  { code: 'RUN_10_MPH', name: 'Running, 10 mph (16 km/h, 6 min/mile)', met: 14.5, category: 'Running' },
  { code: 'RUN_TREADMILL', name: 'Running, treadmill, general', met: 9.0, category: 'Running' },
  { code: 'RUN_TRAIL', name: 'Running, cross country / trail', met: 9.0, category: 'Running' },

  // Cycling
  { code: 'CYCLE_LEISURE', name: 'Cycling, leisure (<10 mph / 16 km/h)', met: 4.0, category: 'Cycling' },
  { code: 'CYCLE_LIGHT', name: 'Cycling, light effort (10-12 mph)', met: 6.0, category: 'Cycling' },
  { code: 'CYCLE_MODERATE', name: 'Cycling, moderate effort (12-14 mph)', met: 8.0, category: 'Cycling' },
  { code: 'CYCLE_VIGOROUS', name: 'Cycling, vigorous effort (14-16 mph)', met: 10.0, category: 'Cycling' },
  { code: 'CYCLE_RACING', name: 'Cycling, racing / very fast (16-19 mph)', met: 12.0, category: 'Cycling' },
  { code: 'CYCLE_COMMUTE', name: 'Cycling, to work or errands', met: 6.8, category: 'Cycling' },
  { code: 'CYCLE_MOUNTAIN', name: 'Mountain biking', met: 8.5, category: 'Cycling' },
  { code: 'CYCLE_STATIONARY_LIGHT', name: 'Stationary bike, light (50 W)', met: 3.5, category: 'Cycling' },
  { code: 'CYCLE_STATIONARY_MODERATE', name: 'Stationary bike, moderate (100 W)', met: 6.8, category: 'Cycling' },
  { code: 'CYCLE_STATIONARY_VIGOROUS', name: 'Stationary bike, vigorous (150 W)', met: 8.8, category: 'Cycling' },

  // Water
  { code: 'SWIM_LAPS_LIGHT', name: 'Swimming laps, light / moderate effort', met: 5.8, category: 'Water' },
  { code: 'SWIM_LAPS_VIGOROUS', name: 'Swimming laps, vigorous effort', met: 9.8, category: 'Water' },
  { code: 'SWIM_LEISURE', name: 'Swimming, leisurely', met: 6.0, category: 'Water' },
  { code: 'WATER_AEROBICS', name: 'Water aerobics', met: 5.3, category: 'Water' },
  { code: 'KAYAK', name: 'Kayaking, moderate effort', met: 5.0, category: 'Water' },
  { code: 'ROW_OUTDOOR', name: 'Rowing / canoeing, moderate effort', met: 4.8, category: 'Water' },
  { code: 'PADDLEBOARD', name: 'Stand-up paddleboarding', met: 6.0, category: 'Water' },
  { code: 'SURFING', name: 'Surfing', met: 3.0, category: 'Water' },

  // Gym & cardio machines
  { code: 'ROW_MACHINE_LIGHT', name: 'Rowing machine, light (50 W)', met: 4.8, category: 'Gym & cardio machines' },
  { code: 'ROW_MACHINE_MODERATE', name: 'Rowing machine, moderate (100 W)', met: 7.0, category: 'Gym & cardio machines' },
  { code: 'ROW_MACHINE_VIGOROUS', name: 'Rowing machine, vigorous (150 W)', met: 8.5, category: 'Gym & cardio machines' },
  { code: 'ELLIPTICAL', name: 'Elliptical trainer, general', met: 5.0, category: 'Gym & cardio machines' },
  { code: 'STAIR_MACHINE', name: 'Stair-climbing machine, general', met: 9.0, category: 'Gym & cardio machines' },
  { code: 'STAIR_CLIMBING_SLOW', name: 'Climbing stairs, slow pace', met: 4.0, category: 'Gym & cardio machines' },
  { code: 'STAIR_CLIMBING_FAST', name: 'Climbing stairs, fast pace', met: 8.8, category: 'Gym & cardio machines' },
  { code: 'AEROBICS', name: 'Aerobics, general', met: 7.3, category: 'Gym & cardio machines' },
  { code: 'AEROBICS_LOW_IMPACT', name: 'Aerobics, low impact', met: 5.0, category: 'Gym & cardio machines' },

  // Strength & conditioning
  { code: 'WEIGHTS_LIGHT', name: 'Weight training, light / moderate effort', met: 3.5, category: 'Strength & conditioning' },
  { code: 'WEIGHTS_VIGOROUS', name: 'Weight training, vigorous effort', met: 6.0, category: 'Strength & conditioning' },
  { code: 'CALISTHENICS_LIGHT', name: 'Bodyweight exercise, light / moderate', met: 3.8, category: 'Strength & conditioning' },
  { code: 'CALISTHENICS_VIGOROUS', name: 'Calisthenics, vigorous (push-ups, pull-ups, sit-ups)', met: 8.0, category: 'Strength & conditioning' },
  { code: 'HIIT', name: 'High-intensity interval training (HIIT)', met: 8.0, category: 'Strength & conditioning' }, // estimate
  { code: 'CIRCUIT_MODERATE', name: 'Circuit training, moderate effort', met: 4.3, category: 'Strength & conditioning' },
  { code: 'CIRCUIT_VIGOROUS', name: 'Circuit training, vigorous effort', met: 8.0, category: 'Strength & conditioning' },
  { code: 'JUMP_ROPE_SLOW', name: 'Jumping rope, slow', met: 8.8, category: 'Strength & conditioning' },
  { code: 'JUMP_ROPE_MODERATE', name: 'Jumping rope, moderate', met: 11.8, category: 'Strength & conditioning' },
  { code: 'JUMP_ROPE_FAST', name: 'Jumping rope, fast', met: 12.3, category: 'Strength & conditioning' },

  // Mind & body
  { code: 'YOGA_HATHA', name: 'Yoga, Hatha', met: 2.5, category: 'Mind & body' },
  { code: 'YOGA_POWER', name: 'Yoga, power / vinyasa', met: 4.0, category: 'Mind & body' },
  { code: 'PILATES', name: 'Pilates', met: 3.0, category: 'Mind & body' },
  { code: 'STRETCHING', name: 'Stretching, mild', met: 2.3, category: 'Mind & body' },
  { code: 'TAI_CHI', name: 'Tai chi / qigong', met: 3.0, category: 'Mind & body' },

  // Dance
  { code: 'DANCE_BALLROOM_SLOW', name: 'Dancing, ballroom, slow', met: 3.0, category: 'Dance' },
  { code: 'DANCE_BALLROOM_FAST', name: 'Dancing, ballroom, fast', met: 5.5, category: 'Dance' },
  { code: 'DANCE_BALLET_MODERN', name: 'Dancing, ballet / modern / jazz / tap', met: 4.8, category: 'Dance' },
  { code: 'DANCE_AEROBIC', name: 'Dancing, aerobic / Zumba / disco', met: 7.3, category: 'Dance' },

  // Team sports
  { code: 'BASKETBALL_SHOOTING', name: 'Basketball, shooting baskets', met: 4.5, category: 'Team sports' },
  { code: 'BASKETBALL_GAME', name: 'Basketball, game', met: 8.0, category: 'Team sports' },
  { code: 'SOCCER_CASUAL', name: 'Soccer, casual', met: 7.0, category: 'Team sports' },
  { code: 'SOCCER_COMPETITIVE', name: 'Soccer, competitive', met: 10.0, category: 'Team sports' },
  { code: 'FOOTBALL_TOUCH', name: 'American football, touch / flag', met: 8.0, category: 'Team sports' },
  { code: 'FOOTBALL_COMPETITIVE', name: 'American football, competitive', met: 9.0, category: 'Team sports' },
  { code: 'VOLLEYBALL_CASUAL', name: 'Volleyball, non-competitive', met: 3.0, category: 'Team sports' },
  { code: 'VOLLEYBALL_COMPETITIVE', name: 'Volleyball, competitive (gym)', met: 4.0, category: 'Team sports' },
  { code: 'VOLLEYBALL_BEACH', name: 'Volleyball, beach', met: 8.0, category: 'Team sports' },
  { code: 'HANDBALL', name: 'Handball, team', met: 8.0, category: 'Team sports' },
  { code: 'RUGBY', name: 'Rugby, competitive', met: 8.3, category: 'Team sports' },
  { code: 'ICE_HOCKEY', name: 'Ice hockey', met: 8.0, category: 'Team sports' },
  { code: 'BASEBALL_SOFTBALL', name: 'Baseball / softball', met: 5.0, category: 'Team sports' },

  // Racket sports
  { code: 'TENNIS_DOUBLES', name: 'Tennis, doubles', met: 6.0, category: 'Racket sports' },
  { code: 'TENNIS_SINGLES', name: 'Tennis, singles', met: 8.0, category: 'Racket sports' },
  { code: 'BADMINTON', name: 'Badminton, social', met: 5.5, category: 'Racket sports' },
  { code: 'TABLE_TENNIS', name: 'Table tennis', met: 4.0, category: 'Racket sports' },
  { code: 'SQUASH', name: 'Squash', met: 7.3, category: 'Racket sports' },
  { code: 'RACQUETBALL', name: 'Racquetball, casual', met: 7.0, category: 'Racket sports' },

  // Combat sports
  { code: 'MARTIAL_ARTS', name: 'Martial arts (judo, karate, taekwondo, kickboxing)', met: 10.3, category: 'Combat sports' },
  { code: 'BOXING_BAG', name: 'Boxing, punching bag', met: 5.5, category: 'Combat sports' },
  { code: 'BOXING_SPARRING', name: 'Boxing, sparring', met: 7.8, category: 'Combat sports' },
  { code: 'BOXING_RING', name: 'Boxing, in the ring', met: 12.8, category: 'Combat sports' },
  { code: 'WRESTLING', name: 'Wrestling', met: 6.0, category: 'Combat sports' },

  // Winter sports
  { code: 'SKI_DOWNHILL', name: 'Skiing, downhill, moderate effort', met: 5.3, category: 'Winter sports' },
  { code: 'SKI_DOWNHILL_VIGOROUS', name: 'Skiing, downhill, vigorous effort', met: 8.0, category: 'Winter sports' },
  { code: 'SKI_CROSS_COUNTRY_SLOW', name: 'Cross-country skiing, slow', met: 6.8, category: 'Winter sports' },
  { code: 'SKI_CROSS_COUNTRY_MODERATE', name: 'Cross-country skiing, moderate', met: 9.0, category: 'Winter sports' },
  { code: 'SNOWBOARDING', name: 'Snowboarding, moderate', met: 5.3, category: 'Winter sports' },
  { code: 'ICE_SKATING', name: 'Ice skating, general', met: 7.0, category: 'Winter sports' },

  // Outdoor & recreation
  { code: 'CLIMBING_ROCK', name: 'Rock climbing, ascending', met: 8.0, category: 'Outdoor & recreation' },
  { code: 'CLIMBING_INDOOR', name: 'Climbing, indoor gym / bouldering', met: 7.5, category: 'Outdoor & recreation' }, // estimate
  { code: 'INLINE_SKATING', name: 'Inline / roller skating', met: 7.5, category: 'Outdoor & recreation' },
  { code: 'GOLF_WALKING', name: 'Golf, walking and carrying clubs', met: 4.3, category: 'Outdoor & recreation' },
  { code: 'GOLF_CART', name: 'Golf, using a cart', met: 3.5, category: 'Outdoor & recreation' },
  { code: 'BOWLING', name: 'Bowling', met: 3.0, category: 'Outdoor & recreation' },
  { code: 'FRISBEE', name: 'Frisbee, casual', met: 3.0, category: 'Outdoor & recreation' },
  { code: 'HORSEBACK_RIDING', name: 'Horseback riding, general', met: 5.5, category: 'Outdoor & recreation' },
  { code: 'PLAY_WITH_KIDS', name: 'Playing with children, moderate effort', met: 4.0, category: 'Outdoor & recreation' },

  // Home & garden
  { code: 'HOUSEWORK_LIGHT', name: 'Housework, light (dusting, tidying)', met: 2.3, category: 'Home & garden' },
  { code: 'HOUSEWORK_VACUUM', name: 'Vacuuming', met: 3.3, category: 'Home & garden' },
  { code: 'HOUSEWORK_MOPPING', name: 'Mopping / sweeping', met: 3.5, category: 'Home & garden' },
  { code: 'HOUSEWORK_HEAVY', name: 'Housework, heavy cleaning (windows, garage)', met: 4.0, category: 'Home & garden' },
  { code: 'COOKING', name: 'Cooking / food preparation', met: 1.8, category: 'Home & garden' },
  { code: 'LAUNDRY', name: 'Laundry, folding and putting away', met: 2.3, category: 'Home & garden' },
  { code: 'MOVING_BOXES', name: 'Moving, carrying boxes / furniture', met: 5.8, category: 'Home & garden' },
  { code: 'GARDENING_GENERAL', name: 'Gardening, general', met: 3.8, category: 'Home & garden' },
  { code: 'GARDENING_WEEDING', name: 'Gardening, weeding / cultivating', met: 4.5, category: 'Home & garden' },
  { code: 'GARDENING_DIGGING', name: 'Gardening, digging / spading', met: 5.0, category: 'Home & garden' },
  { code: 'RAKING_LEAVES', name: 'Raking lawn / leaves', met: 4.3, category: 'Home & garden' },
  { code: 'MOWING_LAWN', name: 'Mowing lawn, walking, power mower', met: 5.5, category: 'Home & garden' },
];

/** Lookup by activity code. */
export const MET_ACTIVITY_BY_CODE: ReadonlyMap<string, MetActivity> = new Map(
  MET_ACTIVITIES.map((a) => [a.code, a]),
);

/** Case-insensitive substring search over activity names (for pickers). */
export function searchActivities(query: string, limit = 20): MetActivity[] {
  const q = query.trim().toLowerCase();
  if (q === '') return MET_ACTIVITIES.slice(0, limit);
  return MET_ACTIVITIES.filter(
    (a) => a.name.toLowerCase().includes(q) || a.category.toLowerCase().includes(q),
  ).slice(0, limit);
}
