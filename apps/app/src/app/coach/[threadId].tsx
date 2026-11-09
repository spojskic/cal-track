import { Redirect, useLocalSearchParams, type Href } from 'expo-router';

import { CoachScreen } from '@/components/coach/CoachScreen';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/coach/[threadId]`: an existing conversation. Anything that is not a thread id goes to a new chat. */
export default function CoachThreadRoute() {
  const params = useLocalSearchParams<{ threadId?: string | string[] }>();
  const raw = Array.isArray(params.threadId) ? params.threadId[0] : params.threadId;
  if (!raw || !UUID.test(raw)) return <Redirect href={'/coach' as unknown as Href} />;
  return <CoachScreen key={raw} initialThreadId={raw} />;
}
