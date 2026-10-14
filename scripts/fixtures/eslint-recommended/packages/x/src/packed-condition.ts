export function packed(alpha: boolean, bravo: boolean, charlie: boolean, delta: boolean, echo: boolean): boolean {
  return (alpha && bravo) || (charlie && !delta) || (echo && alpha && !bravo) || (delta && charlie && echo) || (bravo && !alpha && delta) || (!echo && charlie && bravo && alpha) || (delta && !charlie && bravo);
}
