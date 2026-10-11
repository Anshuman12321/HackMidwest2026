import ripple_initialize from './functions/ripple_initialize/index.ts';
import ripple_action from './functions/ripple_action/index.ts';
export const functionFactory = { ripple_initialize, ripple_action } as const;
export type FunctionFactoryType = keyof typeof functionFactory;
