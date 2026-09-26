// 技法合成与金属音色用例
import { describe, expect, it } from 'vitest';
import { synthesizeHit } from '../src/lib/audio';
import type { Instrument } from '../src/types';

class FakeAudioParam {
  value = 0;
  sets: { time: number; value: number }[] = [];
  ramps: { time: number; value: number }[] = [];

  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.sets.push({ value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number) {
    this.ramps.push({ value, time });
  }
}

class FakeNode {
  connect(node: unknown) {
    return node;
  }

  disconnect() {}
}

class FakeOscillator extends FakeNode {
  type = '';
  frequency = new FakeAudioParam();
  starts: number[] = [];
  stops: number[] = [];

  start(time: number) {
    this.starts.push(time);
  }

  stop(time: number) {
    this.stops.push(time);
  }
}

class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
}

class FakeBufferSource extends FakeNode {
  buffer: AudioBuffer | null = null;
  starts: { time: number; offset: number; duration?: number }[] = [];

  start(time: number, offset = 0, duration?: number) {
    this.starts.push({ time, offset, duration });
  }
}

class FakeAudioContext {
  sampleRate = 44100;
  gainNodes: GainNode[] = [];
  oscillators: FakeOscillator[] = [];
  filters: FakeFilter[] = [];
  sources: FakeBufferSource[] = [];

  createGain() {
    const node = Object.assign(new FakeNode(), { gain: new FakeAudioParam() }) as unknown as GainNode;
    this.gainNodes.push(node);
    return node;
  }

  createOscillator() {
    const node = new FakeOscillator();
    this.oscillators.push(node);
    return node as unknown as OscillatorNode;
  }

  createBiquadFilter() {
    const node = new FakeFilter();
    this.filters.push(node);
    return node as unknown as BiquadFilterNode;
  }

  createBufferSource() {
    const node = new FakeBufferSource();
    this.sources.push(node);
    return node as unknown as AudioBufferSourceNode;
  }

  createBuffer(_channels: number, length: number, _sampleRate: number) {
    return {
      sampleRate: this.sampleRate,
      length,
      getChannelData: () => new Float32Array(length),
    } as unknown as AudioBuffer;
  }
}

const gu: Instrument = {
  id: 'gu',
  name: '鼓',
  glyphs: ['咚', '八', '哒'],
  synth: { type: 'drum', baseHz: 82, decay: 0.22, noise: true },
};

const daluo: Instrument = {
  id: 'daluo',
  name: '大锣',
  glyphs: ['哐'],
  synth: { type: 'metal', baseHz: 196, decay: 1.4, noise: true },
};

describe('技法发声', () => {
  it('双打在 30ms 后补第二声', () => {
    const ctx = new FakeAudioContext();
    synthesizeHit(ctx as unknown as BaseAudioContext, new FakeNode() as unknown as AudioNode, gu, {
      instrumentId: 'gu',
      velocity: 2,
      glyph: '八',
      tech: ['flam'],
    }, 10);

    const startTimes = ctx.oscillators.flatMap((o) => o.starts);
    expect(startTimes).toEqual([10, 10.03]);
  });

  it('闷击把衰减时间压到常规的 0.3 倍', () => {
    const ctx = new FakeAudioContext();
    synthesizeHit(ctx as unknown as BaseAudioContext, new FakeNode() as unknown as AudioNode, gu, {
      instrumentId: 'gu',
      velocity: 2,
      glyph: '哒',
      tech: ['mute'],
    }, 10);

    const envelope = ctx.gainNodes[0].gain as unknown as FakeAudioParam;
    expect(envelope.ramps).toHaveLength(1);
    expect(envelope.ramps[0].time).toBeCloseTo(10 + 0.22 * 0.3, 9);
  });

  it('滚奏按均匀间隔补击到该字时值结束', () => {
    const ctx = new FakeAudioContext();
    const duration = 0.2;
    synthesizeHit(ctx as unknown as BaseAudioContext, new FakeNode() as unknown as AudioNode, gu, {
      instrumentId: 'gu',
      velocity: 2,
      glyph: '台',
      tech: ['roll'],
    }, 10, duration);

    const startTimes = ctx.oscillators.flatMap((o) => o.starts);
    expect(startTimes).toHaveLength(5);
    expect(startTimes[0]).toBe(10);
    expect(startTimes[startTimes.length - 1]).toBeCloseTo(10.2, 9);
    expect(startTimes[1] - startTimes[0]).toBeCloseTo(0.05, 9);
  });
});

describe('金属音色', () => {
  it('大锣同时包含失谐泛音和金属噪声', () => {
    const ctx = new FakeAudioContext();
    synthesizeHit(ctx as unknown as BaseAudioContext, new FakeNode() as unknown as AudioNode, daluo, {
      instrumentId: 'daluo',
      velocity: 2,
      glyph: '哐',
    }, 10);

    const frequencies = ctx.oscillators.map((o) => o.frequency.value).sort((a, b) => a - b);
    expect(frequencies).toEqual([196, 196 * 1.47, 196 * 2.13, 196 * 2.92, 196 * 4.06]);
    expect(ctx.filters.map((f) => f.type)).toContain('bandpass');
    expect(ctx.filters.map((f) => f.type)).toContain('highpass');
    expect(ctx.sources.length).toBeGreaterThanOrEqual(2);
  });

  it('小锣也保留噪声成分，不退化成单一长音', () => {
    const xiaoluo: Instrument = {
      id: 'xiaoluo',
      name: '小锣',
      glyphs: ['才'],
      synth: { type: 'metal', baseHz: 523, decay: 0.45, noise: true },
    };
    const ctx = new FakeAudioContext();
    synthesizeHit(ctx as unknown as BaseAudioContext, new FakeNode() as unknown as AudioNode, xiaoluo, {
      instrumentId: 'xiaoluo',
      velocity: 2,
      glyph: '才',
    }, 10);

    expect(ctx.oscillators.length).toBeGreaterThan(1);
    expect(ctx.sources.length).toBeGreaterThanOrEqual(2);
    expect(ctx.filters.map((f) => f.type)).toContain('bandpass');
  });
});
