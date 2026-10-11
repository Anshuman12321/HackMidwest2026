import { launcher } from '../../bridge.ts';
import type { Event } from '../../bridge.ts';
export default async function run(events: Event[]) { return launcher(events); }
