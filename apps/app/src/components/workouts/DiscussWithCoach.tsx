import { router } from 'expo-router';

import { useAiGate } from '@/ai/use-ai-gate';
import { Button } from '@/components/ui';

import { discussWorkoutHref } from './links';

/**
 * "Discuss with coach": opens the coach on this workout (`/coach?topicKind=workout&topicId=<id>`). Hidden while the AI gate is
 * closed (no OpenRouter key, key not checked yet, no suitable model), exactly like the Coach entry in More.
 */
export function DiscussWithCoach({ workoutId }: { workoutId: string }) {
  const ai = useAiGate();
  if (!ai.enabled) return null;
  return <Button label="Discuss with coach" onPress={() => router.push(discussWorkoutHref(workoutId))} />;
}
