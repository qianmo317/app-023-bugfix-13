// Web Audio 合成与精确调度
// 关键点：用 AudioContext.currentTime 预排（lookahead scheduler），不用 setTimeout 逐拍触发，
// 否则节奏类应用会有明显抖动。时间计算全部基于整数格，无浮点累积。
import {
  TICKS_PER_BEAT,
  VELOCITY_GAIN,
  type Bar,
  type Hit,
  type Instrument,
  type ScheduleEvent,
  type Score,
  type Tech,
} from '../types';
import { barTicks, stepOffsets } from './grid';

/** BPM → 每格秒数（整数格 × 固定秒/格，无累积漂移） */
export function tickSeconds(bpm: number): number {
  return 60 / bpm / TICKS_PER_BEAT;
}

/**
 * 纯函数：把谱面展开为绝对时间事件序列（音频与视觉共用同一时间源）。
 * fromTick/toTick 为全曲绝对格区间（含头不含尾），startTime 为 t0。
 * 散板（freeMeter）：按等格时长 × stretch 近似播放（UI 明确标注为近似）。
 */
export function computeEvents(
  bars: Bar[],
  bpm: number,
  freeMeter: boolean,
  instruments: Instrument[],
  fromTick: number,
  toTick: number,
  startTime: number,
  stretch = 1,
): ScheduleEvent[] {
  const instMap = new Map(instruments.map((i) => [i.id, i]));
  const per = tickSeconds(bpm) * (freeMeter ? stretch : 1);
  const events: ScheduleEvent[] = [];
  let barStart = 0; // 全曲绝对格
  for (const bar of bars) {
    const offs = stepOffsets(bar);
    bar.steps.forEach((step, si) => {
      const absOff = barStart + offs[si];
      if (absOff < fromTick || absOff >= toTick) return;
      if (step.rest || step.hits.length === 0) return;
      for (const hit of step.hits) {
        const inst = instMap.get(hit.instrumentId);
        if (!inst) continue;
        events.push({
          time: startTime + absOff * per,
          barIndex: bar.index,
          offset: offs[si],
          instrumentId: hit.instrumentId,
          hit,
          glyph: hit.glyph ?? inst.glyphs[0],
          durationTicks: step.beats,
          durationSeconds: step.beats * per,
        });
      }
    });
    barStart += barTicks(bar.beatsPerBar);
  }
  return events.sort((a, b) => a.time - b.time);
}

/** 循环区间事件：把 [fromTick,toTick) 的段落重复 loopCount 遍 */
export function computeLoopEvents(
  score: Score,
  fromTick: number,
  toTick: number,
  startTime: number,
  loopCount: number,
  stretch = 1,
): ScheduleEvent[] {
  const span = toTick - fromTick;
  const per = tickSeconds(score.bpm) * (score.freeMeter ? stretch : 1);
  const out: ScheduleEvent[] = [];
  for (let li = 0; li < loopCount; li++) {
    const t0 = startTime + li * span * per;
    for (const ev of computeEvents(score.bars, score.bpm, score.freeMeter, score.instruments, fromTick, toTick, t0, stretch)) {
      out.push(ev);
    }
  }
  return out;
}

// ---------- 合成音（无采样：OscillatorNode + GainNode 包络 + 噪声） ----------

let noiseBufferCache: AudioBuffer | null = null;
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBufferCache && noiseBufferCache.sampleRate === ctx.sampleRate) return noiseBufferCache;
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBufferCache = buf;
  return buf;
}

const FLAM_DELAY_S = 0.03;
const ROLL_INTERVAL_S = 0.055;
const MUTE_DECAY_FACTOR = 0.3;

export interface SynthVoice {
  endsAt: number;
  stop(): void;
}

/** 单击合成：鼓=低频正弦衰减+短噪声、锣/钹=金属噪声+失谐泛音、木=短脉冲 */
export function synthesizeHit(
  ctx: BaseAudioContext,
  dest: AudioNode,
  inst: Instrument,
  hit: Hit,
  time: number,
  durationSeconds = 0.3,
): SynthVoice[] {
  const g0 = VELOCITY_GAIN[hit.velocity];
  const glyph = hit.glyph ?? inst.glyphs[0];
  // 手工挂上的 hit.tech 优先；旧谱没有 tech 时仍从拟音字反查默认打法。
  const techs: Tech[] = hit.tech ?? inst.techMap?.[glyph] ?? [];
  const muted = techs.includes('mute');
  const decay = Math.max(inst.synth.decay * (muted ? MUTE_DECAY_FACTOR : 1), 0.025);

  // 滚奏把本字时值均匀切到不宽于 55ms，首击在字头上，末击正好落在时值结束处。
  let attackTimes: number[] = [time];
  if (techs.includes('roll')) {
    const intervals = Math.max(1, Math.ceil(durationSeconds / ROLL_INTERVAL_S));
    attackTimes = Array.from({ length: intervals + 1 }, (_, i) => time + (durationSeconds * i) / intervals);
  }

  // 双打 = 本击后紧跟一声较轻补击。
  const attacks: { at: number; scale: number }[] = [];
  for (const at of attackTimes) {
    attacks.push({ at, scale: 1 });
    if (techs.includes('flam')) attacks.push({ at: at + FLAM_DELAY_S, scale: 0.55 });
  }

  return attacks.map(({ at, scale }) => renderAttack(ctx, dest, inst, at, g0 * scale, decay));
}

function renderAttack(
  ctx: BaseAudioContext,
  dest: AudioNode,
  inst: Instrument,
  at: number,
  gain: number,
  decay: number,
): SynthVoice {
  const env = ctx.createGain();
  env.connect(dest);
  const headroom = inst.synth.type === 'metal' ? 0.7 : 1;
  env.gain.setValueAtTime(gain * headroom, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  const voice: SynthVoice = {
    endsAt: at + decay + 0.05,
    stop: () => env.disconnect(),
  };

  if (inst.synth.type === 'drum') {
    // 低频正弦下滑 + 短噪声敲击
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(inst.synth.baseHz, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(inst.synth.baseHz * 0.5, 30), at + decay);
    osc.connect(env);
    osc.start(at);
    osc.stop(at + decay + 0.02);
    if (inst.synth.noise) attachNoise(ctx, env, at, Math.min(decay, 0.08), 'lowpass', inst.synth.baseHz * 10, 0.6);
  } else if (inst.synth.type === 'metal') {
    renderMetal(ctx, env, inst, at, decay);
  } else {
    // 木：短脉冲（高通噪声 + 三角波 blip）
    attachNoise(ctx, env, at, Math.min(decay, 0.05), 'highpass', 1200, 0.45);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = inst.synth.baseHz;
    osc.connect(env);
    osc.start(at);
    osc.stop(at + decay + 0.02);
  }

  return voice;
}

function renderMetal(
  ctx: BaseAudioContext,
  env: GainNode,
  inst: Instrument,
  at: number,
  decay: number,
): void {
  // 非整数倍泛音是锣/钹区别于鼓和梆子的金属感来源。
  const partials = [
    { ratio: 1, gain: 0.46, type: 'triangle' as OscillatorType },
    { ratio: 1.47, gain: 0.26, type: 'triangle' as OscillatorType },
    { ratio: 2.13, gain: 0.17, type: 'triangle' as OscillatorType },
    { ratio: 2.92, gain: 0.1, type: 'sine' as OscillatorType },
    { ratio: 4.06, gain: 0.06, type: 'sine' as OscillatorType },
  ];

  for (const p of partials) {
    const osc = ctx.createOscillator();
    osc.type = p.type;
    const hz = inst.synth.baseHz * p.ratio;
    osc.frequency.setValueAtTime(hz, at);
    if (p.ratio === 1 && inst.synth.baseHz < 250) {
      osc.frequency.exponentialRampToValueAtTime(hz * 0.92, at + Math.min(decay, 0.35));
    }
    const partialGain = ctx.createGain();
    partialGain.gain.value = p.gain;
    osc.connect(partialGain).connect(env);
    osc.start(at);
    osc.stop(at + decay + 0.04);
  }

  if (inst.synth.noise) {
    // 带通噪声负责撞击后的“沙沙”金属噪韵；不同音区使用不同中心频。
    const noiseFreq = inst.synth.baseHz < 250 ? 720 : inst.synth.baseHz < 450 ? 1650 : 2700;
    const noiseDecay = Math.min(decay, inst.synth.baseHz < 250 ? 0.55 : 0.28);
    attachNoise(ctx, env, at, noiseDecay, 'bandpass', noiseFreq, 0.42, 0.75);
    attachNoise(ctx, env, at, Math.min(noiseDecay * 0.32, 0.08), 'highpass', Math.max(noiseFreq * 2.2, 3200), 0.18);
  }
}

function attachNoise(
  ctx: BaseAudioContext,
  dest: AudioNode,
  at: number,
  dur: number,
  filter: BiquadFilterType,
  freq: number,
  level: number,
  q = 0.8,
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(level, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(dest);
  src.start(at, Math.random() * 1.5, dur + 0.03);
}

// ---------- Lookahead 调度器 ----------

export interface SchedulerHandle {
  stop(): void;
  /** 已排入 AudioContext 的事件（测试/可视化用） */
  scheduled(): ScheduleEvent[];
  /** 当前播放到的时间（ctx 时轴） */
  currentTime(): number;
}

const LOOKAHEAD_S = 0.12; // 预排窗口
const TIMER_MS = 25; // 轮询间隔（只负责填窗口，不负责发声时刻）

/**
 * lookahead 调度器：setInterval 仅做窗口填充，发声时刻由 Web Audio 精确执行。
 * events 必须已按 time 升序；调用方保证 startAt >= ctx.currentTime。
 */
export function scheduleEvents(
  ctx: AudioContext,
  master: AudioNode,
  score: Score,
  events: ScheduleEvent[],
  onVisual?: (ev: ScheduleEvent) => void,
): SchedulerHandle {
  const instMap = new Map(score.instruments.map((i) => [i.id, i]));
  let idx = 0;
  const done: ScheduleEvent[] = [];
  const activeVoices: SynthVoice[] = [];
  let stopped = false;

  const pump = () => {
    if (stopped) return;
    const now = ctx.currentTime;
    for (let i = activeVoices.length - 1; i >= 0; i--) {
      if (activeVoices[i].endsAt <= now) activeVoices.splice(i, 1);
    }
    while (idx < events.length && events[idx].time < now + LOOKAHEAD_S) {
      const ev = events[idx++];
      const inst = instMap.get(ev.instrumentId);
      if (!inst) continue;
      activeVoices.push(...synthesizeHit(ctx, master, inst, ev.hit, ev.time, ev.durationSeconds));
      done.push(ev);
      const delay = Math.max((ev.time - now) * 1000, 0);
      window.setTimeout(() => onVisual && onVisual(ev), delay);
    }
  };
  pump();
  const timer = window.setInterval(pump, TIMER_MS);
  return {
    stop() {
      stopped = true;
      window.clearInterval(timer);
      const now = ctx.currentTime;
      activeVoices.filter((v) => v.endsAt > now).forEach((v) => v.stop());
      activeVoices.length = 0;
    },
    scheduled: () => done.slice(),
    currentTime: () => ctx.currentTime,
  };
}

/** 便捷：从 score 的某绝对格区间生成事件并调度（循环段落用 computeLoopEvents） */
export function playRange(
  ctx: AudioContext,
  master: AudioNode,
  score: Score,
  fromTick: number,
  toTick: number,
  loopCount: number,
  onVisual?: (ev: ScheduleEvent) => void,
  startOffsetS = 0,
): SchedulerHandle {
  void barTicks; // 保持引用一致性（未直接使用）
  const startAt = ctx.currentTime + 0.06 + startOffsetS;
  const events =
    loopCount > 1
      ? computeLoopEvents(score, fromTick, toTick, startAt, loopCount)
      : computeEvents(score.bars, score.bpm, score.freeMeter, score.instruments, fromTick, toTick, startAt);
  return scheduleEvents(ctx, master, score, events, onVisual);
}
