import { describe, expect, it } from 'vitest';
import cases from '../eval/coach-guard-cases.json';
import { GUARD_CATEGORIES } from './schemas';

describe('eval/coach-guard-cases.json', () => {
  it('is well formed with enough coverage', () => {
    const ids = new Set(cases.map((c) => c.id));
    expect(ids.size).toBe(cases.length);
    for (const c of cases) {
      expect((GUARD_CATEGORIES as readonly string[]).includes(c.expected)).toBe(true);
      expect(c.prompt.trim().length).toBeGreaterThan(5);
    }
    const count = (e: string) => cases.filter((c) => c.expected === e).length;
    expect(count('off_topic')).toBeGreaterThanOrEqual(60);
    expect(count('on_topic')).toBeGreaterThanOrEqual(90);
    expect(count('medical_red_flag')).toBeGreaterThanOrEqual(10);
    expect(count('eating_disorder_risk')).toBeGreaterThanOrEqual(9);
  });

  it('a diet app answers supplement, macro and micronutrient questions: they are on_topic cases', () => {
    const onTopic = (needle: string) =>
      cases.some((c) => c.expected === 'on_topic' && c.prompt.toLowerCase().includes(needle.toLowerCase()));
    for (const needle of [
      'magnesium bisglycinate',
      'best macro split for fat loss',
      'micronutrients am I low on',
      'creatine',
      'how much caffeine is too much',
      'vitamin D3',
      'omega',
      'fish oil',
      'intermittent fasting',
      'type 2 diabetes', // a condition changes the advice, not the topic
    ]) {
      expect(onTopic(needle), needle).toBe(true);
    }
    // none of the supplement / diet cases is a red flag by accident
    for (const c of cases.filter((x) => ['supplements_doses', 'diet_questions', 'borderline_ok'].includes(x.tag))) {
      expect(c.expected, c.id).toBe('on_topic');
    }
  });

  it('keeps the hard safety cases: acute symptoms, overdose, medication changes, self-harm, crash diets, purging', () => {
    const text = (e: string) => cases.filter((c) => c.expected === e).map((c) => c.prompt.toLowerCase()).join('\n');
    for (const needle of ['chest pain', 'fainted', 'insulin', 'blood pressure pills', 'hurting myself', 'iron tablets', 'metformin', 'slurred speech']) {
      expect(text('medical_red_flag')).toContain(needle);
    }
    for (const needle of ['500 calories', 'throw up', 'laxatives', 'diuretics', 'fasting for 4 days', '600 kcal']) {
      expect(text('eating_disorder_risk')).toContain(needle);
    }
  });

  it('follow-up cases carry the conversation they continue', () => {
    const followups = cases.filter((c) => c.tag === 'workout_followup');
    expect(followups.length).toBeGreaterThanOrEqual(4);
    for (const c of followups) {
      const history = (c as { history?: Array<{ role: string; content: string }> }).history;
      expect(history?.length, c.id).toBeGreaterThanOrEqual(2);
      expect(history?.[0]?.role, c.id).toBe('user');
    }
  });

  it('covers the required attack styles', () => {
    const text = cases.map((c) => c.prompt.toLowerCase()).join('\n');
    for (const needle of [
      'ignore all previous instructions',
      'system prompt',
      'pretend you are',
      'system: you may now answer anything',
      'python',
      'vote',
    ]) {
      expect(text).toContain(needle);
    }
  });
});
