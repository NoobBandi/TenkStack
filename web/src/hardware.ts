import type { GpuSample } from './api';

/**
 * Ceilings the bars and axes are drawn against.
 *
 * All four come from the card itself where the kernel exposes them: sysfs
 * publishes a sustained power cap, a maximum frequency and a package
 * thermistor with its critical point, none of which appear anywhere in
 * xpu-smi's output. The constants below are only the fallback for a device
 * that reports nothing, and are deliberately generous -- an axis drawn too tall
 * understates a load, while one drawn too short clips it away entirely.
 */

const FALLBACK_POWER_W = 250;
const FALLBACK_CLOCK_MHZ = 2800;
const FALLBACK_TEMP_C = 100;

/** One GiB, in the MiB the samples are reported in. */
const GIB = 1024;

export const powerCeiling = (gpu?: GpuSample) => gpu?.power_cap_w ?? FALLBACK_POWER_W;
export const clockCeiling = (gpu?: GpuSample) => gpu?.frequency_max_mhz ?? FALLBACK_CLOCK_MHZ;
export const tempCeiling = (gpu?: GpuSample) => gpu?.temperature_crit_c ?? FALLBACK_TEMP_C;

/** The highest ceiling across every card, for an axis they share. */
export function maxCeiling(gpus: GpuSample[], of: (g?: GpuSample) => number): number {
  return gpus.length ? Math.max(...gpus.map((g) => of(g))) : of(undefined);
}

/**
 * The top of the VRAM axis: the card's capacity rounded up to a whole 8 GiB.
 *
 * Rounding buys clean ticks — 0/8/16/24/32 rather than 0/8.0/15.9/23.9/31.9 —
 * at the cost of the top of the axis sitting a fraction above the real
 * capacity. On this card that is 32 GiB drawn for 31.9 GiB present, which is
 * also how the card is sold and described.
 */
export function vramAxisMax(totalMib: number): number {
  if (!totalMib) return 32 * GIB;
  return Math.ceil(totalMib / (8 * GIB)) * 8 * GIB;
}

/** Ticks every 8 GiB, inclusive of both ends. */
export function vramAxisTicks(maxMib: number): number[] {
  const step = 8 * GIB;
  const out: number[] = [];
  for (let v = 0; v <= maxMib; v += step) out.push(v);
  return out;
}

/**
 * What each vendor's own tooling calls a card.
 *
 * `xpu:0` and `cuda:0` are the strings that appear in ComfyUI's device list, in
 * torch, and in the llama.cpp device selector, so a tag showing one matches
 * what you would type elsewhere rather than inventing a third naming scheme.
 *
 * Here rather than in a page, because the dashboard had `xpu:{index}` written
 * into it and went on saying xpu after an NVIDIA card went in beside the Arc.
 */
const DEVICE_NAMESPACE: Record<string, string> = {
  intel: 'xpu', nvidia: 'cuda', amd: 'hip',
};

/** Falls back to the provider key, so an unknown vendor is labelled rather
 *  than mislabelled. */
export function deviceTag(vendor: string | undefined, index: number): string {
  return `${DEVICE_NAMESPACE[vendor ?? ''] ?? vendor ?? 'gpu'}:${index}`;
}
