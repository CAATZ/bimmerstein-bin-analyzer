import { readAxisValues, toPhysical, type AxisDef } from '@binanalyzer/core';
import { axisSaRepresentable } from '@binanalyzer/appkit';
import { foToSA } from '@binanalyzer/engine';

export interface AxisView {
  role: 'x' | 'y';
  kind: AxisDef['kind'];
  count: number;
  address?: number;
  format?: AxisDef['format'];
  scaling?: AxisDef['scaling'];
  name?: string;
  units: string;
  raw?: number[];
  physical?: number[];
  decodeError?: string;
  saRepresentable?: boolean;
  storageAddress?: number;
}

const IDENTITY = { factor: 1, offset: 0, units: '', digits: 0 } as const;

/**
 * Decoded view of one axis. config.axis.maxCount bounds an axis at 64 cells,
 * so raw/physical are always safe to inline. `fullRead` gates the RomRaider
 * storageaddress fields: fo(SA) = (0x10000+SA)^0x4000 only applies to a
 * >=0x18000 full read (on a 24 KB cal partial the file offset IS the SA).
 */
export function axisView(bytes: Uint8Array, axis: AxisDef, role: 'x' | 'y', fullRead: boolean): AxisView {
  const scaling = axis.scaling ?? IDENTITY;
  const view: AxisView = {
    role,
    kind: axis.kind,
    count: axis.count,
    units: scaling.units,
    ...(axis.address !== undefined ? { address: axis.address } : {}),
    ...(axis.format !== undefined ? { format: axis.format } : {}),
    ...(axis.scaling !== undefined ? { scaling: axis.scaling } : {}),
    ...(axis.name !== undefined ? { name: axis.name } : {}),
  };
  try {
    const raw = readAxisValues(bytes, axis);
    view.raw = raw;
    view.physical = raw.map((v) => toPhysical(v, scaling));
  } catch (e) {
    view.decodeError = e instanceof Error ? e.message : String(e);
  }
  if (fullRead) {
    const representable = axisSaRepresentable(axis);
    view.saRepresentable = representable;
    if (representable && axis.kind === 'referenced' && axis.address !== undefined) {
      view.storageAddress = foToSA(axis.address);
    }
  }
  return view;
}
