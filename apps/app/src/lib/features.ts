// Build-time feature flags (Expo inlines EXPO_PUBLIC_* at build time, so changing one needs a rebuild/restart).

/**
 * "Search online" (Open Food Facts / USDA branded products) and the remote half of the barcode scan need the Supabase
 * Edge Functions `online-search` and `barcode-lookup` to be deployed (docs: supabase/functions/README.md).
 * Off by default: without them the app only uses the foods in your own database, and an unknown barcode offers
 * "Create custom food" right away. Set EXPO_PUBLIC_ONLINE_LOOKUP_ENABLED=true when the functions work.
 */
export const ONLINE_LOOKUP_ENABLED: boolean = process.env.EXPO_PUBLIC_ONLINE_LOOKUP_ENABLED === 'true';
