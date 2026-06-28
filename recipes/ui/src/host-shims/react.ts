// eslint-disable-next-line @typescript-eslint/no-explicit-any
const host = (window as any).__MODULAB_HOST__;
const mod = host.React;
export default mod;
export const {
  useState, useEffect, useRef, useCallback, useMemo, useContext,
  useReducer, useLayoutEffect, useId, forwardRef, memo, createContext,
  Fragment, Children, cloneElement, createElement, isValidElement,
  startTransition, Suspense, lazy,
} = mod;
