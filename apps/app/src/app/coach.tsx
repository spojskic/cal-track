import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { parseCoachTopic, topicKey } from '@/ai/coach-topic';
import { CoachScreen } from '@/components/coach/CoachScreen';

/**
 * `/coach`: a new chat. The AI gate is checked inside CoachScreen; with the gate closed it shows how to connect.
 * `/coach?topicKind=workout&topicId=<exercise_entries uuid>`: a chat ABOUT that workout. The conversation that already
 * has this topic is resumed; otherwise the first message starts one. Nothing is sent until the user presses Send.
 */
export default function CoachRoute() {
  const params = useLocalSearchParams<{ topicKind?: string | string[]; topicId?: string | string[] }>();
  const kind = Array.isArray(params.topicKind) ? params.topicKind[0] : params.topicKind;
  const id = Array.isArray(params.topicId) ? params.topicId[0] : params.topicId;
  const topic = useMemo(() => parseCoachTopic({ topicKind: kind, topicId: id }), [kind, id]);
  // a different topic is a different conversation: remount instead of morphing the old one
  return <CoachScreen key={topicKey(topic)} topic={topic} />;
}
