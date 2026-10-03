import { createContext } from 'react';

// Undefined keeps the standalone reader's inner scroll ownership. A drawer
// provides its real panel node; null waits for that panel's ref to attach.
export const HistoryScrollContext = createContext<HTMLDivElement | null | undefined>(undefined);
