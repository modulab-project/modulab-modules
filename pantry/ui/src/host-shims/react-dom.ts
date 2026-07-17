// eslint-disable-next-line @typescript-eslint/no-explicit-any
const host = (window as any).__MODULAB_HOST__;
const mod = host.ReactDOM;
export default mod;
export const { createPortal, flushSync } = mod;
