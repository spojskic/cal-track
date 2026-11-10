// Build-time feature flags (Expo inlines EXPO_PUBLIC_* at build time, so changing one needs a rebuild/restart).

/**
 * "Search online" (Open Food Facts / USDA branded products) and the remote half of the barcode scan need the Supabase
 * Edge Functions `online-search` and `barcode-lookup` to be deployed (supabase/functions/README.md). On by default;
 * set EXPO_PUBLIC_ONLINE_LOOKUP_ENABLED=false to hide "Search online" and make an unknown barcode go straight to
 * "Create custom food" (for example while the functions are not deployed).
 */
export const ONLINE_LOOKUP_ENABLED: boolean = process.env.EXPO_PUBLIC_ONLINE_LOOKUP_ENABLED !== 'false';
