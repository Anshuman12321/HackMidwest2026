import { bridge } from '../../bridge.ts';
import type { Event } from '../../bridge.ts';
export default async function run(events: Event[]) { return bridge(events, true); }
