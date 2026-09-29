/** An explicit unconditional rule needs neither inference nor example ratings. */
export const INCLUDE_EVERYTHING='Include everything.';
export function includesEverything(text:string){return /^include everything\.?$/i.test(text.trim());}
