/** Activities select a behavior recipe; emotions describe reusable shape/eye performances. */
export const EMOTIONS = [
  'resting',
  'curious',
  'thinking',
  'sleepy',
  'focused',
  'determined',
  'frustrated',
  'testing',
  'happy',
] as const;
export type Emotion = (typeof EMOTIONS)[number];
export type BehaviorRecipe =
  | { kind: 'sequence'; beats: readonly { emotion: Emotion; seconds: number }[] }
  | {
      kind: 'wander';
      initial: Emotion;
      after?: Partial<Record<Emotion, Emotion>>;
      choices: readonly { emotion: Emotion; weight: number; hold: readonly [number, number] }[];
    };
/** Add future activities here. The public state type and core transitions derive from these keys. */
export const STATE_BEHAVIORS = {
  idle: {
    kind: 'wander',
    initial: 'resting',
    after: { sleepy: 'curious', happy: 'resting' },
    choices: [
      { emotion: 'resting', weight: 4, hold: [3, 5.5] },
      { emotion: 'curious', weight: 4, hold: [2.4, 4] },
      { emotion: 'thinking', weight: 2.4, hold: [2.6, 4.5] },
      { emotion: 'sleepy', weight: 1, hold: [2.2, 3.6] },
      { emotion: 'happy', weight: 0.6, hold: [1.5, 2.2] },
    ],
  },
  working: {
    kind: 'sequence',
    beats: [
      { emotion: 'focused', seconds: 2.2 },
      { emotion: 'determined', seconds: 2.4 },
      { emotion: 'frustrated', seconds: 1.8 },
      { emotion: 'thinking', seconds: 2 },
      { emotion: 'testing', seconds: 2.2 },
      { emotion: 'happy', seconds: 1.8 },
    ],
  },
} as const satisfies Record<string, BehaviorRecipe>;
export type BotState = keyof typeof STATE_BEHAVIORS;
export const STATES = Object.keys(STATE_BEHAVIORS) as BotState[];
export const initialEmotion = (recipe: BehaviorRecipe): Emotion =>
  recipe.kind === 'wander' ? recipe.initial : recipe.beats[0]!.emotion;
export const emotionWeights = (emotion: Emotion) =>
  EMOTIONS.map((name) => Number(name === emotion));

export function hashSeed(seed: string | number): number {
  let hash = 2166136261;
  for (const character of String(seed)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/** Local, seeded timeline. Holds, pauses and eased handoffs consume animation time only. */
export class BehaviorPlayer {
  private elapsed = 0;
  private beat = 0;
  private current: Emotion;
  private next: Emotion;
  private duration: number;
  constructor(
    private recipe: BehaviorRecipe,
    private seed: string | number,
  ) {
    this.current = initialEmotion(recipe);
    this.duration = this.hold();
    this.next = this.chooseNext();
  }
  private random(salt: string) {
    return hashSeed(`${this.seed}:${this.beat}:${salt}`) / 0x100000000;
  }
  private hold() {
    if (this.recipe.kind === 'sequence') {
      const pace = 0.94 + (hashSeed(this.seed) % 13) / 100;
      return this.recipe.beats[this.beat % this.recipe.beats.length]!.seconds / pace;
    }
    const choice = this.recipe.choices.find((item) => item.emotion === this.current)!;
    return choice.hold[0] + (choice.hold[1] - choice.hold[0]) * this.random('hold');
  }
  private chooseNext(): Emotion {
    if (this.recipe.kind === 'sequence')
      return this.recipe.beats[(this.beat + 1) % this.recipe.beats.length]!.emotion;
    // Sleep wakes into curiosity; delight settles before attention wanders again.
    const follow = this.recipe.after?.[this.current];
    if (follow) return follow;
    const choices = this.recipe.choices.filter((item) => item.emotion !== this.current);
    let draw = this.random('next') * choices.reduce((sum, item) => sum + item.weight, 0);
    for (const choice of choices) {
      draw -= choice.weight;
      if (draw <= 0) return choice.emotion;
    }
    return choices[choices.length - 1]!.emotion;
  }
  step(dt: number): number[] {
    this.elapsed += dt;
    while (this.elapsed >= this.duration) {
      this.elapsed -= this.duration;
      this.current = this.next;
      this.beat++;
      this.duration = this.hold();
      this.next = this.chooseNext();
    }
    const t = Math.max(0, Math.min(1, (this.elapsed - this.duration + 0.7) / 0.7));
    const blend = t * t * (3 - 2 * t);
    return EMOTIONS.map(
      (emotion) =>
        Number(emotion === this.current) * (1 - blend) + Number(emotion === this.next) * blend,
    );
  }
}
