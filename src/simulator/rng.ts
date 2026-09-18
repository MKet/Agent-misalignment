import type { RNGInterface } from '../types/actions';

/**
 * Mulberry32 seeded PRNG.
 * Produces deterministic pseudo-random sequences from a 32-bit integer seed.
 * This ensures reproducibility: the same seed + scenario configuration
 * produces an identical sequence of random choices.
 */
export class SeededRNG implements RNGInterface {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Returns a float in [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
    z = (z ^ (z + Math.imul(z ^ (z >>> 7), z | 61))) >>> 0;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max] inclusive */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Returns true with given probability (default 0.5) */
  nextBool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** Picks a uniformly random element from an array */
  pick<T>(arr: T[]): T {
    if (arr.length === 0) throw new Error('Cannot pick from empty array');
    return arr[Math.floor(this.next() * arr.length)];
  }
}
